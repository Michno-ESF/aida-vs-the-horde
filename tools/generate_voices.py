#!/usr/bin/env python3
"""
Generate the multi-voice / multi-tone narration library with OpenAudio S2-pro,
in-process on the main thread (the API server's worker thread trips a CUDA bug
on Blackwell + Windows -- see tools/README.md).

Runs in TWO PHASES, deliberately as separate processes:

  --phase codes    load ONLY the transformer, generate semantic codes -> _codes/*.npy
  --phase decode   load ONLY the codec, decode every .npy -> mp3, delete the .npy

Why: the transformer's full-length KV cache (~16.6GB) fragments VRAM so badly
that later loading the 1GB codec fails even with >13GB free, and loading the
codec first segfaults the sharded weight load. Keeping them in separate
processes avoids the interaction completely.

For each voice, one ANCHOR clip is generated using that voice's character tag
and seed; every other clip clones the anchor's codes as its voice prompt. That
keeps a voice consistent and stops tag text ever bleeding into a normal line.

Resumable: existing mp3s (and codes) are skipped, so it can be re-run any time.

  conda activate fish-speech && cd C:\\Users\\Michno\\Documents\\VoiceClone
  python <proj>\\tools\\generate_voices.py --src <proj>\\tools\\audio_src.json --out <proj>\\audio --phase codes
  python <proj>\\tools\\generate_voices.py --src <proj>\\tools\\audio_src.json --out <proj>\\audio --phase decode
"""
import argparse
import gc
import json
import sys
import time
from pathlib import Path

import numpy as np
import torch


def parse_args():
    p = argparse.ArgumentParser()
    p.add_argument("--src", required=True)
    p.add_argument("--out", required=True)
    p.add_argument("--ckpt", default="checkpoints/s2-pro")
    p.add_argument("--phase", choices=["codes", "decode", "manifest"], required=True)
    p.add_argument("--voices", default="", help="Comma-separated voice ids to limit to")
    p.add_argument("--tones", default="", help="Comma-separated tone ids to limit to")
    p.add_argument("--limit", type=int, default=0, help="Stop after N new items")
    p.add_argument("--temperature", type=float, default=0.8)
    p.add_argument("--top-p", type=float, default=0.8)
    p.add_argument("--bitrate", default="128k")
    return p.parse_args()


def build_plan(src, args):
    """-> (voices, tones, plan[], manifest_vo{})  plan item: dict(voice,tone,key,idx,rel,text)"""
    voices = src["voices"]
    if args.voices:
        keep = {v.strip() for v in args.voices.split(",")}
        voices = [v for v in voices if v["id"] in keep]
    tones = {k: v for k, v in src["tones"].items() if not k.startswith("_")}
    if args.tones:
        keep = {t.strip() for t in args.tones.split(",")}
        tones = {k: v for k, v in tones.items() if k in keep}

    plan, manifest_vo = [], {}
    for v in voices:
        manifest_vo.setdefault(v["id"], {})
        for tone_id, tone in tones.items():
            manifest_vo[v["id"]].setdefault(tone_id, {})
            for key, variants in tone.items():
                if key.startswith("_"):
                    continue
                rels = []
                for i, text in enumerate(variants, 1):
                    rel = f"vo/{v['id']}/{tone_id}/{key}_{i}.mp3"
                    rels.append(rel)
                    plan.append(dict(voice=v, tone=tone_id, key=key, idx=i, rel=rel, text=text))
                manifest_vo[v["id"]][tone_id][key] = rels
    return voices, tones, plan, manifest_vo


def codes_path(out, rel):
    return out / "_codes" / (rel[3:].replace(".mp3", ".npy"))   # strip leading "vo/"


