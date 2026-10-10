/**
 * THE BLOCK STORE — incidents, blocks with expiry, the per-isolate snapshot
 * the gate reads, lifting, and the owner's bell (design §3.4, §4.1, §4.3, §4.5).
 *
 * NO D1 READ ON AN ORDINARY REQUEST. Account and network blocks live in a
 * per-isolate snapshot (one per database binding, so each test database gets
 * its own), refreshed in the BACKGROUND (`waitUntil`) every 30 s by a delta on
 * `updated_at`, fully every 10 min. Device blocks need no database at all: the
 * tag cookie is signed and carries its own expiry, and the snapshot only
 * carries the small set of LIFTED tags. A tagged request on a cold snapshot is
 * the only one that waits — for at most one read, bounded. A missing table
 * marks the snapshot absent for 10 min: nothing is blocked by account or
 * network, and no error reaches anyone.
 *
 * AN INCIDENT is one detection: its blocks (account 30 days when signed in;
 * device 30 days, the tag set on that very answer; network 24 hours — 1 hour
 * when reached by score alone — only for an ANONYMOUS, deliberate, non-crawler
 * request), the canary batch of a decoy answer, one ACTOR_BLOCKED event and
 * the owner's bell. Written in one batch the decoy answer awaits (bounded), so
 * the attacker's NEXT request meets the block in every isolate that has
 * refreshed, and at once in this one.
 *
 * THE OWNER IS NEVER BLOCKED: the gate never asks, and the table refuses an
 * owner row (`actor_class` has no 'owner').
 */
import type { Context } from 'hono';
import type { AppContext, Env, SessionUser } from '../types';
import { isUnverifiedOwner, viewerClass } from '../adminScope';
import { baghdadDay } from '../baghdadTime';
import { newId } from '../crypto';
import { notify } from '../notifications';
import { contextOf, recordSecurityEvent, type SecurityDetail } from '../securityEvents';
import { cfOf, mintTag, newReferenceHex, referenceOf, type DeviceTag, type FetchIntent } from './actors';
import type { DecoyCode } from './decoys';
import { DECEPTION_BELL } from './strings';

export const ACCOUNT_BLOCK_DAYS = 30;
export const DEVICE_BLOCK_DAYS = 30;
export const NETWORK_BLOCK_HOURS = 24;
export const NETWORK_SCORE_BLOCK_HOURS = 1;
/** Block rows created in any 24 hours before incidents stop writing rows (about 1,000 incidents). */
export const DAILY_BLOCK_ROW_CAP = 3000;
/** Canary batch rows in any 24 hours; past it the decoy still answers with valid canaries. */
export const DAILY_CANARY_CAP = 1000;
/** Deception bells a Baghdad day; the console shows every incident regardless. */
export const DECEPTION_BELL_CAP = 10;
export const RETENTION_DAYS = 90;
export const SCORE_RETENTION_DAYS = 14;
export const PRUNE_PER_WRITE = 8;

export const REFRESH_MS = 30_000;
export const FULL_RELOAD_MS = 600_000;
export const ABSENT_RETRY_MS = 600_000;
export const COLD_WAIT_MS = 300;
export const INCIDENT_WAIT_MS = 1500;
export const HIT_FLUSH_MS = 60_000;

const DAY = 86_400_000;
const isMissingTable = (e: unknown) => /no such table/i.test(e instanceof Error ? e.message : String(e));

export type BlockKind = 'account' | 'device' | 'network';
export type BlockReason = 'canary_used' | 'decoy_hit' | 'score_threshold';

// ------------------------------------------------------------- the snapshot

export interface BlockRef {
  /** The row id ('' for an entry this isolate added before reading it back). */
  id: string;
  incidentId: string;
  reference: string;
  expiresMs: number;
}

export interface Snapshot {
  status: 'cold' | 'ready' | 'absent';
  loadedAt: number;
  fullAt: number;
  since: string;
  absentUntil: number;
  accounts: Map<string, BlockRef>;
  networks: Map<string, BlockRef>;
  /** Device tags the owner lifted — a lifted tag blocks nothing and its cookie goes. */
  lifted: Set<string>;
  loading: Promise<void> | null;
  /** Blocked requests answered, per live block (kind|key), flushed at most once a minute each. */
  hits: Map<string, { kind: BlockKind; key: string; n: number; last: string; flushedAt: number }>;
}

