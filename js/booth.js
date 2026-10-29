// RECEIPT BOOTH — the photobooth itself
import { $, rnd, clamp, sleep, pad, inFrame, makeCanvas, canvasToBlob, decodeImage, encodeBest, encodeCanvas } from './util.js';
import { Seg } from './seg.js';
import { Sound } from './sound.js';
import { thermal, composePrint, INK } from './print.js';
import { Library } from './library.js';
import { crumpleAndToss, resetImage } from './toss.js';
import { Counter } from './counter.js';
import { createFlap } from './flap.js';

// Printer geometry (unscaled px, must match booth.css)
const PRINTER_W = 500, PRINTER_H = 196, SLOT_CY = 24, SLOT_W = PRINTER_W * 0.92;
const MAX_BOARD = 18;

const el = {
  stage: $('stage'), board: $('board'), track: $('track'), printer: $('printer'),
  viewfinder: $('viewfinder'), preview: $('preview'), countdown: $('countdown'),
  vfEmpty: $('vfEmpty'), vfNote: $('vfNote'), vfMeta: $('vfMeta'), startBtn: $('startBtn'),
  file1: $('fileInput'), file2: $('fileInput2'), lcd1: $('lcd1'), lcd2: $('lcd2'), led: $('led'),
  printBtn: $('printBtn'), modeSwitch: $('modeSwitch'), bgSwitch: $('bgSwitch'), bgRow: $('bgRow'), bgState: $('bgState'), soundBtn: $('soundBtn'), count: $('count'), themeBtn: $('themeBtn'), toggles: $('toggles'), counterBox: $('counterBox'),
  hint: $('hint'), flash: $('flash'), video: $('video'), camBtn: $('camBtn'),
  lightbox: $('lightbox'), lbImg: $('lbImg'), lbSave: $('lbSave'), lbDelete: $('lbDelete'), lbClose: $('lbClose'), lbNote: $('lbNote'),
};

export const S = {
  state: 'idle',            // idle | starting | nosource | live | countdown | capturing | printing | tear
  mode: 'full',             // full (whole photo, no detection) — default | focus (person cut-out)
  bg: false,                // focus only: false = background removed, true = faded background
  source: null,             // { type: 'camera'|'image', el, mirror, key }
  printed: 0,
  items: [],
  z: 10,
  L: null,
  refs: { w: 900, h: 1500 },
  lightboxItem: null,
  paused: false,
  tearNow: null,
};

/* =========================================================================
   Layout
   ========================================================================= */
function libraryRefs() {
  const it = Library.enabled();
  if (!it.length) return { w: 900, h: 1500 };
  const hs = it.map((r) => r.h * r.scale).sort((a, b) => a - b);
  const ws = it.map((r) => r.w * r.scale).sort((a, b) => a - b);
  return { h: hs[Math.floor((hs.length - 1) * 0.8)], w: ws[Math.floor((ws.length - 1) * 0.85)] };
}

function layout() {
  const vw = window.innerWidth, vh = window.innerHeight;
  const k = clamp(Math.min((vw * 0.94) / PRINTER_W, (vh * 0.27) / PRINTER_H), 0.6, 1.1);
  // on narrow screens the footer sits in its own row under the printer
  const footer = document.querySelector('.hud-bottom');
  const narrowUI = vw <= 760;
  if (el.toggles && footer) {
    const home = narrowUI ? footer : el.counterBox.parentElement;
    const before = narrowUI ? footer.querySelector('.hud-bottom-right') : el.counterBox;
    if (el.toggles.parentElement !== home) home.insertBefore(el.toggles, before);
  }
  const footerH = narrowUI && footer ? footer.getBoundingClientRect().height : 0;
  const bottom = footerH ? footerH + 4 : clamp(vh * 0.06, 44, 64);
  el.printer.style.setProperty('--k', k);
  el.printer.style.bottom = bottom + 'px';

  const printerTop = vh - bottom - PRINTER_H * k;
  const slotY = printerTop + SLOT_CY * k;
  const slotW = SLOT_W * k;
  const topPad = vw < 640 ? 46 : 56;
  const availH = slotY - topPad - 8;
  const s = Math.min(availH / S.refs.h, (slotW * 0.96) / S.refs.w, 1);

  const prevAvail = slotY - 30 * k - 36 - topPad;
  let pH = Math.min(prevAvail * 0.94, 560);
  let pW = pH * 0.8;
  if (pW > vw - 56) { pW = vw - 56; pH = pW * 1.25; }
  const dpr = window.devicePixelRatio || 1;
  const dotCss = dpr >= 2 ? 1.5 : 2;
  const dotsW = Math.max(80, Math.round(pW / dotCss));
  const dotsH = Math.round(dotsW * 1.25);
  pW = dotsW * dotCss; pH = dotsH * dotCss;
  const pTop = topPad + Math.max(0, (prevAvail - pH) / 2);

  Object.assign(el.viewfinder.style, { width: pW + 'px', height: pH + 'px', top: pTop + 'px', left: (vw - pW) / 2 + 'px' });
  el.track.style.height = slotY + 'px';
  if (el.preview.width !== dotsW || el.preview.height !== dotsH) {
    el.preview.width = dotsW; el.preview.height = dotsH;
    Live.resize(dotsW, dotsH);
  }
  const centerW = Math.max(PRINTER_W * k, pW + 40) + 32;
  const narrow = (vw - centerW) / 2 < 150;
  const changed = S.L && S.L.narrow !== narrow;
  S.L = { vw, vh, k, slotY, slotW, s, pW, pH, centerW, topPad, availH, narrow };
  document.body.classList.toggle('narrow', narrow);

  for (const it of S.items) {
    if (changed) { const sp = pickSpot(it.rec, it.w, it.h); it.x = sp.x; it.y = sp.y; }
    it.x = clamp(it.x, it.w * 0.2, vw - it.w * 0.2);
    it.y = clamp(it.y, 50, vh - 50);
    keepClear(it, false);
    placeItem(it);
  }
}

