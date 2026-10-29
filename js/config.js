// Which GitHub repository this site is published from.
// Only someone with write access to this repo can open the admin panel.
//
// On GitHub Pages (https://<username>.github.io/<repo>/) this is detected automatically.
// On a custom domain, Netlify or Vercel it has to be filled in.
export const SITE_REPO = 'Feelrz/reshito-shot';
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

// Printed under the small dotted line at the bottom of every receipt. Empty string = no watermark.
export const WATERMARK = 'https://reshito-shot.vercel.app/';
