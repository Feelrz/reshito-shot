// Admin panel (#admin): upload receipts, auto-place the photo, review, publish.
import { $, clamp, makeCanvas, decodeImage, encodeBest } from './util.js';
import { Library, defaultZone } from './library.js';
import { DB, LS } from './db.js';
import { processReceipt, autoZone } from './process.js';
import { composePrint } from './print.js';
import { Seg } from './seg.js';
import { makeZip } from './zip.js';
import * as GH from './github.js';
import { snapshot, saveBlob } from './booth.js';

let root = null, opts = {}, isShown = false;
let filter = 'all';
let ed = null;                 // editor state
let testShot = null;           // photo used for test prints when the booth has none
const thumbs = new Map();

export const isOpen = () => isShown;

export async function open(o) {
  opts = o || {};
  if (!root) build();
  root.hidden = false;
  isShown = true;
  document.body.classList.add('admin-open');
  await refresh();
}

export function close() {
  if (!root) return;
  closeEditor();
  root.hidden = true;
  isShown = false;
  document.body.classList.remove('admin-open');
  if (opts.onChange) opts.onChange();
}

/* ---------------------------------------------------------------------- */
function build() {
  root = $('admin');
  root.innerHTML = `
  <header class="ad-top">
    <div class="ad-brand"><i class="brand-mark"></i>Receipt Booth <span>/</span> Admin</div>
    <div class="ad-stats" id="adStats"></div>
    <div class="ad-top-btns">
      <button class="pill" id="adLock" type="button" title="Sign out of the admin on this device">Lock</button>
      <button class="pill" id="adBack" type="button">Back to booth</button>
    </div>
  </header>
  <main class="ad-main">
    <section class="ad-drop" id="adDrop">
      <input type="file" id="adFiles" accept="image/*" multiple hidden>
      <div class="ad-drop-inner">
        <strong>Drop receipt images here</strong>
        <span>or <button class="ad-link" id="adPick" type="button">choose files</button> · PNG, JPG or WebP · as many as you like</span>
        <small>Every receipt is straightened, cropped and read automatically to find where the photo prints. Receipts with coloured pictures are added switched off.</small>
      </div>
      <ol class="ad-queue" id="adQueue"></ol>
    </section>
    <section class="ad-toolbar">
      <div class="ad-filters" id="adFilters">
        <button type="button" data-f="all" class="on">All</button>
        <button type="button" data-f="local">Uploaded</button>
        <button type="button" data-f="changed">Unpublished</button>
        <button type="button" data-f="off">Off</button>
        <button type="button" data-f="removed">Removed</button>
      </div>
      <span class="ad-count" id="adCount"></span>
    </section>
    <section class="ad-grid" id="adGrid"></section>
  </main>
  <footer class="ad-bar">
    <span id="adPending" class="ad-pending"></span>
    <div class="ad-bar-actions">
      <button class="pill" id="adSettingsBtn" type="button">GitHub settings</button>
      <button class="pill" id="adExport" type="button">Export ZIP</button>
      <button class="pill pill-dark" id="adPublish" type="button">Publish to GitHub</button>
    </div>
  </footer>

  <div class="ad-modal" id="adEditor" hidden>
    <div class="ad-editor">
      <div class="ad-stagewrap">
        <div class="ad-stage" id="edStage">
          <img id="edImg" alt="">
          <div class="ad-zone" id="edZone"><span>PHOTO</span><i class="ad-handle" id="edHandle"></i></div>
        </div>
        <img id="edTest" class="ad-test" alt="Test print" hidden>
      </div>
      <aside class="ad-side">
        <h3 id="edTitle"></h3>
        <p class="ad-meta" id="edMeta"></p>
        <label class="ad-check"><input type="checkbox" id="edOn"> Use this receipt in the booth</label>
        <label class="ad-field"><span>Paper size</span><input type="range" id="edScale" min="0.5" max="2.5" step="0.05"><output id="edScaleOut"></output></label>
        <p class="ad-help">Drag the box to move where the photo prints. Drag its corner to resize.</p>
        <div class="ad-btns">
          <button class="pill" id="edAuto" type="button">Auto-place</button>
          <button class="pill" id="edTestBtn" type="button">Test print</button>
          <label class="pill ad-filepill">Test photo…<input type="file" accept="image/*" id="edPhoto" hidden></label>
        </div>
        <p class="ad-help" id="edNote"></p>
        <div class="ad-btns ad-end">
          <button class="pill danger" id="edDelete" type="button">Remove</button>
          <button class="pill pill-dark" id="edDone" type="button">Done</button>
        </div>
      </aside>
    </div>
  </div>

  <div class="ad-modal" id="adSettings" hidden>
    <form class="ad-settings" id="adSettingsForm" autocomplete="off">
      <h3>Publish to GitHub</h3>
      <p class="ad-help">Publishing commits the new receipt images and the updated <code>receipts/manifest.json</code> to your repo in one commit. GitHub Pages, Netlify or Vercel then redeploy the site, usually within a minute.</p>
      <label>Owner<input name="owner" readonly></label>
      <label>Repository<input name="repo" readonly></label>
      <label>Branch<input name="branch" placeholder="main"></label>
      <label>Site folder in repo<input name="dir" placeholder="leave empty if index.html is at the root"></label>
      <p class="ad-help">Signed in on this device with your GitHub token. Owner and repository come from the site itself. Use <b>Lock</b> (top right) to sign out and remove the token from this browser.</p>
      <div class="ad-btns">
        <button class="pill" type="button" id="setTest">Test connection</button>
        <button class="pill pill-dark" type="submit">Save</button>
        <button class="pill" type="button" id="setClose">Close</button>
      </div>
      <p class="ad-help" id="setNote"></p>
      <hr>
      <button class="pill danger" type="button" id="setClear">Clear local uploads &amp; edits</button>
    </form>
  </div>
  <div class="ad-toast" id="adToast" role="status"></div>`;

  $('adBack').onclick = () => (opts.onClose ? opts.onClose() : close());
  $('adLock').onclick = () => { if (opts.onLock) opts.onLock(); else close(); };
  $('adPick').onclick = () => $('adFiles').click();
  $('adFiles').onchange = (e) => { handleFiles([...e.target.files]); e.target.value = ''; };
  const drop = $('adDrop');
  drop.addEventListener('dragover', (e) => { e.preventDefault(); e.stopPropagation(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault(); e.stopPropagation(); drop.classList.remove('over');
    handleFiles([...(e.dataTransfer?.files || [])]);
  });
  root.addEventListener('dragover', (e) => { e.preventDefault(); e.stopPropagation(); });
  root.addEventListener('drop', (e) => { e.preventDefault(); e.stopPropagation(); handleFiles([...(e.dataTransfer?.files || [])]); });

  $('adFilters').onclick = (e) => {
    const b = e.target.closest('button'); if (!b) return;
    filter = b.dataset.f;
    for (const x of $('adFilters').children) x.classList.toggle('on', x === b);
    renderGrid();
  };
  $('adGrid').onclick = (e) => { const c = e.target.closest('.ad-card'); if (c) openEditor(c.dataset.id); };

  $('adSettingsBtn').onclick = openSettings;
  $('setClose').onclick = () => { $('adSettings').hidden = true; };
  $('adSettingsForm').onsubmit = (e) => { e.preventDefault(); saveSettings(); $('setNote').textContent = 'Saved.'; };
  $('setTest').onclick = async () => {
    saveSettings();
    const cfg = settings();
    $('setNote').textContent = 'Checking…';
    try {
      const r = await GH.testConnection(cfg);
      $('setNote').textContent = r.canPush ? `Connected. Branch “${r.branch}” — ready to publish.` : 'Connected, but this token cannot push to the repo.';
      if (!cfg.branch) { LS.set('rb-github', { ...cfg, branch: r.branch }); fillSettings(); }
    } catch (err) { $('setNote').textContent = err.message + (err.message.includes('Failed to fetch') ? ' (network blocked here — try on your hosted site)' : ''); }
  };
  $('setClear').onclick = async () => {
    if (!(await confirmInline($('setClear'), 'Click again to clear everything uploaded or edited in this browser'))) return;
    await DB.clear('receipts'); await DB.clear('overrides');
    for (const id of [...Library.urls.keys()]) Library.forget(id);
    $('adSettings').hidden = true;
    toast('Local uploads and edits cleared.');
    await refresh();
  };
  $('adExport').onclick = exportZip;
  $('adPublish').onclick = publish;

  // editor
  $('edDone').onclick = () => saveEditor(true);
  $('edAuto').onclick = autoPlace;
  $('edTestBtn').onclick = toggleTest;
  $('edPhoto').onchange = async (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) { testShot = await shotFromFile(f); runTest(); } };
  $('edDelete').onclick = removeOrRestore;
  $('edOn').onchange = () => { if (ed) { ed.on = $('edOn').checked; } };
  $('edScale').oninput = () => { if (ed) { ed.scale = +$('edScale').value; $('edScaleOut').textContent = '×' + ed.scale.toFixed(2); } };
  $('adEditor').addEventListener('click', (e) => { if (e.target.id === 'adEditor') saveEditor(true); });
  bindZoneDrag();
  window.addEventListener('keydown', (e) => {
    if (!isShown) return;
    if (e.key === 'Escape') {
      if (!$('adSettings').hidden) $('adSettings').hidden = true;
      else if (ed) saveEditor(true);
    }
  });
}

