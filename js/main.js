import { settings, saveSettings, history, addRun } from './storage.js';
import { Tracker } from './gps.js';
import { Game } from './game.js';
import { AudioEngine } from './audio.js';
import { Narrator } from './speech.js';
import { $, showScreen, renderHUD, setPaused, renderHistory } from './ui.js';
import { buildSummary, renderReport, summaryText } from './report.js';
import {
  loadProfile, saveProfile, rankFor, nextRank, modifiersFor,
  buy, equip, applyRunResult, GEAR, RANKS,
} from './progression.js';

// ?fast=5 speeds the simulation up for development (spawns, gaps, clock)
const FAST = Number(new URLSearchParams(location.search).get('fast')) || 1;

const audio = new AudioEngine();
const narrator = new Narrator(() => settings.voice);

let game = null;
let tracker = null;
let tickTimer = null;
let lastTick = 0;
let paused = false;
let wakeLock = null;
let lastSummary = null;
let profile = loadProfile();          // meta-progression: salvage/gear/rank, carries across runs
let voiceCatalog = { voices: [], tones: [] };   // filled once the audio manifest loads

/* ---------------- narrator script ---------------- */
// Deadpan gallows-humor radio operator. Each event has variants so a 30-minute
// run doesn't repeat itself. These strings are BOTH the fallback TTS text and
// the exact script the generator voices — keep tools/audio_lines.json in sync.
// Distances are qualitative on purpose so lines can be pre-recorded; the HUD
// shows the exact meters.

const pick = arr => arr[Math.floor(Math.random() * arr.length)];

const LINES = {
  start: n => pick([
    `Alright, ${n}. Streets are clear, the dead are asleep. Try not to wake them. Off you go.`,
    `Morning. Statistically, most of them are still where you left them. Enjoy the warm-up while it lasts.`,
    `Comms are up. I'll be here, narrating your questionable life choices. Start running.`,
  ]),
  spawn: n => pick([
    `Company behind you, ${n}. Not close yet. They seem motivated, though. Pity.`,
    `Something's noticed you. It's picking up the pace. Rude, really.`,
    `We've got followers. Nothing urgent. Just, you know, the dead. Keep moving.`,
  ]),
  ambush: n => pick([
    `Oh, that's a lot of them. Sprinters. Right behind you. Do the running thing. Now.`,
    `Ambush. They skipped the small talk. ${n}, I'd move if I were you.`,
    `Well, they're fast. That's unfair. Sprint, ${n}, sprint.`,
  ]),
  gap90: () => pick([
    `Ninety meters and gaining. Slowly. Embarrassing for everyone involved.`,
    `They're closing. Ninety meters. Plenty of time to panic efficiently.`,
  ]),
  gap60: () => pick([
    `Sixty meters. This would be an excellent time to actually try.`,
    `Sixty meters. I'm not saying hurry, but. Hurry.`,
  ]),
  gap30: () => pick([
    `Thirty meters. I'd run if I were you. I'm not. You are. Run.`,
    `Thirty meters. They can basically read your race number. Go.`,
  ]),
  close: () => pick([
    `That's close enough to smell them. You won't enjoy it. Move.`,
    `They're practically wearing you as a scarf. Kick.`,
  ]),
  escapeOutran: n => pick([
    `And they're gone. Turns out cardio pays off. Who knew. Well run, ${n}.`,
    `You lost them. Somewhere back there they're deeply disappointed. Beautiful.`,
  ]),
  escapeTired: () => pick([
    `They've given up. Slumped in the road, like my expectations. You're clear.`,
    `And they quit. Dead, and still lazy. Off you go.`,
  ]),
  bitten: (n, d) => pick([
    `Well, that'll leave a mark. You're fine. Probably. ${d.hearts} ${d.hearts === 1 ? 'life' : 'lives'} left. Keep moving.`,
    `They got a nibble. Rude. Walk it off, ${n} — briskly. Very briskly.`,
  ]),
  overrun: n => pick([
    `That's the horde, then. For what it's worth, you outran my expectations. Stroll home, ${n}.`,
    `They got you. Anticlimactic, honestly. Head home, hero.`,
  ]),
  km: n => pick([
    `Another kilometer. The dead are keeping score. So am I.`,
    `That's another one down. Nobody's impressed. But well done, ${n}.`,
  ]),
  finish: n => pick([
    `Home. Still breathing. Statistically remarkable. Let's see the damage.`,
    `You made it, ${n}. I had money on the zombies. Pulling up the report.`,
  ]),
  armorSave: (n, d) => pick([
    `Teeth met jacket, not skin. ${d && d.left ? `${d.left} more save${d.left === 1 ? '' : 's'} left in the padding.` : 'That was the last one in the padding — get careful.'}`,
    `Direct hit, no damage. Gear earns its keep for once, ${n}.`,
  ]),
  flare: () => pick([
    `Flare's up. They're staring at the sky like idiots. Go, quietly.`,
    `Popped the flare. Even the dead have priorities. Move while they're distracted.`,
  ]),
  bait: () => pick([
    `Something else caught their attention. Cheap trick. Effective, though.`,
    `They took the bait — literally. Enjoy the head start.`,
  ]),
  rankUp: (n, rank) => pick([
    `Well, look at you. ${rank && rank.label ? `Rank up: ${rank.label}.` : 'Rank up.'} Try not to let it go to your head.`,
    `Promotion, of sorts. You're ${rank && rank.label ? `a ${rank.label}` : 'somebody'} now, ${n}. Wear it with dread.`,
  ]),
};

