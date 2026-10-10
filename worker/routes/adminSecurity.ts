/**
 * «الأمان» — THE OWNER'S SECURITY CONSOLE (design §6; DECISIONS row 206).
 *
 * Mounted at /api/admin/security, so it sits behind the apex-only host guard,
 * the no-store layer and the security door; its own door is a rate limit and
 * then `requireOwner` — the VERIFIED owner alone (an unverified owner row
 * hears OWNER_EMAIL_UNVERIFIED, everyone else OWNER_ONLY).
 *
 *   GET  /summary            counts: live blocks by kind, detections 24 h,
 *                            decoy hits, canary uses and incidents over 7 days
 *   GET  /blocks             50 a page (active or all): who, why, until when,
 *                            hits — an account by name, a device by the first
 *                            six of its tag, a network by country and operator
 *                            only (never a hash in full, never an address)
 *   GET  /events             the whole security log (security_events), newest first
 *   GET  /incidents/:id      its blocks, its events, its canary batch, and
 *                            «ما الذي أُعطي له» — the decoy answer REGENERATED
 *                            from the batch (nothing was stored to show it)
 *   GET  /scores             the actors with the highest decayed scores
 *   POST /blocks/:id/lift    lifts one block or the whole incident, resets the
 *                            scores, writes an audit row; this isolate forgets
 *                            the block at once, the others within 30 seconds
 *
 * Every answer is ids, codes, counts and times. No raw address, user agent,
 * password, token or query string is stored anywhere to be shown.
 */
import { Hono } from 'hono';
import type { AppContext } from '../lib/types';
import { HttpError, notFound } from '../lib/http';
import { requireOwner } from '../lib/costAccess';
import { limitByMethod } from '../lib/ratelimit';
import { audit } from '../lib/audit';
import { rootDomainFrom } from '../lib/hosts';
import { isBatchId, keySource, mintBatch } from '../lib/deception/canary';
import { batchShape, isDecoyCode, renderDecoy } from '../lib/deception/decoys';
import { liftBlocks, type BlockKind } from '../lib/deception/blocks';
import { decayed, resetScores } from '../lib/deception/signals';

export const adminSecurityRoutes = new Hono<AppContext>();

adminSecurityRoutes.use('*', limitByMethod(['security-read', 600], ['security-write', 60]));
adminSecurityRoutes.use('*', requireOwner);

const PAGE = 50;
const DAY = 86_400_000;
const isMissingTable = (e: unknown) => /no such table/i.test(e instanceof Error ? e.message : String(e));

/** The detection codes the summary counts. */
const DETECTION_CODES = [
  'DECOY_HIT',
  'DECOY_INDUCED',
  'CANARY_USED',
  'CANARY_INDUCED',
  'CANARY_UNCONFIRMED',
  'CANARY_FLOOD',
  'ACTOR_BLOCKED',
  'CLIENT_PRICE_FIELDS',
  'INJECTION_PATTERN',
  'TAMPER_PARAMS',
  'AUTH_BRUTE_FORCE',
  'IDOR_PROBE',
] as const;

