import { settings, saveSettings, history, addRun } from './storage.js';
import { Tracker } from './gps.js';
import { Game } from './game.js';
import { AudioEngine } from './audio.js';
import { Narrator } from './speech.js';
import { $, showScreen, renderHUD, setPaused, renderHistory } from './ui.js';
import { buildSummary, renderReport, summaryText } from './report.js';

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

/* ---------------- narrator script ---------------- */
// Each event has several variants so a 30-minute run (7-9 chases) doesn't
// repeat itself. pick() chooses one at random per call.

const pick = arr => arr[Math.floor(Math.random() * arr.length)];

const LINES = {
  start: n => pick([
    `Good luck out there, ${n}. The streets look quiet... for now.`,
    `Radio check, ${n}. Comms are up. Start your warm up — I'll watch the perimeter.`,
    `Morning, ${n}. Nothing on the scanners yet. Let's keep it that way.`,
  ]),
  spawn: (n, d) => pick([
    `${n}! Movement behind you — about ${d.gap} meters back. Hold your pace.`,
    `Contact. Horde on your tail, ${d.gap} meters. Stay smooth, stay ahead.`,
    `Heads up, ${n}, they've picked up your scent. ${d.gap} meters and following.`,
  ]),
  ambush: (n, d) => pick([
    `Ambush! Sprinters, ${d.gap} meters and closing fast! Run, ${n}, RUN!`,
    `They came out of nowhere — ${d.gap} meters! Go go go, ${n}!`,
    `Sprinters! Right behind you, ${d.gap} meters! Do not slow down!`,
  ]),
  gap90: () => pick([`They're gaining. Ninety meters.`, `Gap's closing — ninety meters back.`]),
  gap60: () => pick([`Sixty meters! Pick it up!`, `They're at sixty. Dig in!`, `Sixty meters and closing — push!`]),
  gap30: () => pick([`Thirty meters! SPRINT! NOW!`, `Thirty meters — GO, ${settings.name}!`, `They're on you — thirty meters! MOVE!`]),
  close: () => pick([
    `They can smell you! Don't look back!`,
    `That's too close — kick, kick, KICK!`,
    `You can hear them breathing — GO!`,
  ]),
  escapeOutran: n => pick([
    `The gap's opening... you lost them! Beautiful running, ${n}.`,
    `That's it — they're fading behind you. Textbook escape, ${n}.`,
    `You're pulling away! They've got nothing left for that pace.`,
  ]),
  escapeTired: () => pick([
    `They're doubling over. Zombies skip leg day. You're clear.`,
    `And... they've given up. Slumping in the road. Nicely done.`,
    `They lost the scent. You can breathe — for a minute.`,
  ]),
  bitten: (n, d) => pick([
    `They got a piece of you! ${d.hearts} ${d.hearts === 1 ? 'heart' : 'hearts'} left. Shake it off and move!`,
    `Ah — they caught you! ${d.hearts} left. Don't stop, ${n}, keep going!`,
  ]),
  overrun: n => pick([
    `They swarmed you... but ${n} never stops. Get home safe — we'll call it a draw.`,
    `Overrun. But you're still on your feet, ${n}. Walk it home, head high.`,
  ]),
  km: (n, d) => pick([
    `${d.km} ${d.km === 1 ? 'kilometer' : 'kilometers'} down.`,
    `That's ${d.km} clicks. Looking strong, ${n}.`,
    `${d.km} kilometers behind you. Keep it rolling.`,
  ]),
  finish: n => pick([
    `Home safe, ${n}. Pulling up your survival report.`,
    `You made it, ${n}. Let's see how close it got.`,
  ]),
};

function onGameEvent(type, data) {
  const n = settings.name;
  switch (type) {
    case 'spawn':  audio.sting('spawn');  narrator.say(LINES.spawn(n, data), 2); break;
    case 'ambush': audio.sting('ambush'); narrator.say(LINES.ambush(n, data), 3); break;
    case 'gap': { const l = LINES['gap' + data.th]; if (l) narrator.say(l(), data.th <= 30 ? 3 : 2); break; }
    case 'close':  narrator.say(LINES.close(), 2); break;
    case 'escape':
      audio.sting('escape');
      narrator.say(data.how === 'tired' ? LINES.escapeTired() : LINES.escapeOutran(n), 2);
      break;
    case 'bitten':  audio.sting('bitten');  narrator.say(LINES.bitten(n, data), 3); break;
    case 'overrun': audio.sting('overrun'); narrator.say(LINES.overrun(n), 3); break;
    case 'km':      narrator.say(LINES.km(n, data), 1); break;
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

/* ---------------- run lifecycle ---------------- */

function startRun() {
  saveSettings();
  game = new Game(settings.difficulty, onGameEvent);
  tracker = new Tracker(settings.demo);
  paused = false;
  wakeWarned = false;
  $('gps-status').classList.add('hidden');
  $('gps-live').classList.add('hidden');
  $('demo-ctl').classList.toggle('hidden', !settings.demo);
  if (settings.demo) tracker.setDemoSpeed(Number($('demo-speed').value) / 3.6);

  // Both must happen inside the tap handler for iOS to allow them
  audio.unlock();
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
  renderHUD(game);
  narrator.say(LINES.start(settings.name), 2);

  lastTick = performance.now();
  tickTimer = setInterval(() => {
    const now = performance.now();
    const dt = Math.min(5, (now - lastTick) / 1000) * FAST;
    lastTick = now;
    if (!paused) {
      game.tick(dt, document.visibilityState !== 'visible');
      audio.update(game.threat, game.horde ? game.horde.gap : null, now / 1000);
      renderHUD(game);
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
  narrator.say(LINES.finish(settings.name), 3);
  const { path, marks, ...compact } = lastSummary;
  addRun({ ...compact });                       // history without the heavy route data
  renderReport(lastSummary);
  showScreen('screen-report');
  game = null;
}

/* ---------------- home screen bindings ---------------- */

function syncHomeUI() {
  $('set-name').value = settings.name;
  $('set-voice').checked = settings.voice;
  $('set-demo').checked = settings.demo;
  $('title-name').textContent = (settings.name || 'AIDA').toUpperCase();
  document.querySelectorAll('#set-diff button').forEach(b =>
    b.classList.toggle('on', b.dataset.v === settings.difficulty));
  renderHistory(history());
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

$('btn-start').addEventListener('click', startRun);

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

const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
const standalone = window.navigator.standalone === true ||
  window.matchMedia('(display-mode: standalone)').matches;
if (isIOS && !standalone) $('install-hint').classList.remove('hidden');

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => { /* offline support is optional */ });
  });
}