/* ---------------------------------------------------------------------- */
async function refresh() {
  await Library.load();
  await renderGrid();
}

async function pending() {
  const locals = (await DB.all('receipts')).filter((r) => !r.published);
  const ovs = (await DB.all('overrides')).filter((o) => !o.published);
  return { locals, ovs, count: locals.length + ovs.length };
}

async function renderGrid() {
  const all = Library.items, removed = Library.deleted || [];
  const p = await pending();
  const changedIds = new Set([...p.locals.map((r) => r.id), ...p.ovs.map((o) => o.id)]);
  let list;
  switch (filter) {
    case 'local': list = all.filter((r) => r.origin === 'local'); break;
    case 'changed': list = [...all, ...removed].filter((r) => changedIds.has(r.id)); break;
    case 'off': list = all.filter((r) => !r.on); break;
    case 'removed': list = removed; break;
    default: list = all;
  }
  const on = all.filter((r) => r.on).length;
  $('adStats').textContent = `${on} in use · ${all.length} receipts`;
  $('adCount').textContent = `${list.length} shown`;
  $('adPending').textContent = p.count
    ? `${p.locals.length} new/edited upload${p.locals.length === 1 ? '' : 's'} · ${p.ovs.length} edit${p.ovs.length === 1 ? '' : 's'} — live in this browser, not yet published`
    : 'Everything is published.';
  $('adPublish').disabled = !p.count;

  const grid = $('adGrid');
  grid.textContent = '';
  const frag = document.createDocumentFragment();
  for (const r of list) {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'ad-card' + (r.on ? '' : ' off');
    card.dataset.id = r.id;
    const [x, y, w, h] = r.zone;
    const badges = [];
    if (r.origin === 'local') badges.push('<b class="bd new">UPLOAD</b>');
    if (changedIds.has(r.id)) badges.push('<b class="bd ch">UNPUBLISHED</b>');
    if (r.colorArt) badges.push('<b class="bd col">COLOUR</b>');
    if (!r.on) badges.push('<b class="bd">OFF</b>');
    card.innerHTML = `<div class="ad-thumb" style="aspect-ratio:${r.w}/${r.h}"><img alt="" loading="lazy"><i class="ad-zbox" style="left:${x * 100}%;top:${y * 100}%;width:${w * 100}%;height:${h * 100}%"></i></div>
      <div class="ad-cap"><span>${r.id}</span><span class="bds">${badges.join('')}</span></div>`;
    frag.appendChild(card);
    const img = card.querySelector('img');
    Library.url(r).then((u) => { img.src = u; }).catch(() => {});
  }
  grid.appendChild(frag);
  if (!list.length) grid.innerHTML = `<p class="ad-empty">${filter === 'all' ? 'No receipts yet — drop some above.' : 'Nothing here.'}</p>`;
}

