import { caught, json, type Verdict } from '../../verdict';

const QUESTION = '`ASSETS.fetch` through a binding honours `_headers`, ETag/304 and the SPA fallback';

interface Env {
  ASSETS: Fetcher;
}

/**
 * ADR-017 (d). This decides D23: whether the SPA may ever move from the core's
 * Custom Domain to a gateway `assets` block. If `_headers` and 304s are lost
 * when the asset layer is reached THROUGH a binding, the answer is no and the
 * SPA stays where it is for the whole programme — which is the recommended
 * option anyway, but for a reason rather than by default.
 */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const origin = new URL(request.url).origin;
      const first = await env.ASSETS.fetch(new Request(`${origin}/pinned.txt`));
      const etag = first.headers.get('etag');
      const second = etag
        ? await env.ASSETS.fetch(new Request(`${origin}/pinned.txt`, { headers: { 'if-none-match': etag } }))
        : null;
      const spa = await env.ASSETS.fetch(new Request(`${origin}/a/route/only/the/spa/knows`));
      const spaBody = await spa.text();

      const headersApplied = first.headers.get('x-probe-headers-applied') === 'yes';
      const notModified = second?.status === 304;
      const spaFallback = spa.status === 200 && spaBody.includes('probe d');
      const all = headersApplied && notModified && spaFallback;

      const v: Verdict = {
        row: 'd',
        question: QUESTION,
        answer: all ? 'yes' : headersApplied || notModified || spaFallback ? 'partial' : 'no',
        verdict: `_headers ${headersApplied ? 'applied' : 'LOST'}; conditional GET ${notModified ? '304' : `→ ${second?.status ?? 'no etag to send'}`}; SPA fallback ${spaFallback ? 'served index.html' : `→ ${spa.status}`}`,
        detail: {
          first_status: first.status,
          etag,
          cache_control: first.headers.get('cache-control'),
          second_status: second?.status ?? null,
          spa_status: spa.status,
        },
      };
      return json(v);
    } catch (e) {
      return json(caught('d', QUESTION, e));
    }
  },
};
