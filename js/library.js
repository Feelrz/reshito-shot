// Receipt library = bundled receipts (receipts/manifest.json) + receipts uploaded in the admin panel (IndexedDB)
import { DB } from './db.js';
import { decodeImage } from './util.js';

const ROOT = new URL('../receipts/', import.meta.url);

export function defaultZone(w, h) {
  let zw = 0.84, zh = (zw * w * 1.25) / h;
  if (zh > 0.8) { zh = 0.8; zw = (zh * h) / (1.25 * w); }
  return [(1 - zw) / 2, Math.max(0.05, 0.52 - zh / 2), zw, zh];
}

function normalize(r, origin) {
  return {
    id: String(r.id),
    file: r.file || null,
    w: r.w, h: r.h,
    zone: Array.isArray(r.zone) && r.zone.length === 4 ? r.zone.slice() : defaultZone(r.w, r.h),
    scale: r.scale || 1,
    wm: typeof r.wm === 'number' ? r.wm : null,
    on: r.on !== false,
    set: r.set || origin,
    origin,
    blob: r.blob || null,
    type: r.type || (r.blob && r.blob.type) || null,
    pack: r.pack ?? null, offset: r.offset ?? 0, length: r.length ?? 0,
    published: !!r.published,
    added: r.added || 0,
    colorArt: !!r.colorArt,
    name: r.name || '',
  };
}

export const Library = {
  manifest: { receipts: [] },
  items: [],
  urls: new Map(),
  packs: new Map(),

  async load() {
    let m = { receipts: [] };
    try {
      const res = await fetch(new URL('manifest.json', ROOT), { cache: 'no-cache' });
      if (res.ok) m = await res.json();
    } catch (err) { console.warn('[receipt-booth] manifest not loaded', err); }
    this.manifest = m;
    const bundled = (m.receipts || []).map((r) => normalize(r, 'bundled'));
    const [local, overrides] = await Promise.all([DB.all('receipts'), DB.all('overrides')]);
    const ov = new Map(overrides.map((o) => [o.id, o]));
    for (const r of bundled) {
      const o = ov.get(r.id);
      if (!o) continue;
      if (o.zone) r.zone = o.zone.slice();
      if (o.on != null) r.on = o.on;
      if (o.scale) r.scale = o.scale;
      if (o.deleted) r.deleted = true;
      r.edited = true;
    }
    const ids = new Set(bundled.map((r) => r.id));
    const locals = local.filter((r) => !ids.has(r.id)).map((r) => normalize(r, 'local'));
    locals.sort((a, b) => a.added - b.added);
    this.items = [...bundled.filter((r) => !r.deleted), ...locals];
    this.deleted = bundled.filter((r) => r.deleted);
    return this.items;
  },

  enabled() { return this.items.filter((r) => r.on); },

  async packBlob(i) {
    if (!this.packs.has(i)) {
      const p = fetch(new URL(`packs/pack-${i}.${this.manifest.packExt || 'bin'}`, ROOT)).then((r) => { if (!r.ok) throw new Error('pack ' + i); return r.blob(); });
      p.catch(() => this.packs.delete(i));
      this.packs.set(i, p);
    }
    return this.packs.get(i);
  },

  async url(r) {
    if (this.urls.has(r.id)) return this.urls.get(r.id);
    let url;
    if (r.blob) url = URL.createObjectURL(r.blob);
    else if (r.pack != null) {
      const pack = await this.packBlob(r.pack);
      url = URL.createObjectURL(pack.slice(r.offset, r.offset + r.length, r.type || 'image/webp'));
    } else url = new URL(r.file, ROOT).href;
    this.urls.set(r.id, url);
    return url;
  },

  async image(r) { return decodeImage(await this.url(r)); },

  forget(id) {
    const u = this.urls.get(id);
    if (u && u.startsWith('blob:')) URL.revokeObjectURL(u);
    this.urls.delete(id);
  },
};
