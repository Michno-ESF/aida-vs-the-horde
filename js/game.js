import { haversine } from './gps.js';

// Chase tuning. Gaps are meters; `factor` multiplies the runner's pace at
// spawn to set the horde's fixed speed; `escapeRel` is how much further than
// the spawn gap you must open up to shake them. Values chosen with the
// simulation harness in tools/ so that a steady jog gets caught (forcing a
// sprint) while a real surge reliably escapes, and hordes tire as a mercy.
const DIFF = {
  casual: { first: 55, every: [140, 230], startGap: [55, 90], factor: [1.03, 1.13], stamina: [40, 62],  ambush: 0.12 },
  normal: { first: 55, every: [105, 185], startGap: [45, 80], factor: [1.08, 1.18], stamina: [72, 110], ambush: 0.28 },
  hard:   { first: 45, every: [85, 155],  startGap: [35, 70], factor: [1.18, 1.33], stamina: [78, 125], ambush: 0.45 },
};
const AMBUSH = { startGap: [22, 42], factor: [1.16, 1.30], stamina: [24, 40] };

const CLOSE_GAP = 15;       // logged as a "close call"
const ABS_ESCAPE = 88;      // you've "lost them" once they're this far back (≈ out of earshot)
const MIN_REL = 15;         // ...but always at least this much further than the spawn gap
const MIN_HORDE_SPEED = 1.6;
const GPS_STALE = 6;        // seconds without a fix before we freeze the chase (GPS dropout)
const FLARE_GAP = 12;       // horde must be this close before a flare is "needed" (and works)
const MIN_GAP_SECONDS = 25; // no gear may pack hordes closer together than this

// Neutral gear modifiers — used whenever the caller omits opts.modifiers so
// the game plays exactly as it did before gear existed. Keys match the
// Modifiers contract in progression.js verbatim.
const NEUTRAL_MODS = {
  spawnGapMul: 1, spawnIntervalMul: 1, escapeBonus: 0,
  ambushMul: 1, staminaMul: 1, armorCharges: 0,
  flare: false, bait: false, salvageMul: 1,
};

const rand = (a, b) => a + Math.random() * (b - a);
const clamp01x = (v, max) => Math.max(0, Math.min(max, v));

/**
 * The chase happens on a 1-D track: the horde is always "behind you on
 * your path", so only the gap in meters matters. Horde speed is fixed at
 * spawn time relative to the runner's recent pace — slow down and the gap
 * shrinks, speed up and it grows. Hordes have stamina and eventually give
 * up, which turns every chase into a natural running interval.
 *
 * `opts.overrides` lets the sim harness inject candidate tuning without
 * editing this file; in the app it's always omitted. `opts.modifiers` is
 * the equipped-gear Modifiers object from progression.js; absent means
 * everything plays at neutral (no gear effect).
 */
export class Game {
  constructor(diffKey, emit, opts = {}) {
    const { overrides, modifiers } = opts;
    this.diff = Object.assign({}, DIFF[diffKey] || DIFF.normal, overrides);
    this.mods = Object.assign({}, NEUTRAL_MODS, modifiers);
    this.emit = emit || (() => {});
    this.elapsed = 0;
    this.dist = 0;
    this.speed = 0;                                // responsive — drives chase maths
    this.displaySpeed = 0;                          // smoothed — for HUD/report only
    this.hearts = 3;
    this.points = [];
    this.window = [];
    this.horde = null;
    this.nextSpawn = Math.max(MIN_GAP_SECONDS, this.diff.first * this.mods.spawnIntervalMul);
    this.lastKm = 0;
    this.over = false;
    this.lastFix = null;
    this.lastFixElapsed = null;                   // game-time of the most recent GPS fix
    this.armor = this.mods.armorCharges;           // remaining bite-absorbs this run
    this.flareReady = this.mods.flare;             // once-per-run "get out of jail" card
    this.baitPending = this.mods.bait;             // skips the first horde of the run, once
    this.stats = { escapes: 0, escapesOutran: 0, escapesTired: 0, bites: 0, closeCalls: [] };
  }

