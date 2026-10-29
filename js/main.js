// Router: booth by default, admin panel on #admin — admin is locked to the site's GitHub repo owner
import { initBooth, reloadLibrary, pause } from './booth.js';
import * as Auth from './auth.js';

let admin = null;
let lockEl = null;
let paused = false;

function setPaused(v) { if (paused !== v) { paused = v; pause(v); } }

function buildLock() {
  lockEl = document.createElement('div');
  lockEl.className = 'admin-lock';
  lockEl.hidden = true;
  lockEl.innerHTML = `
    <form class="lock-card" id="lockForm" autocomplete="off">
      <div class="ad-brand"><i class="brand-mark"></i>Receipt Booth <span>/</span> Admin</div>
      <h2>Admin is locked</h2>
      <p class="lock-sub" id="lockSub"></p>
      <div class="lock-repo" id="lockRepo" hidden>
        <label>Owner<input name="owner" placeholder="github-username"></label>
        <label>Repository<input name="repo" placeholder="receipt-booth"></label>
      </div>
      <label class="lock-token" id="lockTokenRow">GitHub access token<input name="token" type="password" placeholder="github_pat_…" autocomplete="off" spellcheck="false"></label>
      <div class="lock-btns">
        <button class="pill pill-dark" type="submit" id="lockGo">Unlock</button>
        <button class="pill" type="button" id="lockBack">Back to booth</button>
      </div>
      <p class="lock-note" id="lockNote" role="status"></p>
      <details class="lock-help">
        <summary>How do I get a token?</summary>
        <p>GitHub → Settings → Developer settings → Personal access tokens → <b>Fine-grained tokens</b> → Generate new token. Repository access: <b>only this site’s repo</b>. Permissions: <b>Contents — Read and write</b>. The token stays in this browser only; use <i>Lock</i> in the admin to remove it.</p>
      </details>
    </form>`;
  document.body.appendChild(lockEl);
  const f = lockEl.querySelector('#lockForm');
  lockEl.querySelector('#lockBack').onclick = () => { location.hash = ''; };
  f.onsubmit = async (e) => {
    e.preventDefault();
    const note = lockEl.querySelector('#lockNote'), go = lockEl.querySelector('#lockGo');
    const token = f.elements.token.value.trim();
    if (!token) { note.textContent = 'Paste your token first.'; return; }
    go.disabled = true; note.textContent = 'Checking with GitHub…';
    try {
      await Auth.unlock(token, { owner: f.elements.owner.value.trim(), repo: f.elements.repo.value.trim() });
      f.elements.token.value = '';
      note.textContent = '';
      route();
    } catch (err) {
      note.textContent = err.message;
    } finally { go.disabled = false; }
  };
}

function showLock(msg = '') {
  if (!lockEl) buildLock();
  const site = Auth.siteRepo();
  const sub = lockEl.querySelector('#lockSub');
  const repoRow = lockEl.querySelector('#lockRepo');
  const tokenRow = lockEl.querySelector('#lockTokenRow');
  const go = lockEl.querySelector('#lockGo');
  if (site) {
    sub.innerHTML = `Only accounts that can push to <b></b> can open it. Sign in with a GitHub token.`;
    sub.querySelector('b').textContent = `${site.owner}/${site.repo}`;
    repoRow.hidden = true; tokenRow.hidden = false; go.hidden = false;
  } else if (Auth.isLocalDev()) {
    sub.textContent = 'Local preview: enter the GitHub repo this site is published from, plus a token that can push to it.';
    repoRow.hidden = false; tokenRow.hidden = false; go.hidden = false;
  } else {
    sub.textContent = 'This address does not know which GitHub repo it belongs to, so the admin stays closed. Set SITE_REPO in js/config.js.';
    repoRow.hidden = true; tokenRow.hidden = true; go.hidden = true;
  }
  lockEl.querySelector('#lockNote').textContent = msg;
  lockEl.hidden = false;
  document.body.classList.add('admin-open');
  if (!tokenRow.hidden) setTimeout(() => lockEl.querySelector('input[name=token]').focus(), 50);
}

function hideLock() {
  if (lockEl) lockEl.hidden = true;
  if (!(admin && admin.isOpen())) document.body.classList.remove('admin-open');
}

async function openAdmin() {
  if (!admin) admin = await import('./admin.js');
  admin.open({
    onChange: reloadLibrary,
    onClose: () => { location.hash = ''; },
    onLock: () => { Auth.lock(); location.hash = ''; },
  });
}

async function route() {
  if (location.hash === '#admin') {
    setPaused(true);
    if (!Auth.isUnlocked()) { if (admin && admin.isOpen()) admin.close(); showLock(); return; }
    hideLock();
    await openAdmin();
    const ok = await Auth.revalidate();
    if (!ok && location.hash === '#admin') { admin.close(); showLock('Your sign-in is no longer valid. Unlock again.'); }
  } else {
    hideLock();
    if (admin && admin.isOpen()) admin.close();
    setPaused(false);
  }
}

window.addEventListener('hashchange', route);
window.addEventListener('keydown', (e) => {
  const typing = e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable);
  // the shortcut only exists on a device that has already been unlocked
  if (!typing && e.shiftKey && e.key.toLowerCase() === 'a' && location.hash !== '#admin' && Auth.isUnlocked()) location.hash = 'admin';
  if (e.key === 'Escape' && lockEl && !lockEl.hidden) location.hash = '';
});

initBooth().then(route);