/* =========================================================================
   Live preview loop (thermal dots, optional person cut-out)
   ========================================================================= */
const Live = {
  w: 0, h: 0, src: null, sctx: null, segIn: null, segCtx: null, pctx: null, img: null, u32: null, ink: null,
  liveMask: null, staticMask: null, staticKey: '', segBusy: false, last: 0,
  resize(w, h) {
    this.w = w; this.h = h;
    [this.src, this.sctx] = makeCanvas(w, h, { willReadFrequently: true });
    [this.segIn, this.segCtx] = makeCanvas(w, h);
    this.pctx = el.preview.getContext('2d');
    this.img = this.pctx.createImageData(w, h);
    this.u32 = new Uint32Array(this.img.data.buffer);
    this.ink = new Uint8Array(w * h);
    this.liveMask = null; this.staticKey = '';
  },
  requestMask() {
    if (Seg.status !== 'ready' || this.segBusy) return;
    const w = this.w, h = this.h;
    const isStatic = S.source.type === 'image';
    const key = S.source.key + ':' + w;
    if (isStatic && this.staticKey === key) return;
    this.segBusy = true;
    this.segCtx.drawImage(this.src, 0, 0);
    Seg.segment(this.segIn, w, h).then((m) => {
      this.segBusy = false;
      if (!m || w !== this.w || h !== this.h) return;
      if (isStatic) { this.staticMask = m; this.staticKey = key; return; }
      const prev = this.liveMask;
      if (prev && prev.length === m.length) for (let i = 0; i < m.length; i++) m[i] = m[i] * 0.65 + prev[i] * 0.35;
      this.liveMask = m;
    });
  },
  tick(now) {
    requestAnimationFrame((t) => Live.tick(t));
    if (S.paused || !S.source || (S.state !== 'live' && S.state !== 'countdown')) return;
    if (S.state === 'live') camWatch();
    if (!el.lightbox.hidden) return;                 // preview is covered: save CPU (and keep animations smooth)
    if (now - this.last < 30) return;
    this.last = now;
    if (S.source.type === 'camera' && el.video.readyState < 2) return;
    if (!drawCrop(this.sctx, this.w, this.h)) return;
    const data = this.sctx.getImageData(0, 0, this.w, this.h).data;
    const focus = S.mode === 'focus';
    if (focus) this.requestMask();
    let mask = null;
    if (focus && Seg.status === 'ready') {
      mask = S.source.type === 'image'
        ? (this.staticKey === S.source.key + ':' + this.w ? this.staticMask : null)
        : this.liveMask;
    }
    thermal(data, this.w, this.h, mask, renderMode(), this.ink);
    const inkPx = ((255 << 24) | (INK[2] << 16) | (INK[1] << 8) | INK[0]) >>> 0;
    const u = this.u32, ink = this.ink;
    for (let i = 0; i < ink.length; i++) u[i] = ink[i] ? inkPx : 0;
    this.pctx.putImageData(this.img, 0, 0);
  },
};

function sourceDims() {
  const s = S.source;
  if (!s) return [0, 0];
  return s.type === 'camera' ? [s.el.videoWidth, s.el.videoHeight] : [s.el.naturalWidth, s.el.naturalHeight];
}
function drawCrop(ctx, w, h) {
  const [sw, sh] = sourceDims();
  if (!sw || !sh) return false;
  const ar = w / h;
  let cw, ch;
  if (sw / sh > ar) { ch = sh; cw = sh * ar; } else { cw = sw; ch = sw / ar; }
  ctx.save();
  if (S.source.mirror) { ctx.translate(w, 0); ctx.scale(-1, 1); }
  ctx.drawImage(S.source.el, (sw - cw) / 2, (sh - ch) / 2, cw, ch, 0, 0, w, h);
  ctx.restore();
  return true;
}

/* =========================================================================
   Receipt bag (shuffled, preloaded)
   ========================================================================= */
const Bag = {
  order: [], next: null,
  reset() { this.order = []; this.next = null; this.prefetch(); },
  pick() {
    const pool = Library.enabled();
    if (!pool.length) return null;
    if (!this.order.length) this.order = pool.map((r) => r.id).sort(() => Math.random() - 0.5);
    while (this.order.length) {
      const id = this.order.pop();
      const r = pool.find((x) => x.id === id);
      if (r) return r;
    }
    return pool[Math.floor(Math.random() * pool.length)];
  },
  load(rec) { return Library.image(rec).then((img) => ({ rec, img })); },
  prefetch() { const r = this.pick(); this.next = r ? this.load(r).catch(() => null) : null; },
  async take() {
    let got = this.next ? await this.next : null;
    if (!got || !Library.enabled().some((r) => r.id === got.rec.id)) {
      const r = this.pick();
      if (!r) throw new Error('no receipts');
      got = await this.load(r);
    }
    this.prefetch();
    return got;
  },
};

/* =========================================================================
   UI state
   ========================================================================= */