  addFix(f) {
    if (f.acc > 25) return;                       // poor GPS fix (tightened from 40m)
    let moved = true;
    if (this.lastFix) {
      const d = haversine(this.lastFix, f);
      const dt = (f.t - this.lastFix.t) / 1000;
      if (dt <= 0) return;
      if (d / dt > 9) return;                     // teleport = GPS glitch

      // --- GPS deadband (anchor model) --------------------------------
      // Consumer GPS random-walks several metres while you stand dead
      // still. Naively summing every fix-to-fix delta turns that wander
      // into real "distance" — the jumpy km/pace bug. A random walk's
      // summed |steps| grows with time while its NET displacement barely
      // does, so we treat `lastFix` as an ANCHOR: it only moves once a fix
      // lands convincingly far from it. Real running crosses that
      // threshold every few seconds (distance still accrues, just in
      // chunks); jitter almost never does. The phone's own speed reading
      // is the best "am I actually moving" signal there is, so when it
      // says stationary we widen the threshold a lot.
      const still = f.spd != null && f.spd >= 0 && f.spd < 0.6;
      const deadband = Math.max(4, f.acc * (still ? 2.5 : 1.2));
      if (d < deadband) moved = false;            // jitter — anchor stays put
      else this.dist += d;
    }
    if (moved) {
      this.lastFix = f;
      this.points.push({ lat: f.lat, lng: f.lng, t: f.t, d: this.dist });
    }
    this.lastFixElapsed = this.elapsed;           // a fix arrived: not a dropout

    // The speed window advances on EVERY good fix, moved or not. If it only
    // advanced on movement, standing still would freeze a stale high speed and
    // the horde would never close in — the pause at a crossing has to count.
    this.window.push({ t: f.t, d: this.dist });
    const cut = f.t - 20000;
    while (this.window.length > 2 && this.window[0].t < cut) this.window.shift();
    const w = this.window;
    const span = (w[w.length - 1].t - w[0].t) / 1000;
    this.speed = span >= 5
      ? (w[w.length - 1].d - w[0].d) / span
      : (f.spd > 0 ? f.spd : 0);
    // Smoothed for display only — chase maths reads this.speed directly so
    // it keeps reacting immediately to surges/slowdowns.
    this.displaySpeed += 0.25 * (this.speed - this.displaySpeed);
  }

  dropBaseline() { this.lastFix = null; this.lastFixElapsed = null; this.window = []; }   // after a pause

  // `dt` drives the chase and is clamped by the caller; `wallDt` is the real
  // elapsed wall-clock time (they differ after the app was suspended). The run
  // clock must use real time or the reported duration/pace under-counts.
  tick(dt, hidden, wallDt = dt) {
    this.elapsed += wallDt;
    if (hidden) return;                           // sim freezes while app is hidden
    // Freeze the chase until the first GPS fix, and during any dropout — otherwise
    // the horde would advance on a stale/zero speed and resolve chases on frozen data.
    if (this.lastFixElapsed === null || this.elapsed - this.lastFixElapsed > GPS_STALE) return;

    // Milestone check: after a screen-off gap, several km can pass between
    // ticks (tick() no-ops while hidden, but addFix() keeps accumulating
    // dist in the background). Jump straight to the km actually reached
    // and fire a single event rather than looping — so a gap never causes
    // a silent skip, and (since we only fire on strictly-greater) the same
    // km is never announced twice.
    const km = Math.floor(this.dist / 1000);
    if (km > this.lastKm) { this.lastKm = km; this.emit('km', { km }); }

    if (this.horde) {
      const h = this.horde;
      h.gap += (this.speed - h.speed) * dt;
      h.stamina -= dt;
      h.minGap = Math.min(h.minGap, h.gap);

      if (this.flareReady && h.gap < FLARE_GAP) {   // flare: scare off a horde that's right on you
        this.flareReady = false;
        this.emit('flare', {});
        this._escape('flare');
        return;
      }
      if (h.gap <= 0) { this._bite(); return; }
      if (h.gap >= h.escapeAt) { this._escape('outran'); return; }
      if (h.stamina <= 0) { this._escape('tired'); return; }

      if (h.gap < CLOSE_GAP && !h.closeLogged) {
        h.closeLogged = true;
        this.stats.closeCalls.push({ gap: Math.max(1, Math.round(h.gap)), idx: this.points.length - 1 });
        this.emit('close', { gap: Math.round(h.gap) });
      }
      if (h.pending.length && h.gap <= h.pending[0]) {
        this.emit('gap', { th: h.pending.shift(), gap: Math.round(h.gap) });
      }
    } else if (!this.over && this.elapsed >= this.nextSpawn) {
      if (this.baitPending) {                       // bait: the first horde of the run walks past
        this.baitPending = false;
        this.emit('bait', {});
        this._schedule();
      } else {
        this._spawn();
      }
    }
  }