# ---------------------------------------------------------------- phase: codes
def phase_codes(args, src, voices, tones, plan):
    from fish_speech.models.text2semantic.inference import init_model, generate_long

    todo = [p for p in plan
            if not (Path(args.out) / p["rel"]).exists() and not codes_path(Path(args.out), p["rel"]).exists()]
    print(f"{len(plan)} clips planned, {len(todo)} need codes", flush=True)
    if not todo:
        return

    out, ckpt = Path(args.out), Path(args.ckpt)
    device, precision = "cuda", torch.half
    print("Loading transformer...", flush=True)
    t0 = time.time()
    model, decode_one_token = init_model(ckpt, device, precision, compile=False)
    with torch.device(device):
        model.setup_caches(max_batch_size=1, max_seq_len=model.config.max_seq_len,
                           dtype=next(model.parameters()).dtype)
    torch.cuda.synchronize()
    gc.collect()
    torch.cuda.empty_cache()
    print(f"Loaded in {time.time() - t0:.0f}s", flush=True)

    def gen(text, seed, prompt_text=None, prompt_codes=None):
        torch.manual_seed(seed)
        torch.cuda.manual_seed(seed)
        it = generate_long(
            model=model, device=device, decode_one_token=decode_one_token,
            text=text, num_samples=1, max_new_tokens=0,
            top_p=args.top_p, top_k=30, temperature=args.temperature,
            compile=False, iterative_prompt=True, chunk_length=200,
            prompt_text=[prompt_text] if prompt_text else None,
            prompt_tokens=[prompt_codes] if prompt_codes is not None else None,
        )
        acc = []
        for r in it:
            if r.action == "sample":
                acc.append(r.codes)
            elif r.action == "next":
                break
        if not acc:
            raise RuntimeError("no codes generated")
        return torch.cat(acc, dim=1).detach().cpu()

    anchor_key = src.get("anchorKey", "start")
    first_tone = next(iter(tones))
    anchors = {}

    def anchor_for(v):
        """Load or create this voice's anchor (text, codes)."""
        vid = v["id"]
        if vid in anchors:
            return anchors[vid]
        a_text = tones[first_tone][anchor_key][0]
        a_rel = f"vo/{vid}/{first_tone}/{anchor_key}_1.mp3"
        a_np = codes_path(Path(args.out), a_rel)
        if a_np.exists():
            codes = torch.from_numpy(np.load(a_np))
        else:
            tagged = f"[{v['tag']}] {a_text}" if v.get("tag") else a_text
            print(f"[anchor] {vid}: {v.get('tag', '(untagged)')}", flush=True)
            codes = gen(tagged, v["seed"])
            a_np.parent.mkdir(parents=True, exist_ok=True)
            np.save(a_np, codes.numpy())
        anchors[vid] = (a_text, codes)
        return anchors[vid]

    made, t0 = 0, time.time()
    for p in todo:
        v = p["voice"]
        a_text, a_codes = anchor_for(v)
        np_path = codes_path(out, p["rel"])
        if np_path.exists():
            continue
        print(f"[{made + 1}/{len(todo)}] {p['rel']}  {p['text'][:42]!r}", flush=True)
        try:
            codes = gen(p["text"], v["seed"], prompt_text=a_text, prompt_codes=a_codes)
        except Exception as e:
            import traceback; traceback.print_exc()
            sys.exit(f"FAILED {p['rel']}: {type(e).__name__}: {e}")
        np_path.parent.mkdir(parents=True, exist_ok=True)
        np.save(np_path, codes.numpy())
        made += 1
        if made % 10 == 0:
            el = time.time() - t0
            print(f"  -- {made}/{len(todo)}  {el/60:.0f}m elapsed, ~{el/made*(len(todo)-made)/60:.0f}m left", flush=True)
        if args.limit and made >= args.limit:
            break
    print(f"codes done: {made} in {(time.time()-t0)/60:.0f}m", flush=True)


