// Thermal print engine: tone → dither → dot gain → head artefacts → paper grain → torn edges → scan softness
import { clamp, rnd, smooth, makeCanvas, prng } from './util.js';
import { WATERMARK } from './config.js';

export const INK = [24, 23, 25];          // thermal black (very slightly cool)
export const DOT_REF = 2;                 // thermal dot size in receipt px (at scale 1)
export const TOOTH_W_REF = 22;            // torn-edge tooth width, receipt px (~1.6 mm)
export const TOOTH_D_REF = 12;            // torn-edge tooth depth, receipt px

/* ---------------------------------------------------------------------- */
/*  Tone + dither (shared by live preview and print)                       */
/* ---------------------------------------------------------------------- */
export function boxBlur(src, w, h, r) {
  const tmp = new Float32Array(src.length), out = new Float32Array(src.length), n = r * 2 + 1;
  for (let y = 0; y < h; y++) {
    const row = y * w; let acc = 0;
    for (let x = -r; x <= r; x++) acc += src[row + clamp(x, 0, w - 1)];
    for (let x = 0; x < w; x++) {
      tmp[row + x] = acc / n;
      acc += src[row + Math.min(w - 1, x + r + 1)] - src[row + Math.max(0, x - r)];
    }
  }
  for (let x = 0; x < w; x++) {
    let acc = 0;
    for (let y = -r; y <= r; y++) acc += tmp[clamp(y, 0, h - 1) * w + x];
    for (let y = 0; y < h; y++) {
      out[y * w + x] = acc / n;
      acc += tmp[Math.min(h - 1, y + r + 1) * w + x] - tmp[Math.max(0, y - r) * w + x];
    }
  }
  return out;
}

function histPct(hist, total, p) {
  const target = total * p; let acc = 0;
  for (let i = 0; i < 256; i++) { acc += hist[i]; if (acc >= target) return i / 255; }
  return 1;
}

/** rgba → Uint8Array (1 = ink dot). mode: 'focus' (no background) | 'full' (faded background) */
export function thermal(rgba, w, h, mask, mode, out, noise = 0.16) {
  const N = w * h;
  const L = new Float32Array(N);
  for (let i = 0, j = 0; i < N; i++, j += 4) L[i] = (rgba[j] * 0.299 + rgba[j + 1] * 0.587 + rgba[j + 2] * 0.114) / 255;

  let m = null;
  if (mask) { m = new Float32Array(N); for (let i = 0; i < N; i++) m[i] = smooth(0.3, 0.7, mask[i]); }

  const hist = new Uint32Array(256); let cnt = 0;
  for (let i = 0; i < N; i++) if (!m || m[i] > 0.5) { hist[(L[i] * 255) | 0]++; cnt++; }
  if (cnt < N * 0.03) { hist.fill(0); for (let i = 0; i < N; i++) hist[(L[i] * 255) | 0]++; cnt = N; }
  const lo = histPct(hist, cnt, 0.02), hi = histPct(hist, cnt, 0.985);
  const span = Math.max(0.22, hi - lo);
  for (let i = 0; i < N; i++) L[i] = clamp((L[i] - lo) / span, 0, 1);

  const r = w > 260 ? 2 : 1;
  const B = boxBlur(boxBlur(L, w, h, r), w, h, r);
  for (let i = 0; i < N; i++) {
    let v = L[i] + 0.85 * (L[i] - B[i]);
    v = Math.pow(clamp(v, 0, 1), 0.82);
    if (m) {
      const bg = mode === 'focus' ? 1 : 1 - (1 - v) * 0.38;
      v = v * m[i] + bg * (1 - m[i]);
    }
    L[i] = v;
  }

  // Floyd–Steinberg, serpentine, with threshold noise (xerox-like grain)
  for (let y = 0; y < h; y++) {
    const ltr = (y & 1) === 0, row = y * w;
    for (let k = 0; k < w; k++) {
      const x = ltr ? k : w - 1 - k, i = row + x;
      const old = L[i];
      const nw = old < 0.5 + (Math.random() - 0.5) * noise ? 0 : 1;
      out[i] = nw === 0 ? 1 : 0;
      const e = old - nw, dx = ltr ? 1 : -1;
      if (x + dx >= 0 && x + dx < w) L[i + dx] += e * 0.4375;
      if (y + 1 < h) {
        if (x - dx >= 0 && x - dx < w) L[i + w - dx] += e * 0.1875;
        L[i + w] += e * 0.3125;
        if (x + dx >= 0 && x + dx < w) L[i + w + dx] += e * 0.0625;
      }
    }
  }
  return out;
}

