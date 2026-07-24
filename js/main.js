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
};

// Play a narration clip for `key` if one was generated, else speak the text
// with the phone's TTS. Shared debounce so nearby events don't talk over
// each other (priority 3 = urgent, always through; 1 = flavor, easily skipped).
let lastSpeakAt = 0;
function speak(key, text, priority = 1) {
  const t = performance.now() / 1000;
  if (priority < 2 && t - lastSpeakAt < 10) return;
  if (priority < 3 && t - lastSpeakAt < 4) return;
  lastSpeakAt = t;
  if (!audio.sayClip(key)) narrator.say(text, priority);
}

function onGameEvent(type, data) {
  const n = settings.name;
  switch (type) {
    case 'spawn':  audio.sting('spawn');  speak('spawn', LINES.spawn(n), 2); break;
    case 'ambush': audio.sting('ambush'); speak('ambush', LINES.ambush(n), 3); break;
    case 'gap': { const l = LINES['gap' + data.th]; if (l) speak('gap' + data.th, l(), data.th <= 30 ? 3 : 2); break; }
    case 'close':  speak('close', LINES.close(), 2); break;
    case 'escape':
      audio.sting('escape');
      if (data.how === 'tired') speak('escapeTired', LINES.escapeTired(), 2);
      else speak('escapeOutran', LINES.escapeOutran(n), 2);
      break;
    case 'bitten':  audio.sting('bitten');  speak('bitten', LINES.bitten(n, data), 3); break;
    case 'overrun': audio.sting('overrun'); speak('overrun', LINES.overrun(n), 3); break;
    case 'km':      speak('km', LINES.km(n), 1); break;
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
  audio.loadLibrary();          // decode real clips if present (no-op in fallback mode)
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
  speak('start', LINES.start(settings.name), 2);

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
  speak('finish', LINES.finish(settings.name), 3);
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