function parseJson(text: unknown): Record<string, unknown> {
  try {
    const v: unknown = JSON.parse(String(text ?? '{}'));
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** A cursor is `<time>|<id>` of the last row of the previous page. */
function cursorOf(v: string | undefined): { at: string; id: string } | null {
  if (!v) return null;
  const i = v.lastIndexOf('|');
  if (i <= 0) return null;
  const at = v.slice(0, i);
  const id = v.slice(i + 1);
  return /^\d{4}-\d\d-\d\dT[\d:.]+Z$/.test(at) && /^[A-Za-z0-9_]{1,64}$/.test(id) ? { at, id } : null;
}

interface BlockRow {
  id: string;
  incident_id: string;
  reference: string;
  actor_kind: BlockKind;
  actor_key: string;
  actor_class: string;
  reason: string;
  signal: string;
  created_at: string;
  expires_at: string;
  hits: number;
  last_hit_at: string | null;
  lifted_at: string | null;
  evidence: string;
  user_name: string | null;
  user_email: string | null;
}

const BLOCK_SELECT = `SELECT b.id, b.incident_id, b.reference, b.actor_kind, b.actor_key, b.actor_class, b.reason, b.signal,
       b.created_at, b.expires_at, b.hits, b.last_hit_at, b.lifted_at, b.evidence, u.name AS user_name, u.email AS user_email
  FROM security_blocks b LEFT JOIN users u ON b.actor_kind = 'account' AND u.id = b.actor_key`;

/** A block as the console shows it: the actor named without its hash. */
function blockDto(r: BlockRow, nowMs: number) {
  const ev = parseJson(r.evidence);
  const pick = (k: string) => (typeof ev[k] === 'string' ? (ev[k] as string) : null);
  const actor =
    r.actor_kind === 'account'
      ? { kind: 'account' as const, user_id: r.actor_key, name: r.user_name, email: r.user_email }
      : r.actor_kind === 'device'
        ? { kind: 'device' as const, tag: r.actor_key.slice(0, 6) }
        : { kind: 'network' as const, cc: pick('cc'), asn: pick('asn') };
  return {
    id: r.id,
    incident_id: r.incident_id,
    reference: r.reference,
    actor_kind: r.actor_kind,
    actor,
    actor_class: r.actor_class,
    reason: r.reason,
    signal: r.signal,
    created_at: r.created_at,
    expires_at: r.expires_at,
    hits: Number(r.hits ?? 0),
    last_hit_at: r.last_hit_at,
    lifted_at: r.lifted_at,
    active: !r.lifted_at && Date.parse(r.expires_at) > nowMs,
    evidence: {
      decoy: pick('decoy'),
      sig: pick('sig'),
      intent: pick('intent'),
      cc: pick('cc'),
      asn: pick('asn'),
      batch: pick('batch'),
      route: pick('route'),
    },
  };
}

interface EventRow {
  id: string;
  kind: string;
  code: string;
  actor_id: string | null;
  actor_class: string;
  method: string;
  route: string;
  target_id: string | null;
  status: number;
  count: number;
  first_at: string;
  last_at: string;
  detail: string;
}
const EVENT_SELECT = 'SELECT id, kind, code, actor_id, actor_class, method, route, target_id, status, count, first_at, last_at, detail FROM security_events';
const eventDto = (r: EventRow) => ({ ...r, count: Number(r.count ?? 1), status: Number(r.status ?? 0), detail: parseJson(r.detail) });

// ------------------------------------------------------------- summary

adminSecurityRoutes.get('/summary', async (c) => {
  const db = c.env.DB;
  const nowMs = Date.now();
  const now = new Date(nowMs).toISOString();
  const day = new Date(nowMs - DAY).toISOString();
  const week = new Date(nowMs - 7 * DAY).toISOString();
  const out = {
    installed: true,
    // The trap data and the device tags need a key (worker/lib/deception/canary.ts); without one they are off.
    canaries: keySource(c.env) !== null,
    active_blocks: { account: 0, device: 0, network: 0 },
    detections_24h: 0,
    decoy_hits_7d: 0,
    canary_uses_7d: 0,
    incidents_7d: 0,
  };
  try {
    const kinds = await db
      .prepare('SELECT actor_kind, COUNT(*) AS n FROM security_blocks WHERE lifted_at IS NULL AND expires_at > ? GROUP BY actor_kind')
      .bind(now)
      .all<{ actor_kind: BlockKind; n: number }>();
    for (const r of kinds.results ?? []) if (r.actor_kind in out.active_blocks) out.active_blocks[r.actor_kind] = Number(r.n);
    const inc = await db
      .prepare('SELECT COUNT(DISTINCT incident_id) AS n FROM security_blocks WHERE created_at >= ?')
      .bind(week)
      .first<{ n: number }>();
    out.incidents_7d = Number(inc?.n ?? 0);
  } catch (e) {
    if (!isMissingTable(e)) throw e;
    out.installed = false;
  }
  try {
    const marks = DETECTION_CODES.map(() => '?').join(',');
    const det = await db
      .prepare(`SELECT COALESCE(SUM(count), 0) AS n FROM security_events WHERE last_at >= ? AND code IN (${marks})`)
      .bind(day, ...DETECTION_CODES)
      .first<{ n: number }>();
    out.detections_24h = Number(det?.n ?? 0);
    const sums = await db
      .prepare(
        `SELECT COALESCE(SUM(CASE WHEN code = 'DECOY_HIT' THEN count END), 0) AS decoys,
                COALESCE(SUM(CASE WHEN code = 'CANARY_USED' THEN count END), 0) AS canaries
           FROM security_events WHERE last_at >= ? AND code IN ('DECOY_HIT', 'CANARY_USED')`
      )
      .bind(week)
      .first<{ decoys: number; canaries: number }>();
    out.decoy_hits_7d = Number(sums?.decoys ?? 0);
    out.canary_uses_7d = Number(sums?.canaries ?? 0);
  } catch (e) {
    if (!isMissingTable(e)) throw e;
  }
  return c.json({ success: true, summary: out });
});

// ------------------------------------------------------------- blocks

adminSecurityRoutes.get('/blocks', async (c) => {
  const db = c.env.DB;
  const nowMs = Date.now();
  const state = c.req.query('state') === 'all' ? 'all' : 'active';
  const cur = cursorOf(c.req.query('cursor'));
  const where: string[] = [];
  const binds: unknown[] = [];
  if (state === 'active') {
    where.push('b.lifted_at IS NULL AND b.expires_at > ?');
    binds.push(new Date(nowMs).toISOString());
  }
  if (cur) {
    where.push('(b.created_at < ? OR (b.created_at = ? AND b.id < ?))');
    binds.push(cur.at, cur.at, cur.id);
  }
  try {
    const res = await db
      .prepare(`${BLOCK_SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY b.created_at DESC, b.id DESC LIMIT ${PAGE + 1}`)
      .bind(...binds)
      .all<BlockRow>();
    const rows = res.results ?? [];
    const page = rows.slice(0, PAGE);
    const last = page.at(-1);
    return c.json({
      success: true,
      installed: true,
      blocks: page.map((r) => blockDto(r, nowMs)),
      next: rows.length > PAGE && last ? `${last.created_at}|${last.id}` : null,
    });
  } catch (e) {
    if (!isMissingTable(e)) throw e;
    return c.json({ success: true, installed: false, blocks: [], next: null });
  }
});

// ------------------------------------------------------------- the log

adminSecurityRoutes.get('/events', async (c) => {
  const db = c.env.DB;
  const code = c.req.query('code');
  const cur = cursorOf(c.req.query('cursor'));
  const where: string[] = [];
  const binds: unknown[] = [];
  if (code && /^[A-Z][A-Z0-9_]{1,63}$/.test(code)) {
    where.push('code = ?');
    binds.push(code);
  }
  if (cur) {
    where.push('(last_at < ? OR (last_at = ? AND id < ?))');
    binds.push(cur.at, cur.at, cur.id);
  }
  try {
    const res = await db
      .prepare(`${EVENT_SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY last_at DESC, id DESC LIMIT ${PAGE + 1}`)
      .bind(...binds)
      .all<EventRow>();
    const rows = res.results ?? [];
    const page = rows.slice(0, PAGE);
    const last = page.at(-1);
    return c.json({ success: true, events: page.map(eventDto), next: rows.length > PAGE && last ? `${last.last_at}|${last.id}` : null });
  } catch (e) {
    if (!isMissingTable(e)) throw e;
    return c.json({ success: true, events: [], next: null });
  }
});

// ------------------------------------------------------------- one incident

adminSecurityRoutes.get('/incidents/:id', async (c) => {
  const db = c.env.DB;
  const id = c.req.param('id');
  if (!/^sin_[A-Za-z0-9]{6,36}$/.test(id)) throw notFound();
  const nowMs = Date.now();
  let blocks: BlockRow[];
  try {
    blocks = (await db.prepare(`${BLOCK_SELECT} WHERE b.incident_id = ? ORDER BY b.created_at`).bind(id).all<BlockRow>()).results ?? [];
  } catch (e) {
    if (!isMissingTable(e)) throw e;
    blocks = [];
  }
  if (blocks.length === 0) throw notFound();
  const reference = blocks[0]!.reference;
  const evidence = parseJson(blocks[0]!.evidence);
  const events =
    (
      await db
        .prepare(`${EVENT_SELECT} WHERE json_extract(detail, '$.ref') = ? ORDER BY last_at DESC LIMIT 50`)
        .bind(reference)
        .all<EventRow>()
        .catch(() => ({ results: [] as EventRow[] }))
    ).results ?? [];
  const batchId = typeof evidence.batch === 'string' && isBatchId(evidence.batch) ? evidence.batch : null;
  const batch = batchId
    ? await db
        .prepare('SELECT batch_id, decoy, issued_at, first_used_at, use_count FROM security_canaries WHERE batch_id = ?')
        .bind(batchId)
        .first<{ batch_id: string; decoy: string; issued_at: string; first_used_at: string | null; use_count: number }>()
        .catch(() => null)
    : null;
  // «ما الذي أُعطي له»: the decoy answer regenerated from its batch — the same bytes, never stored.
  let preview: string[] | null = null;
  const decoy = batch?.decoy ?? (typeof evidence.decoy === 'string' ? evidence.decoy : null);
  if (batchId && isDecoyCode(decoy)) {
    const host = c.get('host');
    const root = rootDomainFrom(c.env) ?? host?.host ?? 'levonis.internal';
    const shape = batchShape(batchId);
    const tokens = await mintBatch(c.env, batchId, root, shape.productCount, shape.keyNoise);
    const route = typeof evidence.route === 'string' ? evidence.route : '/';
    const answer = renderDecoy(decoy, tokens, { host: root, rootDomain: root, method: 'GET', path: route });
    preview = answer.body.split('\n').slice(0, 60).map((l) => l.slice(0, 400));
  }
  return c.json({
    success: true,
    incident: {
      id,
      reference,
      reason: blocks[0]!.reason,
      signal: blocks[0]!.signal,
      created_at: blocks[0]!.created_at,
      blocks: blocks.map((r) => blockDto(r, nowMs)),
      events: events.map(eventDto),
      batch: batch ? { batch_id: batch.batch_id, decoy: batch.decoy, issued_at: batch.issued_at, first_used_at: batch.first_used_at, use_count: Number(batch.use_count ?? 0) } : null,
      preview,
    },
  });
});

// ------------------------------------------------------------- scores

adminSecurityRoutes.get('/scores', async (c) => {
  const db = c.env.DB;
  const nowMs = Date.now();
  try {
    const rows =
      (
        await db
          .prepare(
            // 'x:' rows are the per-prefix write budgets (worker/lib/deception/blocks.ts), not actors.
            `SELECT s.actor_key, s.score, s.updated_at, s.signals, u.name AS user_name
               FROM security_scores s LEFT JOIN users u ON s.actor_key = 'u:' || u.id
              WHERE s.actor_key NOT LIKE 'x:%'
              ORDER BY s.updated_at DESC LIMIT 500`
          )
          .all<{ actor_key: string; score: number; updated_at: string; signals: string; user_name: string | null }>()
      ).results ?? [];
    const scored = rows
      .map((r) => {
        const kind = r.actor_key.slice(0, 1);
        const rest = r.actor_key.slice(2);
        return {
          actor_kind: kind === 'u' ? 'account' : kind === 'd' ? 'device' : 'network',
          actor: kind === 'u' ? { user_id: rest, name: r.user_name } : { tag: rest.slice(0, 6) },
          score: decayed(Number(r.score), Date.parse(r.updated_at), nowMs),
          updated_at: r.updated_at,
          signals: parseJson(r.signals),
        };
      })
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, PAGE);
    return c.json({ success: true, scores: scored });
  } catch (e) {
    if (!isMissingTable(e)) throw e;
    return c.json({ success: true, scores: [] });
  }
});

// ------------------------------------------------------------- lift

adminSecurityRoutes.post('/blocks/:id/lift', async (c) => {
  const db = c.env.DB;
  const owner = c.get('user')!;
  const id = c.req.param('id');
  if (!/^sbk_[A-Za-z0-9]{6,36}$/.test(id)) throw notFound();
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const wholeIncident = body.incident === true;
  const note = typeof body.note === 'string' ? body.note.trim().slice(0, 200) : '';
  const nowMs = Date.now();
  let result;
  try {
    result = await liftBlocks(db, id, wholeIncident, owner.id, nowMs);
  } catch (e) {
    if (isMissingTable(e)) throw notFound();
    throw e;
  }
  if (!result) throw notFound();
  if (result.lifted === 0) throw new HttpError(409, 'This block was already lifted.', 'BLOCK_ALREADY_LIFTED');
  const keys = result.blocks.map((b) => (b.actor_kind === 'account' ? `u:${b.actor_key}` : b.actor_kind === 'device' ? `d:${b.actor_key}` : `n:${b.actor_key}`));
  await resetScores(db, keys, new Date(nowMs));
  const first = result.blocks[0]!;
  await audit(db, owner.id, 'security.block_lifted', id, {
    reference: first.reference,
    actor_kinds: result.blocks.map((b) => b.actor_kind),
    incident: wholeIncident ? first.incident_id : null,
    lifted: result.lifted,
    ...(note ? { note } : {}),
  });
  return c.json({ success: true, lifted: result.lifted, reference: first.reference });
});