const snapshots = new WeakMap<object, Snapshot>();

/** This database's snapshot, or null when there is no usable binding. */
export function snapshotFor(db: unknown): Snapshot | null {
  if (!db || typeof db !== 'object') return null;
  let s = snapshots.get(db);
  if (!s) {
    s = {
      status: 'cold',
      loadedAt: 0,
      fullAt: 0,
      since: '',
      absentUntil: 0,
      accounts: new Map(),
      networks: new Map(),
      lifted: new Set(),
      loading: null,
      hits: new Map(),
    };
    snapshots.set(db, s);
  }
  return s;
}

interface BlockRow {
  id: string;
  incident_id: string;
  actor_kind: BlockKind;
  actor_key: string;
  reference: string;
  expires_at: string;
  lifted_at: string | null;
  updated_at: string;
}

function apply(s: Snapshot, r: BlockRow, nowMs: number): void {
  if (r.actor_kind === 'device') {
    if (r.lifted_at) s.lifted.add(r.actor_key);
    return;
  }
  const map = r.actor_kind === 'account' ? s.accounts : s.networks;
  const expiresMs = Date.parse(r.expires_at);
  if (r.lifted_at || !(expiresMs > nowMs)) {
    // Only the block this row IS: a newer block of the same actor stays.
    const cur = map.get(r.actor_key);
    if (cur && (cur.id === r.id || cur.incidentId === r.incident_id)) map.delete(r.actor_key);
    return;
  }
  map.set(r.actor_key, { id: r.id, incidentId: r.incident_id, reference: r.reference, expiresMs });
}

const COLUMNS = 'id, incident_id, actor_kind, actor_key, reference, expires_at, lifted_at, updated_at';

async function loadFull(db: D1Database, s: Snapshot, nowMs: number): Promise<void> {
  const res = await db
    .prepare(
      `SELECT ${COLUMNS} FROM security_blocks
        WHERE (lifted_at IS NULL AND expires_at > ?1 AND actor_kind IN ('account','network'))
           OR (actor_kind = 'device' AND lifted_at > ?2)
        ORDER BY created_at DESC LIMIT 3000`
    )
    .bind(new Date(nowMs).toISOString(), new Date(nowMs - (DEVICE_BLOCK_DAYS + 1) * DAY).toISOString())
    .all<BlockRow>();
  const accounts = new Map<string, BlockRef>();
  const networks = new Map<string, BlockRef>();
  const lifted = new Set<string>();
  let since = '';
  for (const r of res.results ?? []) {
    if (r.updated_at > since) since = r.updated_at;
    if (r.actor_kind === 'device') {
      if (r.lifted_at) lifted.add(r.actor_key);
      continue;
    }
    const map = r.actor_kind === 'account' ? accounts : networks;
    if (!map.has(r.actor_key)) map.set(r.actor_key, { id: r.id, incidentId: r.incident_id, reference: r.reference, expiresMs: Date.parse(r.expires_at) });
  }
  s.accounts = accounts;
  s.networks = networks;
  s.lifted = lifted;
  s.since = since || new Date(nowMs).toISOString();
  s.status = 'ready';
  s.loadedAt = nowMs;
  s.fullAt = nowMs;
}

async function loadDelta(db: D1Database, s: Snapshot, nowMs: number): Promise<void> {
  const from = new Date(Math.max(0, (Date.parse(s.since) || nowMs) - 5000)).toISOString();
  const res = await db
    .prepare(`SELECT ${COLUMNS} FROM security_blocks WHERE updated_at > ?1 ORDER BY updated_at LIMIT 500`)
    .bind(from)
    .all<BlockRow>();
  for (const r of res.results ?? []) {
    apply(s, r, nowMs);
    if (r.updated_at > s.since) s.since = r.updated_at;
  }
  // Expired entries leave on their own.
  for (const map of [s.accounts, s.networks]) for (const [k, v] of map) if (v.expiresMs <= nowMs) map.delete(k);
  s.loadedAt = nowMs;
}

