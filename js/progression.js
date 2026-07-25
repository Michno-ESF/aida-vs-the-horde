// Meta-progression: salvage economy, gear, and rank track that carries over
// between runs. Everything here is pure/defensive on purpose — the UI layer
// (loadout screen, report screen) reads and mutates the profile object but
// none of this module ever touches the DOM.

const P_KEY = 'azs-profile';

function read(key) {
  try { return JSON.parse(localStorage.getItem(key)); } catch { return null; }
}
function write(key, val) {
  try { localStorage.setItem(key, JSON.stringify(val)); } catch { /* private mode */ }
}

// Ranks gate the pricier gear and give the km counter somewhere to point.
// First entry MUST be km:0 so every profile starts ranked.
export const RANKS = [
  { id: 'fresh',     label: 'Fresh Meat', km: 0 },
  { id: 'scavenger', label: 'Scavenger',  km: 10 },
  { id: 'courier',   label: 'Courier',    km: 25 },
  { id: 'runner',    label: 'Runner',     km: 50 },
  { id: 'legend',    label: 'Legend',     km: 100 },
];

// Every slot needs exactly one cost:0/rank:0 item — the implicit default
// that's always owned and equippable, corrupted-save or not.
export const GEAR = {
  boots: [
    { id: 'boots-trainers', slot: 'boots', label: 'Worn Trainers', emoji: '👟', cost: 0, rank: 0,
      desc: 'Free, holey, and somehow still holding together.', mods: {} },
    { id: 'boots-road', slot: 'boots', label: 'Road Runners', emoji: '👟', cost: 50, rank: 1,
      desc: 'Actual tread for once. Worth eight extra meters when the gap really matters.',
      mods: { escapeBonus: 8 } },
    { id: 'boots-carbon', slot: 'boots', label: 'Carbon Racers', emoji: '🏃', cost: 140, rank: 3,
      desc: 'Obscenely expensive plates that make outrunning the dead look easy.',
      mods: { escapeBonus: 15, salvageMul: 1.05 } },
  ],
  armor: [
    { id: 'armor-hoodie', slot: 'armor', label: 'Hoodie', emoji: '🧥', cost: 0, rank: 0,
      desc: 'Free. Stops the wind, not the teeth.', mods: {} },
    { id: 'armor-jacket', slot: 'armor', label: 'Padded Jacket', emoji: '🧥', cost: 60, rank: 1,
      desc: 'Soaks one bite before it reaches skin, and hordes hang back a little further.',
      mods: { armorCharges: 1, spawnGapMul: 0.9 } },
    { id: 'armor-vest', slot: 'armor', label: 'Riot Vest', emoji: '🦺', cost: 150, rank: 2,
      desc: 'Two free bites and a healthy respect from every horde. Heavy, but you\'ll live.',
      mods: { armorCharges: 2, spawnGapMul: 0.8, salvageMul: 0.9 } },
  ],
  tool: [
    { id: 'tool-none', slot: 'tool', label: 'None', emoji: '🚫', cost: 0, rank: 0,
      desc: 'Pockets empty. Bold strategy.', mods: {} },
    { id: 'tool-flare', slot: 'tool', label: 'Flare', emoji: '🧨', cost: 45, rank: 1,
      desc: 'One shot per run. Pop it when they\'re close and watch the whole horde lose interest.',
      mods: { flare: true } },
    { id: 'tool-bait', slot: 'tool', label: 'Bait', emoji: '🥩', cost: 55, rank: 1,
      desc: 'Toss it behind you — the first horde of the run takes the bait instead of you.',
      mods: { bait: true } },
    { id: 'tool-smoke', slot: 'tool', label: 'Smoke Bomb', emoji: '💨', cost: 70, rank: 2,
      desc: 'Cuts a quarter off every horde\'s stamina meter. They tire, you don\'t.',
      mods: { staminaMul: 0.75 } },
  ],
  cargo: [
    { id: 'cargo-empty', slot: 'cargo', label: 'Empty Pack', emoji: '🎒', cost: 0, rank: 0,
      desc: 'Nothing to loot, nothing to lose. Free.', mods: {} },
    { id: 'cargo-cans', slot: 'cargo', label: 'Noisy Cans', emoji: '🥫', cost: 40, rank: 1,
      desc: 'Rattles with every step. Hordes show up more often — but so does the salvage.',
      mods: { spawnIntervalMul: 0.75, salvageMul: 1.4 } },
    { id: 'cargo-loot', slot: 'cargo', label: 'Blood-soaked Loot', emoji: '💰', cost: 90, rank: 2,
      desc: 'Somebody else\'s stash, still warm. Ambushes love it, and so will your salvage count.',
      mods: { spawnIntervalMul: 0.6, ambushMul: 1.5, salvageMul: 1.8 } },
    { id: 'cargo-radio', slot: 'cargo', label: 'Radio Beacon', emoji: '📡', cost: 180, rank: 4,
      desc: 'Screams "EAT ME" to every ambush for miles. Absurd risk. Absurd payout.',
      mods: { ambushMul: 2.0, spawnIntervalMul: 0.7, salvageMul: 2.2 } },
  ],
};