/* ---------------------------------------------------------------------- */
/*  Upload + automatic processing                                          */
/* ---------------------------------------------------------------------- */
const slug = (s) => s.toLowerCase().replace(/\.[a-z0-9]+$/, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24) || 'receipt';

async function handleFiles(files) {
  files = files.filter((f) => f && f.type && f.type.startsWith('image/'));
  if (!files.length) return;
  const q = $('adQueue');
  const existing = new Set([...Library.items, ...(Library.deleted || [])].map((r) => r.id));
  let added = 0;
  for (const f of files) {
    const li = document.createElement('li');
    li.innerHTML = `<span>${f.name}</span><em>processing…</em>`;
    q.prepend(li);
    try {
      const res = await processReceipt(f);
      let id = 'u-' + slug(f.name);
      while (existing.has(id)) id = 'u-' + slug(f.name).slice(0, 18) + '-' + Math.random().toString(36).slice(2, 5);
      existing.add(id);
      const rec = {
        id, file: `${id}.${res.ext}`, w: res.w, h: res.h, zone: res.zone, scale: res.scale,
        on: !res.colorArt, colorArt: res.colorArt, set: 'upload', blob: res.blob, type: res.type,
        added: Date.now(), published: false, name: f.name,
      };
      await DB.put('receipts', rec);
      const notes = [`${res.w}×${res.h}`];
      if (Math.abs(res.skew) >= 0.15) notes.push(`straightened ${res.skew.toFixed(1)}°`);
      if (res.scale !== 1) notes.push(`size ×${res.scale}`);
      if (res.colorArt) notes.push('coloured picture → switched off');
      li.querySelector('em').textContent = 'ready · ' + notes.join(' · ');
      li.classList.add(res.colorArt ? 'warn' : 'ok');
      added++;
    } catch (err) {
      console.error(err);
      li.querySelector('em').textContent = 'could not read this image';
      li.classList.add('err');
    }
  }
  if (added) toast(`${added} receipt${added === 1 ? '' : 's'} added — already live in this browser.`);
  await refresh();
}