function lcd(a, b = '') { el.lcd1.textContent = a; el.lcd2.textContent = b; }
function led(mode) { el.led.className = 'led' + (mode === 'on' ? ' on' : mode === 'blink' ? ' on blink' : ''); }
function modeLabel() {
  if (S.mode === 'full') return 'FULL · WHOLE PHOTO';
  return S.bg ? 'FOCUS · BACKGROUND ON' : 'FOCUS · BACKGROUND OFF';
}
// what the thermal renderer gets: 'focus' = drop background, 'soft' = fade it, 'full' = no mask at all
function renderMode() { return S.mode === 'full' ? 'full' : S.bg ? 'soft' : 'focus'; }
function setTheme(t, save) {
  S.dark = t === 'dark';
  document.documentElement.dataset.theme = t;
  el.themeBtn.setAttribute('aria-pressed', String(S.dark));
  el.themeBtn.title = S.dark ? 'Light mode' : 'Dark mode';
  el.themeBtn.setAttribute('aria-label', el.themeBtn.title);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = S.dark ? '#141413' : '#e8e7e3';
  if (save) { try { localStorage.setItem('rb-theme', t); } catch {} }
}
function saveLook() { try { localStorage.setItem('rb-look', JSON.stringify({ mode: S.mode, bg: S.bg })); } catch {} }
function loadLook() {
  try {
    const v = JSON.parse(localStorage.getItem('rb-look') || 'null');
    if (v && (v.mode === 'focus' || v.mode === 'full')) { S.mode = v.mode; S.bg = !!v.bg; }
  } catch {}
}

function setState(st) {
  S.state = st;
  el.viewfinder.classList.toggle('hidden', st === 'printing' || st === 'tear');
  el.printBtn.disabled = st === 'starting' || st === 'capturing' || st === 'printing';
  switch (st) {
    case 'idle': lcd('HELLO', 'PRESS PRINT TO WAKE'); led('off'); break;
    case 'starting': lcd('WARMING UP', 'ALLOW CAMERA ACCESS'); led('blink'); break;
    case 'nosource': lcd('NO CAMERA', 'UPLOAD A PHOTO'); led('off'); break;
    case 'live': lcd('READY', modeLabel()); led('on'); break;
    case 'capturing': lcd('SAY CHEESE', ''); led('on'); break;
    case 'printing': led('blink'); break;
    case 'tear': lcd('TEAR ↑', 'PULL THE PAPER OR TAP IT'); led('on'); break;
  }
  refreshMeta();
}

function refreshMeta() {
  el.viewfinder.classList.toggle('has-source', !!S.source);
  let t;
  if (!S.source) t = 'NO SIGNAL';
  else {
    const src = S.source.type === 'camera' ? 'LIVE' : 'PHOTO';
    let m = S.mode === 'full' ? 'FULL' : `FOCUS · BG ${S.bg ? 'ON' : 'OFF'}`;
    if (S.mode === 'focus' && Seg.status === 'loading') m += ' · LOADING CUT-OUT…';
    else if (Seg.status === 'failed') m = 'FULL · CUT-OUT UNAVAILABLE';
    t = `${src} · ${m}`;
  }
  el.vfMeta.textContent = t;
}

function refreshMode() {
  const failed = Seg.status === 'failed';
  if (failed && S.mode === 'focus') S.mode = 'full';
  el.modeSwitch.dataset.mode = S.mode;
  for (const b of el.modeSwitch.querySelectorAll('button')) {
    b.setAttribute('aria-checked', String(b.dataset.mode === S.mode));
    if (b.dataset.mode === 'focus') b.disabled = failed;
  }
  const bgOn = S.mode === 'focus' && !failed;
  el.bgSwitch.disabled = !bgOn;
  el.bgSwitch.setAttribute('aria-checked', String(S.bg));
  el.bgRow.classList.toggle('disabled', !bgOn);
  el.bgState.textContent = S.bg ? 'ON' : 'OFF';
  if (S.state === 'live') lcd('READY', modeLabel());
  refreshMeta();
}
Seg.onChange = refreshMode;

function setMode(m) {
  if (m === 'focus' && Seg.status === 'failed') return;
  if (S.mode === m) return;
  S.mode = m;
  Sound.beep(m === 'focus' ? 660 : 520, 0.05, 0.05);
  saveLook();
  refreshMode();
}

function setBg(v) {
  if (S.mode !== 'focus' || Seg.status === 'failed' || S.bg === v) return;
  S.bg = v;
  Sound.beep(v ? 740 : 600, 0.04, 0.05);
  saveLook();
  refreshMode();
}

function updateCount() { if (!el.count) return; const b = el.count.querySelector('b'); if (b) b.textContent = pad(S.printed); else el.count.textContent = `${pad(S.printed)} printed`; }

/* ---------- Ko-fi ---------- */
const kofiUrl = () => (document.getElementById('kofi') || {}).href || 'https://ko-fi.com/notavision';
function initKofi() {
  const img = document.querySelector('#kofi img');
  if (img) {
    const drop = () => img.remove();                  // e.g. remote images blocked: keep the text button
    if (img.complete && !img.naturalWidth) drop(); else img.addEventListener('error', drop);
  }
}
let kofiTipShown = false;
function showKofiTip() {
  if (kofiTipShown) return;
  try { if (sessionStorage.getItem('rb-kofi-tip')) return; sessionStorage.setItem('rb-kofi-tip', '1'); } catch {}
  kofiTipShown = true;
  const tip = document.getElementById('kofiTip'), btn = document.getElementById('kofi');
  if (!tip || !btn) return;
  const r = btn.getBoundingClientRect();
  tip.style.top = Math.round(r.bottom + 12) + 'px';
  tip.style.right = Math.round(Math.max(12, window.innerWidth - r.right)) + 'px';
  tip.style.setProperty('--arrow', Math.round(r.width / 2 - 5) + 'px');
  tip.hidden = false;
  const hide = () => { tip.classList.add('out'); setTimeout(() => { tip.hidden = true; tip.classList.remove('out'); }, 320); };
  setTimeout(hide, 7000);
  tip.addEventListener('click', hide, { once: true });
}

/* =========================================================================
   Sources
   ========================================================================= */
const camConstraints = (deviceId) => ({
  video: deviceId
    ? { deviceId: { exact: deviceId }, width: { ideal: 1280 }, height: { ideal: 960 } }
    : { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 960 } },
  audio: false,
});

/* Camera health: browsers can pause the hidden <video>, the OS can stop the camera (sleep, app switch,
   another app taking it). The live loop calls camWatch(); it resumes playback, and reconnects when
   frames stop coming. */
