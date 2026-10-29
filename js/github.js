// Publish receipt changes straight to a GitHub repo (one commit) — for GitHub Pages / Netlify / Vercel sites
import { blobToBase64 } from './util.js';

function client({ owner, repo, token }) {
  const base = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  return async function api(path, { method = 'GET', body, raw = false } = {}) {
    const res = await fetch(base + path, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: raw ? 'application/vnd.github.raw+json' : 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      let msg = res.statusText;
      try { msg = (await res.json()).message || msg; } catch {}
      const err = new Error(`GitHub ${res.status}: ${msg}`);
      err.status = res.status;
      throw err;
    }
    return raw ? res.text() : res.json();
  };
}

const clean = (dir) => (dir || '').replace(/^\/+|\/+$/g, '').replace(/\/{2,}/g, '/');
export const receiptsPath = (dir) => (clean(dir) ? clean(dir) + '/' : '') + 'receipts/';

export async function testConnection(cfg) {
  const api = client(cfg);
  const repo = await api('');
  const branch = cfg.branch || repo.default_branch;
  await api(`/git/ref/heads/${encodeURIComponent(branch)}`);
  return { branch, private: repo.private, canPush: !!(repo.permissions && repo.permissions.push) };
}

export async function fetchRemoteManifest(cfg) {
  const api = client(cfg);
  const path = receiptsPath(cfg.dir) + 'manifest.json';
  try {
    const txt = await api(`/contents/${path}?ref=${encodeURIComponent(cfg.branch)}`, { raw: true });
    return JSON.parse(txt);
  } catch (err) {
    if (err.status === 404) return { version: 2, receipts: [] };
    throw err;
  }
}

/**
 * files:   [{ path (relative to receipts/), blob }]
 * deletes: [path relative to receipts/]
 * manifest: object written to receipts/manifest.json
 */
export async function commit(cfg, { files, deletes, manifest, message }, log = () => {}) {
  const api = client(cfg);
  const root = receiptsPath(cfg.dir);
  const branch = encodeURIComponent(cfg.branch);
  log('Reading branch…');
  const ref = await api(`/git/ref/heads/${branch}`);
  const head = await api(`/git/commits/${ref.object.sha}`);

  const tree = [];
  let done = 0;
  const queue = files.slice();
  const worker = async () => {
    while (queue.length) {
      const f = queue.shift();
      const content = await blobToBase64(f.blob);
      const blob = await api('/git/blobs', { method: 'POST', body: { content, encoding: 'base64' } });
      tree.push({ path: root + f.path, mode: '100644', type: 'blob', sha: blob.sha });
      log(`Uploading images ${++done}/${files.length}`);
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  for (const p of deletes) tree.push({ path: root + p, mode: '100644', type: 'blob', sha: null });
  tree.push({ path: root + 'manifest.json', mode: '100644', type: 'blob', content: JSON.stringify(manifest, null, 1) + '\n' });

  log('Writing commit…');
  let newTree;
  try {
    newTree = await api('/git/trees', { method: 'POST', body: { base_tree: head.tree.sha, tree } });
  } catch (err) {
    // deleting a path that does not exist fails the whole tree — retry without deletions
    if (!deletes.length) throw err;
    newTree = await api('/git/trees', { method: 'POST', body: { base_tree: head.tree.sha, tree: tree.filter((t) => t.sha !== null) } });
  }
  const c = await api('/git/commits', { method: 'POST', body: { message, tree: newTree.sha, parents: [ref.object.sha] } });
  await api(`/git/refs/heads/${branch}`, { method: 'PATCH', body: { sha: c.sha } });
  log('Published.');
  return c;
}
