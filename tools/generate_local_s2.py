#!/usr/bin/env python3
"""
Generate the zombie-run audio library DIRECTLY with OpenAudio S2-pro, in-process,
on the main thread. Use this instead of the API server on machines where the
server's worker-thread generation trips a CUDA error (Windows + Blackwell).

Loads the model + codec ONCE, voices the first narration line, then reuses that
clip's own codes as the voice prompt for every other clip so the whole narrator
is one consistent voice (no external reference sample needed).

Run inside the Fish Speech conda env, from the VoiceClone repo root, pointing at
this project's audio_src.json / audio output. Example (PowerShell):

  conda activate fish-speech
  cd C:\\Users\\Michno\\Documents\\VoiceClone
  python C:\\Users\\Michno\\Documents\\AidaZombieStrava\\tools\\generate_local_s2.py `
      --src   C:\\Users\\Michno\\Documents\\AidaZombieStrava\\tools\\audio_src.json `
      --out   C:\\Users\\Michno\\Documents\\AidaZombieStrava\\audio `
      --ckpt  checkpoints/s2-pro
"""
import argparse
import json
import sys
import time
from pathlib import Path

import numpy as np
import torch

# fish_speech must be importable (run from the VoiceClone repo root / env)
from fish_speech.models.text2semantic.inference import (
    init_model,
    generate_long,
    load_codec_model,
    decode_to_audio,
)


def parse_args():
    p = argparse.ArgumentParser(description="Generate zombie-run audio with S2-pro, in-process.")
    p.add_argument("--src", required=True, help="Path to audio_src.json")
    p.add_argument("--out", required=True, help="Output audio dir (this project's audio/)")
    p.add_argument("--ckpt", default="checkpoints/s2-pro", help="S2 checkpoint dir")
    p.add_argument("--seed", type=int, default=None, help="Override seed from audio_src.json")
    p.add_argument("--tag", default="", help="Optional S2 delivery instruction in [brackets] "
                   "prepended to narration lines, e.g. 'flat, deadpan tone' (LISTEN and verify it "
                   "isn't read aloud before trusting a full run)")
    p.add_argument("--half", action="store_true", default=True, help="Half precision (default on)")
    p.add_argument("--no-half", dest="half", action="store_false")
    p.add_argument("--limit", type=int, default=0, help="Only generate the first N clips (for testing)")
    p.add_argument("--max-seq-len", type=int, default=2048, help="KV-cache length. The model default "
                   "(32k) preallocates ~9GB of cache; our lines are short, so cap it to save VRAM.")
    p.add_argument("--temperature", type=float, default=0.8)
    p.add_argument("--top-p", type=float, default=0.8)
    return p.parse_args()


def main():
    args = parse_args()
    src = json.loads(Path(args.src).read_text(encoding="utf-8"))
    seed = args.seed if args.seed is not None else src.get("voice", {}).get("seed", 42)
    out = Path(args.out)
    (out / "vo").mkdir(parents=True, exist_ok=True)
    (out / "sfx").mkdir(parents=True, exist_ok=True)
    ckpt = Path(args.ckpt)
    device = "cuda"
    precision = torch.half if args.half else torch.bfloat16

    print("Loading S2-pro (once)...", flush=True)
    t0 = time.time()
    model, decode_one_token = init_model(ckpt, device, precision, compile=False)
    # Match the official CLI exactly: full-length cache, and load the codec LAZILY
    # (only after the first generation) so peak VRAM during generation stays ~17GB.
    with torch.device(device):
        model.setup_caches(max_batch_size=1, max_seq_len=model.config.max_seq_len,
                           dtype=next(model.parameters()).dtype)
    torch.cuda.synchronize()
    import gc
    gc.collect()
    torch.cuda.empty_cache()          # release load-time scratch (tight commit ceiling)
    codec = None
    print(f"Loaded in {time.time() - t0:.0f}s", flush=True)

    def generate_codes(text, prompt_text=None, prompt_codes=None):
        torch.manual_seed(seed)
        torch.cuda.manual_seed(seed)
        gen = generate_long(
            model=model, device=device, decode_one_token=decode_one_token,
            text=text, num_samples=1, max_new_tokens=0,
            top_p=args.top_p, top_k=30, temperature=args.temperature,
            compile=False, iterative_prompt=True, chunk_length=200,
            prompt_text=[prompt_text] if prompt_text else None,
            prompt_tokens=[prompt_codes] if prompt_codes is not None else None,
        )
        codes = []
        for r in gen:
            if r.action == "sample":
                codes.append(r.codes)
            elif r.action == "next":
                break
        if not codes:
            raise RuntimeError("no codes generated")
        return torch.cat(codes, dim=1).detach().cpu()

    # Build the job list. Narration keys mirror LINES in js/main.js.
    jobs = []  # (rel_wav, text, kind)
    manifest = {"sfx": {}, "vo": {}}
    for key, variants in src["vo"].items():
        rels = [f"vo/{key}_{i}.wav" for i, _ in enumerate(variants, 1)]
        manifest["vo"][key] = rels
        jobs += [(r, t, "vo") for r, t in zip(rels, variants)]
    groan_rels = [f"sfx/groan_{i}.wav" for i, _ in enumerate(src["groans"], 1)]
    manifest["sfx"]["groans"] = groan_rels
    jobs += [(r, t, "groan") for r, t in zip(groan_rels, src["groans"])]

    if args.limit:
        jobs = jobs[:args.limit]

    def spoken(text, kind):
        return f"[{args.tag}] {text}" if (args.tag and kind == "vo") else text

    # Anchor: first narration line establishes the voice; reuse its codes as prompt.
    anchor_text, anchor_codes = None, None
    import soundfile as sf

    t0 = time.time()
    for n, (rel, text, kind) in enumerate(jobs, 1):
        is_anchor = anchor_codes is None and kind == "vo"
        print(f"[{n}/{len(jobs)}] {rel}  {text[:48]!r}{'  (anchor)' if is_anchor else ''}", flush=True)
        try:
            if is_anchor:
                codes = generate_codes(spoken(text, kind))
                anchor_codes, anchor_text = codes, text
            else:
                codes = generate_codes(spoken(text, kind), prompt_text=anchor_text, prompt_codes=anchor_codes)
            # Load the codec lazily the first time we decode (keeps generation peak ~17GB).
            if codec is None:
                codec = load_codec_model(ckpt / "codec.pth", device, precision)
            audio = decode_to_audio(codes.to(device), codec).detach().cpu().float().numpy().reshape(-1)
        except Exception as e:
            sys.exit(f"  FAILED on {rel}: {e}")
        sr = codec.sample_rate
        dur = len(audio) / sr
        peak = float(np.max(np.abs(audio))) if len(audio) else 0.0
        sf.write(str(out / rel), audio, sr)
        flag = "  <-- CHECK (silent/tiny)" if (dur < 0.3 or peak < 0.02) else ""
        print(f"      {dur:.1f}s peak={peak:.2f}{flag}", flush=True)

    (out / "manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    print(f"\nDone in {time.time() - t0:.0f}s. Wrote WAVs + manifest to {out}", flush=True)
    print("(WAVs; convert to mp3 separately if you want smaller files.)", flush=True)


if __name__ == "__main__":
    main()
