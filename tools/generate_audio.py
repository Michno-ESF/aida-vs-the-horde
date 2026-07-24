#!/usr/bin/env python3
"""
Generate the realistic audio library for Aida vs. The Horde using a LOCAL
Fish Speech / OpenAudio S1 server (the one in your VoiceClone project).

It voices every narrator line and a set of guttural "groan" clips, saves them
as MP3s under ../audio, and writes ../audio/manifest.json. The web app loads
that manifest on the next run and switches from synthesized sound to these
clips automatically. Delete the audio/ folder (or the manifest) to go back.

USAGE
  1. Start your Fish Speech API server (from the VoiceClone folder):
        python tools/api_server.py --listen 0.0.0.0:8080 \
            --llama-checkpoint-path checkpoints/openaudio-s1-mini \
            --decoder-checkpoint-path checkpoints/openaudio-s1-mini/codec.pth \
            --decoder-config-name modded_dac_vq
  2. Pick a NARRATOR voice. The seed does not fix timbre, so for one consistent
     narrator you must give a reference (10-30s of a dry, deadpan speaker):
        python tools/generate_audio.py --voice-ref path/to/narrator.wav \
            --voice-ref-text "exact transcript of that clip"
     ...or a voice already registered on the server:
        python tools/generate_audio.py --reference-id my_narrator
     (Just testing? add --allow-drift to run with no reference — the voice will
      vary line to line.)
  3. Commit the audio/ folder and push. Done.

Run this with the SAME Python environment as your Fish Speech server (it needs
`requests` and `ormsgpack`, which that project already installs). `pydub` +
ffmpeg are optional and only used to build the ambient bed.
"""
import argparse
import json
import sys
import time
from pathlib import Path

try:
    import requests
    import ormsgpack
except ImportError as e:
    sys.exit(f"Missing dependency: {e}. Run this in your Fish Speech environment "
             "(the one with `requests` and `ormsgpack`).")

ROOT = Path(__file__).resolve().parent.parent          # the repo root
SRC = Path(__file__).resolve().parent / "audio_src.json"
OUT = ROOT / "audio"


def parse_args():
    p = argparse.ArgumentParser(description="Generate zombie-run audio via a local Fish Speech server.")
    p.add_argument("--url", default="http://127.0.0.1:8080/v1/tts", help="Fish Speech /v1/tts endpoint")
    p.add_argument("--reference-id", default=None, help="Name of a voice registered on the server")
    p.add_argument("--voice-ref", default=None, help="Path to a reference voice audio file (wav/mp3/flac)")
    p.add_argument("--voice-ref-text", default="", help="Transcript of the reference audio")
    p.add_argument("--allow-drift", action="store_true", help="Run without a reference (voice will vary per line)")
    p.add_argument("--api-key", default="none", help="Bearer token if your server requires one")
    p.add_argument("--seed", type=int, default=None, help="Override the seed from audio_src.json")
    p.add_argument("--only", choices=["vo", "groans"], default=None, help="Generate only one category")
    p.add_argument("--no-ambient", action="store_true", help="Skip building the ambient horde bed")
    p.add_argument("--tag", default="", help="S2 delivery instruction prepended to each narration line "
                   "in [brackets], e.g. 'flat, deadpan, unbothered tone' (not spoken)")
    p.add_argument("--auto-anchor", action="store_true", help="Generate the first line once, then reuse it as "
                   "the reference for every other clip so the whole narrator is ONE consistent voice "
                   "(no external sample needed)")
    p.add_argument("--dry-run", action="store_true", help="List what would be generated, don't call the server")
    return p.parse_args()


def tts(args, text, seed, references=None):
    """Return MP3 bytes for `text` from the Fish Speech server."""
    if references is None:
        references = []
        if args.voice_ref:
            references = [{"audio": Path(args.voice_ref).read_bytes(), "text": args.voice_ref_text}]
    payload = {
        "text": text,
        "references": references,
        "reference_id": args.reference_id,
        "format": "mp3",
        "chunk_length": 200,
        "max_new_tokens": 1024,
        "top_p": 0.8,
        "repetition_penalty": 1.1,
        "temperature": 0.8,
        "normalize": True,
        "use_memory_cache": "on",   # cache the reference encoding across calls
        "seed": seed,
        "streaming": False,
    }
    r = requests.post(
        args.url,
        params={"format": "msgpack"},
        data=ormsgpack.packb(payload),
        headers={"content-type": "application/msgpack", "authorization": f"Bearer {args.api_key}"},
        timeout=300,
    )
    if r.status_code != 200:
        raise RuntimeError(f"server returned {r.status_code}: {r.text[:300]}")
    return r.content


