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

const rand = (a, b) => a + Math.random() * (b - a);

/**
 * The chase happens on a 1-D track: the horde is always "behind you on
 * your path", so only the gap in meters matters. Horde speed is fixed at
 * spawn time relative to the runner's recent pace — slow down and the gap
 * shrinks, speed up and it grows. Hordes have stamina and eventually give
 * up, which turns every chase into a natural running interval.
 *
 * `overrides` lets the sim harness inject candidate tuning without editing
 * this file; in the app it's always omitted.
 */
export class Game {
  constructor(diffKey, emit, overrides) {
    this.diff = Object.assign({}, DIFF[diffKey] || DIFF.normal, overrides);
    this.emit = emit || (() => {});
    this.elapsed = 0;
    this.dist = 0;
    this.speed = 0;
    this.hearts = 3;
    this.points = [];
    this.window = [];
    this.horde = null;
    this.nextSpawn = this.diff.first;
    this.lastKm = 0;
    this.over = false;
    this.lastFix = null;
    this.lastFixElapsed = null;                   // game-time of the most recent GPS fix
    this.stats = { escapes: 0, escapesOutran: 0, escapesTired: 0, bites: 0, closeCalls: [] };
  }

  addFix(f) {
    if (f.acc > 40) return;                       // poor GPS fix
    if (this.lastFix) {
      const d = haversine(this.lastFix, f);
      const dt = (f.t - this.lastFix.t) / 1000;
      if (dt <= 0) return;
      if (d / dt > 9) return;                     // teleport = GPS glitch
      this.dist += d;
    }
    this.lastFix = f;
    this.lastFixElapsed = this.elapsed;
    this.points.push({ lat: f.lat, lng: f.lng, t: f.t, d: this.dist });
    this.window.push({ t: f.t, d: this.dist });
    const cut = f.t - 20000;
    while (this.window.length > 2 && this.window[0].t < cut) this.window.shift();
    const w = this.window;
    const span = (w[w.length - 1].t - w[0].t) / 1000;
    this.speed = span >= 5
      ? (w[w.length - 1].d - w[0].d) / span
      : (f.spd > 0 ? f.spd : 0);
  }

  dropBaseline() { this.lastFix = null; this.lastFixElapsed = null; this.window = []; }   // after a pause

  tick(dt, hidden) {
    this.elapsed += dt;
    if (hidden) return;                           // sim freezes while app is hidden
    // Freeze the chase until the first GPS fix, and during any dropout — otherwise
    // the horde would advance on a stale/zero speed and resolve chases on frozen data.
    if (this.lastFixElapsed === null || this.elapsed - this.lastFixElapsed > GPS_STALE) return;

    const km = Math.floor(this.dist / 1000);
    if (km > this.lastKm) { this.lastKm = km; this.emit('km', { km }); }

    if (this.horde) {
      const h = this.horde;
      h.gap += (this.speed - h.speed) * dt;
      h.stamina -= dt;
      h.minGap = Math.min(h.minGap, h.gap);

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
      this._spawn();
    }
  }

  _spawn() {
    const canAmbush = this.stats.escapes + this.stats.bites > 0;
    const isAmbush = canAmbush && Math.random() < this.diff.ambush;
    const runAvg = this.elapsed > 30 ? this.dist / this.elapsed : 0;
    const ref = Math.max(this.speed, runAvg, MIN_HORDE_SPEED);
    const p = isAmbush
      ? AMBUSH
      : { startGap: this.diff.startGap, factor: this.diff.factor, stamina: this.diff.stamina };

    const gap = rand(...p.startGap);
    this.horde = {
      kind: isAmbush ? 'ambush' : 'horde',
      gap,
      speed: ref * rand(...p.factor),
      stamina: rand(...p.stamina),
      escapeAt: Math.max(ABS_ESCAPE, gap + MIN_REL),
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

  _schedule(extra = 0) { this.nextSpawn = this.elapsed + extra + rand(...this.diff.every); }

  get threat() {
    return this.horde ? Math.max(0, Math.min(1, 1 - this.horde.gap / 150)) : 0;
  }
}