// Plain, joke-free radio-operator phrasing for the "straight" tone. Matches
// the recorded straight-tone clips; used for the on-screen TTS fallback too
// so switching tone changes what you SEE as well as hear. One line per key
// (no pick() variety) is enough here — deliberately simple.
const LINES_STRAIGHT = {
  start: n => `Starting run for ${n}. Comms open.`,
  spawn: () => `Contact behind you. Distance holding for now.`,
  ambush: n => `Fast group behind you, ${n}. Increase pace immediately.`,
  gap90: () => `Ninety meters back.`,
  gap60: () => `Sixty meters back.`,
  gap30: () => `Thirty meters back. Sprint recommended.`,
  close: () => `Contact close. Immediate action required.`,
  escapeOutran: n => `Clear. Group left behind, ${n}.`,
  escapeTired: () => `Group has stopped pursuit.`,
  bitten: (n, d) => `Contact made.${d && d.hearts != null ? ` ${d.hearts} ${d.hearts === 1 ? 'life' : 'lives'} remaining.` : ''}`,
  overrun: n => `Run ended, ${n}. Group caught up.`,
  km: () => `Kilometer marker reached.`,
  finish: n => `Run complete, ${n}. Compiling report.`,
  armorSave: (n, d) => `Armor absorbed the hit.${d && d.left != null ? ` ${d.left} charge${d.left === 1 ? '' : 's'} remaining.` : ''}`,
  flare: () => `Flare deployed. Pursuit broken off.`,
  bait: () => `Decoy triggered. Pursuit diverted.`,
  rankUp: (n, rank) => `Rank increased${rank && rank.label ? ` to ${rank.label}` : ''}.`,
};

// Picks the line table for the current tone setting, falling back to sassy
// (the always-complete table) for any key the straight table doesn't have.
function lineFor(key, n, extra) {
  const table = settings.tone === 'straight' ? LINES_STRAIGHT : LINES;
  const fn = (table && table[key]) || LINES[key];
  return fn ? fn(n, extra) : '';
}

// Play a narration clip for `key` if one was generated, else speak the text
// with the phone's TTS. Shared debounce so nearby events don't talk over
// each other (priority 3 = urgent, always through; 1 = flavor, easily skipped).
let lastSpeakAt = 0;
function speak(key, text, priority = 1) {
  // The narrator toggle has to gate BOTH paths. Recorded clips now exist for
  // almost every event, so checking it only inside narrator.say() would leave
  // the switch doing nothing at all.
  if (!settings.voice) return;
  const t = performance.now() / 1000;
  if (priority < 2 && t - lastSpeakAt < 10) return;
  if (priority < 3 && t - lastSpeakAt < 4) return;
  lastSpeakAt = t;
  if (!audio.sayClip(key)) narrator.say(text, priority);
}