const SLOTS = ['boots', 'armor', 'tool', 'cargo'];
const ALL_ITEMS = SLOTS.flatMap(slot => GEAR[slot]);
const DEFAULTS = Object.fromEntries(
  SLOTS.map(slot => [slot, (GEAR[slot].find(i => i.cost === 0) || GEAR[slot][0]).id])
);

function getItem(id) {
  return ALL_ITEMS.find(i => i.id === id) || null;
}

const NEUTRAL_MODS = {
  spawnGapMul: 1, spawnIntervalMul: 1, escapeBonus: 0, ambushMul: 1,
  staminaMul: 1, armorCharges: 0, flare: false, bait: false, salvageMul: 1,
};

function defaultEquipped() {
  return { boots: DEFAULTS.boots, armor: DEFAULTS.armor, tool: DEFAULTS.tool, cargo: DEFAULTS.cargo };
}

function defaultProfile() {
  return {
    salvage: 0,
    owned: Object.values(DEFAULTS),
    equipped: defaultEquipped(),
    totalKm: 0,
    runs: 0,
    bestKm: 0,
    rankIdx: 0,
  };
}

const num = (v, fallback = 0) => (Number.isFinite(v) ? v : fallback);

// Defensive merge: a corrupted/partial save must never crash the app or
// leave a slot pointing at an item the player doesn't own / no longer exists.
function sanitize(raw) {
  const p = defaultProfile();
  if (!raw || typeof raw !== 'object') return p;

  p.salvage = Math.max(0, num(raw.salvage));
  p.totalKm = Math.max(0, num(raw.totalKm));
  p.runs = Math.max(0, Math.floor(num(raw.runs)));
  p.bestKm = Math.max(0, num(raw.bestKm));

  const ownedSet = new Set(Object.values(DEFAULTS));
  if (Array.isArray(raw.owned)) {
    for (const id of raw.owned) if (getItem(id)) ownedSet.add(id);
  }
  p.owned = [...ownedSet];

  const eq = defaultEquipped();
  if (raw.equipped && typeof raw.equipped === 'object') {
    for (const slot of SLOTS) {
      const id = raw.equipped[slot];
      const item = id && getItem(id);
      if (item && item.slot === slot && ownedSet.has(id)) eq[slot] = id;
    }
  }
  p.equipped = eq;
  p.rankIdx = rankFor(p.totalKm).idx;
  return p;
}

export function loadProfile() {
  return sanitize(read(P_KEY));
}

export function saveProfile(p) {
  write(P_KEY, p);
}

export function rankFor(totalKm) {
  const km = num(totalKm);
  let idx = 0;
  for (let i = 0; i < RANKS.length; i++) if (km >= RANKS[i].km) idx = i;
  return { idx, ...RANKS[idx] };
}

export function nextRank(totalKm) {
  const { idx } = rankFor(totalKm);
  if (idx >= RANKS.length - 1) return null;
  const nxt = RANKS[idx + 1];
  return { idx: idx + 1, ...nxt, remainingKm: Math.max(0, nxt.km - num(totalKm)) };
}

// Aggregates every equipped item's mods into one Modifiers object. Multipliers
// stack multiplicatively, flat bonuses/charges add, flags OR together.
// ambushMul is intentionally left unclamped here — game.js clamps the final
// probability, not this raw factor, so stacking cargo items reads honestly.
export function modifiersFor(profile) {
  const mods = { ...NEUTRAL_MODS };
  const equipped = (profile && profile.equipped) || {};
  for (const slot of SLOTS) {
    const id = equipped[slot] || DEFAULTS[slot];
    const item = getItem(id) || getItem(DEFAULTS[slot]);
    const m = (item && item.mods) || {};
    if (m.spawnGapMul != null) mods.spawnGapMul *= m.spawnGapMul;
    if (m.spawnIntervalMul != null) mods.spawnIntervalMul *= m.spawnIntervalMul;
    if (m.escapeBonus != null) mods.escapeBonus += m.escapeBonus;
    if (m.ambushMul != null) mods.ambushMul *= m.ambushMul;
    if (m.staminaMul != null) mods.staminaMul *= m.staminaMul;
    if (m.armorCharges != null) mods.armorCharges += m.armorCharges;
    if (m.flare) mods.flare = true;
    if (m.bait) mods.bait = true;
    if (m.salvageMul != null) mods.salvageMul *= m.salvageMul;
  }
  return mods;
}

