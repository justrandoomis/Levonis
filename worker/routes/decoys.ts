/**
 * THE DECOYS (owner brief 2026-10-10; design §2, §4; DECISIONS row 206).
 *
 * «نظام ذكي يوهم المخترق بانه حصل على المعلومات لكن يكتشف بانه تم حظره»:
 * whoever asks for `/.env`, `/.git/config`, `/backup.sql`, `/admin/export/…`,
 * `/api/internal/…`, `/api/v0/…`, WordPress or phpMyAdmin is answered with
 * realistic FAKE data carrying canary tokens (worker/lib/deception/), and in
 * the same step an incident is opened: the blocks, the canary batch, a signed
 * device tag on this very answer, the owner's bell. His next request meets the
 * block page.
 *
 * WHO IS NOT DECEIVED, and gets a plain 404 instead:
 *   the verified owner         recorded (ex=owner) and the owner's bell rings
 *   any other admin            recorded and scored; blocked only by a confirmed canary
 *   a registered probe account nothing written
 *   a crawler or preview bot   recorded (ex=crawler); never scored, never blocked —
 *                              Telegram fetches a pasted link whatever robots.txt says
 *   an INDUCED request         recorded (DECOY_INDUCED); an `<img src="/.env">`
 *                              in a post must never get its viewers blocked
 * A link CLICKED on this site gets the fake data and 60 points, not an
 * incident on its own. A HEAD gets the headers and writes nothing.
 *
 * Reads no table to build an answer, and carries no real figure:
 * tests/deceptionDecoys.test.ts seeds real rows and greps every answer.
 */
import { Hono, type Context } from 'hono';
import type { AppContext } from '../lib/types';
import { rootDomainFrom } from '../lib/hosts';
import { recordSecurityEvent, type SecurityDetail } from '../lib/securityEvents';
import { mintBatch, newBatchId } from '../lib/deception/canary';
import { DECOY_CSP, DECOY_ROUTE_PATTERNS, batchShape, decoyFor, renderDecoy, type DecoyCode } from '../lib/deception/decoys';
import { clientIp, exemptionOf, fetchIntent, intentWeight, isCrawler, networkKeyFor, tagCookieLine } from '../lib/deception/actors';
import { NETWORK_BLOCK_HOURS, canaryStatement, openIncident, ringOwnerDeception, settle } from '../lib/deception/blocks';
import { THRESHOLD, WEIGHTS, bumpScore } from '../lib/deception/signals';
import { hasSessionCookie } from '../lib/session';

export const decoyRoutes = new Hono<AppContext>();

function plainNotFound(c: Context<AppContext>): Response {
  if (c.req.path.startsWith('/api/')) return c.json({ success: false, error: 'Not found' }, 404);
  return new Response('Not Found', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } });
}

async function serve(c: Context<AppContext>, code: DecoyCode, batch: string): Promise<Response> {
  const host = c.get('host');
  const root = rootDomainFrom(c.env) ?? host?.host ?? 'levonis.internal';
  const shape = batchShape(batch);
  const tokens = await mintBatch(c.env, batch, root, shape.productCount, shape.keyNoise);
  const answer = renderDecoy(code, tokens, { host: host?.host ?? root, rootDomain: root, method: c.req.method.toUpperCase(), path: c.req.path });
  const headers = new Headers({
    'Content-Type': answer.contentType,
    'Cache-Control': 'no-store',
    'X-Robots-Tag': 'noindex, nofollow, noarchive',
  });
  if (/^text\/html/.test(answer.contentType)) headers.set('Content-Security-Policy', DECOY_CSP);
  if (answer.location) headers.set('Location', answer.location);
  const body = c.req.method === 'HEAD' || answer.status === 302 ? null : answer.body;
  return new Response(body, { status: answer.status, headers });
}

decoyRoutes.on(['GET', 'POST'], [...DECOY_ROUTE_PATTERNS], async (c) => {
  const code = decoyFor(c.req.path);
  if (!code) return plainNotFound(c);
  const nowMs = Date.now();
  const method = c.req.method.toUpperCase();
  const batch = newBatchId();
  // A HEAD learns the headers and nothing is written.
  if (method === 'HEAD') return serve(c, code, batch);

  const user = c.get('user') ?? null;
  const exemption = exemptionOf(c.env, user);
  const intent = fetchIntent(c.req.raw.headers);
  const detail: SecurityDetail = { decoy: code, intent, sig: 'DECOY_HIT' };
  const event = (code2: string, extra: SecurityDetail = {}) =>
    recordSecurityEvent(c, { kind: 'enumeration_suspected', code: code2, status: 404, detail: { ...detail, ...extra } });

  if (exemption === 'probe') return plainNotFound(c);
  if (exemption === 'owner') {
    await event('DECOY_HIT', { ex: 'owner' });
    const db = c.env.DB;
    if (db) await settle(c, () => ringOwnerDeception(c.env, db, 'ownDecoy', `own_decoy_${batch}`, '', nowMs));
    return plainNotFound(c);
  }
  if (isCrawler(c)) {
    await event('DECOY_HIT', { ex: 'crawler' });
    return plainNotFound(c);
  }
  const weight = intentWeight(intent);
  if (weight === 'none') {
    await event('DECOY_INDUCED');
    return plainNotFound(c);
  }
  if (exemption === 'admin') {
    await event('DECOY_HIT', { ex: 'admin' });
    if (c.env.DB) await bumpScore(c.env.DB, `u:${user!.id}`, 'DECOY_HIT', WEIGHTS.DECOY_HIT, new Date(nowMs));
    return plainNotFound(c);
  }

  const anonymous = !user && !hasSessionCookie(c.req.header('Cookie'));
  const netKey = await networkKeyFor(clientIp(c), nowMs);
  const issuedTo: Record<string, string> = {};
  if (user) issuedTo.u = user.id;
  if (anonymous && netKey) issuedTo.n = netKey;
  const res = await serve(c, code, batch);

  if (weight === 'partial') {
    // A link clicked on this site: the fake data and 60 points; the incident only when the score crosses.
    const db = c.env.DB;
    await event('DECOY_HIT', { ex: 'clicked', batch });
    if (db) {
      await db.batch([canaryStatement(db, batch, code, null, issuedTo, nowMs)]).catch(() => undefined);
      const key = user ? `u:${user.id}` : netKey ? `n:${netKey}` : '';
      const score = key ? await bumpScore(db, key, 'DECOY_HIT', WEIGHTS.DECOY_CLICKED, new Date(nowMs)) : null;
      if (score !== null && score >= THRESHOLD) {
        const incident = await openIncident(c, {
          reason: 'decoy_hit',
          signal: 'DECOY_HIT',
          user,
          account: !!user,
          network: null,
          intent,
          decoy: code,
        });
        res.headers.append('Set-Cookie', tagCookieLine(c, incident.tag, nowMs));
        return res;
      }
    }
    return res;
  }

  await event('DECOY_HIT', { batch });
  const incident = await openIncident(c, {
    reason: 'decoy_hit',
    signal: 'DECOY_HIT',
    user,
    account: !!user,
    network: anonymous && netKey ? { key: netKey, hours: NETWORK_BLOCK_HOURS } : null,
    intent,
    decoy: code,
    batch: { id: batch, issuedTo },
  });
  // The deceiving answer, and on it the tag: from the next request he meets the block.
  res.headers.append('Set-Cookie', tagCookieLine(c, incident.tag, nowMs));
  return res;
});
