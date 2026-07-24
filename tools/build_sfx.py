#!/usr/bin/env python3
"""
Turn a folder of raw zombie sound files into the game's SFX set: trims silence,
levels each clip, slots them into the groan pool + event cues, rebuilds the
ambient horde bed, and updates audio/manifest.json (leaving the narration `vo`
section untouched). Needs pydub + ffmpeg.

Naming convention in --src (mp3/wav):
  groan_*        -> groan pool (played, pitched down, as the horde nears)
  event_bite*    -> the "bitten" cue
  event_scream*  -> the "ambush" cue
  event_screech* -> the "ambush" cue (if no scream)
  event_fem*     -> the "overrun" cue
  event_dying*   -> added to the groan pool

  python tools/build_sfx.py --src <raw folder> --out <project>/audio
"""
import argparse
import json
from pathlib import Path

from pydub import AudioSegment, silence


def trim_level(path, max_s, target_dbfs=-3.0):
    seg = AudioSegment.from_file(path).set_channels(1).set_frame_rate(44100)
    thresh = (seg.dBFS - 16) if seg.dBFS > -50 else -45
    nons = silence.detect_nonsilent(seg, min_silence_len=150, silence_thresh=thresh)
    if nons:
        seg = seg[max(0, nons[0][0] - 30):]           # drop leading silence
    seg = seg[:int(max_s * 1000)]
    if seg.max_dBFS > -90:
        seg = seg.apply_gain(target_dbfs - seg.max_dBFS)  # normalize peak
    return seg.fade_in(20).fade_out(140)


def pitch(seg, factor):
    return seg._spawn(seg.raw_data, overrides={"frame_rate": int(seg.frame_rate * factor)}).set_frame_rate(44100)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", required=True)
    ap.add_argument("--out", required=True)
    args = ap.parse_args()
    src, out = Path(args.src), Path(args.out)
    (out / "sfx").mkdir(parents=True, exist_ok=True)
    manifest = json.loads((out / "manifest.json").read_text(encoding="utf-8"))
    manifest.setdefault("sfx", {})

    files = sorted(list(src.glob("*.mp3")) + list(src.glob("*.wav")))

    def match(*keys):
        for f in files:
            if any(k in f.stem.lower() for k in keys):
                return f
        return None

    # clear old groans/ambient so the pool is exactly the new set
    for old in out.glob("sfx/groan_*.mp3"):
        old.unlink()
    (out / "sfx" / "ambient.mp3").unlink(missing_ok=True)

    # Groan pool: everything named groan_*, plus the "dying" one
    groan_src = [f for f in files if f.stem.lower().startswith("groan")]
    if (dy := match("dying")):
        groan_src.append(dy)
    groan_rels, groan_segs = [], []
    for i, f in enumerate(groan_src, 1):
        seg = trim_level(f, max_s=2.8)
        rel = f"sfx/groan_{i}.mp3"
        seg.export(out / rel, format="mp3", bitrate="128k")
        groan_rels.append(rel)
        groan_segs.append(seg)
        print(f"groan_{i}  <- {f.name}  ({len(seg)/1000:.1f}s)")
    manifest["sfx"]["groans"] = groan_rels

    # Event cues
    cue_map = {
        "bitten": match("event_bite", "_bite"),
        "ambush": match("event_scream", "_scream", "screech"),
        "overrun": match("event_fem", "fem", "screams"),
    }
    for kind, f in cue_map.items():
        if not f:
            continue
        seg = trim_level(f, max_s=2.0)
        rel = f"sfx/{kind}.mp3"
        seg.export(out / rel, format="mp3", bitrate="128k")
        manifest["sfx"][kind] = rel
        print(f"{kind}  <- {f.name}  ({len(seg)/1000:.1f}s)")

    # Ambient bed: overlay pitched-down groans into a rolling murmur
    if groan_segs:
        bed = AudioSegment.silent(duration=15000, frame_rate=44100)
        offset, i = 0, 0
        while offset < 14000:
            g = pitch(groan_segs[i % len(groan_segs)], 0.72).apply_gain(-13)
            bed = bed.overlay(g, position=offset)
            offset += 1200
            i += 1
        bed.fade_in(1800).fade_out(1800).export(out / "sfx" / "ambient.mp3", format="mp3", bitrate="96k")
        manifest["sfx"]["ambient"] = "sfx/ambient.mp3"
        print("ambient.mp3 built")

    (out / "manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    total = sum(f.stat().st_size for f in out.rglob("*.mp3")) / 1e6
    print(f"\nDone. {len(groan_rels)} groans + {len(cue_map)} cues. audio total {total:.1f} MB")


if __name__ == "__main__":
    main()