// Pure salvage calculation for the report screen. `summary` is whatever
// report.buildSummary() produces; we only read from it, never mutate it.
export function salvageFor(summary, mods = {}) {
  const salvageMul = num(mods.salvageMul, 1);
  const dist = Math.max(0, num(summary && summary.dist));
  const escapes = Math.max(0, Math.floor(num(summary && summary.escapes)));
  const bites = Math.max(0, Math.floor(num(summary && summary.bites)));
  const closeCalls = Array.isArray(summary && summary.marks)
    ? summary.marks.filter(m => !m.bite).length
    : Math.max(0, Math.floor(num(summary && summary.closeCalls)));

  const km = dist / 1000;
  const distAmt = Math.round(km * 10);
  const escAmt = escapes * 5;
  const closeAmt = closeCalls * 3;
  const biteAmt = bites * 8;

  const lines = [];
  if (distAmt) lines.push({ label: `${km.toFixed(2)} km covered`, amount: distAmt });
  if (escAmt) lines.push({ label: `${escapes} horde${escapes === 1 ? '' : 's'} escaped`, amount: escAmt });
  if (closeAmt) lines.push({ label: `${closeCalls} close call${closeCalls === 1 ? '' : 's'}`, amount: closeAmt });
  if (biteAmt) lines.push({ label: `${bites} bite${bites === 1 ? '' : 's'} (gear patched up)`, amount: -biteAmt });

  const raw = Math.max(0, distAmt + escAmt + closeAmt - biteAmt);
  const total = Math.max(0, Math.round(raw * salvageMul));
  if (raw > 0 && salvageMul !== 1) {
    lines.push({ label: salvageMul > 1 ? 'Cargo bonus' : 'Cargo penalty', amount: total - raw });
  }
  return { total, lines };
}

export function buy(profile, itemId) {
  if (!profile) return { ok: false, reason: 'no-profile' };
  const item = getItem(itemId);
  if (!item) return { ok: false, reason: 'unknown-item' };
  if (!Array.isArray(profile.owned)) profile.owned = [];
  if (profile.owned.includes(itemId)) return { ok: false, reason: 'already-owned' };
  const rankIdx = rankFor(profile.totalKm || 0).idx;
  if (rankIdx < item.rank) return { ok: false, reason: 'rank-locked' };
  if (num(profile.salvage) < item.cost) return { ok: false, reason: 'insufficient-salvage' };
  profile.salvage = num(profile.salvage) - item.cost;
  profile.owned.push(itemId);
  return { ok: true };
}

export function equip(profile, itemId) {
  if (!profile) return { ok: false, reason: 'no-profile' };
  const item = getItem(itemId);
  if (!item) return { ok: false, reason: 'unknown-item' };
  if (!Array.isArray(profile.owned) || !profile.owned.includes(itemId)) {
    return { ok: false, reason: 'not-owned' };
  }
  if (!profile.equipped || typeof profile.equipped !== 'object') profile.equipped = defaultEquipped();
  profile.equipped[item.slot] = itemId;
  return { ok: true };
}

// Called once per finished run: banks salvage, advances distance/rank, saves.
export function applyRunResult(profile, summary) {
  const mods = modifiersFor(profile);
  const salvage = salvageFor(summary, mods);
  const prevIdx = rankFor(profile.totalKm || 0).idx;
  const km = Math.max(0, num(summary && summary.dist) / 1000);

  profile.salvage = num(profile.salvage) + salvage.total;
  profile.totalKm = num(profile.totalKm) + km;
  profile.runs = num(profile.runs) + 1;
  profile.bestKm = Math.max(num(profile.bestKm), km);

  const rank = rankFor(profile.totalKm);
  profile.rankIdx = rank.idx;
  const rankUp = rank.idx > prevIdx ? rank : null;

  saveProfile(profile);
  return { salvage, rankUp };
}
