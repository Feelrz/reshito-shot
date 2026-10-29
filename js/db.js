// Tiny IndexedDB wrapper. Everything is wrapped so the booth still works when storage is unavailable.
const DB_NAME = 'receipt-booth';
const VERSION = 1;
let dbp = null;

function open() {
  if (dbp) return dbp;
  dbp = new Promise((res, rej) => {
    let req;
    try { req = indexedDB.open(DB_NAME, VERSION); } catch (e) { rej(e); return; }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('receipts')) db.createObjectStore('receipts', { keyPath: 'id' });   // uploaded receipts (local)
      if (!db.objectStoreNames.contains('overrides')) db.createObjectStore('overrides', { keyPath: 'id' }); // edits to bundled receipts
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv', { keyPath: 'key' });
    };
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
  dbp.catch(() => { dbp = null; });
  return dbp;
}

function tx(store, mode, fn) {
  return open().then((db) => new Promise((res, rej) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    let out;
    Promise.resolve(fn(s)).then((v) => { out = v; });
    t.oncomplete = () => res(out);
    t.onerror = () => rej(t.error);
    t.onabort = () => rej(t.error);
  }));
}
const req2p = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

// in-memory fallback when IndexedDB is unavailable (private mode, sandboxed previews)
const mem = { receipts: new Map(), overrides: new Map(), kv: new Map() };
const keyOf = (store, v) => (store === 'kv' ? v.key : v.id);
let usable = null;
async function ok() { if (usable === null) { try { await open(); usable = true; } catch { usable = false; } } return usable; }

export const DB = {
  async all(store) {
    if (!(await ok())) return [...mem[store].values()];
    try { return await tx(store, 'readonly', (s) => req2p(s.getAll())); } catch { return [...mem[store].values()]; }
  },
  async get(store, key) {
    if (!(await ok())) return mem[store].get(key);
    try { return await tx(store, 'readonly', (s) => req2p(s.get(key))); } catch { return mem[store].get(key); }
  },
  async put(store, value) {
    if (!(await ok())) { mem[store].set(keyOf(store, value), value); return; }
    try { await tx(store, 'readwrite', (s) => req2p(s.put(value))); } catch { usable = false; mem[store].set(keyOf(store, value), value); }
  },
  async del(store, key) {
    mem[store].delete(key);
    if (await ok()) { try { await tx(store, 'readwrite', (s) => req2p(s.delete(key))); } catch {} }
  },
  async clear(store) {
    mem[store].clear();
    if (await ok()) { try { await tx(store, 'readwrite', (s) => req2p(s.clear())); } catch {} }
  },
  async persistent() { return ok(); },
};

// localStorage that never throws
export const LS = {
  get(k, d = null) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  del(k) { try { localStorage.removeItem(k); } catch {} },
};
