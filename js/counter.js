// Global print counter (shared by every visitor), shown on the split-flap display.
// Providers (pick one in js/config.js):
//   abacus         — free, no sign-up, live updates over Server-Sent Events. Default.
//   upstash-proxy  — your own tiny Cloudflare Worker in front of Upstash Redis (token stays secret). See counter-worker/.
//   upstash        — Upstash REST directly with an ACL-restricted token (INCR/GET on one key only; paid Upstash plans).
import { COUNTER } from './config.js';

const POLL_MS = 12000;
const cfg = { provider: 'abacus', namespace: 'receipt-booth', key: 'prints', ...COUNTER };

function endpoints() {
  const ns = encodeURIComponent(cfg.namespace), key = encodeURIComponent(cfg.key);
  switch (cfg.provider) {
    case 'upstash': {
      const base = String(cfg.url || '').replace(/\/+$/, '');
      const k = encodeURIComponent(`${cfg.namespace}:${cfg.key}`);
      return { get: `${base}/get/${k}`, hit: `${base}/incr/${k}`, auth: cfg.token ? `Bearer ${cfg.token}` : null, read: (j) => Number(j.result || 0) };
    }
    case 'upstash-proxy': {
      const base = String(cfg.url || '').replace(/\/+$/, '');
      return { get: `${base}/get`, hit: `${base}/hit`, read: (j) => Number(j.value || 0) };
    }
    default: {
      const base = 'https://abacus.jasoncameron.dev';
      return { get: `${base}/get/${ns}/${key}`, hit: `${base}/hit/${ns}/${key}`, stream: `${base}/stream/${ns}/${key}`, read: (j) => Number(j.value || 0) };
    }
  }
}

export const Counter = {
  value: null,          // last known global value (null = unknown)
  online: false,
  listeners: new Set(),
  es: null, pollT: 0, started: false, local: 0,

  on(fn) { this.listeners.add(fn); if (this.value != null) fn(this.value, { initial: true }); },
  emit(v, meta = {}) {
    if (!Number.isFinite(v)) return;
    if (this.value != null && v < this.value && !meta.force) return;   // never run backwards
    const initial = this.value == null;
    this.value = v;
    for (const fn of this.listeners) fn(v, { initial, ...meta });
  },

  async request(url) {
    const e = endpoints();
    const res = await fetch(url, { headers: e.auth ? { Authorization: e.auth } : {}, cache: 'no-store' });
    if (res.status === 404) return 0;                                  // counter not created yet
    if (!res.ok) throw new Error('counter ' + res.status);
    return e.read(await res.json());
  },

  async start() {
    if (this.started) return;
    this.started = true;
    try {
      this.emit(await this.request(endpoints().get));
      this.online = true;
    } catch (err) {
      console.warn('[receipt-booth] global counter unavailable, counting locally', err);
      this.online = false;
      this.emit(0);
      return;
    }
    this.live();
  },

  // live updates: SSE when the provider has it, otherwise poll while the tab is visible
  live() {
    const e = endpoints();
    if (e.stream && window.EventSource) {
      try {
        let fails = 0;
        this.es = new EventSource(e.stream);
        this.es.onmessage = (m) => { fails = 0; try { this.emit(e.read(JSON.parse(m.data))); } catch {} };
        this.es.onerror = () => { if (++fails > 3) { this.es.close(); this.es = null; this.poll(); } };
        return;
      } catch {}
    }
    this.poll();
  },
  poll() {
    clearInterval(this.pollT);
    this.pollT = setInterval(async () => {
      if (document.hidden) return;
      try { this.emit(await this.request(endpoints().get)); } catch {}
    }, POLL_MS);
  },

  // one more print
  async hit() {
    this.local += 1;
    if (!this.online) { this.emit((this.value || 0) + 1); return; }
    this.emit((this.value || 0) + 1, { optimistic: true });               // flip right away
    try { this.emit(await this.request(endpoints().hit)); } catch {}
  },
};
