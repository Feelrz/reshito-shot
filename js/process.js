// Automatic receipt preparation: find the paper, straighten it, crop it, and work out where the photo goes.
import { makeCanvas, clamp, percentile, encodeBest, decodeImage } from './util.js';

const MAX_W = 1200, MAX_H = 2800;
export const REF_PITCH = 36;        // typical text-line pitch (receipt px) of the bundled receipt family

export async function loadBitmap(file) {
  if (window.createImageBitmap) { try { return await createImageBitmap(file); } catch {} }
  const url = URL.createObjectURL(file);
  try { return await decodeImage(url); } finally { setTimeout(() => URL.revokeObjectURL(url), 2000); }
}

function sample(src, sw, sh, aw, rot = 0) {
  const ah = Math.max(1, Math.round((sh * aw) / sw));
  const [c, ctx] = makeCanvas(aw, ah, { willReadFrequently: true });
  ctx.imageSmoothingQuality = 'high';
  if (rot) { ctx.translate(aw / 2, ah / 2); ctx.rotate(rot); ctx.translate(-aw / 2, -ah / 2); }
  ctx.drawImage(src, 0, 0, aw, ah);
  return { d: ctx.getImageData(0, 0, aw, ah).data, w: aw, h: ah };
}

function paperMask({ d, w, h }) {
  const m = new Uint8Array(w * h);
  for (let i = 0, j = 0; i < m.length; i++, j += 4) {
    const r = d[j], g = d[j + 1], b = d[j + 2], a = d[j + 3];
    const L = r * 0.299 + g * 0.587 + b * 0.114;
    const sat = Math.max(r, g, b) - Math.min(r, g, b);
    m[i] = a > 200 && L > 150 && sat < 48 ? 1 : 0;
  }
  return m;
}

// first run of 3 paper pixels scanning in from each side
function edges(m, w, h) {
  const left = [], right = [], top = [], bottom = [];
  const run = 3;
  for (let y = 0; y < h; y++) {
    let xl = -1, xr = -1;
    for (let x = 0; x <= w - run; x++) { const i = y * w + x; if (m[i] && m[i + 1] && m[i + 2]) { xl = x; break; } }
    for (let x = w - 1; x >= run - 1; x--) { const i = y * w + x; if (m[i] && m[i - 1] && m[i - 2]) { xr = x; break; } }
    if (xl >= 0 && xr - xl > w * 0.3) { left.push([y, xl]); right.push([y, xr]); }
  }
  for (let x = 0; x < w; x++) {
    let yt = -1, yb = -1;
    for (let y = 0; y <= h - run; y++) { if (m[y * w + x] && m[(y + 1) * w + x] && m[(y + 2) * w + x]) { yt = y; break; } }
    for (let y = h - 1; y >= run - 1; y--) { if (m[y * w + x] && m[(y - 1) * w + x] && m[(y - 2) * w + x]) { yb = y; break; } }
    if (yt >= 0 && yb - yt > h * 0.3) { top.push([x, yt]); bottom.push([x, yb]); }
  }
  return { left, right, top, bottom };
}

// robust least squares v = a*t + b
function fitLine(pts) {
  let use = pts;
  let a = 0, b = 0;
  for (let pass = 0; pass < 3 && use.length > 8; pass++) {
    let st = 0, sv = 0, stt = 0, stv = 0;
    for (const [t, v] of use) { st += t; sv += v; stt += t * t; stv += t * v; }
    const n = use.length, den = n * stt - st * st;
    a = den ? (n * stv - st * sv) / den : 0;
    b = (sv - a * st) / n;
    const res = use.map(([t, v]) => Math.abs(v - (a * t + b)));
    const lim = Math.max(1.5, percentile(res, 0.5) * 3);
    use = use.filter((p, k) => res[k] <= lim);
  }
  return { a, b, n: use.length };
}