  _spawn() {
    const canAmbush = this.stats.escapes + this.stats.bites > 0;
    const ambushChance = clamp01x(this.diff.ambush * this.mods.ambushMul, 0.9);
    const isAmbush = canAmbush && Math.random() < ambushChance;
    const runAvg = this.elapsed > 30 ? this.dist / this.elapsed : 0;
    const ref = Math.max(this.speed, runAvg, MIN_HORDE_SPEED);
    const p = isAmbush
      ? AMBUSH
      : { startGap: this.diff.startGap, factor: this.diff.factor, stamina: this.diff.stamina };

    const gap = rand(...p.startGap) * this.mods.spawnGapMul;
    // escapeBonus shortens the distance needed to shake them, but never past
    // gap+10 — otherwise a big bonus could make a horde escapable on spawn.
    const escapeAt = Math.max(
      gap + 10,
      Math.max(ABS_ESCAPE, gap + MIN_REL) - this.mods.escapeBonus
    );
    this.horde = {
      kind: isAmbush ? 'ambush' : 'horde',
      gap,
      speed: ref * rand(...p.factor),
      stamina: rand(...p.stamina) * this.mods.staminaMul,
      escapeAt,
      minGap: Infinity,
      closeLogged: false,
      pending: [90, 60, 30].filter(th => th < gap),
    };
    this.emit(isAmbush ? 'ambush' : 'spawn', { gap: Math.round(gap) });
  }

  _escape(how) {
    this.stats.escapes++;
    if (how === 'tired') this.stats.escapesTired++; else this.stats.escapesOutran++;
    this.horde = null;
    this._schedule();
    this.emit('escape', { how });
  }

  _bite() {
    if (this.armor > 0) {                           // armor: absorb the catch, no heart lost
      this.armor--;
      this.horde = null;
      this._schedule(45);                           // same grace period as a real bite
      this.emit('armorSave', { left: this.armor });
      return;
    }
    this.stats.bites++;
    this.hearts--;
    this.stats.closeCalls.push({ gap: 0, idx: this.points.length - 1, bite: true });
    this.horde = null;
    if (this.hearts <= 0) {
      this.over = true;
      this.emit('overrun', {});
    } else {
      this._schedule(45);                         // grace period after a bite
      this.emit('bitten', { hearts: this.hearts });
    }
  }

  _schedule(extra = 0) {
    // Floor the interval so no combination of gear can collapse it into a
    // continuous stream of hordes with no breathing room.
    const wait = Math.max(MIN_GAP_SECONDS, rand(...this.diff.every) * this.mods.spawnIntervalMul);
    this.nextSpawn = this.elapsed + extra + wait;
  }

  get threat() {
    return this.horde ? Math.max(0, Math.min(1, 1 - this.horde.gap / 150)) : 0;
  }
}