/* ---------------------------------------------------------------------- */
/*  Editor                                                                 */
/* ---------------------------------------------------------------------- */
async function openEditor(id) {
  const r = Library.items.find((x) => x.id === id) || (Library.deleted || []).find((x) => x.id === id);
  if (!r) return;
  ed = { r, zone: r.zone.slice(), on: r.on, scale: r.scale || 1, removed: !!r.deleted };
  $('edTitle').textContent = r.id;
  $('edMeta').textContent = `${r.w}×${r.h}px · ${r.origin === 'local' ? 'uploaded here' : 'bundled with the site'}${r.colorArt ? ' · has a coloured picture' : ''}`;
  $('edOn').checked = ed.on;
  $('edScale').value = ed.scale;
  $('edScaleOut').textContent = '×' + ed.scale.toFixed(2);
  $('edDelete').textContent = ed.removed ? 'Restore' : 'Remove';
  $('edNote').textContent = '';
  $('edTest').hidden = true; $('edStage').hidden = false; $('edTestBtn').textContent = 'Test print';
  const img = $('edImg');
  img.src = await Library.url(r);
  await img.decode().catch(() => {});
  $('edStage').style.aspectRatio = `${r.w} / ${r.h}`;
  drawZone();
  $('adEditor').hidden = false;
}

