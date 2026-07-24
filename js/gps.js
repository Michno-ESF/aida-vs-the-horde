export function haversine(a, b) {
  const R = 6371000, rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLng = (b.lng - a.lng) * rad;
  const s = Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

/**
 * Wraps geolocation.watchPosition, or fakes a runner wandering around
 * Copenhagen in demo mode so the game can be tried indoors / on desktop.
 */
export class Tracker {
  constructor(demo) {
    this.demo = demo;
    this.watchId = null;
    this.timer = null;
    this.demoSpeed = 2.8;                       // m/s
    this._pos = { lat: 55.6761, lng: 12.5683 };
    this._head = Math.random() * Math.PI * 2;
  }

  start(onFix, onError) {
    if (this.demo) {
      this.timer = setInterval(() => {
        this._head += (Math.random() - 0.5) * 0.35;
        const d = this.demoSpeed, R = 6371000, rad = Math.PI / 180;
        this._pos = {
          lat: this._pos.lat + (d * Math.cos(this._head)) / R / rad,
          lng: this._pos.lng + (d * Math.sin(this._head)) / (R * Math.cos(this._pos.lat * rad)) / rad,
        };
        onFix({ ...this._pos, acc: 5, spd: this.demoSpeed, t: Date.now() });
      }, 1000);
      return;
    }
    if (!navigator.geolocation) { onError('unsupported'); return; }
    this.watchId = navigator.geolocation.watchPosition(
      p => onFix({
        lat: p.coords.latitude, lng: p.coords.longitude,
        acc: p.coords.accuracy, spd: p.coords.speed, t: p.timestamp,
      }),
      // code 1 = PERMISSION_DENIED is permanent; code 2/3 (unavailable/timeout) are
      // transient on a phone — a bridge, tunnel or cold start. The watch stays alive
      // and recovers on its own, so callers must not treat these as fatal.
      e => onError(e.code === 1 ? 'denied' : 'transient'),
      { enableHighAccuracy: true, maximumAge: 4000, timeout: 30000 }
    );
  }

  setDemoSpeed(mps) { this.demoSpeed = Math.max(0, mps); }

  stop() {
    if (this.watchId != null) navigator.geolocation.clearWatch(this.watchId);
    if (this.timer) clearInterval(this.timer);
    this.watchId = this.timer = null;
  }
}