const Cam = { stream: null, rvfc: false, lastFrameAt: 0, lastCT: -1, lastPlayTry: 0, mutedAt: 0, recovering: false, restarts: [] };

function watchCamera(stream) {
  Cam.stream = stream;
  Cam.lastFrameAt = performance.now(); Cam.lastCT = -1; Cam.mutedAt = 0;
  const track = stream.getVideoTracks()[0];
  if (track) {
    track.addEventListener('mute', () => { if (Cam.stream === stream) Cam.mutedAt = performance.now(); });
    track.addEventListener('unmute', () => { if (Cam.stream === stream) { Cam.mutedAt = 0; Cam.lastFrameAt = performance.now(); el.video.play().catch(() => {}); } });
  }
  const v = el.video;
  Cam.rvfc = typeof v.requestVideoFrameCallback === 'function';
  if (Cam.rvfc) {
    const onFrame = () => { if (Cam.stream !== stream) return; Cam.lastFrameAt = performance.now(); v.requestVideoFrameCallback(onFrame); };
    v.requestVideoFrameCallback(onFrame);
  }
}

function camWatch() {
  if (!S.source || S.source.type !== 'camera' || !Cam.stream || Cam.recovering || document.hidden) return;
  const now = performance.now(), v = el.video;
  if (v.currentTime !== Cam.lastCT) { Cam.lastCT = v.currentTime; if (!Cam.rvfc) Cam.lastFrameAt = now; }
  const track = Cam.stream.getVideoTracks()[0];
  if (!track || track.readyState === 'ended') { recoverCamera('ended'); return; }
  const idle = now - Cam.lastFrameAt;
  if ((v.paused || idle > 1200) && now - Cam.lastPlayTry > 1000) { Cam.lastPlayTry = now; v.play().catch(() => {}); }
  if (idle > 5000 || (Cam.mutedAt && now - Cam.mutedAt > 5000)) recoverCamera(Cam.mutedAt ? 'muted' : 'frozen');
}

async function recoverCamera(reason) {
  if (Cam.recovering) return;
  const now = performance.now();
  Cam.restarts = Cam.restarts.filter((t) => now - t < 60000);
  if (Cam.restarts.length >= 3) { camLost(); return; }
  Cam.restarts.push(now);
  Cam.recovering = true;
  console.warn('[reshito-shot] camera', reason, '→ reconnecting');
  const old = Cam.stream && Cam.stream.getVideoTracks()[0];
  const deviceId = old && old.getSettings ? old.getSettings().deviceId : undefined;
  if (S.state === 'live') lcd('RECONNECTING', 'CAMERA');
  stopCamera();
  try {
    let stream;
    try { stream = await navigator.mediaDevices.getUserMedia(camConstraints(deviceId)); }
    catch { stream = await navigator.mediaDevices.getUserMedia(camConstraints()); }
    if (!S.source || S.source.type !== 'camera') { stream.getTracks().forEach((t) => t.stop()); return; }   // switched to a photo meanwhile
    el.video.srcObject = stream;
    await el.video.play().catch(() => {});
    watchCamera(stream);
    if (S.state === 'live') lcd('READY', modeLabel());
  } catch (err) {
    console.warn('[reshito-shot] camera reconnect failed:', err);
    camLost();
  } finally {
    Cam.recovering = false;
  }
}

function camLost() {
  stopCamera();
  if (!S.source || S.source.type !== 'camera') return;
  S.source = null;
  Live.liveMask = null;
  el.vfNote.textContent = 'The camera stopped (it may be in use by another app). Try again, or upload a photo.';
  el.startBtn.textContent = 'Try camera again';
  el.vfEmpty.classList.remove('waking', 'leaving');
  el.vfEmpty.hidden = false;
  el.camBtn.hidden = true;
  setState('nosource');
}

async function startCamera() {
  if (S.state === 'starting') return;
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return noSource();
  if (!el.vfEmpty.hidden) el.vfEmpty.classList.add('waking');
  setState('starting');
  try {
    stopCamera();
    const stream = await navigator.mediaDevices.getUserMedia(camConstraints());
    el.video.srcObject = stream;
    await el.video.play().catch(() => {});
    for (let i = 0; i < 100 && !el.video.videoWidth; i++) await sleep(50);
    if (!el.video.videoWidth) throw new Error('no frames');
    watchCamera(stream);
    Cam.restarts = [];
    if (S.source && S.source.url) URL.revokeObjectURL(S.source.url);
    S.source = { type: 'camera', el: el.video, mirror: true, key: 'cam' };
    Live.liveMask = null;
    hideEmpty();
    el.camBtn.hidden = true;
    setState('live');
    revealPreview();
    Seg.init();
  } catch (err) {
    console.warn('[reshito-shot] camera:', err);
    noSource(err && err.name);
  }
}

let revealT = 0;
function hideEmpty() {
  const v = el.vfEmpty;
  if (v.hidden) return;
  v.classList.add('leaving');
  setTimeout(() => { v.hidden = true; v.classList.remove('leaving', 'waking'); }, 420);
}
function revealPreview() {
  const vf = el.viewfinder;
  vf.classList.remove('reveal'); void vf.offsetWidth; vf.classList.add('reveal');
  clearTimeout(revealT);
  revealT = setTimeout(() => vf.classList.remove('reveal'), 1700);
  Sound.beep(660, 0.05, 0.04); setTimeout(() => Sound.beep(990, 0.07, 0.04), 110);
}