/** One load (full when cold, stale or due), single-flight. Never rejects. */
export function startLoad(db: D1Database, s: Snapshot, nowMs: number): Promise<void> {
  if (s.loading) return s.loading;
  const full = s.status !== 'ready' || nowMs - s.fullAt >= FULL_RELOAD_MS;
  s.loading = (full ? loadFull(db, s, nowMs) : loadDelta(db, s, nowMs))
    .catch((e) => {
      if (isMissingTable(e)) {
        s.status = 'absent';
        s.absentUntil = nowMs + ABSENT_RETRY_MS;
        s.accounts.clear();
        s.networks.clear();
      }
      s.loadedAt = nowMs;
    })
    .finally(() => {
      s.loading = null;
    });
  return s.loading;
}

/**
 * The background refresh: due every REFRESH_MS, handed to `waitUntil`. With no
 * execution context (an internal dispatch, a unit test without one) nothing
 * starts — the request path never waits on it.
 */
export function scheduleRefresh(c: Context<AppContext>, db: D1Database, s: Snapshot, nowMs: number): void {
  if (s.loading) return;
  if (s.status === 'absent' && nowMs < s.absentUntil) return;
  if (s.status === 'ready' && nowMs - s.loadedAt < REFRESH_MS) return;
  let ctx: { waitUntil(p: Promise<unknown>): void };
  try {
    ctx = c.executionCtx;
  } catch {
    return;
  }
  try {
    ctx.waitUntil(startLoad(db, s, nowMs));
  } catch {
    /* never in the way */
  }
}

/** For a tagged request on a cold snapshot: wait for one load, at most COLD_WAIT_MS. */
export async function warmForTag(db: D1Database, s: Snapshot, nowMs: number): Promise<void> {
  if (s.status !== 'cold') return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    startLoad(db, s, nowMs),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, COLD_WAIT_MS);
    }),
  ]);
  if (timer) clearTimeout(timer);
}

/** Counts a blocked request against its block; flushed at most once a minute per block, after the response. */
export function countHit(c: Context<AppContext>, db: D1Database, s: Snapshot, kind: BlockKind, key: string, nowMs: number): void {
  const id = `${kind}|${key}`;
  const now = new Date(nowMs).toISOString();
  const h = s.hits.get(id) ?? { kind, key, n: 0, last: now, flushedAt: 0 };
  h.n += 1;
  h.last = now;
  s.hits.set(id, h);
  if (nowMs - h.flushedAt < HIT_FLUSH_MS) return;
  const n = h.n;
  h.n = 0;
  h.flushedAt = nowMs;
  const work = db
    .prepare('UPDATE security_blocks SET hits = hits + ?, last_hit_at = ? WHERE actor_kind = ? AND actor_key = ? AND lifted_at IS NULL')
    .bind(n, now, kind, key)
    .run()
    .catch(() => undefined);
  try {
    c.executionCtx.waitUntil(work);
  } catch {
    /* no context: it runs on its own */
  }
}

// ------------------------------------------------------------- incidents

export interface IncidentInput {
  reason: BlockReason;
  signal: string;
  user: SessionUser | null;
  /** Place an account block (signed in, and not an exempt admin). */
  account: boolean;
  /** Place a network block: the network key (today's), and how long. */
  network: { key: string; hours: number } | null;
  intent: FetchIntent;
  decoy?: DecoyCode;
  /** The canary batch this decoy answer carries — its row is written with the incident. */
  batch?: { id: string; issuedTo: Record<string, string> };
  /** An existing incident's reference to reuse (an account-blocked answer tagging a new browser). */
  reuse?: { incidentId: string; referenceHex: string };
  /** Only the device tag (the account-blocked answer's new browser). */
  deviceOnly?: boolean;
}

export interface Incident {
  incidentId: string;
  reference: string;
  tag: DeviceTag & { value: string };
  /** False when nothing could be written (a database behind 0185, a failure, the cap). */
  written: boolean;
}

function evidenceOf(c: Context<AppContext>, input: IncidentInput, fp: { s: string; u: string }): string {
  const cf = cfOf(c);
  const ev: Record<string, unknown> = {
    sig: input.signal,
    intent: input.intent,
    class: actorClassFor(c.env, input.user),
  };
  if (input.decoy) ev.decoy = input.decoy;
  if (input.batch) ev.batch = input.batch.id;
  if (typeof cf.country === 'string' && /^[A-Z]{2}$/.test(cf.country)) ev.cc = cf.country;
  if (typeof cf.asn === 'number' && Number.isInteger(cf.asn)) ev.asn = `AS${cf.asn}`;
  if (fp.s) ev.s = fp.s;
  if (fp.u) ev.u = fp.u;
  const route = c.req.path.length <= 120 && /^[A-Za-z0-9/._-]+$/.test(c.req.path) ? c.req.path : '';
  if (route && input.decoy) ev.route = route;
  const text = JSON.stringify(ev);
  return text.length <= 1500 ? text : '{}';
}