# --------------------------------------------------------------- phase: decode
def phase_decode(args):
    from fish_speech.models.text2semantic.inference import load_codec_model, decode_to_audio
    from pydub import AudioSegment
    import soundfile as sf
    import io

    out, ckpt = Path(args.out), Path(args.ckpt)
    npys = sorted((out / "_codes").rglob("*.npy"))
    if not npys:
        print("no codes to decode")
        return
    print(f"decoding {len(npys)} clips...", flush=True)
    codec = load_codec_model(ckpt / "codec.pth", "cuda", torch.half)
    sr = codec.sample_rate
    ok = flagged = 0
    for n, np_path in enumerate(npys, 1):
        rel = "vo/" + str(np_path.relative_to(out / "_codes")).replace("\\", "/").replace(".npy", ".mp3")
        dest = out / rel
        try:
            codes = torch.from_numpy(np.load(np_path)).to("cuda")
            audio = decode_to_audio(codes, codec).detach().cpu().float().numpy().reshape(-1)
        except Exception as e:
            print(f"  FAILED {rel}: {e}", flush=True)
            continue
        dur = len(audio) / sr
        peak = float(np.max(np.abs(audio))) if len(audio) else 0.0
        dest.parent.mkdir(parents=True, exist_ok=True)
        buf = io.BytesIO()
        sf.write(buf, audio, sr, format="WAV")
        buf.seek(0)
        AudioSegment.from_file(buf, format="wav").export(dest, format="mp3", bitrate=args.bitrate)
        np_path.unlink()
        ok += 1
        if dur < 0.4 or peak < 0.02:
            flagged += 1
            print(f"  CHECK {rel}: {dur:.1f}s peak={peak:.2f}", flush=True)
        if n % 25 == 0:
            print(f"  -- {n}/{len(npys)}", flush=True)
    print(f"decoded {ok}/{len(npys)} ({flagged} flagged)", flush=True)


# ------------------------------------------------------------- manifest writing
def write_manifest(out, src, voices, tones, manifest_vo):
    path = out / "manifest.json"
    m = {}
    if path.exists():
        try:
            m = json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            m = {}
    m["version"] = 2
    m.setdefault("sfx", {})
    anchor_key = src.get("anchorKey", "start")
    first_tone = next(iter(tones))
    m["voices"] = [
        {"id": v["id"], "label": v["label"],
         "sample": f"vo/{v['id']}/{first_tone}/{anchor_key}_1.mp3"}
        for v in voices
        if (out / f"vo/{v['id']}/{first_tone}/{anchor_key}_1.mp3").exists()
    ]
    m["tones"] = [{"id": t, "label": tones[t].get("_label", t.title())} for t in tones]
    vo = m.get("vo") if isinstance(m.get("vo"), dict) else {}
    if vo and all(isinstance(x, list) for x in vo.values()):
        vo = {}                                     # drop legacy flat layout
    for vid, byTone in manifest_vo.items():
        vo.setdefault(vid, {})
        for tone_id, keys in byTone.items():
            present = {k: [r for r in rels if (out / r).exists()] for k, rels in keys.items()}
            vo[vid][tone_id] = {k: v for k, v in present.items() if v}
            if not vo[vid][tone_id]:
                del vo[vid][tone_id]
        if not vo[vid]:
            del vo[vid]
    m["vo"] = vo
    path.write_text(json.dumps(m, indent=2), encoding="utf-8")
    n = sum(len(r) for t in vo.values() for k in t.values() for r in k.values())
    print(f"manifest: {len(m['voices'])} voices, {n} clips", flush=True)


def main():
    args = parse_args()
    src = json.loads(Path(args.src).read_text(encoding="utf-8"))
    voices, tones, plan, manifest_vo = build_plan(src, args)
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)

    if args.phase == "codes":
        phase_codes(args, src, voices, tones, plan)
    elif args.phase == "decode":
        phase_decode(args)
        write_manifest(out, src, voices, tones, manifest_vo)
    else:
        write_manifest(out, src, voices, tones, manifest_vo)


if __name__ == "__main__":
    main()