function noSource(reason) {
  let note = 'No camera found. Upload a photo instead.';
  if (reason === 'NotAllowedError' || reason === 'SecurityError') {
    note = inFrame
      ? 'The camera is blocked in this embedded preview. Upload a photo, or open the hosted site to use the webcam.'
      : 'Camera access was blocked. Allow it in the browser bar, or upload a photo.';
  } else if (!navigator.mediaDevices) note = 'Camera needs HTTPS (or localhost). Upload a photo instead.';
  el.vfNote.textContent = note;
  el.startBtn.textContent = 'Try camera again';
  el.vfEmpty.classList.remove('waking', 'leaving');
  if (!S.source) { el.vfEmpty.hidden = false; setState('nosource'); }
  else { el.vfEmpty.hidden = true; setState('live'); }
}

function loadFile(file) {
  if (!file || !file.type.startsWith('image/')) return;
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.onload = () => {
    if (S.source && S.source.type === 'camera') stopCamera();
    if (S.source && S.source.url) URL.revokeObjectURL(S.source.url);
    S.source = { type: 'image', el: img, mirror: false, key: 'img' + Date.now(), url };
    hideEmpty();
    el.camBtn.hidden = false;
    Seg.init();
    if (S.state !== 'printing' && S.state !== 'tear' && S.state !== 'capturing') { setState('live'); revealPreview(); }
    else refreshMeta();
  };
  img.src = url;
}

function stopCamera() {
  const st = el.video.srcObject;
  if (st) st.getTracks().forEach((t) => t.stop());
  el.video.srcObject = null;
  Cam.stream = null;
}

/* =========================================================================
   Print flow
   ========================================================================= */
function pressFx() { el.printBtn.classList.add('pressed'); setTimeout(() => el.printBtn.classList.remove('pressed'), 120); }

async function onPrint() {
  Sound.ensure();
  pressFx();
  if ((S.state === 'idle' || S.state === 'nosource') && !S.source) return startCamera();
  if (S.state === 'tear' && S.tearNow) return S.tearNow();
  if (S.state !== 'live' || !S.source) return;
  await runPrint();
}

async function captureShot() {
  const [cap, cctx] = makeCanvas(720, 900);
  drawCrop(cctx, 720, 900);
  let mask = null;
  const focus = S.mode === 'focus';
  if (focus && Seg.status === 'loading') {
    lcd('CUT-OUT', 'LOADING MODEL…');
    await Promise.race([Seg.ready, sleep(15000)]);
  }
  if (focus && Seg.status === 'ready') {
    const [segIn, sx] = makeCanvas(288, 360);
    sx.drawImage(cap, 0, 0, 288, 360);
    const arr = await Seg.segment(segIn, 288, 360);
    if (arr) mask = { arr, w: 288, h: 360 };
  }
  return { canvas: cap, mask, mode: focus && mask ? renderMode() : 'full' };
}

async function runPrint() {
  if (!Library.enabled().length) { lcd('NO PAPER', 'ADD RECEIPTS IN #ADMIN'); return; }
  setState('countdown');
  if (S.source.type === 'camera') {
    for (const n of [3, 2, 1]) {
      if (S.state !== 'countdown') return;
      el.countdown.textContent = n;
      el.countdown.classList.remove('tick'); void el.countdown.offsetWidth; el.countdown.classList.add('tick');
      lcd(String(n), 'HOLD STILL');
      Sound.beep(n === 1 ? 1175 : 880);
      await sleep(820);
    }
  }
  setState('capturing');
  el.flash.classList.remove('go'); void el.flash.offsetWidth; el.flash.classList.add('go');
  Sound.shutter();
  const shotP = captureShot();
  await sleep(380);
  const shot = await shotP;
  setState('printing');
  lcd('PRINTING', 'HEATING THE HEAD…');
  try {
    const got = await Bag.take();
    const out = composePrint(shot, got.rec, got.img);
    S.printed += 1; updateCount();
    Counter.hit();
    const job = { rec: got.rec, W: out.W, H: out.H, toothD: out.toothD, canvas: out.canvas, blob: null, url: null, n: S.printed };
    // encode in the background while the paper feeds
    job.ready = (async () => {
      const blob = await encodeBest(out.canvas, { quality: 0.95 });
      job.blob = blob; job.url = URL.createObjectURL(blob);
    })();
    await feed(job);
  } catch (err) {
    console.error(err);
    lcd('PAPER JAM', 'TRY AGAIN');
    await sleep(1400);
    setState('live');
  }
}

function receiptScale(rec) {
  const L = S.L, w = rec.w * rec.scale, h = rec.h * rec.scale;
  return Math.min(L.s, (L.slotW * 0.96) / w, (L.availH - 6) / h);
}

function feed(job) {
  return new Promise((resolve) => {
    const s = receiptScale(job.rec);
    const wCss = job.rec.w * job.rec.scale * s, hCss = job.rec.h * job.rec.scale * s;
    const toothCss = (job.toothD / job.W) * wCss;
    const node = document.createElement('div');
    node.className = 'feeding';
    node.style.width = wCss + 'px'; node.style.height = hCss + 'px';
    node.appendChild(job.canvas);
    let y = hCss + 2;
    const end = toothCss + 1.5;
    node.style.transform = `translate(-50%, ${y}px)`;
    el.track.appendChild(node);

    const total = y - end;
    const duration = clamp(1500 + total * 6, 2600, 5800);
    const v = total / duration;
    let last = performance.now(), stutter = 0, slow = false;
    Sound.motor(true);
    const step = (now) => {
      const dt = Math.min(48, now - last); last = now;
      if (stutter > 0) stutter -= dt;
      else if (Math.random() < 0.025) stutter = rnd(50, 140);
      const isSlow = stutter > 0;
      if (isSlow !== slow) { slow = isSlow; Sound.motorStutter(slow); }
      y = Math.max(end, y - v * (isSlow ? 0.1 : 1.2) * dt);
      const jx = (Math.random() - 0.5) * 0.6;
      node.style.transform = `translate(calc(-50% + ${jx}px), ${y}px)`;
      const pctDone = Math.round((1 - (y - end) / total) * 100);
      lcd(`PRINTING ${pad(pctDone, 2)}%`, `RCPT ${job.rec.id.toUpperCase()} · №${pad(job.n, 4)}`);
      if (y > end) requestAnimationFrame(step);
      else {
        Sound.motor(false);
        node.style.transform = `translate(-50%, ${end}px)`;
        armTear(node, job, s, wCss, hCss, end);
        resolve();
      }
    };
    requestAnimationFrame(step);
  });
}

