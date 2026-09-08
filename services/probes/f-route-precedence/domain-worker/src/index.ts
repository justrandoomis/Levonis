import { json } from '../../../verdict';

/**
 * ADR-017 (f), half two. This Worker is attached as a CUSTOM DOMAIN on the same
 * hostname the route worker is routed on (and to `*.<darkroot>/*`, the
 * wildcard the more specific `*.<darkroot>/api/*` has to beat).
 *
 * If curling `https://probe.<darkroot>/api/x` answers with THIS name, the route
 * did not win and plan 3.0-alt is the path.
 */
export default {
  fetch(request: Request): Response {
    const url = new URL(request.url);
    return json({
      row: 'f',
      question: 'A `<host>/api/*` zone route wins over a Custom Domain on the same hostname',
      answer: 'no',
      verdict: `CUSTOM DOMAIN / wildcard answered ${url.host}${url.pathname} — the more specific route did NOT win`,
      detail: { worker: 'levonis-probe-domain', attachment: 'custom domain or *.<root>/*', host: url.host, path: url.pathname },
    });
  },
};
