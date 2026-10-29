// Cloudflare Worker: a tiny, safe front for an Upstash Redis counter.
// Only two routes exist — GET /get and GET /hit — so the Upstash token never reaches the browser.
//
// Setup (free tiers are enough):
// 1. Upstash console → create a Redis database → copy "UPSTASH_REDIS_REST_URL" and "UPSTASH_REDIS_REST_TOKEN".
// 2. Cloudflare dashboard → Workers & Pages → Create Worker → paste this file → Deploy.
// 3. Worker → Settings → Variables and Secrets: add UPSTASH_URL, UPSTASH_TOKEN (as Secret), ALLOWED_ORIGIN
//    (e.g. https://feelrz.github.io).
// 4. In js/config.js: COUNTER = { provider: 'upstash-proxy', url: 'https://<worker-name>.<you>.workers.dev' }

const KEY = 'receipt-booth:prints';

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const allow = env.ALLOWED_ORIGIN && origin.startsWith(env.ALLOWED_ORIGIN) ? origin : (env.ALLOWED_ORIGIN || '*');
    const cors = {
      'Access-Control-Allow-Origin': allow,
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Cache-Control': 'no-store',
      'Content-Type': 'application/json',
    };
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });
    if (request.method !== 'GET') return new Response('{"error":"method"}', { status: 405, headers: cors });

    const path = new URL(request.url).pathname.replace(/\/+$/, '');
    const cmd = path === '/hit' ? 'incr' : path === '/get' ? 'get' : null;
    if (!cmd) return new Response('{"error":"not found"}', { status: 404, headers: cors });

    const res = await fetch(`${env.UPSTASH_URL}/${cmd}/${encodeURIComponent(KEY)}`, {
      headers: { Authorization: `Bearer ${env.UPSTASH_TOKEN}` },
    });
    if (!res.ok) return new Response('{"error":"upstream"}', { status: 502, headers: cors });
    const { result } = await res.json();
    return new Response(JSON.stringify({ value: Number(result || 0) }), { headers: cors });
  },
};