function armTear(node, job, s, wCss, hCss, end) {
  setState('tear');
  node.classList.add('tearable');
  let startY = null, pulled = 0, moved = false, done = false;
  const go = () => {
    if (done) return; done = true;
    clearTimeout(auto);
    node.onpointerdown = node.onpointermove = node.onpointerup = node.onpointercancel = null;
    S.tearNow = null;
    tearOff(node, job, s, wCss, hCss);
  };
  S.tearNow = go;
  const auto = setTimeout(go, 5200);
  node.onpointerdown = (e) => { startY = e.clientY; moved = false; pulled = 0; try { node.setPointerCapture(e.pointerId); } catch {} };
  node.onpointermove = (e) => {
    if (startY == null) return;
    const dy = startY - e.clientY;
    if (Math.abs(dy) > 4) moved = true;
    pulled = Math.max(0, dy);
    node.style.transform = `translate(-50%, ${end - Math.min(18, pulled * 0.3)}px)`;
    if (pulled > 64) go();
  };
  node.onpointerup = node.onpointercancel = () => {
    if (startY == null) return;
    startY = null;
    if (!moved || pulled > 26) go();
    else node.style.transform = `translate(-50%, ${end}px)`;
  };
}

async function tearOff(node, job, s, wCss, hCss) {
  Sound.tear();
  const r = node.getBoundingClientRect();
  const x0 = r.left, y0 = r.top;
  node.classList.remove('feeding', 'tearable');
  node.classList.add('flying');
  node.style.transform = `translate(${x0}px, ${y0}px)`;
  document.body.appendChild(node);

  const rot = rnd(-8, 8) || 2;
  const bscale = boardScale(job.rec, s);
  const bw = job.rec.w * job.rec.scale * bscale, bh = job.rec.h * job.rec.scale * bscale;
  const spot = pickSpot(job.rec, bw, bh, rot);
  const k = bw / wCss;
  const tx = spot.x - wCss / 2, ty = spot.y - hCss / 2;

  setTimeout(() => { if (S.state === 'tear') setState('live'); }, 420);
  const anim = node.animate([
    { transform: `translate(${x0}px, ${y0}px) rotate(0deg) scale(1)` },
    { transform: `translate(${x0 + rnd(-6, 6)}px, ${y0 - 34}px) rotate(${rot * 0.25}deg) scale(1.01)`, offset: 0.2, easing: 'cubic-bezier(.3,.7,.4,1)' },
    { transform: `translate(${tx}px, ${ty}px) rotate(${rot}deg) scale(${k})` },
  ], { duration: 950, easing: 'cubic-bezier(.22,.8,.25,1)', fill: 'forwards' });
  try { await anim.finished; } catch {}
  await job.ready;
  node.remove();
  job.canvas = null;
  addItem(job, spot, bw, bh, rot);
  if (S.printed === 1) { el.hint.textContent = 'Tap a receipt to save it · drag to move'; setTimeout(showKofiTip, 900); }
}

/* =========================================================================
   Board (torn receipts) — never under the live preview
   ========================================================================= */
function boardScale(rec, s) {
  const { vw, vh, centerW, narrow } = S.L;
  const sideW = (vw - centerW) / 2;
  const w = rec.w * rec.scale, h = rec.h * rec.scale;
  return narrow ? s * 0.62 : Math.min(s * 0.72, (sideW - 36) / w, (vh * 0.6) / h);
}

function halfWidth(w, h, rotDeg) {
  const r = (Math.abs(rotDeg) * Math.PI) / 180;
  return (w * Math.cos(r) + h * Math.sin(r)) / 2;
}

function pickSpot(rec, bw, bh, rot = 0) {
  const { vw, vh, centerW, narrow } = S.L;
  const cL = vw / 2 - centerW / 2, cR = vw / 2 + centerW / 2;
  const hw = halfWidth(bw, bh, rot);
  let best = null, bestScore = -Infinity;
  for (let t = 0; t < 30; t++) {
    const left = Math.random() < 0.5;
    let x, y;
    if (!narrow) {
      const lo = left ? Math.min(24 + hw, cL - hw - 8) : cR + hw + 8;
      const hi = left ? cL - hw - 8 : Math.max(cR + hw + 8, vw - 24 - hw);
      x = rnd(Math.min(lo, hi), Math.max(lo, hi));
      y = rnd(Math.min(64 + bh * 0.5, vh / 2), Math.max(vh / 2, vh - 64 - bh * 0.55));
    } else {
      x = left ? rnd(-bw * 0.32, -bw * 0.24) : vw + rnd(bw * 0.24, bw * 0.32);
      y = rnd(80 + bh * 0.25, Math.max(90 + bh * 0.25, vh * 0.55));
    }
    let score = Math.random() * 400;
    for (const it of S.items) {
      const ox = Math.max(0, Math.min(x + bw / 2, it.x + it.w / 2) - Math.max(x - bw / 2, it.x - it.w / 2));
      const oy = Math.max(0, Math.min(y + bh / 2, it.y + it.h / 2) - Math.max(y - bh / 2, it.y - it.h / 2));
      score -= ox * oy;
    }
    if (score > bestScore) { bestScore = score; best = { x, y }; }
  }
  return best;
}

