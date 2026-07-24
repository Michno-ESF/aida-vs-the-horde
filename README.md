# 🧟 Aida vs. The Horde

A zombie-chase running game that lives on an iPhone home screen — no App Store,
no native app. It's a PWA: GPS, synthesized horror audio, a narrator that says
your name, and a post-run survival report, all in Safari.

**How it plays:** start a run and hordes spawn behind you on your path. Their
speed is set relative to *your* recent pace, so they're always a fair threat —
slow down and the gap shrinks (heartbeat quickens, groans get louder), speed up
and you escape. Hordes tire and give up, ambushes force short sprints, three
bites and you're overrun. Afterward you get a survival report with your route,
close calls, and a copy-paste summary for Strava.

## Try it locally

Any static file server works, e.g.:

```
python -m http.server 8123
```

Then open http://localhost:8123 — enable **Demo mode** on the home screen to
fake GPS (a pace slider appears during the run). Add `?fast=5` to the URL to
speed up the simulation while developing.

## Put it on her iPhone

1. Host these files anywhere with HTTPS (GitHub Pages is free and perfect).
2. On the iPhone: open the URL in **Safari** → Share → **Add to Home Screen**.
3. First run: tap Start once outside, allow Location.

## Two rules before she runs

1. **Keep the screen on.** iOS suspends web pages when the phone locks, so the
   app requests a wake lock — but Low Power Mode and older iOS can refuse it, so
   also set **Auto-Lock → Never** (Settings › Display & Brightness). Armband or
   waistband, brightness low, headphones in.
2. **Silent switch OFF.** On iPhone, Web Audio (the heartbeat and groans) is
   muted by the physical Ring/Silent switch. If she can't hear zombies, that
   orange switch is why. The spoken narrator is less affected, the ambient
   tension audio is not.

The game deliberately **freezes** whenever the screen is off or GPS drops out,
rather than letting zombies eat her on stale data — it resumes when a fresh fix
arrives.

## No dependencies

Vanilla ES modules, Web Audio synthesis, `speechSynthesis` narrator, canvas
route map, service worker for offline. Nothing to build, nothing to install —
edit a file, refresh, done.
