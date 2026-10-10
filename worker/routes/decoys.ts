/**
 * THE DECOYS (owner brief 2026-10-10; design §2, §4 and §F1; DECISIONS row 206).
 *
 * «نظام ذكي يوهم المخترق بانه حصل على المعلومات لكن يكتشف بانه تم حظره»:
 * whoever asks for `/.env`, `/.git/config`, `/backup.sql`, `/admin/export/…`,
 * `/api/internal/…`, `/api/v0/…`, WordPress or phpMyAdmin is answered with
 * realistic FAKE data carrying canary tokens (worker/lib/deception/).
 *
 * ONE ANSWER FOR EVERYONE who is answered at all — a tool, a browser, an
 * image tag, a user agent that claims to be Googlebot, a staff account: the
 * same fake body with the same headers as any file (no cookie, no extra
 * header, no wait for a database write), so comparing two requests tells an
 * attacker nothing. What differs is only what is WRITTEN, after the answer:
 *
 *   a tool (no Sec-Fetch-* at all, or a set no browser sends)
 *        → an incident at once: the account blocked when signed in, else the
 *          address (enforced against tools); his next request meets the block
 *   a browser that opened or fetched it (a link, the address bar, the app)
 *        → LINKABLE: anyone can post that link, so it scores (60) and its
 *          batch is recorded, but it never blocks on its own — the canaries
 *          he was handed do the rest the moment he uses one where no link
 *          could have put it (a header, a cookie, the sign-in form)
 *   a crawler by user-agent claim → linkable as well (crawlers follow links)
 *   an induced request (an image, a frame, a cross-site fetch) → recorded only
 *   another admin → the batch is issued to the account and the owner's bell
 *          rings; never blocked by the decoy (by its canaries, yes)
 *
 * WHO IS NOT DECEIVED, and gets a plain 404: the verified owner (recorded, the
 * bell rings), a registered probe account (nothing written), a crawler
 * Cloudflare VERIFIED (recorded). None of them can be an attacker's disguise.
 * A HEAD gets the headers and writes nothing.
 *
 * Reads no table to build an answer, and carries no real figure:
 * tests/deceptionDecoys.test.ts seeds real rows and greps every answer.
 */
import { Hono, type Context } from 'hono';
import type { AppContext } from '../lib/types';
import { rootDomainFrom } from '../lib/hosts';
import { recordSecurityEvent, type SecurityDetail } from '../lib/securityEvents';
import { mintBatch, newBatchId } from '../lib/deception/canary';
import { DECOY_ROUTE_PATTERNS, batchShape, decoyFor, productsShown, renderDecoy, type DecoyCode } from '../lib/deception/decoys';
import { claimsCrawler, clientIp, exemptionOf, fetchIntent, networkKeyFor, urlEvidence, verifiedCrawler } from '../lib/deception/actors';
import { NETWORK_BLOCK_HOURS, canaryStatement, openIncident, ringOwnerDeception, settle } from '../lib/deception/blocks';
import { LINKABLE_CAP, WEIGHTS, bumpScore } from '../lib/deception/signals';

export const decoyRoutes = new Hono<AppContext>();

