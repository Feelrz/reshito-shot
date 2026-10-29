// "Throw away": the receipt is crumpled into a paper ball and tossed into a little wastebasket.
import { rnd, clamp, sleep, makeCanvas } from './util.js';
import { Sound } from './sound.js';

const reduced = () => window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/* ---------- a crumpled paper ball made from pieces of the receipt ---------- */
function makeBall(srcImg, S) {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  // work from a small copy: drawing the full-size receipt 30+ times is slow on phones
  const iw = srcImg.naturalWidth || srcImg.width, ih = srcImg.naturalHeight || srcImg.height;
  const k = Math.min(1, 360 / Math.max(iw, ih));
  const [src, sctx] = makeCanvas(iw * k, ih * k);
  sctx.drawImage(srcImg, 0, 0, src.width, src.height);
  const [c, ctx] = makeCanvas(S * dpr, S * dpr);
  c.className = 'paper-ball';
  c.style.width = c.style.height = S + 'px';
  ctx.scale(dpr, dpr);
  const R = S / 2;
  const sw = src.width, sh = src.height;

  // lumpy outline
  const pts = [];
  const n = 20;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + rnd(-0.08, 0.08);
    const r = R * (0.84 + rnd(-0.07, 0.06));
    pts.push([R + Math.cos(a) * r, R + Math.sin(a) * r]);
  }
  const outline = () => { ctx.beginPath(); pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y))); ctx.closePath(); };

  ctx.save();
  outline();
  ctx.clip();
  ctx.fillStyle = '#efede7';
  ctx.fillRect(0, 0, S, S);

  // folded facets, each showing a random scrap of the receipt at a random angle
  const facets = 34;
  for (let k = 0; k < facets; k++) {
    const a = rnd(0, Math.PI * 2), d = Math.sqrt(Math.random()) * R * 0.92;
    const px = R + Math.cos(a) * d, py = R + Math.sin(a) * d;
    const rad = S * rnd(0.14, 0.3);
    const m = 4 + Math.floor(Math.random() * 3);
    const poly = [];
    const off = rnd(0, Math.PI * 2);
    for (let i = 0; i < m; i++) {
      const b = off + (i / m) * Math.PI * 2 + rnd(-0.3, 0.3);
      poly.push([px + Math.cos(b) * rad * rnd(0.6, 1.1), py + Math.sin(b) * rad * rnd(0.6, 1.1)]);
    }
    const path = () => { ctx.beginPath(); poly.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y))); ctx.closePath(); };

    ctx.save();
    path(); ctx.clip();
    ctx.translate(px, py);
    ctx.rotate(rnd(-Math.PI, Math.PI));
    const sc = (S * rnd(1.1, 1.8)) / Math.max(sw, sh) * rnd(0.9, 1.3);
    ctx.scale(sc, sc);
    ctx.drawImage(src, -sw * rnd(0.15, 0.85), -sh * rnd(0.1, 0.9));
    ctx.restore();

    // light from the top-left: facets facing away get darker
    const facing = Math.cos(Math.atan2(py - R, px - R) - (-2.4)) * (d / R) + rnd(-0.5, 0.5);
    path();
    ctx.fillStyle = facing > 0 ? `rgba(255,255,255,${(facing * 0.18).toFixed(3)})` : `rgba(30,28,25,${(-facing * 0.22).toFixed(3)})`;
    ctx.fill();
    ctx.lineWidth = 0.7;
    ctx.strokeStyle = 'rgba(40,36,30,.22)';
    ctx.stroke();
    ctx.save(); ctx.translate(0.6, 0.6); path(); ctx.strokeStyle = 'rgba(255,255,255,.45)'; ctx.lineWidth = 0.6; ctx.stroke(); ctx.restore();
  }

  // overall roundness
  const g = ctx.createRadialGradient(R * 0.7, R * 0.6, R * 0.1, R, R, R * 1.05);
  g.addColorStop(0, 'rgba(255,255,255,.22)');
  g.addColorStop(0.55, 'rgba(255,255,255,0)');
  g.addColorStop(1, 'rgba(20,18,15,.38)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, S, S);
  ctx.restore();

  outline();
  ctx.lineWidth = 1;
  ctx.strokeStyle = 'rgba(60,55,48,.35)';
  ctx.stroke();
  return c;
}

