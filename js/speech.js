/**
 * Narrator on top of the built-in speech synthesis (free, offline, and it
 * can say her name). iOS quirks handled: voices load async, and the first
 * utterance must happen after a user gesture — prime() runs in the Start
 * button handler.
 */
export class Narrator {
  constructor(isEnabled) {
    this.isEnabled = isEnabled;
    this.lastAt = 0;
    this.voice = null;
    if ('speechSynthesis' in window) {
      const pick = () => {
        const vs = speechSynthesis.getVoices();
        this.voice =
          vs.find(v => /en[-_]US/i.test(v.lang) && /samantha|ava|allison/i.test(v.name)) ||
          vs.find(v => /en[-_](US|GB)/i.test(v.lang)) ||
          vs.find(v => /^en/i.test(v.lang)) || null;
      };
      pick();
      speechSynthesis.addEventListener?.('voiceschanged', pick);
    }
  }

  prime() {
    if (!('speechSynthesis' in window)) return;
    try {
      const u = new SpeechSynthesisUtterance(' ');
      u.volume = 0;
      speechSynthesis.speak(u);
    } catch { /* not fatal */ }
  }

  /** priority 1 = flavor (skipped if recent), 2 = important, 3 = urgent (interrupts) */
  say(text, priority = 1) {
    if (!this.isEnabled() || !('speechSynthesis' in window)) return;
    const now = Date.now() / 1000;
    if (priority < 2 && now - this.lastAt < 10) return;
    if (priority < 3 && now - this.lastAt < 4) return;
    try {
      if (priority >= 3) speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.rate = 1.04;
      u.pitch = 0.85;
      u.lang = 'en-US';
      if (this.voice) u.voice = this.voice;
      speechSynthesis.speak(u);
      this.lastAt = now;
    } catch { /* not fatal */ }
  }

  // iOS suspends speechSynthesis while the PWA is hidden and can leave the queue
  // wedged on return; pumping resume() un-sticks it so callouts keep firing.
  resume() {
    if (!('speechSynthesis' in window)) return;
    try { speechSynthesis.resume(); } catch { /* fine */ }
  }

  stop() { try { speechSynthesis.cancel(); } catch { /* fine */ } }
}
