const rand = (a, b) => a + Math.random() * (b - a);

/**
 * Audio for the chase. Two modes, chosen per-asset at load time:
 *
 *  - REALISTIC: if `audio/manifest.json` and its clips are present, real
 *    recordings are used — zombie groans (pitched down + panned so they feel
 *    like they're behind her), a horde ambience bed, and spoken narration.
 *    Everything still scales with how close the horde is.
 *  - FALLBACK: with no clips (the default until they're generated), sound is
 *    synthesized with the Web Audio API so the app always makes noise.
 *
 * Either way the proximity behaviour is identical: heartbeat tempo/volume and
 * groan frequency/volume rise as the gap shrinks. Must be unlocked from a user
 * gesture (iOS): call unlock() in the Start handler.
 *
 * Manifest versions: v2 nests narration under { voiceId: { toneId: { key:
 * [urls] } } } plus a `voices`/`tones` catalog so the Loadout screen can offer
 * a picker; v1 (still live) is just `{ key: [urls] }`. loadLibrary() decodes
 * sfx once and swaps ONLY the narration set when the chosen voice/tone
 * changes, falling back voice -> first available -> v1 flat -> synth/TTS at
 * every step so a missing or malformed manifest never breaks the run.
 */
export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.sfxBus = null;
    this.voiceBus = null;
    this.nextHeart = 0;
    this.nextGroan = 0;
    this._heartTimer = null;
    this._ambientSrc = null;
    this._ambientGain = null;
    this._voiceSrc = null;
    this.lib = { groans: [], ambient: null, stings: {}, vo: {} };
    // Manifest/voice-loading state, kept separate so a voice/tone switch can
    // re-decode just the narration set without re-fetching sfx or the manifest.
    this._manifest = null;
    this._base = 'audio/';
    this._sfxLoaded = false;
    this._voice = null;         // currently loaded voice id (v2 only)
    this._tone = null;          // currently loaded tone id (v2 only)
    this._voKey = null;         // cache key for the loaded narration set
    this._voSeq = 0;            // request counter, so stale loads can't win a race
    this._previewCache = new Map(); // voiceId -> decoded sample AudioBuffer
  }

  async unlock() {
    try {
      if (!this.ctx) {
        this.ctx = new (window.AudioContext || window.webkitAudioContext)();
        this.master = this.ctx.createGain();
        this.master.gain.value = 0.9;
        this.master.connect(this.ctx.destination);
        this.sfxBus = this.ctx.createGain();
        this.sfxBus.gain.value = 1;
        this.sfxBus.connect(this.master);
        this.voiceBus = this.ctx.createGain();
        this.voiceBus.gain.value = 1;
        this.voiceBus.connect(this.master);
      }
      await this.ctx.resume();
    } catch { this.ctx = null; }
  }

  // iOS suspends the audio session on a call/Siri/app-switch; without this the
  // heartbeat and groans would stay silent for the rest of the run.
  async resume() {
    try { if (this.ctx && this.ctx.state !== 'running') await this.ctx.resume(); } catch { /* ignore */ }
  }

  get ok() { return this.ctx && this.ctx.state === 'running'; }
  get hasGroans() { return this.lib.groans.length > 0; }

  // Voices/tones advertised by the last-loaded manifest, for the Loadout UI.
  // Empty lists (never throws) if no manifest or a v1 flat one is in play.
  get catalog() {
    const m = this._manifest;
    const voices = (m && Array.isArray(m.voices)) ? m.voices.map((v) => ({ id: v.id, label: v.label || v.id })) : [];
    const tones = (m && Array.isArray(m.tones)) ? m.tones.map((t) => ({ id: t.id, label: t.label || t.id })) : [];
    return { voices, tones };
  }

  async _decode(url, base = this._base) {
    try {
      const r = await fetch(base + url);
      if (!r.ok) return null;
      return await this.ctx.decodeAudioData(await r.arrayBuffer());
    } catch { return null; }
  }

  async _decodeList(arr, base = this._base) {
    return (await Promise.all((arr || []).map((u) => this._decode(u, base)))).filter(Boolean);
  }

  // Fetches (and caches) the manifest exactly once, however many times
  // loadLibrary/previewVoice ask for it. Never throws — a missing/broken
  // manifest just leaves everything in synth/TTS fallback.
  async _ensureManifest(base) {
    if (this._manifest) return this._manifest;
    try {
      // Revalidate the manifest every time: the clip files themselves are
      // immutable per path and stay cacheable, but a stale manifest silently
      // hides voices/lines that were added in a later release.
      const res = await fetch(base + 'manifest.json', { cache: 'no-cache' });
      if (res.ok) this._manifest = await res.json();
    } catch { /* stays null -> fallback mode */ }
    return this._manifest;
  }

  async _loadSfx(sfx) {
    const [groans, ambient] = await Promise.all([
      this._decodeList(sfx.groans),
      sfx.ambient ? this._decode(sfx.ambient) : null,
    ]);
    this.lib.groans = groans;
    this.lib.ambient = ambient;
    for (const k of ['spawn', 'ambush', 'escape', 'bitten', 'overrun']) {
      if (sfx[k]) { const b = await this._decode(sfx[k]); if (b) this.lib.stings[k] = b; }
    }
  }

  // Picks the clip set for a voice/tone request against either manifest shape.
  // Falls back requested -> first available at each level; if the v2 shape
  // turns out to be unusable it falls back to treating `vo` as v1-flat.
  // Returns { voiceId, toneId, clips } (voiceId/toneId are null for v1 flat).
  _resolveVoiceMap(manifest, wantVoice, wantTone) {
    const voRoot = manifest && manifest.vo;
    if (!voRoot || typeof voRoot !== 'object') return null;

    const isNested = manifest.version === 2 || (Array.isArray(manifest.voices) && manifest.voices.length > 0);
    if (isNested) {
      const voiceIds = Object.keys(voRoot);
      if (voiceIds.length) {
        const voiceId = (wantVoice && voRoot[wantVoice]) ? wantVoice : voiceIds[0];
        const toneMap = voRoot[voiceId];
        if (toneMap && typeof toneMap === 'object') {
          const toneIds = Object.keys(toneMap);
          if (toneIds.length) {
            const toneId = (wantTone && toneMap[wantTone]) ? wantTone : toneIds[0];
            const clips = toneMap[toneId];
            if (clips && typeof clips === 'object') return { voiceId, toneId, clips };
          }
        }
      }
      // Nested shape advertised but empty/malformed — fall through to flat.
    }
    return { voiceId: null, toneId: null, clips: voRoot };
  }

  // Decodes the narration set for `sel = {voice, tone}` and swaps it in,
  // releasing the previously loaded buffers. Skips the work entirely if the
  // resolved voice/tone is already the one loaded.
  async _loadVoiceSet(sel) {
    const resolved = this._manifest ? this._resolveVoiceMap(this._manifest, sel.voice, sel.tone) : null;
    if (!resolved) {
      this.lib.vo = {};
      this._voice = this._tone = this._voKey = null;
      return;
    }
    const key = resolved.voiceId ? `${resolved.voiceId}::${resolved.toneId}` : 'flat';
    if (key === this._voKey) return; // already the loaded set

    // Decoding ~17 clips takes a while, and a user auditioning voices can tap
    // several in a row. Stamp this request so a slower earlier load can't land
    // after a later one and silently leave the wrong voice playing.
    const token = ++this._voSeq;
    const nextVo = {};
    const clips = resolved.clips || {};
    for (const k of Object.keys(clips)) {
      const arr = clips[k];
      if (!Array.isArray(arr) || !arr.length) continue; // ignore malformed entries, never throw
      const bufs = await this._decodeList(arr);
      if (token !== this._voSeq) return;                // superseded — discard
      if (bufs.length) nextVo[k] = bufs;
    }
    if (token !== this._voSeq) return;
    this.lib.vo = nextVo;          // old buffers are dropped here (GC-eligible)
    this._voice = resolved.voiceId;
    this._tone = resolved.toneId;
    this._voKey = key;
  }

  /**
   * Fetch the clip manifest (once) and decode sfx (once), then load ONLY the
   * requested voice/tone narration set. Safe to call repeatedly — with a new
   * `sel` it swaps the narration set without re-touching sfx; with the same
   * `sel` it's a no-op. Never throws; anything missing just stays in
   * synth/TTS fallback mode.
   */
  async loadLibrary(base = 'audio/', sel = {}) {
    if (!this.ctx) return;
    this._base = base;
    const manifest = await this._ensureManifest(base);
    if (manifest && !this._sfxLoaded) {
      this._sfxLoaded = true;
      await this._loadSfx(manifest.sfx || {});
    }
    await this._loadVoiceSet(sel);
  }

  /* ---------------- per-tick proximity audio ---------------- */

  update(threat, gap, now) {
    if (!this.ok) return;

    // Horde ambience bed (realistic only): fades in with proximity.
    this._updateAmbient(gap != null ? threat : 0);

    // Heartbeat — synth is fine here; it's a subtle low thud, not "gamey".
    if (threat > 0.12 && now >= this.nextHeart) {
      const interval = 1.25 - 0.85 * threat;      // ~48 → ~130 bpm
      const v = 0.22 + 0.5 * threat;
      this._thump(v);
      clearTimeout(this._heartTimer);
      this._heartTimer = setTimeout(() => this._thump(v * 0.75), interval * 260);  // the "dub"
      this.nextHeart = now + interval;
    }

    // Groans — real clips if we have them, else synth.
    if (gap != null && gap < 90 && now >= this.nextGroan) {
      const intensity = Math.min(1, (95 - gap) / 85);
      if (this.hasGroans) this._playGroan(intensity); else this._groan(intensity);
      this.nextGroan = now + rand(2.5, 6) / (0.5 + threat);
    }
  }

  _updateAmbient(level) {
    if (!this.lib.ambient) return;
    const t = this.ctx.currentTime;
    if (!this._ambientSrc) {
      this._ambientSrc = this.ctx.createBufferSource();
      this._ambientSrc.buffer = this.lib.ambient;
      this._ambientSrc.loop = true;
      this._ambientGain = this.ctx.createGain();
      this._ambientGain.gain.value = 0;
      this._ambientSrc.connect(this._ambientGain).connect(this.sfxBus);
      this._ambientSrc.start();
    }
    const target = level > 0 ? 0.1 + 0.45 * level : 0;
    this._ambientGain.gain.setTargetAtTime(target, t, 0.8);
  }

  /* ---------------- realistic sample playback ---------------- */

  _playGroan(intensity) {
    const t = this.ctx.currentTime;
    const buf = this.lib.groans[(Math.random() * this.lib.groans.length) | 0];
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = rand(0.68, 0.82);    // pitch a human groan down into "zombie"
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 700 + 900 * intensity;   // muffled when far, clearer when close
    const pan = this.ctx.createStereoPanner ? this.ctx.createStereoPanner() : null;
    if (pan) pan.pan.value = rand(-0.7, 0.7);      // scattered around her
    const g = this.ctx.createGain();
    g.gain.value = 0.25 + 0.6 * intensity;
    src.connect(lp);
    (pan ? lp.connect(pan).connect(g) : lp.connect(g)).connect(this.sfxBus);
    src.start(t);
  }

  /** Play a narration clip for `key` if one exists; return false to fall back to TTS. */
  sayClip(key) {
    if (!this.ok) return false;
    const variants = this.lib.vo[key];
    if (!variants || !variants.length) return false;
    const buf = variants[(Math.random() * variants.length) | 0];
    try { this._voiceSrc && this._voiceSrc.stop(); } catch { /* already ended */ }
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.connect(this.voiceBus);
    this._duck(buf.duration);
    src.start();
    this._voiceSrc = src;
    return true;
  }

  /**
   * Fetch+decode a voice's small 'sample' clip and play it immediately, so
   * the user can audition it on the Loadout screen. Decoded samples are
   * cached (by voiceId) so repeat taps are instant. Returns false if the
   * voice/sample can't be found — never throws.
   */
  async previewVoice(voiceId, base = 'audio/') {
    if (!this.ok) return false;
    try {
      let buf = this._previewCache.get(voiceId);
      if (!buf) {
        const manifest = await this._ensureManifest(base);
        const voices = (manifest && manifest.voices) || [];
        const v = voices.find((x) => x.id === voiceId);
        if (!v || !v.sample) return false;
        buf = await this._decode(v.sample, base);
        if (!buf) return false;
        this._previewCache.set(voiceId, buf);
      }
      try { this._voiceSrc && this._voiceSrc.stop(); } catch { /* already ended */ }
      const src = this.ctx.createBufferSource();
      src.buffer = buf;
      src.connect(this.voiceBus);
      this._duck(buf.duration);        // same ducking as normal narration
      src.start();
      this._voiceSrc = src;
      return true;
    } catch { return false; }
  }

  // Pull the SFX bed down while narration plays, then bring it back.
  _duck(seconds) {
    if (!this.sfxBus) return;
    const t = this.ctx.currentTime;
    const g = this.sfxBus.gain;
    g.cancelScheduledValues(t);
    g.setTargetAtTime(0.32, t, 0.08);
    g.setTargetAtTime(1, t + Math.max(0.4, seconds) + 0.15, 0.25);
  }

  /* ---------------- synth fallbacks ---------------- */

  _thump(vol) {
    if (!this.ok) return;
    const t = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(58, t);
    osc.frequency.exponentialRampToValueAtTime(40, t + 0.1);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.16);
    osc.connect(g).connect(this.sfxBus);
    osc.start(t); osc.stop(t + 0.2);
  }

  _groan(intensity) {
    if (!this.ok) return;
    const t = this.ctx.currentTime;
    const dur = rand(1.1, 2.0);
    const osc = this.ctx.createOscillator();
    const osc2 = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    const lp = this.ctx.createBiquadFilter();
    const trem = this.ctx.createOscillator();
    const tremGain = this.ctx.createGain();

    osc.type = 'sawtooth';
    osc2.type = 'sawtooth';
    const f0 = rand(65, 110);
    osc.frequency.setValueAtTime(f0, t);
    osc.frequency.exponentialRampToValueAtTime(f0 * rand(0.55, 0.75), t + dur);
    osc2.frequency.setValueAtTime(f0 * 1.017, t);
    osc2.frequency.exponentialRampToValueAtTime(f0 * 0.68, t + dur);

    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(rand(280, 500), t);
    lp.Q.value = 3;

    trem.type = 'sine';
    trem.frequency.value = rand(5, 9);
    tremGain.gain.value = 0.35;
    trem.connect(tremGain).connect(g.gain);

    const vol = 0.08 + 0.3 * intensity;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + dur * 0.3);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);

    osc.connect(lp); osc2.connect(lp);
    lp.connect(g).connect(this.sfxBus);
    osc.start(t); osc2.start(t); trem.start(t);
    osc.stop(t + dur + 0.1); osc2.stop(t + dur + 0.1); trem.stop(t + dur + 0.1);
  }

  _noiseHit(vol, dur, cutoff) {
    const t = this.ctx.currentTime;
    const src = this.ctx.createBufferSource();
    const buf = this.ctx.createBuffer(1, this.ctx.sampleRate * dur, this.ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / data.length);
    src.buffer = buf;
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = cutoff;
    const g = this.ctx.createGain(); g.gain.value = vol;
    src.connect(lp).connect(g).connect(this.sfxBus);
    src.start(t);
  }

  _sub(fromHz, toHz, dur, vol) {
    const t = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(fromHz, t);
    osc.frequency.exponentialRampToValueAtTime(toHz, t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.03);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(g).connect(this.sfxBus);
    osc.start(t); osc.stop(t + dur + 0.05);
  }

  /* ---------------- event stings ---------------- */

  sting(kind) {
    if (!this.ok) return;
    const clip = this.lib.stings[kind];
    if (clip) {
      const src = this.ctx.createBufferSource();
      src.buffer = clip;
      src.connect(this.sfxBus);
      src.start();
      return;
    }
    // De-gamified synth cues — organic hits/swells, no melodic jingles.
    if (kind === 'spawn')        this._sub(70, 44, 0.7, 0.22);
    else if (kind === 'ambush') { this._noiseHit(0.4, 0.35, 2400); this._sub(150, 60, 0.5, 0.28); }
    else if (kind === 'escape')  this._sub(120, 190, 0.6, 0.14);   // gentle upward relief
    else if (kind === 'bitten') { this._noiseHit(0.5, 0.4, 1800); this._sub(110, 55, 0.5, 0.3); }
    else if (kind === 'overrun') this._sub(120, 40, 1.2, 0.3);
  }

  // Ends a run's sound but keeps the context + decoded clips alive so the next
  // run doesn't pay to re-decode the whole library.
  stop() {
    clearTimeout(this._heartTimer);
    this._heartTimer = null;
    try { this._ambientSrc && this._ambientSrc.stop(); } catch { /* fine */ }
    try { this._voiceSrc && this._voiceSrc.stop(); } catch { /* already ended */ }
    this._ambientSrc = this._ambientGain = this._voiceSrc = null;
    if (this.sfxBus) this.sfxBus.gain.cancelScheduledValues(this.ctx.currentTime), (this.sfxBus.gain.value = 1);
  }
}
