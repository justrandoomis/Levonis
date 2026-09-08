import { caught, json, type Verdict } from '../../verdict';

const QUESTION = '`caches.default` on a zone route behaves as the gateway cache design assumes';

/**
 * ADR-017 (g). The gateway's safe-cache layer (`01-TARGET.md` §3.7) is only
 * worth building if the Cache API is real on the path the gateway will run on.
 * It is NOT real on workers.dev, which is why this probe has to be curled on
 * the dark ZONE — and why it says so in its own answer rather than reporting a
 * clean miss forever and letting someone conclude the cache is broken.
 */
export default {
  async fetch(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url);
      const onZone = !url.hostname.endsWith('.workers.dev');
      const key = new Request(`${url.origin}/probe-cache-entry`, { method: 'GET' });
      const cache = caches.default;

      const before = await cache.match(key);
      let stored = false;
      if (!before) {
        await cache.put(
          key,
          new Response(JSON.stringify({ minted: new Date().toISOString() }), {
            headers: { 'content-type': 'application/json', 'cache-control': 'public, s-maxage=60' },
          })
        );
        stored = true;
      }
      const after = await cache.match(key);

      const v: Verdict = {
        row: 'g',
        question: QUESTION,
        answer: after ? (onZone ? 'yes' : 'partial') : 'no',
        verdict: onZone
          ? `on the zone: ${before ? 'HIT on arrival' : stored ? 'stored, then ' + (after ? 'read back' : 'NOT readable')  : 'nothing stored'}`
          : 'reached on workers.dev, where the Cache API is a no-op — re-run this on the dark zone, the answer here means nothing',
        detail: {
          host: url.hostname,
          on_zone: onZone,
          hit_on_arrival: !!before,
          readable_after_put: !!after,
          cf_cache_status: request.headers.get('cf-cache-status'),
          age: before?.headers.get('age') ?? null,
        },
      };
      return json(v);
    } catch (e) {
      return json(caught('g', QUESTION, e));
    }
  },
};