/* ---------- crumpling: silhouette morph + creases drawn over the flat receipt ---------- */
const N_PTS = 24;
// points around the rectangle (in %), clockwise from the top-left corner
function rectPts() {
  const pts = [];
  for (let i = 0; i < N_PTS; i++) {
    const t = (i / N_PTS) * 4, side = Math.floor(t), f = t - side;
    pts.push(side === 0 ? [f * 100, 0] : side === 1 ? [100, f * 100] : side === 2 ? [100 - f * 100, 100] : [0, 100 - f * 100]);
  }
  return pts;
}
// the same points pulled toward a lumpy ellipse; amt 0 = flat sheet, 1 = ball
function crumplePts(base, amt, lumps) {
  return base.map(([x, y], i) => {
    const a = Math.atan2(y - 50, x - 50);
    const r = 50 * lumps[i];
    const tx = 50 + Math.cos(a) * r, ty = 50 + Math.sin(a) * r;
    const j = (1 - amt) * amt * 14 * (lumps[(i + 7) % N_PTS] - 0.85);   // ragged while it folds
    return [x + (tx - x) * amt + j, y + (ty - y) * amt - j];
  });
}
const poly = (pts) => `polygon(${pts.map(([x, y]) => `${x.toFixed(1)}% ${y.toFixed(1)}%`).join(',')})`;

function makeCreases(w, h) {
  const [c, ctx] = makeCanvas(Math.round(w), Math.round(h));
  const lines = 26;
  for (let k = 0; k < lines; k++) {
    // a crease: a fold line with a dark side and a light side
    const x0 = rnd(-0.1, 1.1) * w, y0 = rnd(-0.1, 1.1) * h;
    const a = rnd(0, Math.PI), len = rnd(0.35, 0.9) * Math.max(w, h);
    const dx = Math.cos(a) * len, dy = Math.sin(a) * len;
    const nx = -Math.sin(a), ny = Math.cos(a), wd = rnd(10, 34);
    const g = ctx.createLinearGradient(x0, y0, x0 + nx * wd, y0 + ny * wd);
    g.addColorStop(0, `rgba(25,22,18,${rnd(0.1, 0.2).toFixed(3)})`);
    g.addColorStop(1, 'rgba(25,22,18,0)');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.moveTo(x0 - dx / 2, y0 - dy / 2); ctx.lineTo(x0 + dx / 2, y0 + dy / 2);
    ctx.lineTo(x0 + dx / 2 + nx * wd, y0 + dy / 2 + ny * wd); ctx.lineTo(x0 - dx / 2 + nx * wd, y0 - dy / 2 + ny * wd); ctx.fill();
    const g2 = ctx.createLinearGradient(x0, y0, x0 - nx * wd * 0.7, y0 - ny * wd * 0.7);
    g2.addColorStop(0, `rgba(255,255,255,${rnd(0.25, 0.45).toFixed(3)})`);
    g2.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g2;
    ctx.beginPath(); ctx.moveTo(x0 - dx / 2, y0 - dy / 2); ctx.lineTo(x0 + dx / 2, y0 + dy / 2);
    ctx.lineTo(x0 + dx / 2 - nx * wd * 0.7, y0 + dy / 2 - ny * wd * 0.7); ctx.lineTo(x0 - dx / 2 - nx * wd * 0.7, y0 - dy / 2 - ny * wd * 0.7); ctx.fill();
    ctx.strokeStyle = 'rgba(30,26,22,.16)'; ctx.lineWidth = 0.8;
    ctx.beginPath(); ctx.moveTo(x0 - dx / 2, y0 - dy / 2); ctx.lineTo(x0 + dx / 2, y0 + dy / 2); ctx.stroke();
  }
  // squashed paper is darker at the edges
  const v = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.15, w / 2, h / 2, Math.max(w, h) * 0.62);
  v.addColorStop(0, 'rgba(0,0,0,0)'); v.addColorStop(1, 'rgba(20,18,15,.28)');
  ctx.fillStyle = v; ctx.fillRect(0, 0, w, h);
  c.className = 'paper-creases';
  return c;
}

