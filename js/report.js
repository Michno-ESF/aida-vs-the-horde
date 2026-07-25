import { fmtTime, fmtPace, $ } from './ui.js';
import { rankFor, nextRank } from './progression.js';

export function buildSummary(game, name, difficulty) {
  const stride = Math.max(1, Math.floor(game.points.length / 300));
  const path = game.points.filter((_, i) => i % stride === 0).map(p => [p.lat, p.lng]);
  const marks = game.stats.closeCalls.map(c => ({
    // remap the point index onto the strided path
    i: Math.min(path.length - 1, Math.floor(c.idx / stride)),
    bite: !!c.bite,
    gap: c.gap,
  }));
  return {
    date: new Date().toISOString(),
    name,
    difficulty,
    dist: game.dist,
    elapsed: game.elapsed,
    avgSpeed: game.elapsed > 0 ? game.dist / game.elapsed : 0,
    hearts: game.hearts,
    escapes: game.stats.escapes,
    bites: game.stats.bites,
    // null (not Infinity) for "never got close" — Infinity JSON-serialises to
    // null anyway, so store the sentinel we actually mean.
    closest: game.stats.closeCalls.length
      ? game.stats.closeCalls.reduce((m, c) => Math.min(m, c.gap), Infinity)
      : null,
    survived: game.hearts > 0,
    path,
    marks,
  };
}

export function renderReport(sum, ctx = {}) {
  const head = $('rep-head');
  head.textContent = sum.survived
    ? `🏆 ${sum.name.toUpperCase()} SURVIVED`
    : `💀 OVERRUN — BUT ${sum.name.toUpperCase()} MADE IT HOME`;
  head.className = 'rep-head ' + (sum.survived ? 'ok' : 'dead');

  const cells = [
    [(sum.dist / 1000).toFixed(2) + ' km', 'distance'],
    [fmtTime(sum.elapsed), 'time'],
    [fmtPace(sum.avgSpeed) + ' /km', 'avg pace'],
    ['❤️'.repeat(sum.hearts) + '🖤'.repeat(3 - sum.hearts), 'hearts left'],
    [String(sum.escapes), 'hordes escaped'],
    [Number.isFinite(sum.closest) ? Math.round(sum.closest) + ' m' : '—', 'closest call'],
  ];
  $('rep-stats').innerHTML = cells
    .map(([b, l]) => `<div class="cell"><b>${b}</b><span>${l}</span></div>`)
    .join('');

  drawMap($('rep-map'), sum);
  renderSalvage(ctx.salvage);
  renderRankNote(ctx.profile, ctx.rankUp);
}

// Salvage breakdown card. `salvage` is the { total, lines } shape from
// progression.salvageFor(); hidden entirely if there's nothing to show.
function renderSalvage(salvage) {
  const el = $('rep-salvage');
  if (!salvage || !salvage.lines.length) { el.classList.add('hidden'); el.innerHTML = ''; return; }
  el.classList.remove('hidden');
  const lines = salvage.lines
    .map(l => `<div class="salvage-line"><span class="label">${l.label}</span><span class="amount">${l.amount >= 0 ? '+' : ''}${l.amount}</span></div>`)
    .join('');
  el.innerHTML = `<h2>Salvage</h2>${lines}<div class="salvage-total"><span>Total</span><span>+${salvage.total} ⚙️</span></div>`;
}

// Rank status/announcement. Shows a rank-up callout when one happened this
// run, otherwise the current rank and progress toward the next one.
function renderRankNote(profile, rankUp) {
  const el = $('rep-rank');
  if (!profile) { el.classList.add('hidden'); el.innerHTML = ''; return; }
  el.classList.remove('hidden');
  if (rankUp) {
    el.innerHTML = `🎖️ Rank up — you're now <b>${rankUp.label}</b>.`;
    return;
  }
  const nxt = nextRank(profile.totalKm);
  el.textContent = nxt
    ? `${rankFor(profile.totalKm).label} · ${nxt.remainingKm.toFixed(1)} km to ${nxt.label}`
    : `${rankFor(profile.totalKm).label} — max rank reached.`;
}

