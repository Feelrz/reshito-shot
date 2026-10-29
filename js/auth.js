// Admin lock: the admin panel opens only for a GitHub token that can push to THIS site's repo.
// The repo is fixed by the site (GitHub Pages URL or js/config.js), never typed in by the visitor.
import { LS } from './db.js';
import { SITE_REPO, SITE_BRANCH, SITE_DIR } from './config.js';
import * as GH from './github.js';

const KEY = 'rb-admin';          // { owner, repo, verifiedAt }
const GH_KEY = 'rb-github';      // publish settings (owner, repo, branch, dir, token)
const OFFLINE_GRACE = 30 * 24 * 3600 * 1000;

export const isLocalDev = () => /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);

/** The repo this site belongs to, or null if it cannot be known. */
export function siteRepo() {
  if (SITE_REPO && SITE_REPO.includes('/')) {
    const [owner, repo] = SITE_REPO.split('/').map((s) => s.trim());
    return { owner, repo, branch: SITE_BRANCH, dir: SITE_DIR, source: 'config' };
  }
  const host = location.hostname.toLowerCase();
  if (host.endsWith('.github.io')) {
    const owner = host.slice(0, -'.github.io'.length);
    const first = location.pathname.split('/').filter(Boolean)[0];
    const repo = first && !first.includes('.') ? first : `${owner}.github.io`;
    return { owner, repo, branch: SITE_BRANCH, dir: SITE_DIR, source: 'github-pages' };
  }
  return null;
}

function stored() { return LS.get(KEY, null); }

/** Quick, offline check used to decide whether to show any admin affordance at all. */
export function isUnlocked() {
  const s = stored(), gh = LS.get(GH_KEY, {}) || {};
  if (!s || !gh.token) return false;
  const site = siteRepo();
  if (site && (site.owner.toLowerCase() !== s.owner.toLowerCase() || site.repo.toLowerCase() !== s.repo.toLowerCase())) return false;
  if (!site && !isLocalDev()) return false;
  return true;
}

export function session() { return isUnlocked() ? { ...stored(), ...(LS.get(GH_KEY, {}) || {}) } : null; }

/** Verify a token against the site's repo and remember it on this device. */
export async function unlock(token, manual = {}) {
  const site = siteRepo() || (isLocalDev() ? { owner: manual.owner, repo: manual.repo, branch: '', dir: '' } : null);
  if (!site || !site.owner || !site.repo) throw new Error('This site does not know its GitHub repo yet. Set SITE_REPO in js/config.js.');
  const cfg = { owner: site.owner, repo: site.repo, branch: site.branch, dir: site.dir, token: token.trim() };
  let r;
  try { r = await GH.testConnection(cfg); }
  catch (err) {
    if (err.status === 401) throw new Error('That token is not valid.');
    if (err.status === 404 || err.status === 403) throw new Error(`That token has no access to ${site.owner}/${site.repo}.`);
    if (/Failed to fetch|NetworkError|Load failed/i.test(err.message)) throw new Error('Could not reach GitHub. Check the connection and try again.');
    throw err;
  }
  if (!r.canPush) throw new Error(`That account cannot push to ${site.owner}/${site.repo}.`);
  const prev = LS.get(GH_KEY, {}) || {};
  LS.set(GH_KEY, { ...prev, owner: site.owner, repo: site.repo, branch: site.branch || prev.branch || r.branch, dir: site.dir || prev.dir || '', token: cfg.token });
  LS.set(KEY, { owner: site.owner, repo: site.repo, verifiedAt: Date.now() });
  return true;
}

/** Re-check the saved token. Returns true if the admin may stay open. */
export async function revalidate() {
  const s = session();
  if (!s) return false;
  try {
    const r = await GH.testConnection({ owner: s.owner, repo: s.repo, branch: s.branch, token: s.token });
    if (!r.canPush) { lock(); return false; }
    LS.set(KEY, { owner: s.owner, repo: s.repo, verifiedAt: Date.now() });
    return true;
  } catch (err) {
    if (err.status === 401 || err.status === 403 || err.status === 404) { lock(); return false; }
    // offline (e.g. an event laptop): keep a recent verification
    return Date.now() - (s.verifiedAt || 0) < OFFLINE_GRACE;
  }
}

export function lock() {
  LS.del(KEY);
  const gh = LS.get(GH_KEY, {}) || {};
  delete gh.token;
  LS.set(GH_KEY, gh);
}