function skewAngle(m, w, h) {
  const e = edges(m, w, h);
  const cands = [];
  const touches = (pts, edge) => pts.filter(([, v]) => Math.abs(v - edge) <= 1).length > pts.length * 0.6;
  if (e.left.length > h * 0.3 && !touches(e.left, 0)) cands.push(Math.atan(fitLine(e.left).a));
  if (e.right.length > h * 0.3 && !touches(e.right, w - 1)) cands.push(Math.atan(fitLine(e.right).a));
  if (e.top.length > w * 0.3 && !touches(e.top, 0)) cands.push(-Math.atan(fitLine(e.top).a));
  if (e.bottom.length > w * 0.3 && !touches(e.bottom, h - 1)) cands.push(-Math.atan(fitLine(e.bottom).a));
  if (!cands.length) return 0;
  cands.sort((p, q) => p - q);
  const ang = cands[Math.floor(cands.length / 2)];
  const deg = (ang * 180) / Math.PI;
  return Math.abs(deg) < 0.15 || Math.abs(deg) > 10 ? 0 : ang;
}

/* ---------------------------------------------------------------------- */
/*  Content analysis → photo zone + line pitch                              */
/* ---------------------------------------------------------------------- */
export function analyseContent(src, W, H) {
  const aw = 240;
  const s = sample(src, W, H, aw);
  const { d, w, h } = s;
  const Ls = new Float32Array(w * h);
  for (let i = 0, j = 0; i < Ls.length; i++, j += 4) Ls[i] = d[j] * 0.299 + d[j + 1] * 0.587 + d[j + 2] * 0.114;
  const Lp = percentile(Array.from(Ls.filter((_, i) => i % 7 === 0)), 0.8);
  const inkF = new Float32Array(h), colF = new Float32Array(h), trans = new Uint16Array(h);
  for (let y = 0; y < h; y++) {
    let ink = 0, col = 0, tr = 0, prev = 0;
    for (let x = 0; x < w; x++) {
      const i = y * w + x, j = i * 4;
      const sat = Math.max(d[j], d[j + 1], d[j + 2]) - Math.min(d[j], d[j + 1], d[j + 2]);
      const isInk = Ls[i] < Lp - 55 || sat > 70 ? 1 : 0;
      if (sat > 70) col++;
      ink += isInk;
      if (x > 0 && isInk !== prev) tr++;
      prev = isInk;
    }
    inkF[y] = ink / w; colF[y] = col / w; trans[y] = tr;
  }
  // barcode rows: many bar transitions, medium coverage, in a tall block
  const bar = new Uint8Array(h);
  for (let y = 0; y < h; y++) bar[y] = trans[y] >= 22 && inkF[y] > 0.18 && inkF[y] < 0.82 ? 1 : 0;
  const runs = (flags, minLen) => {
    const out = []; let st = -1;
    for (let y = 0; y <= h; y++) {
      const f = y < h && flags[y];
      if (f && st < 0) st = y;
      if (!f && st >= 0) { if (y - st >= minLen) out.push([st, y]); st = -1; }
    }
    return out;
  };
  const barRuns = runs(bar, Math.max(4, Math.round(h * 0.012)));
  const isBar = new Uint8Array(h);
  for (const [a, b] of barRuns) for (let y = a; y < b; y++) isBar[y] = 1;
  const mainBar = barRuns.slice().sort((p, q) => (q[1] - q[0]) - (p[1] - p[0]))[0] || null;

  // separators (solid or dashed rules): thin rows with long coverage or regular dashes
  const sepFlag = new Uint8Array(h);
  for (let y = 0; y < h; y++) sepFlag[y] = !isBar[y] && (inkF[y] > 0.5 || (trans[y] >= 14 && inkF[y] > 0.1 && inkF[y] < 0.6)) ? 1 : 0;
  const seps = runs(sepFlag, 1).filter(([a, b]) => b - a <= Math.max(3, h * 0.006)).map(([a, b]) => (a + b) / 2);

  // header = store name block: up to the first rule (or first big gap) below the top
  let headerEnd = seps.find((y) => y > h * 0.04 && y < h * 0.4);
  if (headerEnd == null) {
    let y = 0; while (y < h && inkF[y] < 0.01) y++;
    let gap = 0;
    for (; y < h; y++) { if (inkF[y] < 0.01) { if (++gap > h * 0.012) break; } else gap = 0; }
    headerEnd = y - gap;
  }
  headerEnd = clamp(headerEnd, h * 0.05, h * 0.32);

  // photo size: wide, 4:5
  let pw = w * 0.84, ph = pw * 1.25;
  if (ph > h * 0.9) { ph = h * 0.9; pw = ph * 0.8; }
  const bodyTop = headerEnd, bodyBot = mainBar ? mainBar[0] : h * 0.9;
  const bodyMid = (bodyTop + bodyBot) / 2;
  const rowCost = new Float32Array(h);
  for (let y = 0; y < h; y++) {
    rowCost[y] = (y < headerEnd ? 3 : 0) + (isBar[y] ? 1.6 : 0) + colF[y] * 6 + (mainBar && y >= mainBar[1] ? 0.8 : 0);
  }
  const cum = new Float32Array(h + 1);
  for (let y = 0; y < h; y++) cum[y + 1] = cum[y] + rowCost[y];
  const P = Math.round(ph);
  let best = Math.max(0, bodyMid - ph / 2), bestCost = Infinity;
  for (let y = Math.round(h * 0.02); y <= h - P - Math.round(h * 0.015); y++) {
    const c = cum[y + P] - cum[y] + 0.6 * Math.abs(y + ph / 2 - bodyMid);
    if (c < bestCost) { bestCost = c; best = y; }
  }

  // text line pitch (for size normalisation of uploads)
  const textRows = new Uint8Array(h);
  for (let y = 0; y < h; y++) textRows[y] = !isBar[y] && inkF[y] > 0.015 ? 1 : 0;
  const lines = runs(textRows, 1).filter(([a, b]) => b - a < h * 0.04);
  const steps = [];
  for (let k = 1; k < lines.length; k++) { const st = lines[k][0] - lines[k - 1][0]; if (st > 2 && st < h * 0.06) steps.push(st); }
  const pitch = steps.length >= 4 ? percentile(steps, 0.5) * (W / w) : 0;

  return {
    zone: [(w - pw) / 2 / w, best / h, pw / w, ph / h],
    pitch,
    debug: { headerEnd: headerEnd / h, barcode: mainBar ? [mainBar[0] / h, mainBar[1] / h] : null, seps: seps.map((y) => y / h) },
  };
}

