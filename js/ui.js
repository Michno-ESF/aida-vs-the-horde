export const $ = id => document.getElementById(id);

export function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  $(id).classList.add('active');
  window.scrollTo(0, 0);
}

export function fmtTime(sec) {
  sec = Math.max(0, Math.round(sec));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
           : `${m}:${String(s).padStart(2, '0')}`;
}

export function fmtPace(mps) {
  if (!mps || mps < 0.4) return '–:––';
  const spk = 1000 / mps;
  const m = Math.floor(spk / 60), s = Math.round(spk % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function renderHUD(g) {
  $('r-time').textContent = fmtTime(g.elapsed);
  $('r-dist').textContent = (g.dist / 1000).toFixed(2);
  $('r-pace').textContent = fmtPace(g.speed);
  $('hearts').textContent = '❤️'.repeat(g.hearts) + '🖤'.repeat(3 - g.hearts);

  const box = $('threat');
  if (g.horde) {
    const gap = Math.max(0, Math.round(g.horde.gap));
    $('threat-emoji').textContent = g.horde.kind === 'ambush' ? '🧟⚡' : '🧟🧟🧟';
    $('threat-main').textContent = `${gap} m`;
    $('threat-sub').textContent = g.horde.kind === 'ambush' ? 'AMBUSH — SPRINT!' : 'horde behind you';
    box.className = 'threat ' + (g.threat > 0.6 ? 'danger' : g.threat > 0.25 ? 'warn' : 'clear');
    $('threat-fill').style.width = `${Math.round(g.threat * 100)}%`;
  } else {
    $('threat-emoji').textContent = g.over ? '💀' : '🌤';
    $('threat-main').textContent = g.over ? 'Overrun' : 'All clear';
    $('threat-sub').textContent = g.over ? 'shamble home with pride' : 'for now…';
    box.className = 'threat clear';
    $('threat-fill').style.width = '0%';
  }
}

export function setPaused(paused) {
  $('btn-pause').textContent = paused ? '▶ Resume' : '⏸ Pause';
  $('threat-sub').textContent = paused ? 'paused — the horde waits, politely' : $('threat-sub').textContent;
}

export function renderHistory(list) {
  const ul = $('history');
  if (!list.length) {
    ul.innerHTML = '<li class="hint">No runs yet. The horde is patient.</li>';
    return;
  }
  ul.innerHTML = list.map(r => {
    const date = new Date(r.date).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    const badge = r.survived
      ? '<span class="badge ok">SURVIVED</span>'
      : '<span class="badge dead">OVERRUN</span>';
    return `<li><span>${date} · ${(r.dist / 1000).toFixed(1)} km · ${fmtTime(r.elapsed)}</span>${badge}</li>`;
  }).join('');
}