function plainNotFound(c: Context<AppContext>): Response {
  if (c.req.path.startsWith('/api/')) return c.json({ success: false, error: 'Not found' }, 404);
  return new Response('Not Found', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
}

async function serve(c: Context<AppContext>, code: DecoyCode, batch: string): Promise<{ res: Response; status: number }> {
  const host = c.get('host');
  const root = rootDomainFrom(c.env) ?? host?.host ?? 'levonis.internal';
  const shape = batchShape(batch);
  const tokens = await mintBatch(c.env, batch, root, productsShown(code, c.req.method.toUpperCase(), shape.productCount), shape.keyNoise);
  const url = new URL(c.req.url);
  const answer = renderDecoy(code, tokens, { host: host?.host ?? root, rootDomain: root, method: c.req.method.toUpperCase(), path: c.req.path, search: url.search });
  const headers = new Headers({ 'Content-Type': answer.contentType });
  if (answer.location) headers.set('Location', answer.location);
  const body = c.req.method === 'HEAD' || answer.status === 302 ? null : answer.body;
  return { res: new Response(body, { status: answer.status, headers }), status: answer.status };
}

/** One canary batch row per actor a minute in this isolate: a scanner looping on a decoy cannot fill the daily cap. */
const BATCH_EVERY_MS = 60_000;
const batchSeen = new WeakMap<object, Map<string, number>>();
function batchRowDue(db: object, actor: string, nowMs: number): boolean {
  let m = batchSeen.get(db);
  if (!m) batchSeen.set(db, (m = new Map()));
  const last = m.get(actor);
  if (last !== undefined && nowMs - last < BATCH_EVERY_MS) return false;
  if (m.size > 5000) m.clear();
  m.set(actor, nowMs);
  return true;
}

decoyRoutes.on(['GET', 'POST'], [...DECOY_ROUTE_PATTERNS], async (c) => {
  const code = decoyFor(c.req.path);
  if (!code) return plainNotFound(c);
  const nowMs = Date.now();
  const method = c.req.method.toUpperCase();
  const batch = newBatchId();
  // A HEAD learns the headers and nothing is written.
  if (method === 'HEAD') return (await serve(c, code, batch)).res;

  const user = c.get('user') ?? null;
  const exemption = exemptionOf(c.env, user);
  const intent = fetchIntent(c.req.raw.headers, method);
  const detail: SecurityDetail = { decoy: code, intent, sig: 'DECOY_HIT' };
  const event = (code2: string, extra: SecurityDetail = {}) =>
    recordSecurityEvent(c, { kind: 'enumeration_suspected', code: code2, status: 404, detail: { ...detail, ...extra } }, { target: false });
  const db = c.env.DB;

  if (exemption === 'probe') return plainNotFound(c);
  if (exemption === 'owner') {
    await event('DECOY_HIT', { ex: 'owner' });
    if (db) await settle(c, () => ringOwnerDeception(c.env, db, 'ownDecoy', `own_decoy_${batch}`, '', nowMs));
    return plainNotFound(c);
  }
  if (verifiedCrawler(c)) {
    await event('DECOY_HIT', { ex: 'crawler' });
    return plainNotFound(c);
  }

  const { res, status } = await serve(c, code, batch);
  const cls = urlEvidence(intent, claimsCrawler(c));
  if (cls === 'induced') {
    await event('DECOY_INDUCED');
    return res;
  }
  // A path a real exposed server would not have either (a git object, an unknown API path) answers 404 and hands
  // out no trap data — no batch to record — but asking for it is still asking for a trap.
  const served = status !== 404;
  // From here the answer stays as it is; everything else happens after it.
  const anonymous = !user;
  const ip = clientIp(c);
  const work = async () => {
    const netKey = anonymous ? await networkKeyFor(c.env, ip, nowMs) : '';
    const actor = user ? `u:${user.id}` : netKey ? `n:${netKey}` : '';
    const issuedTo: Record<string, string> = {};
    if (user) issuedTo.u = user.id;
    if (netKey) issuedTo.n = netKey;
    if (exemption === 'admin') {
      // A staff account: deceived like anyone, its batch issued to it (so using
      // the canaries blocks it), the owner told — never blocked by the decoy.
      await event('DECOY_HIT', { ex: 'admin', batch });
      if (db) {
        if (served) await db.batch([canaryStatement(db, batch, code, null, issuedTo, nowMs)]).catch(() => undefined);
        await bumpScore(db, actor, 'DECOY_HIT', WEIGHTS.DECOY_LINKED, new Date(nowMs), LINKABLE_CAP);
        await ringOwnerDeception(c.env, db, 'adminDecoy', `admin_decoy_${user!.id}_${Math.floor(nowMs / 3_600_000)}`, '', nowMs);
      }
      return;
    }
    if (cls === 'linkable') {
      await event('DECOY_HIT', { ex: claimsCrawler(c) ? 'crawler' : 'linked', batch });
      if (db && actor) {
        if (served && batchRowDue(db, actor, nowMs)) await db.batch([canaryStatement(db, batch, code, null, issuedTo, nowMs)]).catch(() => undefined);
        await bumpScore(db, actor, 'DECOY_HIT', WEIGHTS.DECOY_LINKED, new Date(nowMs), LINKABLE_CAP);
      }
      return;
    }
    // A tool: the incident at once — written after this answer, known to this isolate now.
    await event('DECOY_HIT', { batch });
    await openIncident(c, {
      reason: 'decoy_hit',
      signal: 'DECOY_HIT',
      user,
      account: !!user,
      network: anonymous && ip ? { ip, hours: NETWORK_BLOCK_HOURS } : null,
      intent,
      decoy: code,
      ...(served ? { batch: { id: batch, issuedTo } } : {}),
      tag: false,
      background: true,
    });
  };
  if (cls === 'hard' && exemption !== 'admin') {
    // The blocks reach this isolate's memory before the answer leaves (no D1 wait: openIncident writes in the background).
    await work().catch(() => undefined);
  } else {
    await settle(c, work);
  }
  return res;
});