function closeEditor() {
  if (!root) return;
  $('adEditor').hidden = true;
  const t = $('edTest');
  if (t.src && t.src.startsWith('blob:')) URL.revokeObjectURL(t.src);
  t.removeAttribute('src');
  ed = null;
}

function drawZone() {
  const [x, y, w, h] = ed.zone;
  Object.assign($('edZone').style, { left: x * 100 + '%', top: y * 100 + '%', width: w * 100 + '%', height: h * 100 + '%' });
}

function fixZone(z, r) {
  let [x, y, w] = z;
  w = clamp(w, 0.25, 1);
  let h = (w * 1.25 * r.w) / r.h;
  if (h > 1) { h = 1; w = (h * r.h) / (1.25 * r.w); }
  x = clamp(x, 0, 1 - w); y = clamp(y, 0, 1 - h);
  return [x, y, w, h].map((v) => Math.round(v * 10000) / 10000);
}

function bindZoneDrag() {
  const zone = $('edZone'), handle = $('edHandle'), stage = $('edStage');
  let mode = null, sx = 0, sy = 0, start = null;
  const down = (m) => (e) => {
    if (!ed) return;
    e.preventDefault(); e.stopPropagation();
    mode = m; sx = e.clientX; sy = e.clientY; start = ed.zone.slice();
    try { e.target.setPointerCapture(e.pointerId); } catch {}
  };
  zone.addEventListener('pointerdown', down('move'));
  handle.addEventListener('pointerdown', down('size'));
  const move = (e) => {
    if (!mode || !ed) return;
    const rect = stage.getBoundingClientRect();
    const dx = (e.clientX - sx) / rect.width, dy = (e.clientY - sy) / rect.height;
    if (mode === 'move') ed.zone = fixZone([start[0] + dx, start[1] + dy, start[2]], ed.r);
    else ed.zone = fixZone([start[0], start[1], start[2] + dx], ed.r);
    drawZone();
  };
  const up = () => { mode = null; };
  zone.addEventListener('pointermove', move); handle.addEventListener('pointermove', move);
  zone.addEventListener('pointerup', up); handle.addEventListener('pointerup', up);
  zone.addEventListener('pointercancel', up); handle.addEventListener('pointercancel', up);
}

function autoPlace() {
  if (!ed) return;
  const img = $('edImg');
  ed.zone = fixZone(autoZone(img, ed.r.w, ed.r.h), ed.r);
  drawZone();
  $('edNote').textContent = 'Placed automatically.';
  if (!$('edTest').hidden) runTest();
}

async function saveEditor(andClose) {
  if (!ed) return;
  const { r } = ed;
  const changed = ed.on !== r.on || Math.abs(ed.scale - r.scale) > 1e-6 || ed.zone.some((v, i) => Math.abs(v - r.zone[i]) > 1e-4);
  if (changed) {
    if (r.origin === 'local') {
      const cur = await DB.get('receipts', r.id);
      if (cur) await DB.put('receipts', { ...cur, zone: ed.zone, on: ed.on, scale: ed.scale, published: false });
    } else {
      const cur = (await DB.get('overrides', r.id)) || { id: r.id };
      await DB.put('overrides', { ...cur, zone: ed.zone, on: ed.on, scale: ed.scale, published: false });
    }
  }
  if (andClose) closeEditor();
  if (changed) await refresh();
}

async function removeOrRestore() {
  if (!ed) return;
  const { r } = ed;
  if (ed.removed) {
    const cur = (await DB.get('overrides', r.id)) || { id: r.id };
    await DB.put('overrides', { ...cur, deleted: false, published: false });
    toast(`${r.id} restored.`);
  } else if (r.origin === 'local') {
    const cur = await DB.get('receipts', r.id);
    await DB.del('receipts', r.id);
    if (cur && cur.published) await DB.put('overrides', { id: r.id, deleted: true, published: false });
    Library.forget(r.id);
    toast(`${r.id} removed.`);
  } else {
    const cur = (await DB.get('overrides', r.id)) || { id: r.id };
    await DB.put('overrides', { ...cur, deleted: true, published: false });
    toast(`${r.id} removed — publish to remove it from the site.`);
  }
  closeEditor();
  await refresh();
}