def build_ambient(groan_paths, dest):
    """Overlay pitched-down groans into a seamless low horde murmur. Best-effort."""
    try:
        from pydub import AudioSegment
    except Exception:
        print("  (pydub not available — skipping ambient bed; the app fades groans instead)")
        return False

    def pitch(seg, factor):
        shifted = seg._spawn(seg.raw_data, overrides={"frame_rate": int(seg.frame_rate * factor)})
        return shifted.set_frame_rate(44100)

    try:
        bed = AudioSegment.silent(duration=14000, frame_rate=44100)
        offset = 0
        i = 0
        while offset < 13000:
            seg = AudioSegment.from_file(groan_paths[i % len(groan_paths)])
            seg = pitch(seg, 0.7).apply_gain(-16)
            bed = bed.overlay(seg, position=offset)
            offset += 1100
            i += 1
        bed = bed.fade_in(1500).fade_out(1500)
        bed.export(dest, format="mp3", bitrate="96k")
        return True
    except Exception as e:
        print(f"  (ambient build failed: {e} — skipping)")
        return False


def main():
    args = parse_args()
    if not (args.reference_id or args.voice_ref or args.allow_drift or args.auto_anchor or args.dry_run):
        sys.exit("No narrator voice given. Pass --auto-anchor (one consistent voice, no sample needed), "
                 "or --voice-ref <file> (+ --voice-ref-text), or --reference-id <name>, "
                 "or --allow-drift to accept a varying voice.")

    src = json.loads(SRC.read_text(encoding="utf-8"))
    seed = args.seed if args.seed is not None else src.get("voice", {}).get("seed")
    (OUT / "vo").mkdir(parents=True, exist_ok=True)
    (OUT / "sfx").mkdir(parents=True, exist_ok=True)

    manifest = {"sfx": {}, "vo": {}}
    jobs = []   # each: {"rel", "text", "kind"}
    if args.only != "groans":
        for key, variants in src["vo"].items():
            rels = [f"vo/{key}_{i}.mp3" for i, _ in enumerate(variants, 1)]
            manifest["vo"][key] = rels
            jobs += [{"rel": r, "text": t, "kind": "vo"} for r, t in zip(rels, variants)]
    groan_rels = []
    if args.only != "vo":
        for i, text in enumerate(src["groans"], 1):
            groan_rels.append((f"sfx/groan_{i}.mp3", text))
        manifest["sfx"]["groans"] = [r for r, _ in groan_rels]
        jobs += [{"rel": r, "text": t, "kind": "groan"} for r, t in groan_rels]

    # Delivery instruction (spoken as tone, not aloud) — narration only, never groans.
    def gen_text(job):
        return f"[{args.tag}] {job['text']}" if args.tag and job["kind"] == "vo" else job["text"]

    print(f"{len(jobs)} clip(s) to generate into {OUT}")
    if args.dry_run:
        for j in jobs:
            print(f"  {j['rel']:24} {gen_text(j)[:70]}")
        return

    t0 = time.time()
    # Auto-anchor: voice the first narration line, then clone it onto every other
    # clip so the whole run is one consistent narrator without an external sample.
    anchor_ref = None
    done = set()
    if args.auto_anchor and not args.voice_ref and not args.reference_id:
        first = next((j for j in jobs if j["kind"] == "vo"), None)
        if first:
            print(f"[anchor] {first['rel']} — establishing the narrator voice")
            try:
                (OUT / first["rel"]).write_bytes(tts(args, gen_text(first), seed))
            except Exception as e:
                sys.exit(f"  FAILED on anchor {first['rel']}: {e}\n  Is the server running at {args.url}?")
            anchor_ref = [{"audio": (OUT / first["rel"]).read_bytes(), "text": first["text"]}]
            done.add(first["rel"])

    for n, job in enumerate(jobs, 1):
        if job["rel"] in done:
            continue
        dest = OUT / job["rel"]
        print(f"[{n}/{len(jobs)}] {job['rel']} — {job['text'][:50]!r}")
        try:
            dest.write_bytes(tts(args, gen_text(job), seed, references=anchor_ref))
        except Exception as e:
            sys.exit(f"  FAILED on {job['rel']}: {e}\n  Is the server running at {args.url}?")

    if groan_rels and not args.no_ambient and args.only != "vo":
        print("Building ambient horde bed...")
        if build_ambient([OUT / r for r, _ in groan_rels], OUT / "sfx" / "ambient.mp3"):
            manifest["sfx"]["ambient"] = "sfx/ambient.mp3"

    # Merge into any existing manifest so --only runs don't wipe the other half.
    mpath = OUT / "manifest.json"
    if mpath.exists() and args.only:
        old = json.loads(mpath.read_text(encoding="utf-8"))
        old.setdefault("sfx", {}).update(manifest["sfx"])
        old.setdefault("vo", {}).update(manifest["vo"])
        manifest = old
    mpath.write_text(json.dumps(manifest, indent=2), encoding="utf-8")

    print(f"\nDone in {time.time() - t0:.0f}s. Wrote {mpath}")
    print("Commit the audio/ folder and push — the app upgrades itself on the next run.")


if __name__ == "__main__":
    main()