// push an item out of the centre column (live preview + printer) if it wandered in
function keepClear(it, animate) {
  if (!S.L || S.L.narrow) return false;
  const { vw, centerW } = S.L;
  const cL = vw / 2 - centerW / 2, cR = vw / 2 + centerW / 2;
  const hw = halfWidth(it.w, it.h, it.rot);
  if (it.x + hw <= cL || it.x - hw >= cR) return false;
  it.x = it.x < vw / 2 ? cL - hw - 10 : cR + hw + 10;
  placeItem(it, animate);
  return true;
}

function placeItem(it, animate = false) {
  it.node.classList.toggle('settle', !!animate);
  it.node.style.left = it.x + 'px';
  it.node.style.top = it.y + 'px';
  if (animate) setTimeout(() => it.node.classList.remove('settle'), 420);
}

function addItem(job, spot, w, h, rot) {
  const node = document.createElement('div');
  node.className = 'item';
  node.style.width = w + 'px'; node.style.height = h + 'px';
  node.style.setProperty('--r', rot + 'deg');
  node.style.zIndex = ++S.z;
  const img = new Image(); img.src = job.url; img.alt = `Receipt print №${job.n}`; img.draggable = false;
  const tape = document.createElement('span');
  tape.className = 'tape';
  tape.style.width = clamp(w * rnd(0.32, 0.45), 44, 96) + 'px';
  tape.style.setProperty('--tr', rnd(-7, 7) + 'deg');
  tape.style.marginLeft = rnd(-w * 0.12, w * 0.12) + 'px';
  node.append(img, tape);
  el.board.appendChild(node);
  const it = { node, x: spot.x, y: spot.y, w, h, rot, job, rec: job.rec };
  S.items.push(it);
  placeItem(it);
  keepClear(it, false);
  bindDrag(it);
  while (S.items.length > MAX_BOARD) removeItem(S.items[0]);
}

function removeItem(it) {
  it.node.remove();
  URL.revokeObjectURL(it.job.url);
  S.items = S.items.filter((x) => x !== it);
}

function bindDrag(it) {
  const n = it.node;
  let sx = 0, sy = 0, ox = 0, oy = 0, active = false, moved = false;
  n.addEventListener('pointerdown', (e) => {
    active = true; moved = false; sx = e.clientX; sy = e.clientY; ox = it.x; oy = it.y;
    n.style.zIndex = ++S.z;
    try { n.setPointerCapture(e.pointerId); } catch {}
  });
  n.addEventListener('pointermove', (e) => {
    if (!active) return;
    const dx = e.clientX - sx, dy = e.clientY - sy;
    if (!moved && Math.hypot(dx, dy) > 5) { moved = true; n.classList.add('dragging'); }
    if (moved) { it.x = ox + dx; it.y = oy + dy; placeItem(it); }
  });
  const up = () => {
    if (!active) return;
    active = false; n.classList.remove('dragging');
    if (!moved) openLightbox(it);
    else keepClear(it, true);
  };
  n.addEventListener('pointerup', up);
  n.addEventListener('pointercancel', () => { active = false; n.classList.remove('dragging'); keepClear(it, true); });
}

/* =========================================================================
   Lightbox + save
   ========================================================================= */
const fromBoard = (it, to) => {
  const s = it.w / to.width;
  const dx = it.x - (to.left + to.width / 2), dy = it.y - (to.top + to.height / 2);
  return `translate(${dx.toFixed(1)}px, ${dy.toFixed(1)}px) rotate(${(it.rot || 0).toFixed(2)}deg) scale(${s.toFixed(4)})`;
};

async function openLightbox(it) {
  if (S.tossing || S.closing || !el.lightbox.hidden) return;
  S.lightboxItem = it;
  resetImage(el.lbImg);
  el.lbImg.src = it.job.url;
  el.lbNote.textContent = `№${pad(it.job.n, 4)} · receipt ${it.job.rec.id} · ${it.job.W}×${it.job.H}px`;
  el.lightbox.classList.add('pre');
  el.lightbox.hidden = false;
  try { await el.lbImg.decode(); } catch {}
  const to = el.lbImg.getBoundingClientRect();
  it.node.style.visibility = 'hidden';
  el.lbImg.animate([{ transform: fromBoard(it, to) }, { transform: 'none' }], { duration: 480, easing: 'cubic-bezier(.2,.85,.25,1)' });
  requestAnimationFrame(() => el.lightbox.classList.remove('pre'));
}

async function closeLightbox() {
  if (S.tossing || S.closing || el.lightbox.hidden) return;
  S.closing = true;
  const it = S.lightboxItem;
  el.lightbox.classList.add('pre');
  if (it && it.node.isConnected) {
    const to = el.lbImg.getBoundingClientRect();
    await el.lbImg.animate([{ transform: 'none' }, { transform: fromBoard(it, to) }], { duration: 400, easing: 'cubic-bezier(.45,0,.2,1)', fill: 'forwards' }).finished.catch(() => {});
    it.node.style.visibility = '';
  } else await sleep(220);
  el.lightbox.hidden = true;
  el.lightbox.classList.remove('pre');
  resetImage(el.lbImg);
  S.lightboxItem = null;
  S.closing = false;
}

async function throwAway() {
  const it = S.lightboxItem;
  if (!it || S.tossing) return;
  S.tossing = true;
  el.lightbox.classList.add('tossing');
  try { await crumpleAndToss(el.lbImg); }
  catch (err) { console.warn(err); }
  removeItem(it);
  const fade = el.lightbox.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 240, easing: 'ease-out', fill: 'forwards' });
  await fade.finished.catch(() => {});
  el.lightbox.hidden = true;
  fade.cancel();
  el.lightbox.classList.remove('tossing');
  resetImage(el.lbImg);
  S.lightboxItem = null;
  S.tossing = false;
}

async function pngOf(job) {
  if (job.blob.type === 'image/png') return job.blob;
  const img = await decodeImage(job.url);
  const [c, x] = makeCanvas(img.naturalWidth, img.naturalHeight);
  x.drawImage(img, 0, 0);
  return encodeCanvas(c, 'image/png');
}

