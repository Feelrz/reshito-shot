// Which GitHub repository this site is published from.
// Only someone with write access to this repo can open the admin panel.
//
// On GitHub Pages (https://<username>.github.io/<repo>/) this is detected automatically: leave it empty.
// On a custom domain, Netlify or Vercel, fill it in, e.g. SITE_REPO = 'nafil/receipt-booth'.
export const SITE_REPO = '';
export const SITE_BRANCH = '';   // empty = the repo's default branch
export const SITE_DIR = '';      // folder that holds index.html inside the repo; empty = repo root

// Global print counter shown on the split-flap display (see js/counter.js).
// 'abacus' works out of the box. To use Upstash instead, deploy counter-worker/ (free Cloudflare Worker)
// and set: { provider: 'upstash-proxy', url: 'https://<your-worker>.workers.dev' }
export const COUNTER = {
  provider: 'abacus',
  namespace: 'feelrz-receipt-booth',
  key: 'prints',
};

export const CREDIT = { label: 'made by NAV', url: 'https://www.instagram.com/not.a.vision/' };
