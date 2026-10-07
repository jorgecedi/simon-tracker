// Serves a JSON payload from a Pages Function, cached at the edge so visitors
// share one set of upstream requests per TTL.
export async function cachedJson({ request, waitUntil }, ttlSeconds, build) {
  const cache = caches.default;
  const cacheKey = new Request(new URL(new URL(request.url).pathname, request.url).toString());
  const hit = await cache.match(cacheKey);
  if (hit) return hit;

  try {
    const response = Response.json(await build(), {
      headers: { 'Cache-Control': `public, max-age=${ttlSeconds}` },
    });
    waitUntil(cache.put(cacheKey, response.clone()));
    return response;
  } catch (err) {
    return Response.json({ error: err.message }, { status: 502 });
  }
}