export async function saveBlob(blob, filename) {
  if (window.claude && typeof window.claude.use === 'function') {
    try {
      const dl = await window.claude.use('downloads');
      if (dl) { await dl.save({ filename, data: blob }); return 'saved'; }
    } catch (err) {
      if (err && err.code === 'declined') return 'cancelled';
      if (err && err.code === 'rate_limited') return 'busy';
      console.warn(err);
      if (inFrame) return 'unavailable';
    }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  return 'saved';
}

/* =========================================================================
   Wiring
   ========================================================================= */
export async function reloadLibrary() {
  await Library.load();
  S.refs = libraryRefs();
  layout();
  Bag.reset();
}

// current camera frame / uploaded photo as a print-ready shot (used by the admin test print)
export async function snapshot() {
  if (!S.source) return null;
  if (S.source.type === 'camera' && el.video.readyState < 2) return null;
  return captureShot();
}

export function pause(p) {
  S.paused = p;
  if (p) Sound.motor(false);
}

export async function initBooth() {
  loadLook();
  initKofi();
  el.printBtn.addEventListener('click', onPrint);
  el.startBtn.addEventListener('click', () => { Sound.ensure(); startCamera(); });
  el.camBtn.addEventListener('click', () => { Sound.ensure(); if (S.state === 'live' || S.state === 'nosource') startCamera(); });
  for (const f of [el.file1, el.file2]) f.addEventListener('change', (e) => { Sound.ensure(); loadFile(e.target.files[0]); e.target.value = ''; });
  el.modeSwitch.addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) { Sound.ensure(); setMode(b.dataset.mode); } });
  el.bgSwitch.addEventListener('click', () => { Sound.ensure(); setBg(!S.bg); });
  el.soundBtn.addEventListener('click', () => {
    Sound.enabled = !Sound.enabled;
    el.soundBtn.setAttribute('aria-pressed', String(Sound.enabled));
    el.soundBtn.title = Sound.enabled ? 'Sound on' : 'Sound off';
    if (!Sound.enabled) Sound.motor(false); else Sound.beep(880, 0.05, 0.05);
  });
  el.themeBtn.addEventListener('click', () => setTheme(S.dark ? 'light' : 'dark', true));
  setTheme(document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light', false);

  const flap = createFlap(document.getElementById('flaps'), 6);
  Counter.on((v, meta) => flap.set(v, { roll: !!meta.initial }));
  Counter.start();
  el.lbClose.addEventListener('click', closeLightbox);
  el.lightbox.addEventListener('click', (e) => { if (e.target === el.lightbox) closeLightbox(); });
  el.lbDelete.addEventListener('click', () => { Sound.ensure(); throwAway(); });
  el.lbSave.addEventListener('click', async () => {
    const it = S.lightboxItem; if (!it) return;
    el.lbNote.textContent = 'Preparing PNG…';
    const png = await pngOf(it.job);
    const r = await saveBlob(png, `reshito-shot-${pad(it.job.n, 4)}.png`);
    el.lbNote.textContent = { saved: 'Saved.', cancelled: 'Not saved.', busy: 'One moment — try again.', unavailable: 'Saving is not available in this view.' }[r] || '';
    if (r === 'saved') {
      el.lbNote.append(' Like it? ');
      const a = document.createElement('a');
      a.href = kofiUrl(); a.target = '_blank'; a.rel = 'noopener'; a.textContent = 'Support me on Ko-fi';
      el.lbNote.append(a);
    }
  });

  // drop a photo from outside the page. Dragging the page's own images (e.g. the receipt in the
  // lightbox) must never end up as the booth's photo: that used to swap the camera for a receipt.
  let innerDrag = false;
  document.addEventListener('dragstart', (e) => {
    if (e.target && e.target.tagName === 'IMG') { e.preventDefault(); return; }
    innerDrag = true;
  });
  document.addEventListener('dragend', () => { innerDrag = false; });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    const inner = innerDrag; innerDrag = false;
    if (S.paused || inner) return;
    const f = e.dataTransfer && e.dataTransfer.files[0];
    if (f && f.type.startsWith('image/')) loadFile(f);
  });
  // coming back to the tab/app: make sure the camera is still playing
  document.addEventListener('visibilitychange', () => {
    if (document.hidden || !S.source || S.source.type !== 'camera') return;
    Cam.lastFrameAt = performance.now(); Cam.lastCT = -1;
    el.video.play().catch(() => {});
  });
  window.addEventListener('keydown', (e) => {
    if (S.paused) return;
    if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) return;
    if (!el.lightbox.hidden) { if (e.key === 'Escape') closeLightbox(); return; }
    if (e.code === 'Space' || e.key === 'Enter') {
      if (e.target.tagName === 'BUTTON' && e.key === 'Enter') return;
      e.preventDefault();
      if (e.repeat) return;
      if (e.target.tagName === 'BUTTON') e.target.blur();
      onPrint();
    } else if (e.key === 'f' || e.key === 'F') setMode(S.mode === 'focus' ? 'full' : 'focus');
    else if (e.key === 'b' || e.key === 'B') setBg(!S.bg);
  });
  window.addEventListener('keyup', (e) => { if (e.code === 'Space' && e.target && e.target.tagName === 'BUTTON') e.preventDefault(); });
  let raf = 0;
  window.addEventListener('resize', () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(layout); });

  el.lbImg.draggable = false;
  Live.resize(el.preview.width, el.preview.height);
  layout();
  setState('idle');
  updateCount();
  refreshMode();
  requestAnimationFrame((t) => Live.tick(t));
  await reloadLibrary();
  (window.requestIdleCallback || ((f) => setTimeout(f, 600)))(() => Seg.init());
}