/* ---- test print ---- */
async function shotFromFile(file) {
  const img = await decodeImage(URL.createObjectURL(file));
  const [c, x] = makeCanvas(720, 900);
  const sw = img.naturalWidth, sh = img.naturalHeight, ar = 0.8;
  let cw, ch; if (sw / sh > ar) { ch = sh; cw = sh * ar; } else { cw = sw; ch = sw / ar; }
  x.drawImage(img, (sw - cw) / 2, (sh - ch) / 2, cw, ch, 0, 0, 720, 900);
  URL.revokeObjectURL(img.src);
  let mask = null;
  if (await Seg.init()) {
    const [si, sx] = makeCanvas(288, 360); sx.drawImage(c, 0, 0, 288, 360);
    const arr = await Seg.segment(si, 288, 360);
    if (arr) mask = { arr, w: 288, h: 360 };
  }
  return { canvas: c, mask, mode: mask ? 'focus' : 'full' };
}

async function toggleTest() {
  if (!$('edTest').hidden) {
    $('edTest').hidden = true; $('edStage').hidden = false; $('edTestBtn').textContent = 'Test print';
    return;
  }
  runTest();
}

async function runTest() {
  if (!ed) return;
  $('edNote').textContent = 'Printing a test…';
  const shot = testShot || (await snapshot().catch(() => null));
  if (!shot) { $('edNote').textContent = 'No photo yet — choose a test photo, or start the camera in the booth.'; return; }
  const rec = { ...ed.r, zone: ed.zone, scale: ed.scale };
  const out = composePrint(shot, rec, $('edImg'), { jitter: 0 });
  const blob = await encodeBest(out.canvas, { quality: 0.9 });
  const t = $('edTest');
  if (t.src && t.src.startsWith('blob:')) URL.revokeObjectURL(t.src);
  t.src = URL.createObjectURL(blob);
  t.hidden = false; $('edStage').hidden = true; $('edTestBtn').textContent = 'Edit placement';
  $('edNote').textContent = 'This is how a print on this receipt looks (exact placement varies slightly per print).';
}

/* ---------------------------------------------------------------------- */
/*  Publish / export                                                       */
/* ---------------------------------------------------------------------- */
function settings() { return LS.get('rb-github', {}) || {}; }
function fillSettings() {
  const f = $('adSettingsForm'), s = settings();
  for (const k of ['owner', 'repo', 'branch', 'dir']) f.elements[k].value = s[k] || '';
}
function saveSettings() {
  const f = $('adSettingsForm');
  const s = { ...settings() };                // owner, repo and token are set by the admin lock
  for (const k of ['branch', 'dir']) s[k] = f.elements[k].value.trim();
  LS.set('rb-github', s);
}
function openSettings() { fillSettings(); $('setNote').textContent = ''; $('adSettings').hidden = false; }

const entryOf = (r) => {
  const e = { id: r.id, file: r.file, w: r.w, h: r.h, zone: r.zone, set: r.set || 'upload' };
  if (r.scale && r.scale !== 1) e.scale = r.scale;
  if (r.on === false) e.on = false;
  return e;
};

function mergeManifest(base, p) {
  const ov = new Map(p.ovs.map((o) => [o.id, o]));
  const dels = new Set(p.ovs.filter((o) => o.deleted).map((o) => o.id));
  const list = (base.receipts || []).filter((r) => !dels.has(r.id)).map((r) => {
    const e = { ...r };
    delete e.pack; delete e.offset; delete e.length; delete e.type;
    const o = ov.get(r.id);
    if (o) {
      if (o.zone) e.zone = o.zone;
      if (o.scale) { if (o.scale !== 1) e.scale = o.scale; else delete e.scale; }
      if (o.on === false) e.on = false; else if (o.on === true) delete e.on;
    }
    return e;
  });
  for (const r of p.locals) {
    const e = entryOf(r);
    const i = list.findIndex((x) => x.id === r.id);
    if (i >= 0) list[i] = e; else list.push(e);
  }
  const removedFiles = (base.receipts || []).filter((r) => dels.has(r.id) && r.file).map((r) => r.file);
  return { manifest: { version: 2, updated: new Date().toISOString(), receipts: list }, removedFiles };
}