function onGameEvent(type, data) {
  const n = settings.name;
  switch (type) {
    case 'spawn':  audio.sting('spawn');  speak('spawn', lineFor('spawn', n), 2); break;
    case 'ambush': audio.sting('ambush'); speak('ambush', lineFor('ambush', n), 3); break;
    case 'gap': { const key = 'gap' + data.th; if (LINES[key]) speak(key, lineFor(key, n), data.th <= 30 ? 3 : 2); break; }
    case 'close':  speak('close', lineFor('close', n), 2); break;
    case 'escape':
      audio.sting('escape');
      if (data.how === 'tired') speak('escapeTired', lineFor('escapeTired', n), 2);
      // 'flare' escapes are already narrated by the 'flare' event just before
      // this one fires (game.js emits flare then escape in the same tick).
      else if (data.how !== 'flare') speak('escapeOutran', lineFor('escapeOutran', n), 2);
      break;
    case 'bitten':    audio.sting('bitten');  speak('bitten', lineFor('bitten', n, data), 3); break;
    case 'overrun':   audio.sting('overrun'); speak('overrun', lineFor('overrun', n), 3); break;
    case 'km':        speak('km', lineFor('km', n), 1); break;
    case 'armorSave': speak('armorSave', lineFor('armorSave', n, data), 2); break;
    case 'flare':     speak('flare', lineFor('flare', n), 3); break;
    case 'bait':      speak('bait', lineFor('bait', n), 2); break;
  }
}

/* ---------------- wake lock (keeps iPhone screen on) ---------------- */

let wakeWarned = false;

async function acquireWakeLock() {
  try { wakeLock = (await navigator.wakeLock?.request('screen')) || null; } catch { wakeLock = null; }
  // Older iOS (<16.4) lacks the API and Low Power Mode rejects the request. If we
  // couldn't get it, tell her once so she can keep the screen on herself.
  if (!wakeLock && game && !wakeWarned) {
    wakeWarned = true;
    const el = $('gps-live');
    el.textContent = "⚠️ Couldn't keep the screen awake — set Auto-Lock to Never (Settings › Display), or tap the screen now and then.";
    el.classList.remove('hidden');
  }
}
function releaseWakeLock() {
  try { wakeLock?.release(); } catch { /* fine */ }
  wakeLock = null;
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && game && !paused) {
    acquireWakeLock();
    audio.resume();       // iOS suspends the audio session while hidden
    narrator.resume();    // ...and wedges speech until pumped
  }
});

/* ---------------- HUD wiring ---------------- */

// ui.js's renderHUD reads `speed` for the pace readout; game.js now keeps the
// responsive (jumpy) value on `speed` for chase maths and the smoothed one on
// `displaySpeed` for display. Since ui.js isn't ours to edit, hand it a thin
// view that swaps in the smoothed value under the same field name it expects.
function hudView(g) {
  return {
    elapsed: g.elapsed, dist: g.dist, speed: g.displaySpeed,
    hearts: g.hearts, horde: g.horde, over: g.over,
    get threat() { return g.threat; },
  };
}

/* ---------------- run lifecycle ---------------- */

