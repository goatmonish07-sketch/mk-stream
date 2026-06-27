// Vercel EDGE Function â€” mirror of the working Netlify proxy for MK player.
// Edge runtime streams natively (like Netlify) so movies/series don't choke.
// Reachable at: https://<your-site>.vercel.app/api/proxy?url=<encoded>

export const config = { runtime: 'edge' };

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,HEAD,OPTIONS',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Expose-Headers': '*',
  'Access-Control-Max-Age': '86400',
};

export default async function handler(request) {
  if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });

  const here = new URL(request.url);
  const target = here.searchParams.get('url');
  if (!target) {
    return new Response('MK proxy is running. Use ?url=<encoded stream url>', {
      status: 200, headers: { ...CORS, 'Content-Type': 'text/plain' },
    });
  }

  let targetUrl;
  try { targetUrl = new URL(target); }
  catch { return new Response('Invalid url parameter', { status: 400, headers: CORS }); }

  // Forward method, body, key headers; spoof a player User-Agent + Referer
  // (many IPTV servers reject browser User-Agents / missing Referer).
  const fwd = new Headers();
  const range = request.headers.get('Range'); if (range) fwd.set('Range', range);
  const auth = request.headers.get('Authorization'); if (auth) fwd.set('Authorization', auth);
  const apiKey = request.headers.get('Api-Key'); if (apiKey) fwd.set('Api-Key', apiKey);
  const ctIn = request.headers.get('Content-Type'); if (ctIn) fwd.set('Content-Type', ctIn);
  fwd.set('User-Agent', request.headers.get('User-Agent') || 'VLC/3.0.20 LibVLC/3.0.20');
  fwd.set('Referer', targetUrl.origin + '/');
  fwd.set('Accept', '*/*');

  const init = { method: request.method, headers: fwd, redirect: 'follow' };
  if (request.method !== 'GET' && request.method !== 'HEAD') init.body = await request.arrayBuffer();

  let resp;
  try { resp = await fetch(targetUrl.toString(), init); }
  catch (e) { return new Response('Upstream fetch failed: ' + e, { status: 502, headers: CORS }); }

  const ctype = resp.headers.get('Content-Type') || '';
  const isManifest = /mpegurl|m3u8/i.test(ctype) || /\.m3u8($|\?)/i.test(targetUrl.pathname);

  const out = new Headers(resp.headers);
  for (const k in CORS) out.set(k, CORS[k]);
  out.delete('content-encoding');

  // Rewrite HLS manifests so segments route back through the proxy.
  if (isManifest) {
    const text = await resp.text();
    const proxyBase = here.origin + here.pathname;
    const wrap = (raw) => proxyBase + '?url=' + encodeURIComponent(new URL(raw, targetUrl).toString());
    const rewritten = text.split('\n').map((line) => {
      const t = line.trim();
      if (!t) return line;
      if (t.startsWith('#')) return line.replace(/URI="([^"]+)"/g, (_, u) => `URI="${wrap(u)}"`);
      return wrap(t);
    }).join('\n');
    out.set('Content-Type', ctype || 'application/vnd.apple.mpegurl');
    out.delete('Content-Length');
    return new Response(rewritten, { status: resp.status, headers: out });
  }

  // mp4 / .ts / JSON stream straight through (Edge runtime = native streaming).
  return new Response(resp.body, { status: resp.status, headers: out });
}
