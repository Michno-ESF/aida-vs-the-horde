import { fmtTime, fmtPace, $ } from './ui.js';

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
    closest: game.stats.closeCalls.reduce((m, c) => Math.min(m, c.gap), Infinity),
    survived: game.hearts > 0,
    path,
    marks,
  };
}

export function renderReport(sum) {
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
    [sum.closest === Infinity ? '—' : Math.round(sum.closest) + ' m', 'closest call'],
  ];
  $('rep-stats').innerHTML = cells
    .map(([b, l]) => `<div class="cell"><b>${b}</b><span>${l}</span></div>`)
    .join('');

  drawMap($('rep-map'), sum);
}

function drawMap(canvas, sum) {
  // Size the backing store to the displayed CSS size × devicePixelRatio so the
  // route is crisp on a retina iPhone instead of an upscaled 660×440 blur.
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  const W = canvas.clientWidth || 660;
  const H = Math.round(W * 2 / 3);              // keep the 3:2 aspect ratio
  canvas.width = Math.round(W * dpr);
  canvas.height = Math.round(H * dpr);
  canvas.style.height = H + 'px';
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
  if (sum.closest !== Infinity) lines.push(`😱 Closest call: ${Math.round(sum.closest)} m`);
  lines.push(`${'❤️'.repeat(sum.hearts)}${'🖤'.repeat(3 - sum.hearts)} — aida-vs-the-horde`);
  return lines.join('\n');
}