/* ---------------------------------------------------------------------- */
/*  Coloured pictures (pixel art, logos…) — such receipts start switched off */
/*  Red stamps (VOID, PAID…) are fine and don't count.                       */
/* ---------------------------------------------------------------------- */
export function detectColorArt(src, W, H) {
  const { d } = sample(src, W, H, 200);
  let n = 0;
  for (let j = 0; j < d.length; j += 4) {
    const r = d[j], g = d[j + 1], b = d[j + 2];
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    if (mx - mn < 60) continue;
    let h;
    if (mx === r) h = (60 * ((g - b) / (mx - mn)) + 360) % 360;
    else if (mx === g) h = 60 * ((b - r) / (mx - mn)) + 120;
    else h = 60 * ((r - g) / (mx - mn)) + 240;
    if (h >= 22 && h <= 330) n++;
  }
  return n > 25 * ((200 * Math.round((H * 200) / W)) / 60000);
}

/* ---------------------------------------------------------------------- */
/*  Full pipeline for one uploaded file                                    */
/* ---------------------------------------------------------------------- */
export async function processReceipt(file, { autoScale = true } = {}) {
  const bmp = await loadBitmap(file);
  let sw = bmp.width, sh = bmp.height;
  const k = Math.min(1, MAX_W / sw, MAX_H / sh);
  const W0 = Math.round(sw * k), H0 = Math.round(sh * k);

  // 1) find skew on a small copy
  const aw = Math.min(360, W0);
  const s0 = sample(bmp, W0, H0, aw);
  const ang = skewAngle(paperMask(s0), s0.w, s0.h);

  // 2) straighten at full size
  const [rc, rctx] = makeCanvas(W0, H0);
  rctx.imageSmoothingQuality = 'high';
  if (ang) { rctx.translate(W0 / 2, H0 / 2); rctx.rotate(ang); rctx.translate(-W0 / 2, -H0 / 2); }
  rctx.drawImage(bmp, 0, 0, W0, H0);
  if (bmp.close) bmp.close();

  // 3) crop to the paper
  const s1 = sample(rc, W0, H0, aw);
  const m1 = paperMask(s1);
  const e = edges(m1, s1.w, s1.h);
  const f = W0 / s1.w;
  let x0 = 0, x1 = s1.w - 1, y0 = 0, y1 = s1.h - 1;
  if (e.left.length) { x0 = percentile(e.left.map((p) => p[1]), 0.9); x1 = percentile(e.right.map((p) => p[1]), 0.1); }
  if (e.top.length) { y0 = percentile(e.top.map((p) => p[1]), 0.9); y1 = percentile(e.bottom.map((p) => p[1]), 0.1); }
  const inset = ang ? 2 : 1;
  let cx = Math.max(0, Math.round((x0 + (x0 > 0 ? inset : 0)) * f));
  let cy = Math.max(0, Math.round((y0 + (y0 > 0 ? inset : 0)) * f));
  let cw = Math.min(W0 - cx, Math.round((x1 - x0 + 1 - (x0 > 0 ? inset : 0) - (x1 < s1.w - 1 ? inset : 0)) * f));
  let ch = Math.min(H0 - cy, Math.round((y1 - y0 + 1 - (y0 > 0 ? inset : 0) - (y1 < s1.h - 1 ? inset : 0)) * f));
  if (cw < W0 * 0.3 || ch < H0 * 0.3) { cx = 0; cy = 0; cw = W0; ch = H0; }   // detection failed → keep everything

  // paper colour for flattening any transparency
  let pr = 0, pg = 0, pb = 0, pn = 0;
  for (let i = 0, j = 0; i < m1.length; i += 5, j += 20) if (m1[i]) { pr += s1.d[j]; pg += s1.d[j + 1]; pb += s1.d[j + 2]; pn++; }
  const paper = pn ? `rgb(${Math.round(pr / pn)},${Math.round(pg / pn)},${Math.round(pb / pn)})` : '#f2f0eb';

  const [out, octx] = makeCanvas(cw, ch);
  octx.fillStyle = paper; octx.fillRect(0, 0, cw, ch);
  octx.drawImage(rc, cx, cy, cw, ch, 0, 0, cw, ch);

  // 4) where should the photo go + how big is this receipt physically
  const info = analyseContent(out, cw, ch);
  const colorArt = detectColorArt(out, cw, ch);
  let scale = 1;
  if (autoScale && info.pitch) {
    const s = REF_PITCH / info.pitch;
    if (s > 1.45 || s < 1 / 1.45) scale = clamp(Math.round(s * 100) / 100, 0.5, 2.5);
  }

  // 5) encode
  const blob = await encodeBest(out, { alpha: false, quality: 0.9 });
  const ext = blob.type === 'image/webp' ? 'webp' : 'jpg';
  return {
    blob, type: blob.type, ext, w: cw, h: ch, zone: info.zone.map((v) => Math.round(v * 10000) / 10000),
    scale, colorArt, skew: (ang * 180) / Math.PI, pitch: info.pitch, debug: info.debug,
  };
}

// Re-run zone detection for an existing receipt image
export function autoZone(img, w, h) {
  return analyseContent(img, w, h).zone.map((v) => Math.round(v * 10000) / 10000);
}