function startRun() {
  saveSettings();
  const mods = modifiersFor(profile);
  game = new Game(settings.difficulty, onGameEvent, { modifiers: mods });
  tracker = new Tracker(settings.demo);
  paused = false;
  wakeWarned = false;
  $('gps-status').classList.add('hidden');
  $('gps-live').classList.add('hidden');
  $('demo-ctl').classList.toggle('hidden', !settings.demo);
  if (settings.demo) tracker.setDemoSpeed(Number($('demo-speed').value) / 3.6);

  // Both must happen inside the tap handler for iOS to allow them
  audio.unlock();
  // Decode real clips if present (no-op in fallback mode). Refresh the picker
  // afterwards too: on a cold start the boot-time load can fail before audio is
  // unlocked, which would otherwise leave the voice list hidden all session.
  audio.loadLibrary('audio/', { voice: settings.voiceId, tone: settings.tone })
    .then(() => { voiceCatalog = audio.catalog; renderVoicePicker(); })
    .catch(() => { /* stays on synth/TTS fallback */ });
  narrator.prime();

  tracker.start(
    fix => {
      if (!paused) game.addFix(fix);
      $('gps-live').classList.add('hidden');      // a fix arrived — clear any "searching" note
    },
    err => {
      if (err === 'denied' || err === 'unsupported') {
        // Permanent: bail back home with instructions.
        stopEverything();
        game = null;            // the run is over — don't let handlers treat it as live
        showScreen('screen-home');
        const el = $('gps-status');
        el.classList.remove('hidden');
        el.textContent = err === 'denied'
          ? '📍 Location was blocked. Allow it in Safari (aA menu → Website Settings → Location) or try Demo mode.'
          : '📍 This device has no GPS. Try Demo mode.';
      } else {
        // Transient (bridge/tunnel/cold start): keep running, the watch recovers itself.
        const el = $('gps-live');
        el.textContent = '📡 Searching for GPS…';
        el.classList.remove('hidden');
      }
    }
  );

  acquireWakeLock();
  showScreen('screen-run');
  renderHUD(hudView(game));
  speak('start', lineFor('start', settings.name), 2);

  lastTick = performance.now();
  tickTimer = setInterval(() => {
    const now = performance.now();
    // Two different deltas on purpose. iOS suspends timers while the app is
    // hidden, so a resume can arrive minutes later: the chase maths must be
    // clamped (one huge jump would teleport the horde), but the run CLOCK has
    // to count the real wall-clock time or the reported duration and pace come
    // out wrong — and that pace gets pasted straight into Strava.
    const wallDt = (now - lastTick) / 1000 * FAST;
    const dt = Math.min(5 * FAST, wallDt);
    lastTick = now;
    if (!paused) {
      game.tick(dt, document.visibilityState !== 'visible', wallDt);
      audio.update(game.threat, game.horde ? game.horde.gap : null, now / 1000);
      renderHUD(hudView(game));
    }
  }, 1000);
}

function stopEverything(keepNarration) {
  clearInterval(tickTimer);
  tickTimer = null;
  tracker?.stop();
  releaseWakeLock();
  audio.stop();
  if (!keepNarration) narrator.stop();
}

function endRun() {
  if (!game) return;
  lastSummary = buildSummary(game, settings.name, settings.difficulty);
  stopEverything(true);                           // keep speech so the farewell isn't cut off
  speak('finish', lineFor('finish', settings.name), 3);
  const { path, marks, ...compact } = lastSummary;
  addRun({ ...compact });                       // history without the heavy route data

  const { salvage, rankUp } = applyRunResult(profile, lastSummary);
  renderReport(lastSummary, { profile, salvage, rankUp });
  renderRankStrip();                              // reflect the updated salvage/rank on the home strip too
  if (rankUp) setTimeout(() => speak('rankUp', lineFor('rankUp', settings.name, rankUp), 3), 4000);

  showScreen('screen-report');
  game = null;
}

/* ---------------- home screen bindings ---------------- */

function renderRankStrip() {
  const rank = rankFor(profile.totalKm);
  const nxt = nextRank(profile.totalKm);
  const pct = nxt ? Math.min(100, Math.max(0, Math.round(100 * (profile.totalKm - rank.km) / (nxt.km - rank.km)))) : 100;
  $('rank-name').textContent = rank.label;
  $('rank-salvage').textContent = `⚙️ ${profile.salvage}`;
  $('rank-bar-fill').style.width = pct + '%';
}

const SLOT_META = {
  boots: { label: 'Boots', emoji: '👟' },
  armor: { label: 'Armor', emoji: '🧥' },
  tool:  { label: 'Tool',  emoji: '🛠' },
  cargo: { label: 'Cargo', emoji: '🎒' },
};

