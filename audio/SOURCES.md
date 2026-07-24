# Audio sources

- **Narration** (`vo/*.mp3`) — generated locally with OpenAudio S2-pro (Fish
  Speech). Original text; deadpan gallows-humor script written for this app.
- **Zombie SFX** (`sfx/groan_*.mp3`, `sfx/bitten.mp3`, `sfx/ambush.mp3`,
  `sfx/overrun.mp3`) — royalty-free sound effects from **Pixabay**
  (https://pixabay.com/sound-effects/), used under the Pixabay Content License
  (free for commercial use, no attribution required).
- **Ambient bed** (`sfx/ambient.mp3`) — built from the groan clips above.

Regenerate the SFX from a folder of raw sounds with `tools/build_sfx.py`; the
narration with `tools/generate_local_s2.py` + `tools/postprocess_audio.py`.
