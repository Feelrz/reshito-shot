// Small shared helpers
export const $ = (id) => document.getElementById(id);
export const rnd = (a, b) => a + Math.random() * (b - a);
export const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const pad = (n, l = 2) => String(n).padStart(l, '0');
export const smooth = (e0, e1, x) => { const t = clamp((x - e0) / (e1 - e0), 0, 1); return t * t * (3 - 2 * t); };
export const inFrame = (() => { try { return window.self !== window.top; } catch { return true; } })();

export function makeCanvas(w, h, opts) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return [c, c.getContext('2d', opts)];
}

// fast seeded PRNG (mulberry32)
export function prng(seed = (Math.random() * 2 ** 32) >>> 0) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function loadScript(src) {
  return new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = src; s.async = true;
    s.onload = () => res(); s.onerror = () => rej(new Error('script failed: ' + src));
    document.head.appendChild(s);
  });
}

export function canvasToBlob(canvas, type = 'image/png', quality) {
  return new Promise((res) => canvas.toBlob((b) => res(b), type, quality));
}

export function blobToBase64(blob) {
  return new Promise((res, rej) => {
    const fr = new FileReader();
    fr.onload = () => res(String(fr.result).split(',')[1]);
    fr.onerror = rej;
    fr.readAsDataURL(blob);
  });
}

export async function decodeImage(src) {
  const img = new Image();
  img.decoding = 'async';
  img.src = src;
  await img.decode();
  return img;
}

export function percentile(arr, p) {
  if (!arr.length) return 0;
  const a = Float64Array.from(arr).sort();
  return a[Math.min(a.length - 1, Math.max(0, Math.round((a.length - 1) * p)))];
}

// Encode a canvas off the main thread when possible (keeps the paper-feed animation smooth)
let encWorker = null, encSeq = 0;
const encWait = new Map();
function encoder() {
  if (encWorker !== null) return encWorker;
  try {
    const src = `self.onmessage = async (e) => {
      const { id, bmp, type, quality } = e.data;
      try {
        const c = new OffscreenCanvas(bmp.width, bmp.height);
        c.getContext('2d').drawImage(bmp, 0, 0); bmp.close();
        self.postMessage({ id, blob: await c.convertToBlob({ type, quality }) });
      } catch (err) { self.postMessage({ id, error: String(err) }); }
    };`;
    encWorker = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
    encWorker.onmessage = (e) => {
      const w = encWait.get(e.data.id);
      if (!w) return;
      encWait.delete(e.data.id);
      if (e.data.blob) w.res(e.data.blob); else w.rej(new Error(e.data.error));
    };
    encWorker.onerror = () => { encWorker = false; for (const w of encWait.values()) w.rej(new Error('worker')); encWait.clear(); };
  } catch { encWorker = false; }
  return encWorker;
}

export async function encodeCanvas(canvas, type = 'image/png', quality) {
  const w = typeof OffscreenCanvas !== 'undefined' && window.createImageBitmap ? encoder() : false;
  if (w) {
    try {
      const bmp = await createImageBitmap(canvas);
      const id = ++encSeq;
      return await new Promise((res, rej) => { encWait.set(id, { res, rej }); w.postMessage({ id, bmp, type, quality }, [bmp]); });
    } catch {}
  }
  return canvasToBlob(canvas, type, quality);
}

// WebP when the browser can encode it (Chrome, Firefox, Edge), otherwise PNG/JPEG
export async function encodeBest(canvas, { alpha = true, quality = 0.95 } = {}) {
  let blob = await encodeCanvas(canvas, 'image/webp', quality);
  if (!blob || blob.type !== 'image/webp') blob = await encodeCanvas(canvas, alpha ? 'image/png' : 'image/jpeg', alpha ? undefined : 0.92);
  return blob;
}
