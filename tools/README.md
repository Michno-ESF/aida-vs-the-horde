# Realistic audio pipeline

The app ships with **synthesized** sound and the phone's built-in text-to-speech
as a zero-dependency fallback. To make it realistic, generate a library of audio
clips with the local **Fish Speech / OpenAudio S2** model (the `VoiceClone`
project) and drop them in `../audio/`. The app detects `audio/manifest.json` on
the next run and switches over automatically — no code change, no redeploy logic.

## ⭐ The method that works on this machine (5090 / Windows)

The bundled `audio/` was generated this way. Two scripts:

```powershell
conda activate fish-speech
cd C:\Users\Michno\Documents\VoiceClone
# 1) generate every clip in-process (loads S2-pro once, ~12 min for 35 clips)
python C:\Users\Michno\Documents\AidaZombieStrava\tools\generate_local_s2.py `
    --src C:\Users\Michno\Documents\AidaZombieStrava\tools\audio_src.json `
    --out C:\Users\Michno\Documents\AidaZombieStrava\audio
# 2) convert the WAVs to mp3 + build the ambient bed (needs pydub + ffmpeg)
python C:\Users\Michno\Documents\AidaZombieStrava\tools\postprocess_audio.py --dir C:\Users\Michno\Documents\AidaZombieStrava\audio
```

`generate_local_s2.py` runs generation **in the main thread** and reuses the
first line's own codes as the voice prompt, so the whole narrator is one
consistent voice with no reference sample. Hard-won gotchas baked into it:

- **The API server (`api_server.py`) does NOT work here** — it runs generation
  in a worker thread, which trips `CUDA error: unknown error` on Blackwell +
  Windows. Use the in-process script instead. (`generate_audio.py` below targets
  that server; keep it only if you fix/serve S2 elsewhere, e.g. WSL2 + SGLang.)
- **VRAM:** load the full-length KV cache like the official CLI, and load the
  codec *lazily* (after the first generation) — peak stays ~17–22 GB.
- **System commit:** free RAM/disk first. S2-pro's load spikes commit hard; on a
  near-full C: drive the pagefile can't grow and generation dies at the ceiling.
  The script runs `gc.collect()` + `empty_cache()` after load to help.
- Want a specific voice/character? Pass `--voice-ref sample.wav` (a dry, deadpan
  speaker) instead of the auto-anchor, and/or `--tag "flat, deadpan tone"` — then
  LISTEN to one clip to confirm the tag isn't read aloud before a full run.

The section below documents the (server-based) `generate_audio.py` alternative.

---

## What gets generated

- **Narration** (`audio/vo/*.mp3`) — every deadpan line, spoken by one consistent
  voice. Keys map 1:1 to the `LINES` in [`js/main.js`](../js/main.js); any line
  without a clip just falls back to phone TTS, so partial generation is fine.
- **Groans** (`audio/sfx/groan_*.mp3`) — short guttural sounds. The browser
  pitches them **down** and pans them around her, so they read as zombies, not a
  person. They fire more often and louder as the horde closes.
- **Ambient bed** (`audio/sfx/ambient.mp3`, optional) — a low horde murmur built
  by layering the groans; fades in with proximity.

Everything is scored by the same proximity engine, so the closer the horde, the
more you hear — the whole point of the app.

## Steps

```bash
# 1. Start your Fish Speech server (from the VoiceClone folder)
python tools/api_server.py --listen 0.0.0.0:8080 \
  --llama-checkpoint-path checkpoints/openaudio-s1-mini \
  --decoder-checkpoint-path checkpoints/openaudio-s1-mini/codec.pth \
  --decoder-config-name modded_dac_vq

# 2. Generate everything (run in the Fish Speech Python env). Give it a
#    reference voice so every line is the SAME narrator — pick something dry
#    and unbothered for the deadpan tone.
python tools/generate_audio.py \
  --voice-ref "C:/path/to/narrator_sample.wav" \
  --voice-ref-text "the exact words spoken in that sample"

# preview the plan without calling the server:
python tools/generate_audio.py --dry-run
```

Then commit the new `audio/` folder and push. That's it.

## Notes

- **Voice consistency:** the seed does *not* fix the timbre in S1 — you must pass
  a reference (`--voice-ref` or a registered `--reference-id`) or every line will
  sound like a different person. `--allow-drift` bypasses this for quick tests.
- **The script and the app must agree:** clip keys come from
  [`audio_src.json`](audio_src.json), whose `vo` keys mirror `LINES` in
  `js/main.js`. Reword the lines there freely; if you rename a key, rename it in
  both places (otherwise that line falls back to TTS).
- **The name:** clips bake in "Aida". If you change the runner name in the app,
  the clips won't match that name, but TTS fallback still personalizes — or just
  regenerate with the new name in `audio_src.json`.
- **Revert:** delete `audio/` (or just `audio/manifest.json`) and the app returns
  to synthesized sound.
- **Want even richer SFX** (a dedicated heartbeat, footstep, or sting) later? Drop
  MP3s in `audio/sfx/` and add them under `sfx` in the manifest — `spawn`,
  `ambush`, `escape`, `bitten`, `overrun` clip keys are already supported by the
  engine and override the synth cues when present.