/** The actor class a block row records — never 'owner'; the owner address on an unverified admin row is an admin here. */
export function actorClassFor(env: Env, user: SessionUser | null): string {
  const vc = viewerClass(env, user);
  if (vc !== 'owner') return vc;
  return isUnverifiedOwner(env, user) ? 'full_admin' : 'owner';
}

function blockStatement(
  db: D1Database,
  b: { incidentId: string; reference: string; kind: BlockKind; key: string; actorClass: string; reason: BlockReason; signal: string; nowIso: string; expiresIso: string; evidence: string },
  sinceIso: string
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO security_blocks
         (id, incident_id, reference, actor_kind, actor_key, actor_class, reason, signal, created_at, expires_at, updated_at, evidence)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?9, ?11
        WHERE (SELECT COUNT(*) FROM (SELECT 1 FROM security_blocks WHERE created_at >= ?12 LIMIT ${DAILY_BLOCK_ROW_CAP})) < ${DAILY_BLOCK_ROW_CAP}
       ON CONFLICT(actor_kind, actor_key) WHERE lifted_at IS NULL DO UPDATE SET
         incident_id = excluded.incident_id, reference = excluded.reference, actor_class = excluded.actor_class,
         reason = excluded.reason, signal = excluded.signal, created_at = excluded.created_at,
         expires_at = MAX(security_blocks.expires_at, excluded.expires_at), updated_at = excluded.updated_at,
         evidence = excluded.evidence`
    )
    .bind(newId('sbk'), b.incidentId, b.reference, b.kind, b.key, b.actorClass, b.reason, b.signal.slice(0, 64), b.nowIso, b.expiresIso, b.evidence, sinceIso);
}

function pruneStatements(db: D1Database, nowMs: number): D1PreparedStatement[] {
  const cut = new Date(nowMs - RETENTION_DAYS * DAY).toISOString();
  const scoreCut = new Date(nowMs - SCORE_RETENTION_DAYS * DAY).toISOString();
  return [
    db
      .prepare(
        `DELETE FROM security_blocks WHERE id IN (SELECT id FROM security_blocks
          WHERE (lifted_at IS NOT NULL AND lifted_at < ?1) OR (lifted_at IS NULL AND expires_at < ?1) ORDER BY created_at LIMIT ?2)`
      )
      .bind(cut, PRUNE_PER_WRITE),
    db
      .prepare('DELETE FROM security_canaries WHERE batch_id IN (SELECT batch_id FROM security_canaries WHERE issued_at < ? ORDER BY issued_at LIMIT ?)')
      .bind(cut, PRUNE_PER_WRITE),
    db
      .prepare('DELETE FROM security_scores WHERE actor_key IN (SELECT actor_key FROM security_scores WHERE updated_at < ? ORDER BY updated_at LIMIT ?)')
      .bind(scoreCut, PRUNE_PER_WRITE),
  ];
}

/** The canary batch row of a decoy answer, under its daily cap. */
export function canaryStatement(db: D1Database, batch: string, decoy: string, incidentId: string | null, issuedTo: Record<string, string>, nowMs: number): D1PreparedStatement {
  const since = new Date(nowMs - DAY).toISOString();
  return db
    .prepare(
      `INSERT OR IGNORE INTO security_canaries (batch_id, decoy, incident_id, issued_to, issued_at)
       SELECT ?1, ?2, ?3, ?4, ?5
        WHERE (SELECT COUNT(*) FROM (SELECT 1 FROM security_canaries WHERE issued_at >= ?6 LIMIT ${DAILY_CANARY_CAP})) < ${DAILY_CANARY_CAP}`
    )
    .bind(batch, decoy.slice(0, 40), incidentId, JSON.stringify(issuedTo).slice(0, 400), new Date(nowMs).toISOString(), since);
}

/** `promise`, or undefined after `ms`. */
async function bounded<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<undefined>((resolve) => (timer = setTimeout(() => resolve(undefined), ms)))]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Runs `work` after the response where the platform allows it, else now. Never throws. */
export async function settle(c: Context<AppContext>, work: () => Promise<unknown>): Promise<void> {
  const safe = () => work().catch(() => undefined);
  try {
    c.executionCtx.waitUntil(safe());
    return;
  } catch {
    /* no ExecutionContext: run it in line */
  }
  await safe();
}

/**
 * Opens an incident: mints the device tag (the caller sets its cookie), writes
 * the blocks, the canary batch and prunes in ONE batch (awaited at most
 * INCIDENT_WAIT_MS), updates this isolate's snapshot when the write landed,
 * then records ACTOR_BLOCKED and rings the owner after the response. Never
 * throws: a failed write leaves the stateless tag doing its work.
 */
export async function openIncident(c: Context<AppContext>, input: IncidentInput): Promise<Incident> {
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const refHex = input.reuse?.referenceHex ?? newReferenceHex();
  const reference = referenceOf(refHex);
  const incidentId = input.reuse?.incidentId ?? `sin_${newId()}`;
  const tag = await mintTag(c.env, refHex, nowMs);
  const out: Incident = { incidentId, reference, tag, written: false };
  const db = c.env?.DB;
  if (!db) return out;
  try {
    const fp = await contextOf(c).catch(() => ({ s: '', i: '', u: '' }));
    const evidence = evidenceOf(c, input, fp);
    const actorClass = actorClassFor(c.env, input.user);
    if (actorClass === 'owner') return out;
    const since = new Date(nowMs - DAY).toISOString();
    const base = { incidentId, reference, actorClass, reason: input.reason, signal: input.signal, nowIso, evidence };
    const stmts: D1PreparedStatement[] = [];
    if (input.batch && input.decoy) stmts.push(canaryStatement(db, input.batch.id, input.decoy, incidentId, input.batch.issuedTo, nowMs));
    stmts.push(
      blockStatement(db, { ...base, kind: 'device', key: tag.tagId, expiresIso: new Date(tag.exp * 1000).toISOString() }, since)
    );
    const accountKey = input.account && input.user && !input.deviceOnly ? input.user.id : null;
    if (accountKey) {
      stmts.push(blockStatement(db, { ...base, kind: 'account', key: accountKey, expiresIso: new Date(nowMs + ACCOUNT_BLOCK_DAYS * DAY).toISOString() }, since));
    }
    const net = input.network && !input.deviceOnly ? input.network : null;
    if (net?.key) {
      stmts.push(blockStatement(db, { ...base, kind: 'network', key: net.key, expiresIso: new Date(nowMs + net.hours * 3_600_000).toISOString() }, since));
    }
    stmts.push(...pruneStatements(db, nowMs));
    const res = await bounded(
      db.batch(stmts).then(
        (r) => r,
        (e: unknown) => {
          if (!isMissingTable(e)) console.error('security incident not written:', e instanceof Error ? e.name : 'unknown');
          return null;
        }
      ),
      INCIDENT_WAIT_MS
    );
    if (!res) return out;
    const blockResults = res.slice(input.batch && input.decoy ? 1 : 0, (input.batch && input.decoy ? 1 : 0) + 1 + (accountKey ? 1 : 0) + (net?.key ? 1 : 0));
    out.written = blockResults.some((r) => Number((r as { meta?: { changes?: number } }).meta?.changes ?? 0) > 0);
    const s = snapshotFor(db);
    if (s && s.status !== 'absent') {
      if (out.written && accountKey) s.accounts.set(accountKey, { id: '', incidentId, reference, expiresMs: nowMs + ACCOUNT_BLOCK_DAYS * DAY });
      // Past the daily cap nothing is written, but this isolate still blocks the network.
      if (net?.key) s.networks.set(net.key, { id: '', incidentId, reference, expiresMs: nowMs + net.hours * 3_600_000 });
    }
    if (out.written && !input.deviceOnly) {
      const detail: SecurityDetail = { sig: input.signal, ref: reference, intent: input.intent, d: tag.tagId };
      if (input.decoy) detail.decoy = input.decoy;
      if (input.batch) detail.batch = input.batch.id;
      await recordSecurityEvent(c, { kind: 'enumeration_suspected', code: 'ACTOR_BLOCKED', status: 403, detail });
      await settle(c, () => ringOwnerDeception(c.env, db, 'blocked', incidentId, reference, nowMs));
    }
  } catch {
    /* never in the way */
  }
  return out;
}

// ------------------------------------------------------------- the owner's bell

const ownerIds = new WeakMap<object, { id: string | null; at: number }>();

/** The owner's user id (INITIAL_ADMIN_EMAIL on an admin row), memoised per isolate for ten minutes. */
export async function ownerUserId(env: Env, db: D1Database): Promise<string | null> {
  const email = (env.INITIAL_ADMIN_EMAIL ?? '').trim().toLowerCase();
  if (!email) return null;
  const memo = ownerIds.get(db);
  if (memo && Date.now() - memo.at < 600_000) return memo.id;
  const row = await db
    .prepare("SELECT id FROM users WHERE lower(trim(email)) = ? AND role = 'admin' LIMIT 1")
    .bind(email)
    .first<{ id: string }>()
    .catch(() => null);
  ownerIds.set(db, { id: row?.id ?? null, at: Date.now() });
  return row?.id ?? null;
}

/** One bell per incident, DECEPTION_BELL_CAP a Baghdad day, on its own key prefix. No figure in it. */
export async function ringOwnerDeception(
  env: Env,
  db: D1Database,
  which: 'blocked' | 'ownCanary' | 'ownDecoy',
  incidentId: string,
  reference: string,
  nowMs: number
): Promise<void> {
  try {
    const ownerId = await ownerUserId(env, db);
    if (!ownerId) return;
    const day = baghdadDay(nowMs);
    const today = await db
      .prepare("SELECT COUNT(*) AS n FROM user_notifications WHERE user_id = ? AND kind = 'security_alert' AND event_key LIKE ?")
      .bind(ownerId, `security_deception:${day}:%`)
      .first<{ n: number }>();
    if (Number(today?.n ?? 0) >= DECEPTION_BELL_CAP) return;
    const text = DECEPTION_BELL[which];
    await notify(db, {
      userId: ownerId,
      kind: 'security_alert',
      title_ar: text.title.ar,
      title_en: text.title.en,
      body_ar: text.body.ar,
      body_en: text.body.en,
      link: '/admin?tab=security',
      meta: { title_ckb: text.title.ckb, body_ckb: text.body.ckb, reason: which === 'blocked' ? 'deception_block' : `deception_${which}`, reference },
      eventKey: `security_deception:${day}:${incidentId}`,
    });
  } catch {
    /* never in the way */
  }
}

// ------------------------------------------------------------- lifting

export interface LiftResult {
  lifted: number;
  blocks: Array<{ id: string; actor_kind: BlockKind; actor_key: string; reference: string; incident_id: string }>;
}

/**
 * Lifts one block, or every live block of its incident. Moves `updated_at` so
 * every isolate's delta refresh sees it; this isolate forgets it at once.
 */
export async function liftBlocks(db: D1Database, blockId: string, wholeIncident: boolean, ownerId: string, nowMs: number): Promise<LiftResult | null> {
  const target = await db
    .prepare('SELECT id, incident_id, actor_kind, actor_key, reference, lifted_at FROM security_blocks WHERE id = ?')
    .bind(blockId)
    .first<{ id: string; incident_id: string; actor_kind: BlockKind; actor_key: string; reference: string; lifted_at: string | null }>();
  if (!target) return null;
  const rows = wholeIncident
    ? (
        await db
          .prepare('SELECT id, incident_id, actor_kind, actor_key, reference FROM security_blocks WHERE incident_id = ? AND lifted_at IS NULL LIMIT 20')
          .bind(target.incident_id)
          .all<{ id: string; incident_id: string; actor_kind: BlockKind; actor_key: string; reference: string }>()
      ).results ?? []
    : target.lifted_at
      ? []
      : [target];
  const nowIso = new Date(nowMs).toISOString();
  if (rows.length) {
    await db.batch(
      rows.map((r) =>
        db
          .prepare('UPDATE security_blocks SET lifted_at = ?1, lifted_by = ?2, updated_at = ?1 WHERE id = ?3 AND lifted_at IS NULL')
          .bind(nowIso, ownerId, r.id)
      )
    );
  }
  const s = snapshotFor(db);
  if (s) {
    for (const r of rows) {
      if (r.actor_kind === 'device') s.lifted.add(r.actor_key);
      else (r.actor_kind === 'account' ? s.accounts : s.networks).delete(r.actor_key);
    }
  }
  return { lifted: rows.length, blocks: rows };
}
