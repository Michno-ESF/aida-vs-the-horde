const rand = (a, b) => a + Math.random() * (b - a);

/**
 * All sound is synthesized with the Web Audio API — no audio files to host.
 * Heartbeat tempo/volume and zombie groans scale with how close the horde is.
 * Must be unlocked from a user gesture (iOS requirement): call unlock() in
 * the Start button handler.
 */
export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.nextHeart = 0;
    this.nextGroan = 0;
    this._heartTimer = null;
  }

  async unlock() {
    try {
      if (!this.ctx) {
        this.ctx = new (window.AudioContext || window.webkitAudioContext)();
        this.master = this.ctx.createGain();
        this.master.gain.value = 0.9;
        this.master.connect(this.ctx.destination);
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

  /** Called once per game tick with current threat (0..1) and gap in meters. */
  update(threat, gap, now) {
    if (!this.ok) return;
    if (threat > 0.12 && now >= this.nextHeart) {
      const interval = 1.25 - 0.85 * threat;      // 48 → 130 bpm-ish
      const v = 0.22 + 0.5 * threat;
      this._thump(v);
      clearTimeout(this._heartTimer);
      this._heartTimer = setTimeout(() => this._thump(v * 0.75), interval * 260);
      this.nextHeart = now + interval;
    }
    if (gap != null && gap < 90 && now >= this.nextGroan) {
      this._groan(Math.min(1, (95 - gap) / 85));
      this.nextGroan = now + rand(2.5, 6) / (0.5 + threat);
    }
  }

  _thump(vol) {
    if (!this.ok) return;                         // context may have closed since scheduling
    const t = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(58, t);
    osc.frequency.exponentialRampToValueAtTime(40, t + 0.1);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.16);
    osc.connect(g).connect(this.master);
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
    osc.frequency.exponentialRampToValueAtTime(f0 * rand(0.55, 0.75), t + dur); // pitch droops
    osc2.frequency.setValueAtTime(f0 * 1.017, t);                              // beating detune
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
    lp.connect(g).connect(this.master);
    osc.start(t); osc2.start(t); trem.start(t);
    osc.stop(t + dur + 0.1); osc2.stop(t + dur + 0.1); trem.stop(t + dur + 0.1);
  }

  _tone(freq, when, dur, vol, type = 'square') {
    const t = this.ctx.currentTime + when;
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.type = type;
    osc.frequency.value = freq;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(g).connect(this.master);
    osc.start(t); osc.stop(t + dur + 0.05);
  }

  sting(kind) {
    if (!this.ok) return;
    if (kind === 'spawn') {
      this._tone(98, 0, 0.7, 0.25, 'sawtooth');
      this._tone(104, 0.05, 0.7, 0.2, 'sawtooth');
    } else if (kind === 'ambush') {
      [0, 0.14, 0.28].forEach((w, i) => this._tone(330 - i * 40, w, 0.12, 0.3));
    } else if (kind === 'escape') {
      [262, 330, 392, 523].forEach((f, i) => this._tone(f, i * 0.09, 0.16, 0.22, 'triangle'));
    } else if (kind === 'bitten') {
      const t = this.ctx.currentTime;
      const noise = this.ctx.createBufferSource();
      const buf = this.ctx.createBuffer(1, this.ctx.sampleRate * 0.4, this.ctx.sampleRate);
      const data = buf.getChannelData(0);
      for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / data.length);
      noise.buffer = buf;
      const g = this.ctx.createGain();
      g.gain.value = 0.5;
      noise.connect(g).connect(this.master);
      noise.start(t);
      this._tone(196, 0, 0.5, 0.3, 'sawtooth');
      this._tone(92, 0.15, 0.6, 0.3, 'sawtooth');
    } else if (kind === 'overrun') {
      [220, 174, 146, 110].forEach((f, i) => this._tone(f, i * 0.25, 0.4, 0.28, 'sawtooth'));
    }
  }

  stop() {
    clearTimeout(this._heartTimer);
    this._heartTimer = null;
    try { this.ctx && this.ctx.close(); } catch { /* already closed */ }
    this.ctx = null;
  }
}
