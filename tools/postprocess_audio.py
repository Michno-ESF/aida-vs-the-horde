#!/usr/bin/env python3
"""
Post-process the generated WAVs: convert to MP3 (much smaller for the web),
build the ambient horde bed from the groans, and rewrite manifest.json to point
at the MP3s. Run in an env with pydub + ffmpeg available.

  python tools/postprocess_audio.py --dir <project>/audio
"""
import argparse
import json
from pathlib import Path

from pydub import AudioSegment


def pitch(seg, factor):
    shifted = seg._spawn(seg.raw_data, overrides={"frame_rate": int(seg.frame_rate * factor)})
    return shifted.set_frame_rate(44100)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", required=True, help="audio/ dir")
    ap.add_argument("--bitrate", default="128k")
    args = ap.parse_args()
    root = Path(args.dir)
    manifest = json.loads((root / "manifest.json").read_text(encoding="utf-8"))

    def wav_to_mp3(rel):
        wav = root / rel
        if not wav.exists():
            return rel  # already mp3 or missing
        mp3_rel = rel[:-4] + ".mp3"
        AudioSegment.from_file(wav).export(root / mp3_rel, format="mp3", bitrate=args.bitrate)
        wav.unlink()
        return mp3_rel

    # Narration
    for key, rels in manifest.get("vo", {}).items():
        manifest["vo"][key] = [wav_to_mp3(r) for r in rels]

    # Groans — keep the wavs a moment to build the ambient bed first
    groan_rels = manifest.get("sfx", {}).get("groans", [])
    groan_wavs = [root / r for r in groan_rels if (root / r).exists()]
    if groan_wavs:
        bed = AudioSegment.silent(duration=14000, frame_rate=44100)
        offset, i = 0, 0
        while offset < 13000:
            seg = pitch(AudioSegment.from_file(groan_wavs[i % len(groan_wavs)]), 0.7).apply_gain(-14)
            bed = bed.overlay(seg, position=offset)
            offset += 1100
            i += 1
        bed.fade_in(1500).fade_out(1500).export(root / "sfx" / "ambient.mp3", format="mp3", bitrate="96k")
        manifest["sfx"]["ambient"] = "sfx/ambient.mp3"
        print("built sfx/ambient.mp3")

    manifest["sfx"]["groans"] = [wav_to_mp3(r) for r in groan_rels]

    (root / "manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    total = sum(f.stat().st_size for f in root.rglob("*.mp3")) / 1e6
    print(f"Done. {len(list(root.rglob('*.mp3')))} mp3s, {total:.1f} MB total.")


if __name__ == "__main__":
    main()