async function publish() {
  const cfg = settings();
  if (!cfg.owner || !cfg.repo || !cfg.token) { openSettings(); return; }
  if (!cfg.branch) cfg.branch = 'main';
  const p = await pending();
  if (!p.count) { toast('Nothing to publish.'); return; }
  const btn = $('adPublish');
  btn.disabled = true;
  try {
    toast('Reading the site’s current receipt list…', true);
    const remote = await GH.fetchRemoteManifest(cfg);
    const { manifest, removedFiles } = mergeManifest(remote, p);
    const files = p.locals.map((r) => ({ path: r.file, blob: r.blob }));
    const msg = `Receipt Booth: ${p.locals.length ? `+${p.locals.length} receipt${p.locals.length === 1 ? '' : 's'}` : ''}${p.locals.length && p.ovs.length ? ', ' : ''}${p.ovs.length ? `${p.ovs.length} edit${p.ovs.length === 1 ? '' : 's'}` : ''}`;
    await GH.commit(cfg, { files, deletes: removedFiles, manifest, message: msg }, (t) => toast(t, true));
    for (const r of p.locals) await DB.put('receipts', { ...r, published: true });
    for (const o of p.ovs) await DB.put('overrides', { ...o, published: true });
    toast('Published. The live site updates as soon as it redeploys (about a minute).');
    await refresh();
  } catch (err) {
    console.error(err);
    const blocked = /Failed to fetch|NetworkError|Load failed/i.test(err.message);
    toast(blocked ? 'Could not reach GitHub from here. Publish from your hosted site, or use Export ZIP.' : err.message);
  } finally {
    btn.disabled = false;
  }
}

async function exportZip() {
  const p = await pending();
  const { manifest, removedFiles } = mergeManifest(Library.manifest || { receipts: [] }, p);
  const files = [{ name: 'receipts/manifest.json', data: JSON.stringify(manifest, null, 1) + '\n' }];
  for (const r of p.locals) files.push({ name: 'receipts/' + r.file, data: r.blob });
  const howto = [
    'Receipt Booth — receipt update',
    '',
    '1. Copy the "receipts" folder from this zip into your site folder and let it replace manifest.json.',
    '2. Upload / commit the changed files to your host.',
    removedFiles.length ? '3. You can also delete these files from receipts/ (no longer used):\n   ' + removedFiles.join('\n   ') : '',
  ].join('\n');
  files.push({ name: 'HOW-TO-UPDATE.txt', data: howto });
  const zip = await makeZip(files);
  const r = await saveBlob(zip, `receipt-booth-update-${new Date().toISOString().slice(0, 10)}.zip`);
  toast(r === 'saved' ? `ZIP ready: ${p.locals.length} new image${p.locals.length === 1 ? '' : 's'} + manifest.` : 'Download not available in this view.');
}

/* ---------------------------------------------------------------------- */
let toastTimer = 0;
function toast(msg, sticky = false) {
  const t = $('adToast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  if (!sticky) toastTimer = setTimeout(() => t.classList.remove('show'), 4200);
}

function confirmInline(btn, text) {
  return new Promise((res) => {
    if (btn.dataset.armed) { delete btn.dataset.armed; btn.textContent = btn.dataset.old; res(true); return; }
    btn.dataset.armed = '1';
    const old = btn.textContent;
    btn.dataset.old = old;
    btn.textContent = text;
    setTimeout(() => { if (btn.dataset.armed) { delete btn.dataset.armed; btn.textContent = old; res(false); } }, 3500);
  });
}

export { defaultZone };