function drawMap(canvas, sum) {
  // Size the backing store to the displayed CSS size × devicePixelRatio so the
  // route is crisp on a retina iPhone instead of an upscaled 660×440 blur.
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  // renderReport() runs while the report screen is still display:none, so
  // clientWidth reads 0 here. Fall back to the parent's width, and never pin an
  // inline pixel height — the CSS keeps height:auto so the 3:2 backing store
  // scales uniformly instead of being squashed into a stale 440px box.
  const W = canvas.clientWidth || canvas.parentElement?.clientWidth || 660;
  const H = Math.round(W * 2 / 3);              // keep the 3:2 aspect ratio
  canvas.width = Math.round(W * dpr);
  canvas.height = Math.round(H * dpr);
  canvas.style.removeProperty('height');
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);       // draw in CSS pixels
  const PAD = Math.round(W * 0.08);
  ctx.clearRect(0, 0, W, H);

  if (sum.path.length < 2) {
    ctx.fillStyle = '#86a68c';
    ctx.font = '20px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('No route recorded', W / 2, H / 2);
    return;
  }

  const lats = sum.path.map(p => p[0]), lngs = sum.path.map(p => p[1]);
  const minLat = Math.min(...lats), maxLat = Math.max(...lats);
  const minLng = Math.min(...lngs), maxLng = Math.max(...lngs);
  const midLat = (minLat + maxLat) / 2;
  const kx = Math.cos(midLat * Math.PI / 180);      // meters-true aspect ratio
  const spanLat = Math.max(maxLat - minLat, 1e-5);
  const spanLng = Math.max((maxLng - minLng) * kx, 1e-5);
  const scale = Math.min((W - 2 * PAD) / spanLng, (H - 2 * PAD) / spanLat);
  const ox = (W - spanLng * scale) / 2, oy = (H - spanLat * scale) / 2;
  const X = p => ox + (p[1] - minLng) * kx * scale;
  const Y = p => H - oy - (p[0] - minLat) * scale;

  ctx.lineWidth = 5;
  ctx.lineJoin = ctx.lineCap = 'round';
  ctx.strokeStyle = '#5fbf6b';
  ctx.shadowColor = 'rgba(95,191,107,.5)';
  ctx.shadowBlur = 10;
  ctx.beginPath();
  sum.path.forEach((p, i) => i ? ctx.lineTo(X(p), Y(p)) : ctx.moveTo(X(p), Y(p)));
  ctx.stroke();
  ctx.shadowBlur = 0;

  const dot = (x, y, r, fill) => {
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = fill; ctx.fill();
  };
  for (const m of sum.marks) {
    const p = sum.path[m.i];
    if (!p) continue;
    dot(X(p), Y(p), m.bite ? 9 : 7, m.bite ? '#111' : '#ef5350');
    if (m.bite) {
      ctx.strokeStyle = '#ef5350'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(X(p), Y(p), 9, 0, Math.PI * 2); ctx.stroke();
    }
  }
  dot(X(sum.path[0]), Y(sum.path[0]), 8, '#e8f5e9');
  const last = sum.path[sum.path.length - 1];
  ctx.font = '26px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(sum.survived ? '🏁' : '💀', X(last), Y(last) + 9);

  ctx.font = '13px sans-serif';
  ctx.fillStyle = '#86a68c';
  ctx.textAlign = 'left';
  ctx.fillText('● start', 14, H - 34);
  ctx.fillStyle = '#ef5350';
  ctx.fillText('● close call', 14, H - 16);
}

export function summaryText(sum) {
  const paceStr = fmtPace(sum.avgSpeed);
  const lines = [
    `🧟 ${sum.name} vs. The Horde — ${sum.survived ? 'SURVIVED ✅' : 'OVERRUN 💀'}`,
    `🏃‍♀️ ${(sum.dist / 1000).toFixed(2)} km in ${fmtTime(sum.elapsed)} (${paceStr}/km)`,
    `🧟 Hordes escaped: ${sum.escapes}${sum.bites ? ` · Bitten: ${sum.bites}` : ''}`,
  ];
  if (Number.isFinite(sum.closest)) lines.push(`😱 Closest call: ${Math.round(sum.closest)} m`);
  lines.push(`${'❤️'.repeat(sum.hearts)}${'🖤'.repeat(3 - sum.hearts)} — aida-vs-the-horde`);
  return lines.join('\n');
}