export function resampleMask(m, tw, th) {
  if (!m) return null;
  if (m.w === tw && m.h === th) return m.arr;
  const out = new Float32Array(tw * th), { arr, w, h } = m;
  const sx = w / tw, sy = h / th;
  for (let y = 0; y < th; y++) {
    const fy = clamp((y + 0.5) * sy - 0.5, 0, h - 1), y0 = fy | 0, y1 = Math.min(h - 1, y0 + 1), ty = fy - y0;
    for (let x = 0; x < tw; x++) {
      const fx = clamp((x + 0.5) * sx - 0.5, 0, w - 1), x0 = fx | 0, x1 = Math.min(w - 1, x0 + 1), tx = fx - x0;
      const a = arr[y0 * w + x0], b = arr[y0 * w + x1], c = arr[y1 * w + x0], d = arr[y1 * w + x1];
      out[y * tw + x] = (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
    }
  }
  return out;
}

/* ---------------------------------------------------------------------- */
/*  Torn (serrated) paper ends                                             */
/* ---------------------------------------------------------------------- */
export function tornPath(ctx, W, H, tw, td) {
  ctx.beginPath();
  ctx.moveTo(0, td * rnd(0.7, 1.1));
  for (let x = 0; x < W;) {
    const nx = Math.min(W, x + tw * rnd(0.82, 1.18));
    ctx.lineTo(Math.min(W, (x + nx) / 2 + rnd(-tw * 0.1, tw * 0.1)), rnd(0, td * 0.22));
    ctx.lineTo(nx, td * rnd(0.78, 1.15));
    x = nx;
  }
  ctx.lineTo(W, H - td * rnd(0.8, 1.15));
  for (let x = W; x > 0;) {
    const nx = Math.max(0, x - tw * rnd(0.82, 1.18));
    ctx.lineTo(Math.max(0, (x + nx) / 2 + rnd(-tw * 0.1, tw * 0.1)), H - rnd(0, td * 0.22));
    ctx.lineTo(nx, H - td * rnd(0.78, 1.15));
    x = nx;
  }
  ctx.closePath();
}

/* ---------------------------------------------------------------------- */
/*  Photo box from a receipt zone                                          */
/* ---------------------------------------------------------------------- */
export function photoBox(rec, W, H, jitter = 1) {
  const [zx, zy, zw, zh] = rec.zone;
  const bottom = rec.wm != null ? rec.wm * H - H * 0.006 : H - H * 0.01;   // never over the watermark line
  let pw = zw * W * (1 + rnd(-0.04, 0.03) * jitter);
  let ph = pw * 1.25;
  if (ph > bottom - H * 0.01) { ph = bottom - H * 0.01; pw = ph * 0.8; }
  let x = zx * W + (zw * W - pw) / 2 + rnd(-0.015, 0.015) * W * jitter;
  let y = zy * H + (zh * H - ph) / 2 + rnd(-0.012, 0.012) * H * jitter;
  x = clamp(x, W * 0.01, W - pw - W * 0.01);
  y = clamp(y, H * 0.01, bottom - ph);
  return { x, y, w: pw, h: ph };
}

/* ---------------------------------------------------------------------- */
/*  Watermark: the site address, printed by the same head under the last    */
/*  dotted line. Drawn before the print artefacts so it fades with the rest */
/* ---------------------------------------------------------------------- */
const MONO = 'ui-monospace, "SFMono-Regular", Menlo, Consolas, "DejaVu Sans Mono", "Liberation Mono", monospace';
export function drawWatermark(ctx, rec, W, H, text = WATERMARK) {
  if (!text || rec.wm == null) return;
  const lineY = rec.wm * H;
  const room = H - lineY;
  if (room < H * 0.03) return;
  let fs = clamp(W * 0.026, 15, 34);
  ctx.save();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = 'rgb(78,77,80)';
  const font = () => { ctx.font = `500 ${fs.toFixed(1)}px ${MONO}`; };
  font();
  const maxW = W * 0.8;
  const tw = ctx.measureText(text).width;
  if (tw > maxW) { fs *= maxW / tw; font(); }
  if ('letterSpacing' in ctx) ctx.letterSpacing = `${(fs * 0.04).toFixed(2)}px`;
  ctx.fillText(text, W / 2, lineY + Math.min(fs * 1.55, room * 0.42));
  ctx.restore();
}

/* ---------------------------------------------------------------------- */
/*  Compose a print                                                        */
/*  shot = { canvas, mask:{arr,w,h}|null, mode }  rec = library item        */
/* ---------------------------------------------------------------------- */
export function composePrint(shot, rec, img, opts = {}) {
  const rand = prng();
  const scale = rec.scale || 1;
  const SC = rec.w * scale < 700 ? 2 : 1;                 // keep exports at a usable resolution
  const W = Math.round(rec.w * SC), H = Math.round(rec.h * SC);
  const dot = Math.max(1.5, (DOT_REF / scale) * SC);
  const toothW = (TOOTH_W_REF / scale) * SC, toothD = (TOOTH_D_REF / scale) * SC;

  // 1) receipt as it came out of the printer
  const [base, bctx] = makeCanvas(W, H, { willReadFrequently: true });
  bctx.imageSmoothingQuality = 'high';
  bctx.drawImage(img, 0, 0, W, H);
  if (opts.watermark !== false) drawWatermark(bctx, rec, W, H);
  const id = bctx.getImageData(0, 0, W, H);
  const px = id.data;

  // paper tone = median-ish of the top margin row band
  let pr = 0, pg = 0, pb = 0, pn = 0;
  for (let y = Math.round(H * 0.004); y < Math.round(H * 0.012) + 1; y++) {
    for (let x = Math.round(W * 0.1); x < W * 0.9; x += 3) {
      const i = (y * W + x) * 4;
      if (px[i] + px[i + 1] + px[i + 2] > 560) { pr += px[i]; pg += px[i + 1]; pb += px[i + 2]; pn++; }
    }
  }
  const paper = pn ? [pr / pn, pg / pn, pb / pn] : [242, 240, 235];

  // 2) photo → thermal dots
  const box = photoBox(rec, W, H, opts.jitter ?? 1);
  const dW = Math.max(40, Math.round(box.w / dot)), dH = Math.round(dW * 1.25);
  const [sc, sctx] = makeCanvas(dW, dH, { willReadFrequently: true });
  sctx.imageSmoothingQuality = 'high';
  sctx.drawImage(shot.canvas, 0, 0, dW, dH);
  const src = sctx.getImageData(0, 0, dW, dH).data;
  const mask = shot.mask ? resampleMask(shot.mask, dW, dH) : null;
  const ink = thermal(src, dW, dH, mask, shot.mode, new Uint8Array(dW * dH));

  // per-dot energy (thermal head heat varies a little dot to dot)
  const dimg = sctx.createImageData(dW, dH);
  const du = new Uint32Array(dimg.data.buffer);
  for (let i = 0; i < ink.length; i++) if (ink[i]) du[i] = ((200 + rand() * 55) << 24) >>> 0;
  sctx.putImageData(dimg, 0, 0);

  // dot gain: upsample the dot map smoothly, then re-threshold softly → round, merging dots
  const PX = Math.round(box.x), PY = Math.round(box.y), PW = Math.round(dW * dot), PH = Math.round(dH * dot);
  const [ac, actx] = makeCanvas(PW, PH, { willReadFrequently: true });
  actx.imageSmoothingEnabled = true; actx.imageSmoothingQuality = 'high';
  if ('filter' in actx && dot >= 2) actx.filter = `blur(${(dot * 0.22).toFixed(2)}px)`;
  actx.drawImage(sc, 0, 0, PW, PH);
  const A = actx.getImageData(0, 0, PW, PH).data;

  // 3) print-head density field shared by the receipt text AND the photo
  const G = 56;
  const gx = Math.ceil(W / G) + 2, gy = Math.ceil(H / G) + 2;
  let grid = new Float32Array(gx * gy).map(() => rand());
  grid = boxBlur(grid, gx, gy, 1);
  const gmin = Math.min(...grid), gmax = Math.max(...grid);
  for (let i = 0; i < grid.length; i++) grid[i] = (grid[i] - gmin) / Math.max(1e-6, gmax - gmin);
  const fadeAmt = rnd(0.12, 0.2);
  let shade = new Float32Array(gx * gy).map(() => rand());
  shade = boxBlur(boxBlur(shade, gx, gy, 2), gx, gy, 2);
  const smin = Math.min(...shade), smax = Math.max(...shade);
  for (let i = 0; i < shade.length; i++) shade[i] = 0.975 + 0.025 * (shade[i] - smin) / Math.max(1e-6, smax - smin);

  const band = new Float32Array(H);                       // paper-feed banding
  const ph1 = rand() * 6.28, ph2 = rand() * 6.28, f1 = rnd(2, 4) / H, f2 = rnd(9, 15) / H;
  for (let y = 0; y < H; y++) band[y] = 1 - 0.035 * (0.5 + 0.5 * Math.sin(y * f1 * 6.28 + ph1)) - 0.02 * (0.5 + 0.5 * Math.sin(y * f2 * 6.28 + ph2));
  const nGlitch = rand() < 0.55 ? 1 : 0;                  // one feed hiccup: a pale line across
  for (let g = 0; g < nGlitch; g++) {
    const y0 = Math.floor(rnd(0.2, 0.85) * H), hh = Math.max(1, Math.round(dot * rnd(0.6, 1.4)));
    for (let y = y0; y < Math.min(H, y0 + hh); y++) band[y] *= rnd(0.55, 0.75);
  }

  const col = new Float32Array(W);                        // head pressure + dead elements
  const side = rand() < 0.5, press = rnd(0.04, 0.1);
  for (let x = 0; x < W; x++) { const t = side ? x / W : 1 - x / W; col[x] = 1 - press * t * t; }
  const nStreak = rand() < 0.7 ? (rand() < 0.35 ? 2 : 1) : 0;
  for (let s = 0; s < nStreak; s++) {
    const x0 = Math.floor(rnd(0.08, 0.92) * W), sw = Math.max(1, Math.round(dot * rnd(0.5, 0.9)));
    const k = rnd(0.25, 0.5);
    for (let x = x0; x < Math.min(W, x0 + sw); x++) col[x] *= k;
  }

  // 4) per-pixel composite
  const ir = 1 - INK[0] / 255, ig = 1 - INK[1] / 255, ib = 1 - INK[2] / 255;
  const rowGrid = new Float32Array(gx), rowShade = new Float32Array(gx);
  const grain = 3.2;
  for (let y = 0; y < H; y++) {
    const fy = y / G, y0 = Math.min(gy - 1, fy | 0), y1 = Math.min(gy - 1, y0 + 1), ty = fy - (fy | 0);
    for (let k = 0; k < gx; k++) {
      rowGrid[k] = grid[y0 * gx + k] * (1 - ty) + grid[y1 * gx + k] * ty;
      rowShade[k] = shade[y0 * gx + k] * (1 - ty) + shade[y1 * gx + k] * ty;
    }
    const inPhotoY = y >= PY && y < PY + PH;
    const bandY = band[y];
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      const fx = x / G, x0 = fx | 0, tx = fx - x0;
      const x1 = Math.min(gx - 1, x0 + 1);
      const fade = rowGrid[x0] * (1 - tx) + rowGrid[x1] * tx;
      const sh = rowShade[x0] * (1 - tx) + rowShade[x1] * tx;
      const d = (1 - fadeAmt * fade) * bandY * col[x];
      const sp = rand();
      const speck = 1 - 0.32 * sp * sp * sp;              // thermal dropouts: ink never lands perfectly evenly

      // receipt text printed by the same head: lift ink toward paper where density is low
      const dd = d * speck;
      let r = paper[0] + (px[i] - paper[0]) * dd;
      let g = paper[1] + (px[i + 1] - paper[1]) * dd;
      let b = paper[2] + (px[i + 2] - paper[2]) * dd;

      if (inPhotoY && x >= PX && x < PX + PW) {
        const a0 = A[((y - PY) * PW + (x - PX)) * 4 + 3] / 255;
        if (a0 > 0.02) {
          const a = smooth(0.3, 0.66, a0) * dd * 0.97;
          r *= 1 - a * ir; g *= 1 - a * ig; b *= 1 - a * ib;
        }
      }
      const n = (rand() - 0.5) * grain;
      px[i] = r * sh + n; px[i + 1] = g * sh + n; px[i + 2] = b * sh + n * 0.9;
    }
  }
  bctx.putImageData(id, 0, 0);

  // 5) tear it off + a touch of scanner softness
  const [out, octx] = makeCanvas(W, H);
  octx.save();
  tornPath(octx, W, H, toothW, toothD);
  octx.clip();
  if ('filter' in octx) octx.filter = `blur(${(0.35 * SC).toFixed(2)}px)`;
  octx.drawImage(base, 0, 0);
  octx.filter = 'none';
  octx.lineWidth = 1.4 * SC;
  octx.strokeStyle = 'rgba(255,255,255,0.5)';           // fibrous, slightly lighter torn rim
  octx.stroke();
  octx.restore();

  return { canvas: out, W, H, toothD, box: { x: PX, y: PY, w: PW, h: PH } };
}
