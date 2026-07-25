const S_KEY = 'azs-settings';
const H_KEY = 'azs-history';

function read(key) {
  try { return JSON.parse(localStorage.getItem(key)); } catch { return null; }
}
function write(key, val) {
  try { localStorage.setItem(key, JSON.stringify(val)); } catch { /* private mode */ }
}

export const settings = Object.assign(
  { name: 'Aida', difficulty: 'normal', voice: true, demo: false, voiceId: '', tone: 'sassy' },
  read(S_KEY) || {}
);

export function saveSettings() { write(S_KEY, settings); }

export function history() { return read(H_KEY) || []; }

export function addRun(summary) {
  const h = history();
  h.unshift(summary);
  write(H_KEY, h.slice(0, 20));
}