/* ---------- wastebasket ---------- */
// One element: inside, back rim, a slot for the ball, the frosted body and the front rim all move together.
function makeBin() {
  const el = document.createElement('div');
  el.className = 'bin';
  el.innerHTML = '<i class="bin-hole"></i><i class="bin-rim-back"></i><div class="bin-slot"></div><i class="bin-shell"><i class="bin-body"></i></i><i class="bin-rim"></i>';
  document.body.appendChild(el);
  return { el, slot: el.querySelector('.bin-slot'), w: 124, h: 140, mouth: 14 };
}

const tf = (x, y, rot = 0, s = 1) => `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) rotate(${rot.toFixed(1)}deg) scale(${s.toFixed(3)})`;

/**
 * Crumple `img` (an <img> on screen) into a ball and throw it into a bin.
 * Resolves when the animation is over; the caller removes the receipt afterwards.
 */
export async function crumpleAndToss(img) {
  const r = img.getBoundingClientRect();
  if (reduced() || !r.width) {
    await img.animate([{ opacity: 1 }, { opacity: 0, transform: 'scale(.9)' }], { duration: 250, fill: 'forwards' }).finished.catch(() => {});
    return;
  }
  const vw = window.innerWidth, vh = window.innerHeight;
  const S = Math.round(clamp(Math.min(r.width, r.height) * 0.42, 84, 160));
  const cx = r.left + r.width / 2, cy = r.top + r.height / 2;


  // bin slides up: next to the receipt on wide screens, centred at the bottom on phones
  const bin = makeBin();
  const narrow = vw < 760;
  const bx = narrow ? vw / 2 - bin.w / 2 : clamp(r.right + Math.min(220, (vw - r.right) * 0.5) - bin.w / 2, r.right + 30, vw - bin.w - 24);
  const by = vh - bin.h - (narrow ? 26 : 44);
  bin.el.style.left = bx + 'px'; bin.el.style.top = by + 'px';
  const binIn = bin.el.animate([{ transform: 'translateY(180px)', opacity: 0 }, { transform: 'translateY(0)', opacity: 1 }], { duration: 520, easing: 'cubic-bezier(.2,.9,.3,1.15)', fill: 'forwards' });
  // 1) crumple the flat receipt (starts right away; the ball is built while it runs):
  //    it squeezes, its outline goes ragged and lumpy, and creases darken in over it
  Sound.crumple();
  const kx = S / r.width, ky = S / r.height;
  const base = rectPts(), lumps = base.map(() => rnd(0.74, 0.98));
  const shapes = [0, 0.12, 0.42, 0.78, 1].map((a) => poly(crumplePts(base, a, lumps)));
  const crushFrames = [
    { transform: 'none', clipPath: shapes[0] },
    { transform: 'scale(.97,.9) rotate(-2deg) skewX(3deg)', clipPath: shapes[1], offset: 0.16 },
    { transform: 'scale(.86,.66) rotate(4deg) skewY(-4deg)', clipPath: shapes[2], offset: 0.36 },
    { transform: `scale(${(kx * 2.1).toFixed(3)},${(ky * 2.4).toFixed(3)}) rotate(-8deg) skewX(-6deg)`, clipPath: shapes[3], offset: 0.62 },
    { transform: `scale(${(kx * 1.15).toFixed(3)},${(ky * 1.15).toFixed(3)}) rotate(16deg)`, clipPath: shapes[4] },
  ];
  const crushOpts = { duration: 680, easing: 'cubic-bezier(.45,0,.55,1)', fill: 'forwards' };
  const crush = img.animate(crushFrames, crushOpts);
  const creases = makeCreases(r.width, r.height);
  Object.assign(creases.style, { left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px' });
  document.body.appendChild(creases);
  creases.animate(crushFrames, crushOpts);
  creases.animate([{ opacity: 0 }, { opacity: 0.55, offset: 0.25 }, { opacity: 1, offset: 0.6 }, { opacity: 1 }], crushOpts);
  await new Promise((res) => requestAnimationFrame(() => setTimeout(res, 30)));   // let the crumple start painting
  const ball = makeBall(img, S);
  ball.style.opacity = '0';
  ball.style.transform = tf(cx - S / 2, cy - S / 2);
  document.body.appendChild(ball);
  const left = Math.max(0, 680 - (crush.currentTime || 0));
  ball.animate([
    { opacity: 0, transform: tf(cx - S / 2, cy - S / 2, -25, 1.18) },
    { opacity: 1, transform: tf(cx - S / 2, cy - S / 2, 0, 1) },
  ], { delay: Math.max(0, left - 190), duration: 200, easing: 'ease-out', fill: 'forwards' });
  await crush.finished.catch(() => {});
  img.style.visibility = 'hidden';
  creases.remove();
  await sleep(40);

  // 2) a last squeeze in the hand
  const sx0 = cx - S / 2, sy0 = cy - S / 2;
  await ball.animate([
    { transform: tf(sx0, sy0, 0, 1) },
    { transform: `${tf(sx0, sy0, 9, 1)} scale(.9,1.07)` },
    { transform: `${tf(sx0, sy0, -7, 1)} scale(1.05,.93)` },
    { transform: tf(sx0, sy0, 0, 1) },
  ], { duration: 340, easing: 'ease-in-out', fill: 'forwards' }).finished.catch(() => {});
  // 3) toss in an arc into the bin
  const end = 64 / S;                                   // ball size when it reaches the opening
  const ex = bx + bin.w / 2 - S / 2, ey = by + bin.mouth - 4 - S / 2;
  const arc = 150 + Math.abs(ex - sx0) * 0.18;
  const spin = (ex > sx0 ? 1 : -1) * rnd(420, 620);
  const frames = [];
  const steps = 18;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const x = sx0 + (ex - sx0) * t;
    const y = sy0 + (ey - sy0) * t - arc * 4 * t * (1 - t);
    frames.push({ transform: tf(x, y, spin * t, 1 + (end - 1) * t) });
  }
  Sound.whoosh();
  await ball.animate(frames, { duration: 720, easing: 'cubic-bezier(.3,.05,.6,1)', fill: 'forwards' }).finished.catch(() => {});
  // 4) the ball moves into the bin itself (between the back rim and the frosted body) and drops in
  await binIn.finished.catch(() => {});
  ball.style.opacity = '1';               // the fade-in is cancelled next; keep the ball visible in the bin
  for (const a of ball.getAnimations()) a.cancel();
  ball.classList.add('in-bin');
  const lx = ex - bx, ly = ey - by;
  ball.style.transform = tf(lx, ly, spin, end);
  bin.slot.appendChild(ball);
  await ball.animate([
    { transform: tf(lx, ly, spin, end) },
    { transform: tf(lx, ly + 50, spin + 40, end) },
  ], { duration: 210, easing: 'cubic-bezier(.5,0,1,1)', fill: 'forwards' }).finished.catch(() => {});
  ball.classList.add('sunk');            // seen through the frosted body
  Sound.thunk();
  // 5) the whole bin wobbles as one piece, then leaves
  await bin.el.animate([
    { transform: 'rotate(0)' }, { transform: 'rotate(-4.5deg)' }, { transform: 'rotate(3.2deg)' }, { transform: 'rotate(-1.6deg)' }, { transform: 'rotate(.6deg)' }, { transform: 'rotate(0)' },
  ], { duration: 520, easing: 'ease-out', composite: 'add' }).finished.catch(() => {});
  await sleep(140);
  await bin.el.animate([{ transform: 'translateY(0)', opacity: 1 }, { transform: 'translateY(180px)', opacity: 0 }], { duration: 380, easing: 'cubic-bezier(.5,0,.8,.4)', fill: 'forwards' }).finished.catch(() => {});
  bin.el.remove();
}

export function resetImage(img) {
  for (const a of img.getAnimations()) a.cancel();
  img.style.visibility = '';
  document.querySelectorAll('.paper-creases').forEach((n) => n.remove());
}
