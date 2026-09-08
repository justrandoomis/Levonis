import { json } from '../../../verdict';

/**
 * ADR-017 (f), half one. This Worker is attached to a ZONE ROUTE
 * (`probe.<darkroot>/api/*` and `*.<darkroot>/api/*`). Its only job is to say
 * its own name, so that curling the hostname answers the question directly.
 *
 * The stakes: `01-TARGET.md` §3.1 plans the gateway cut-over as a route ADD in
 * front of Custom Domains that never move, which makes the rollback "delete six
 * routes" instead of a DNS change with certificate issuance. If a zone route
 * does NOT win, plan 3.0-alt applies and the apex/www Custom Domains must be
 * converted to proxied DNS + routes first, as a separately approved step.
 */
export default {
  fetch(request: Request): Response {
    const url = new URL(request.url);
    return json({
      row: 'f',
      question: 'A `<host>/api/*` zone route wins over a Custom Domain on the same hostname',
      answer: 'yes',
      verdict: `ZONE ROUTE answered ${url.host}${url.pathname}`,
      detail: { worker: 'levonis-probe-route', attachment: 'zone route', host: url.host, path: url.pathname },
    });
  },
};