function gearRowHtml(item, rankIdx) {
  const owned = profile.owned.includes(item.id);
  const equipped = profile.equipped[item.slot] === item.id;
  const locked = !owned && rankIdx < item.rank;
  const cls = ['gear', owned && 'owned', equipped && 'equipped', locked && 'locked'].filter(Boolean).join(' ');

  let action;
  if (equipped) {
    action = '';
  } else if (owned) {
    action = `<button type="button" data-equip="${item.id}">Equip</button>`;
  } else if (locked) {
    action = `<span class="cost">🔒 ${RANKS[item.rank].label}</span>`;
  } else {
    const afford = profile.salvage >= item.cost;
    action = `<button type="button" class="cost" data-buy="${item.id}"${afford ? '' : ' disabled'}>⚙️ ${item.cost}</button>`;
  }

  return `<div class="${cls}">
    <span class="gear-icon">${item.emoji}</span>
    <div class="gear-info"><span class="gear-label">${item.label}</span><span class="gear-desc">${item.desc}</span></div>
    ${action}
  </div>`;
}

function renderLoadout() {
  const rank = rankFor(profile.totalKm);
  const nxt = nextRank(profile.totalKm);
  const pct = nxt ? Math.min(100, Math.max(0, Math.round(100 * (profile.totalKm - rank.km) / (nxt.km - rank.km)))) : 100;
  $('loadout-rank').textContent = rank.label;
  $('loadout-salvage').textContent = `⚙️ ${profile.salvage}`;
  $('loadout-rankbar').style.width = pct + '%';

  const slots = $('loadout-slots');
  slots.innerHTML = Object.keys(SLOT_META).map(slot => {
    const meta = SLOT_META[slot];
    const rows = GEAR[slot].map(item => gearRowHtml(item, rank.idx)).join('');
    return `<div class="slot"><h3>${meta.emoji} ${meta.label}</h3>${rows}</div>`;
  }).join('');

  slots.querySelectorAll('[data-equip]').forEach(b => b.addEventListener('click', () => {
    equip(profile, b.dataset.equip);
    saveProfile(profile);
    renderLoadout();
  }));
  slots.querySelectorAll('[data-buy]').forEach(b => b.addEventListener('click', () => {
    const r = buy(profile, b.dataset.buy);
    if (r.ok) saveProfile(profile);
    renderLoadout();
  }));
}

// Renders the narrator voice picker from the audio manifest's catalog. Hides
// itself entirely if no voices are advertised (v1 manifest / no audio yet).
function renderVoicePicker() {
  const wrap = $('set-voicelist').closest('.field') || $('set-voicelist');
  const voices = voiceCatalog.voices;
  if (!voices.length) { wrap.classList.add('hidden'); return; }
  wrap.classList.remove('hidden');

  // Fall back to the first available voice for the highlight only — mirrors
  // audio.js's own requested->first-available fallback — without silently
  // overwriting the player's saved preference.
  const effective = voices.find(v => v.id === settings.voiceId) ? settings.voiceId : voices[0].id;

  const list = $('set-voicelist');
  list.innerHTML = voices.map(v => `
    <div class="voice-row${v.id === effective ? ' on' : ''}">
      <button type="button" data-voice="${v.id}">${v.label}</button>
      <button type="button" class="preview-btn" data-preview="${v.id}">▶</button>
    </div>`).join('');

  list.querySelectorAll('[data-voice]').forEach(b => b.addEventListener('click', () => selectVoice(b.dataset.voice)));
  list.querySelectorAll('[data-preview]').forEach(b => b.addEventListener('click', () => previewVoice(b.dataset.preview)));
}

async function selectVoice(id) {
  settings.voiceId = id;
  saveSettings();
  renderVoicePicker();
  await audio.loadLibrary('audio/', { voice: settings.voiceId, tone: settings.tone });
}

async function previewVoice(id) {
  await audio.unlock();               // iOS: the gesture must reach unlock() directly, not just at boot
  await audio.previewVoice(id, 'audio/');
}

function syncHomeUI() {
  $('set-name').value = settings.name;
  $('set-voice').checked = settings.voice;
  $('set-demo').checked = settings.demo;
  $('title-name').textContent = (settings.name || 'AIDA').toUpperCase();
  document.querySelectorAll('#set-diff button').forEach(b =>
    b.classList.toggle('on', b.dataset.v === settings.difficulty));
  document.querySelectorAll('#set-tone button').forEach(b =>
    b.classList.toggle('on', b.dataset.v === settings.tone));
  renderHistory(history());
  renderRankStrip();
}

