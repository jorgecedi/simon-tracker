import { buildSnapshot, DEFAULT_STORM_ID, SNAPSHOT_TTL_SECONDS } from '../../lib/snapshot.js';

// GET /api/storm: the merged NHC snapshot, cached at the edge so visitors
// share one set of upstream requests per TTL.
export async function onRequestGet({ request, env, waitUntil }) {
  const cache = caches.default;
  const cacheKey = new Request(new URL('/api/storm', request.url).toString());
  const hit = await cache.match(cacheKey);
  if (hit) return hit;

  try {
    const snapshot = await buildSnapshot(env.STORM_ID || DEFAULT_STORM_ID);
    const response = Response.json(snapshot, {
      headers: { 'Cache-Control': `public, max-age=${SNAPSHOT_TTL_SECONDS}` },
    });
    waitUntil(cache.put(cacheKey, response.clone()));
    return response;
  } catch (err) {
    return Response.json({ error: err.message }, { status: 502 });
  }
}