$('set-name').addEventListener('input', e => {
  settings.name = e.target.value.trim() || 'Aida';
  $('title-name').textContent = settings.name.toUpperCase();
  saveSettings();
});
$('set-voice').addEventListener('change', e => { settings.voice = e.target.checked; saveSettings(); });
$('set-demo').addEventListener('change', e => { settings.demo = e.target.checked; saveSettings(); });
document.querySelectorAll('#set-diff button').forEach(b =>
  b.addEventListener('click', () => {
    settings.difficulty = b.dataset.v;
    saveSettings();
    syncHomeUI();
  }));
document.querySelectorAll('#set-tone button').forEach(b =>
  b.addEventListener('click', () => {
    settings.tone = b.dataset.v;
    saveSettings();
    syncHomeUI();
    audio.loadLibrary('audio/', { voice: settings.voiceId, tone: settings.tone });
  }));

$('btn-start').addEventListener('click', startRun);

$('btn-loadout').addEventListener('click', () => {
  renderLoadout();
  showScreen('screen-loadout');
});
$('btn-loadout-back').addEventListener('click', () => {
  syncHomeUI();
  showScreen('screen-home');
});

/* ---------------- run screen bindings ---------------- */

$('btn-pause').addEventListener('click', () => {
  paused = !paused;
  setPaused(paused);
  if (paused) {
    releaseWakeLock();
  } else {
    game.dropBaseline();                        // don't count distance walked while paused
    lastTick = performance.now();
    acquireWakeLock();
    // If a call/Siri suspended the audio session while paused, the
    // visibilitychange handler skipped resuming (it ignores paused runs), so
    // this tap is the trusted gesture that brings sound back for the rest of
    // the run. Without it the whole game goes permanently silent.
    audio.resume();
    narrator.resume();
  }
});

// Hold-to-finish so a sweaty mid-run tap can't end the game by accident
let holdTimer = null;
const endBtn = $('btn-end');
const startHold = e => {
  e.preventDefault();
  endBtn.classList.add('holding');
  holdTimer = setTimeout(() => { endBtn.classList.remove('holding'); endRun(); }, 1100);
};
const cancelHold = () => {
  endBtn.classList.remove('holding');
  clearTimeout(holdTimer);
};
endBtn.addEventListener('pointerdown', startHold);
endBtn.addEventListener('pointerup', cancelHold);
endBtn.addEventListener('pointerleave', cancelHold);
endBtn.addEventListener('pointercancel', cancelHold);

$('demo-speed').addEventListener('input', e => {
  const kmh = Number(e.target.value);
  $('demo-out').textContent = kmh.toFixed(1) + ' km/h';
  tracker?.setDemoSpeed(kmh / 3.6);
});

/* ---------------- report screen bindings ---------------- */

$('btn-copy').addEventListener('click', async () => {
  if (!lastSummary) return;
  const text = summaryText(lastSummary);
  try {
    await navigator.clipboard.writeText(text);
    $('btn-copy').textContent = '✅ Copied — paste it into your Strava activity';
  } catch {
    prompt('Copy your survival report:', text);
  }
  setTimeout(() => { $('btn-copy').textContent = '📋 Copy report (paste into Strava)'; }, 2500);
});

$('btn-home').addEventListener('click', () => {
  syncHomeUI();
  showScreen('screen-home');
});

/* ---------------- boot ---------------- */

syncHomeUI();
renderVoicePicker();      // hides the (still-empty) picker until the catalog below resolves

// Kick off audio unlock+library load speculatively so the voice/tone catalog
// (and sfx) are ready before the first run — real per-tap unlock() calls in
// startRun()/previewVoice() still happen for iOS's stricter gesture rule.
audio.unlock()
  .then(() => audio.loadLibrary('audio/', { voice: settings.voiceId, tone: settings.tone }))
  .then(() => { voiceCatalog = audio.catalog; renderVoicePicker(); })
  .catch(() => { /* fine — picker just stays hidden until the first run starts audio */ });

const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
const standalone = window.navigator.standalone === true ||
  window.matchMedia('(display-mode: standalone)').matches;
if (isIOS && !standalone) $('install-hint').classList.remove('hidden');

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => { /* offline support is optional */ });
  });
}
