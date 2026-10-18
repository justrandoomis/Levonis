/**
 * THE MERCHANT APPROVAL GATE (Community V3 phase 1; DECISIONS row 256).
 *
 * Approval is a fourth axis beside sanction (`community_merchants.status`),
 * store operation (`merchant_stores.status`) and subscription (memberships),
 * written into none of them. A person becomes a merchant when a human
 * reviewer approves their merchant application; the flag the public
 * predicates read is `community_merchants.approved_at`, and NULL fails
 * closed. A NEW merchant's row does not exist until /onboard creates it with
 * the store, stamped from the approved application — until then
 * `merchantApprovalOf` reads that application (row 257, final check).
 *
 * This module is the single place that knows:
 *   - the application's states and the only legal transitions between them,
 *     and how a transition is written (one batch: the conditional UPDATE, a
 *     lost-race fence, the append-only event and the audit row);
 *   - who may review (owner decision C5) — `canReviewMerchants`;
 *   - the predicates the gates and public lists use (`merchantApproved`,
 *     `merchantPublicSql`, `storePublicSql`), so push 1.4 switches every
 *     surface to ONE definition instead of fifteen copies of `<> 'suspended'`;
 *   - the applicant's validation rules (a three-part name whose parts may hold
 *     spaces, a date of birth that is a DATE and never a timestamp, 18+, an
 *     Instagram/Facebook activity link);
 *   - the retention sweep (owner decision C7).
 *
 * Nothing here ever returns, logs, audits or announces a personal value. The
 * sealed columns are opaque strings to everything but the applicant's own
 * save (seal) and the audited reviewer detail (unseal, push 1.2).
 *
 * SCHEMA TOLERANCE (CLAUDE.md rule 2, gap §3.11). Every read of migration
 * 0204's objects survives their absence and fails CLOSED: no table means no
 * application, no grant and no approval.
 */
import type { Context } from 'hono';
import type { AppContext, Env, SessionUser } from './types';
import { isOwner, normalizeAdminScope } from './adminScope';
import { auditStatements } from './audit';
import { newId } from './crypto';
import { changedExactlyOne, isLostRace } from './gifts/fence';
import { HttpError, isPlatformAdmin } from './http';
import { deleteMediaObject, mediaBucket } from './mediaStorage';

// ------------------------------------------------------------------ states

export const APPLICATION_STATES = [
  'draft',
  'submitted',
  'in_review',
  'changes_requested',
  'approved',
  'rejected',
  'withdrawn',
] as const;
export type ApplicationState = (typeof APPLICATION_STATES)[number];

/** States the partial unique index counts: at most one of these per user. */
export const LIVE_STATES: readonly ApplicationState[] = ['draft', 'submitted', 'in_review', 'changes_requested'];

/** Owner decision C7: private data lives this long after a rejection or a withdrawal. */
export const RETENTION_DAYS = 90;
/** Owner decision C6. */
export const MIN_APPLICANT_AGE = 18;

export type ActorKind = 'applicant' | 'reviewer' | 'system';
export type EventAction =
  | 'created'
  | 'reopened'
  | 'submitted'
  | 'review_started'
  | 'changes_requested'
  | 'approved'
  | 'rejected'
  | 'withdrawn'
  | 'purged';

export type ApplicationAction = 'submit' | 'reopen' | 'withdraw' | 'start_review' | 'request_changes' | 'approve' | 'reject';

interface TransitionRule {
  from: readonly ApplicationState[];
  to: ApplicationState;
  actor: ActorKind;
  event: EventAction;
  /** The applicant edits after a submission: the reviewer must see a NEW revision. */
  bumpRevision?: true;
  /** A reviewer's decision: decided_by / decided_at / decided_revision and the two reasons. */
  decision?: true;
  /** Starts the C7 clock. */
  retention?: true;
}

/**
 * THE WHOLE STATE MACHINE (gap §3.2). Anything not listed is illegal.
 *
 *   draft ─submit→ submitted ─start_review→ in_review ─approve→ approved
 *                                                    ├─reject→ rejected
 *                                                    └─request_changes→ changes_requested
 *   submitted | changes_requested ─reopen (applicant edits, revision+1)→ draft
 *   draft | submitted | in_review | changes_requested ─withdraw→ withdrawn
 *   approved ─reject (REVOKE, only while the user has no store)→ rejected
 *
 * A DRAFT'S REVISION WAS NEVER SENT: submit freezes a revision without
 * bumping it and reopen always bumps, so a draft never has a 'submitted' event
 * at its own revision. Withdrawn from a draft — a first draft, or values
 * edited after a reopen — nothing in the sealed columns was ever a reviewer's
 * (`revisionSentSql`), so nothing is kept: its C7 clock is due at once and the
 * withdraw purges it (`purgeDueApplication`).
 *
 * A finished application (rejected, withdrawn) never moves again; a rejected
 * applicant re-applies at once with a NEW application (owner decision C8 — no
 * cooldown).
 *
 * APPROVED IS FINAL ONCE THERE IS A STORE. Before that, an approval made in
 * error (or fraud found later) is REVOKED by the reviewer's own 'reject',
 * named as a revoke (`revoke: true`, so a late reject never revokes) —
 * reason required, revision- and operation-guarded, audited — and only while
 * no `merchant_stores` row exists for the user, checked IN the conditional
 * UPDATE (`applyTransition`), so a revoke and an /onboard racing each other
 * cannot both win. The revoked application is 'rejected' like any other: it
 * no longer counts in `merchantApprovalOf`, the stamp it put on an existing
 * merchant row is cleared, /onboard refuses MERCHANT_APPLICATION_REQUIRED and
 * the applicant may re-apply at once (C8). Once a store exists, revocation is
 * the existing suspension (sanction axis), never a state here
 * (APPROVAL_REVOKE_STORE_EXISTS).
 */
export const TRANSITIONS: Readonly<Record<ApplicationAction, TransitionRule>> = {
  submit: { from: ['draft'], to: 'submitted', actor: 'applicant', event: 'submitted' },
  reopen: { from: ['submitted', 'changes_requested'], to: 'draft', actor: 'applicant', event: 'reopened', bumpRevision: true },
  withdraw: { from: LIVE_STATES, to: 'withdrawn', actor: 'applicant', event: 'withdrawn', retention: true },
  start_review: { from: ['submitted'], to: 'in_review', actor: 'reviewer', event: 'review_started' },
  request_changes: { from: ['in_review'], to: 'changes_requested', actor: 'reviewer', event: 'changes_requested', decision: true },
  approve: { from: ['in_review'], to: 'approved', actor: 'reviewer', event: 'approved', decision: true },
  reject: { from: ['in_review', 'approved'], to: 'rejected', actor: 'reviewer', event: 'rejected', decision: true, retention: true },
};

/** A reviewer's 'reject' of an APPROVED application: revoking the approval (store-less users only). */
export function isRevocation(action: ApplicationAction, from: string): boolean {
  return action === 'reject' && from === 'approved';
}

/** The correlated rule the revocation's UPDATE carries: the application's user has no store. */
const NO_STORE_YET_SQL = `NOT EXISTS (SELECT 1 FROM merchant_stores WHERE merchant_stores.user_id = merchant_applications.user_id)`;

async function storeExistsFor(db: D1Database, userId: string): Promise<boolean> {
  const row = await db.prepare('SELECT 1 AS x FROM merchant_stores WHERE user_id = ? LIMIT 1').bind(userId).first();
  return !!row;
}

/** The state an action leads to from `from`, or null when the move is illegal. */
export function nextState(action: ApplicationAction, from: string): ApplicationState | null {
  const rule = TRANSITIONS[action];
  return rule && (rule.from as readonly string[]).includes(from) ? rule.to : null;
}

export function isLiveState(state: string): boolean {
  return (LIVE_STATES as readonly string[]).includes(state);
}

// ---------------------------------------------------------- schema absence

/** A read of 0204's objects on a database that has not applied it. */
export function isMissingSchema(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return /no such (table|column)/i.test(msg);
}

// -------------------------------------------------------------- predicates

/** Approved means a real stamp. NULL, '' and a missing column are not approval. */
export function merchantApproved(m: { approved_at?: unknown } | null | undefined): boolean {
  return !!m && typeof m.approved_at === 'string' && m.approved_at.trim() !== '';
}

const ALIAS = /^[A-Za-z_][A-Za-z0-9_]{0,30}$/;
function alias(a: string): string {
  if (!ALIAS.test(a)) throw new Error('merchantApproval: invalid SQL alias');
  return a;
}

/** The sanction rule the directory and the feed use today: a suspended merchant is shown nowhere. */
export function merchantUnsanctionedSql(a: string): string {
  return `${alias(a)}.status <> 'suspended'`;
}

/**
 * A store an admin suspended is shown nowhere. The alias may come from a LEFT
 * JOIN (a store-less row reads as not suspended), as the feed's rule does.
 * A merchant-PAUSED store stays listed with its label (owner decision C10).
 */
export function storeUnsanctionedSql(s: string): string {
  return `COALESCE(${alias(s)}.status, '') <> 'suspended'`;
}

/**
 * PUBLIC MERCHANT (gap §3.6): not suspended AND approved. Push 1.4 moves every
 * public surface onto this; until then only new code reads it.
 */
export function merchantPublicSql(a: string): string {
  return `${merchantUnsanctionedSql(a)} AND ${alias(a)}.approved_at IS NOT NULL`;
}

/**
 * WAS THE APPLICATION'S CURRENT REVISION EVER SENT? (final check, row 257.)
 * The sealed columns hold only the LATEST values, so a reviewer may open an
 * application only while its current revision is one the applicant
 * submitted: a 'submitted' event at exactly that revision. A draft never
 * qualifies, and neither does a withdrawn application whose last revision
 * was a draft — a first draft never sent, or values edited after a reopen.
 * Nothing older is shown in their place: the earlier revision's values are
 * not stored anywhere, so the answer is nothing at all.
 */
export function revisionSentSql(a: string): string {
  return `EXISTS (SELECT 1 FROM merchant_application_events sent
                   WHERE sent.application_id = ${alias(a)}.id AND sent.revision = ${alias(a)}.revision
                     AND sent.action = 'submitted')`;
}

/** PUBLIC STORE (gap §3.6): not suspended; paused stays visible (C10). */
export function storePublicSql(s: string): string {
  return storeUnsanctionedSql(s);
}

export interface MerchantApprovalState {
  /** The user already has a `community_merchants` row. */
  merchant: boolean;
  /** A reviewer approved them: the row's stamp, or an approved application not yet turned into a store. */
  approved: boolean;
}

/**
 * Where this user stands on the approval axis. Approved is the merchant
 * row's stamp OR an application in state 'approved' (final once a store
 * exists; before that a reviewer's revoke moves it to 'rejected' and clears
 * the stamp it made, so neither counts): approving a NEW applicant writes no public row — the
 * row is born with its store at /onboard, stamped from that application — so
 * nothing appears in «المتاجر» before there is a store to show.
 *
 * An older database without 0204 answers "not approved" (fails closed) while
 * still telling an existing merchant row apart from none.
 */
export async function merchantApprovalOf(db: D1Database, userId: string): Promise<MerchantApprovalState> {
  try {
    const row = await db
      .prepare(
        `SELECT (SELECT id FROM community_merchants WHERE user_id = ?1) AS id,
                (SELECT approved_at FROM community_merchants WHERE user_id = ?1) AS approved_at,
                EXISTS (SELECT 1 FROM merchant_applications WHERE user_id = ?1 AND state = 'approved') AS application_approved`
      )
      .bind(userId)
      .first<{ id: string | null; approved_at: string | null; application_approved: number }>();
    return { merchant: !!row?.id, approved: merchantApproved(row) || Number(row?.application_approved ?? 0) === 1 };
  } catch (e) {
    if (!isMissingSchema(e)) throw e;
    const row = await db.prepare('SELECT id FROM community_merchants WHERE user_id = ?').bind(userId).first();
    return { merchant: !!row, approved: false };
  }
}

/**
 * THE NEW-MERCHANT REFUSAL (E1, E2). One code and one sentence for every door
 * that would create a merchant: the applicant learns what to do, and nothing
 * in it names a state, a person or a reason.
 */
export function applicationRequiredRefusal(): HttpError {
  return new HttpError(
    403,
    'قدّم طلب اعتماد التاجر أولًا؛ يُفتح المتجر بعد موافقة المراجعة / Apply to become a merchant first; a store opens after the review approves it',
    'MERCHANT_APPLICATION_REQUIRED'
  );
}

// ------------------------------------------------------------ reviewer scope

/** Capability keys `admin_capability_grants` may hold — checked here, shape-checked in 0204. */
export const CAPABILITY_GRANTS = ['MERCHANT_REVIEW'] as const;
export type CapabilityGrant = (typeof CAPABILITY_GRANTS)[number];

/** A LIVE grant. No table, no grant. Never a financial capability. */
export async function hasCapabilityGrant(db: D1Database, userId: string, key: CapabilityGrant): Promise<boolean> {
  try {
    const row = await db
      .prepare('SELECT 1 AS x FROM admin_capability_grants WHERE user_id = ? AND grant_key = ? AND revoked_at IS NULL LIMIT 1')
      .bind(userId, key)
      .first();
    return !!row;
  } catch (e) {
    if (isMissingSchema(e)) return false;
    throw e;
  }
}

type ReviewerSubject = Pick<SessionUser, 'id' | 'role' | 'email'> & { admin_scope?: string | null };

/**
 * WHO MAY REVIEW A MERCHANT APPLICATION (owner decision C5): the owner and
 * full-scope admins by default; an assistant admin only with a live
 * MERCHANT_REVIEW grant the owner issued. Built on adminScope.ts — an
 * unrecognised scope is an assistant's. The capability opens merchant review
 * and NOTHING else: no money, no cost (it never feeds canMoveMoney/canViewCost).
 *
 * The admin HOST is part of the rule; a route asks `canReviewMerchantsHere`.
 */
export async function canReviewMerchants(
  env: Pick<Env, 'DB' | 'INITIAL_ADMIN_EMAIL'>,
  user: ReviewerSubject | null | undefined
): Promise<boolean> {
  if (!user || user.role !== 'admin') return false;
  if (isOwner(env as Env, user)) return true;
  if (normalizeAdminScope(user.admin_scope) !== 'assistant') return true;
  return hasCapabilityGrant(env.DB, user.id, 'MERCHANT_REVIEW');
}

/** `canReviewMerchants` on a host where administration is served at all. */
export async function canReviewMerchantsHere(c: Context<AppContext>): Promise<boolean> {
  if (!isPlatformAdmin(c)) return false;
  return canReviewMerchants(c.env, c.get('user'));
}

// ------------------------------------------------------------- transitions

export interface ApplicationRef {
  id: string;
  user_id: string;
  state: string;
  revision: number;
}

export interface TransitionRequest {
  application: ApplicationRef;
  action: ApplicationAction;
  actor: { id: string | null; kind: ActorKind };
  /** Unique per intended transition; a replay of the same id writes nothing. */
  operationId: string;
  now?: string;
  /** Shown to the applicant (request_changes, reject). */
  reasonPublic?: string;
  /** Staff only; never serialised to the applicant. */
  noteInternal?: string;
  /**
   * 'reject' of an APPROVED application — revoking it — is SAID, never
   * inferred: approve keeps the revision, so a reject clicked on a review
   * another reviewer approved meanwhile would otherwise revoke that approval.
   * A reject from 'approved' without it, or with it from any other state, is
   * APPLICATION_STATE_INVALID.
   */
  revoke?: boolean;
}

export type TransitionOutcome =
  | { ok: true; replay: boolean; state: ApplicationState; revision: number }
  | {
      ok: false;
      code:
        | 'APPLICATION_STATE_INVALID'
        | 'APPLICATION_CHANGED'
        | 'SELF_DECISION_FORBIDDEN'
        | 'OPERATION_REUSED'
        | 'OPERATION_ID_INVALID'
        | 'APPROVAL_REVOKE_STORE_EXISTS';
    };

/** The stored shape of an operation id: a client's, or one of the server's own (`srv:…`, `create:…`, `purge:…`). */
const OPERATION_ID = /^[A-Za-z0-9:_-]{8,80}$/;
/**
 * A CLIENT's operation id never carries ':'. Every id the server mints itself
 * lives in a ':' namespace (`srv:`, `create:`, `purge:`), so no client can
 * take one of them — `operation_id` is UNIQUE across the whole event trail,
 * and a client holding the sweep's id would stop the C7 purge of its row.
 */
const CLIENT_OPERATION_ID = /^[A-Za-z0-9_-]{8,80}$/;

export function validOperationId(v: unknown): v is string {
  return typeof v === 'string' && OPERATION_ID.test(v);
}

export function validClientOperationId(v: unknown): v is string {
  return typeof v === 'string' && CLIENT_OPERATION_ID.test(v);
}

/** The caller's operation id when it sent a valid CLIENT one, a fresh server id otherwise. */
export function operationIdFrom(v: unknown): string {
  return validClientOperationId(v) ? v : `srv:${newId()}`;
}

export function retentionUntil(now: string): string {
  return new Date(Date.parse(now) + RETENTION_DAYS * 86_400_000).toISOString();
}

async function replayOf(
  db: D1Database,
  req: TransitionRequest
): Promise<TransitionOutcome | null> {
  const ev = await db
    .prepare('SELECT application_id, action FROM merchant_application_events WHERE operation_id = ?')
    .bind(req.operationId)
    .first<{ application_id: string; action: string }>();
  if (!ev) return null;
  if (ev.application_id !== req.application.id || ev.action !== TRANSITIONS[req.action].event) {
    return { ok: false, code: 'OPERATION_REUSED' };
  }
  const now = await db
    .prepare('SELECT state, revision FROM merchant_applications WHERE id = ?')
    .bind(req.application.id)
    .first<{ state: ApplicationState; revision: number }>();
  return { ok: true, replay: true, state: now!.state, revision: Number(now!.revision) };
}

/** The event row of a transition (or of 'created' / 'purged'), with no personal value in it. */
export function eventStatement(
  db: D1Database,
  e: { applicationId: string; revision: number; actorId: string | null; actorKind: ActorKind; action: EventAction; reasonPublic?: string; at: string; operationId: string }
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO merchant_application_events
         (id, application_id, revision, actor_id, actor_kind, action, reason_public, at, operation_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(newId('mape'), e.applicationId, e.revision, e.actorId, e.actorKind, e.action, e.reasonPublic ?? '', e.at, e.operationId);
}

/**
 * ONE TRANSITION, ONE BATCH (gap §3.2): `UPDATE … WHERE id = ? AND state = ?
 * AND revision = ?`, the lost-race fence (`changedExactlyOne`: the batch rolls
 * back unless that UPDATE changed exactly one row), the append-only event
 * carrying the unique `operation_id`, approve's upsert of the merchant row,
 * and the audit row — all or nothing. Two reviewers cannot both win; a replay
 * of the same operation id answers with the state it produced and writes
 * nothing.
 *
 * APPROVE stamps `approved_at` and `approved_application_id` on the user's
 * EXISTING merchant row (one from before the gate keeps its listing exactly
 * as it was) and creates none: a new applicant's approval lives on the
 * application, and /onboard creates the merchant row with its store, stamped
 * from it. So approval creates no store and publishes nothing — no
 * store-less card in «المتاجر» (final check, row 257).
 *
 * REVOKE ('reject' from 'approved') is the same batch with one more rule in
 * the conditional UPDATE — the user has no store (`NO_STORE_YET_SQL`) — and
 * one more statement: the stamp this application put on an existing merchant
 * row is cleared. An /onboard that commits first makes the UPDATE match
 * nothing, the fence rolls the revoke back, and the reviewer hears
 * APPROVAL_REVOKE_STORE_EXISTS; a revoke that commits first fails /onboard's
 * own approval fence (merchant.ts). Exactly one of them wins.
 */
export async function applyTransition(db: D1Database, req: TransitionRequest): Promise<TransitionOutcome> {
  if (!validOperationId(req.operationId)) return { ok: false, code: 'OPERATION_ID_INVALID' };
  const rule = TRANSITIONS[req.action];
  const app = req.application;

  const replay = await replayOf(db, req);
  if (replay) return replay;

  if (req.actor.kind !== rule.actor) return { ok: false, code: 'APPLICATION_STATE_INVALID' };
  // NO SELF-DECISION: a reviewer never moves their own application.
  if (rule.actor === 'reviewer' && req.actor.id === app.user_id) return { ok: false, code: 'SELF_DECISION_FORBIDDEN' };
  if (!(rule.from as readonly string[]).includes(app.state)) return { ok: false, code: 'APPLICATION_STATE_INVALID' };
  const revoke = isRevocation(req.action, app.state);
  if (req.action === 'reject' && revoke !== (req.revoke === true)) return { ok: false, code: 'APPLICATION_STATE_INVALID' };
  // The early, honest answer; the rule that decides is the one IN the UPDATE below.
  if (revoke && (await storeExistsFor(db, app.user_id))) return { ok: false, code: 'APPROVAL_REVOKE_STORE_EXISTS' };

  const now = req.now ?? new Date().toISOString();
  const revision = rule.bumpRevision ? app.revision + 1 : app.revision;
  const sets: string[] = ['state = ?', 'revision = ?', 'updated_at = ?'];
  const binds: unknown[] = [rule.to, revision, now];
  if (req.action === 'submit') {
    sets.push('submitted_at = ?');
    binds.push(now);
  }
  if (rule.decision) {
    sets.push('reason_public = ?', 'note_internal = ?', 'decided_by = ?', 'decided_at = ?', 'decided_revision = ?');
    binds.push((req.reasonPublic ?? '').slice(0, 1000), (req.noteInternal ?? '').slice(0, 2000), req.actor.id, now, app.revision);
  }
  if (rule.retention) {
    sets.push('retention_until = ?');
    // Withdrawn from a draft, no reviewer ever had this revision (see TRANSITIONS):
    // nothing is kept for the C7 period — the purge is due now.
    binds.push(req.action === 'withdraw' && app.state === 'draft' ? now : retentionUntil(now));
  }

  // SUBMIT re-checks completeness IN the write: a draft save keeps the revision,
  // so one landing between the route's check and this batch (a blanked public
  // name) would otherwise slip through the state + revision fence.
  const complete =
    req.action === 'submit'
      ? ` AND length(trim(public_name)) >= 2 AND legal_name_enc <> '' AND dob_enc <> '' AND social_link_enc <> '' AND photo_key IS NOT NULL`
      : revoke
        ? ` AND ${NO_STORE_YET_SQL}`
        : '';
  const statements: D1PreparedStatement[] = [
    db
      .prepare(`UPDATE merchant_applications SET ${sets.join(', ')} WHERE id = ? AND state = ? AND revision = ?${complete}`)
      .bind(...binds, app.id, app.state, app.revision),
    ...changedExactlyOne(db),
    eventStatement(db, {
      applicationId: app.id,
      revision,
      actorId: req.actor.id,
      actorKind: req.actor.kind,
      action: rule.event,
      reasonPublic: rule.decision ? req.reasonPublic : '',
      at: now,
      operationId: req.operationId,
    }),
  ];
  if (req.action === 'approve') {
    // An existing merchant row only: a new applicant gets theirs at /onboard, with the store.
    statements.push(
      db
        .prepare(
          `UPDATE community_merchants SET approved_at = ?, approved_application_id = ?
            WHERE user_id = (SELECT user_id FROM merchant_applications WHERE id = ?)`
        )
        .bind(now, app.id, app.id)
    );
  }
  if (revoke) {
    // The stamp this approval put on a merchant row from before the gate goes with it.
    statements.push(
      db
        .prepare(
          `UPDATE community_merchants SET approved_at = NULL, approved_application_id = NULL
            WHERE user_id = ? AND approved_application_id = ?`
        )
        .bind(app.user_id, app.id)
    );
  }
  const { statements: auditRows } = await auditStatements(
    db,
    req.actor.id,
    `merchant_application.${rule.event}`,
    app.id,
    { from: app.state, to: rule.to, revision, operation_id: req.operationId }
  );
  statements.push(...auditRows);

  try {
    await db.batch(statements);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // A concurrent request with the SAME operation id landed first: answer as its replay.
    if (isLostRace(e) || /UNIQUE constraint failed: merchant_application_events\.operation_id/.test(msg)) {
      const after = await replayOf(db, req);
      if (after) return after;
      // A store opened between the early check and this batch: the revoke lost to /onboard.
      if (revoke && isLostRace(e) && (await storeExistsFor(db, app.user_id))) return { ok: false, code: 'APPROVAL_REVOKE_STORE_EXISTS' };
      return { ok: false, code: 'APPLICATION_CHANGED' };
    }
    throw e;
  }
  return { ok: true, replay: false, state: rule.to, revision };
}

/** The HTTP answer for a refused transition. Codes only; no state of anyone else, no value. */
export function transitionRefusal(code: Exclude<TransitionOutcome, { ok: true }>['code']): HttpError {
  switch (code) {
    case 'SELF_DECISION_FORBIDDEN':
      return new HttpError(
        403,
        'لا يمكنك البتّ في طلبك أنت؛ يقرّره مراجع آخر / You cannot decide your own application; another reviewer decides it',
        code
      );
    case 'OPERATION_ID_INVALID':
      return new HttpError(400, 'Invalid operation id', code);
    case 'OPERATION_REUSED':
      return new HttpError(409, 'This operation id was already used for another action', code);
    case 'APPLICATION_CHANGED':
      return new HttpError(
        409,
        'تغيّر الطلب للتو؛ حدّث الصفحة ثم أعد المحاولة / The application just changed; refresh and try again',
        code
      );
    case 'APPROVAL_REVOKE_STORE_EXISTS':
      return new HttpError(
        409,
        'فتح هذا التاجر متجره بالفعل فلا يُسحب اعتماده؛ أوقف التاجر من إدارة المجتمع بدلًا من ذلك / This merchant already opened a store, so the approval cannot be revoked; suspend the merchant from community administration instead',
        code
      );
    default:
      return new HttpError(
        409,
        'لا يمكن تنفيذ هذا الإجراء على الطلب في حالته الحالية / This action is not possible in the application\'s current state',
        'APPLICATION_STATE_INVALID'
      );
  }
}

// ---------------------------------------------------------- applicant rules

export interface LegalName {
  given: string;
  father: string;
  grandfather: string;
}

/**
 * One part of the three-part name. A part is a NAME, not a word: «عبد الله»
 * and «Abdul Rahman» are one part each (the brief: "three-part name … not
 * «three words»"). Letters (any script) and combining marks, with single
 * spaces, hyphens, apostrophes and dots between them.
 */
const NAME_PART = /^[\p{L}\p{M}](?:[\p{L}\p{M}'’.\- ]{0,58}[\p{L}\p{M}.])?$/u;

function namePart(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = v.normalize('NFC').replace(/\s+/g, ' ').trim();
  if (t.length < 2 || t.length > 60 || !NAME_PART.test(t)) return null;
  return t;
}

/** The legal name, or null. Never echoes the value in any refusal. */
export function parseLegalName(raw: unknown): LegalName | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const given = namePart(r.given);
  const father = namePart(r.father);
  const grandfather = namePart(r.grandfather);
  return given && father && grandfather ? { given, father, grandfather } : null;
}

/**
 * A DATE OF BIRTH IS A DATE. `YYYY-MM-DD`, checked against the calendar in
 * UTC arithmetic only — never `new Date(local)`, which shifts a date by the
 * viewer's zone — and stored as the same ten characters it arrived as.
 */
export function parseDob(raw: unknown, today: string = new Date().toISOString().slice(0, 10)): string | null {
  if (typeof raw !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
  const [y, m, d] = raw.split('-').map(Number) as [number, number, number];
  if (y < 1900 || m < 1 || m > 12 || d < 1) return null;
  const check = new Date(Date.UTC(y, m - 1, d));
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== m - 1 || check.getUTCDate() !== d) return null;
  if (raw > today) return null;
  return raw;
}

/** Whole years between two `YYYY-MM-DD` dates, by the calendar (no time, no zone). */
export function ageOn(dob: string, today: string): number {
  const years = Number(today.slice(0, 4)) - Number(dob.slice(0, 4));
  return today.slice(5) >= dob.slice(5) ? years : years - 1;
}

/** Baghdad's calendar date — the applicant's own "today". */
export function baghdadToday(nowMs: number = Date.now()): string {
  return new Date(nowMs + 3 * 3_600_000).toISOString().slice(0, 10);
}

const SOCIAL_HOSTS = new Set([
  'instagram.com',
  'www.instagram.com',
  'm.instagram.com',
  'facebook.com',
  'www.facebook.com',
  'm.facebook.com',
  'web.facebook.com',
  'fb.com',
  'www.fb.com',
]);

/** The Instagram/Facebook activity link, normalised to `https://host/path` (query and fragment dropped), or null. */
export function parseSocialLink(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const t = raw.trim();
  if (!t || t.length > 300) return null;
  let u: URL;
  try {
    u = new URL(/^[a-z][a-z0-9+.-]*:/i.test(t) ? t : `https://${t}`);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  if (u.username || u.password || u.port) return null;
  const host = u.hostname.toLowerCase();
  if (!SOCIAL_HOSTS.has(host)) return null;
  const path = u.pathname.replace(/\/+$/, '');
  if (!path || path === '/') return null;
  return `https://${host}${path}`;
}

/** Up to five https links the applicant chose to make public. Null when any is not a plain https URL. */
export function parsePublicLinks(raw: unknown): string[] | null {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw) || raw.length > 5) return null;
  const out: string[] = [];
  for (const v of raw) {
    if (typeof v !== 'string') return null;
    const t = v.trim();
    if (!t) continue;
    if (t.length > 300) return null;
    let u: URL;
    try {
      u = new URL(t);
    } catch {
      return null;
    }
    if (u.protocol !== 'https:' || u.username || u.password) return null;
    if (!out.includes(u.toString())) out.push(u.toString());
  }
  return out;
}

export const ACTIVITY_KINDS = ['print_services', 'products', 'both'] as const;

// ---------------------------------------------------------------- notices

/**
 * The «توثيق التجار» admin notice for a submission: ids only (gap §3.7 —
 * no name, no link, no date of birth, nothing a reader of the group could
 * learn the person from). The reviewer opens the audited detail instead.
 */
export function submittedNoticeText(applicationId: string, revision: number): string {
  return `⚡ New merchant application awaiting review\nApplication: ${applicationId}\nRevision: ${revision}`;
}

/**
 * A reviewer's move, for the same topic: ids, the revision and the action —
 * nothing else (no name, no reason, no reviewer). There is no decision command
 * in Telegram; the decision is taken in the audited admin panel only.
 */
export function reviewerNoticeText(applicationId: string, revision: number, action: EventAction): string {
  return `🧾 Merchant application ${action.replace(/_/g, ' ')}\nApplication: ${applicationId}\nRevision: ${revision}`;
}

// ------------------------------------------------- the applicant's summary

/** What `/api/merchant/me` says about the caller's application: no value, no internal note. */
export interface ApplicationSummary {
  state: ApplicationState;
  revision: number;
  /** The reviewer's reason addressed to the applicant, only once a reviewer decided. */
  reason_public: string;
}

/**
 * The caller's live application, else their newest finished one, else null —
 * the same choice as the applicant's own GET. A database without 0204 answers
 * null (nothing to show; the gate itself fails closed elsewhere).
 */
export async function applicationSummaryOf(db: D1Database, userId: string): Promise<ApplicationSummary | null> {
  let row: { state: ApplicationState; revision: number; reason_public: string } | null;
  try {
    row = await db
      .prepare(
        `SELECT state, revision, reason_public FROM merchant_applications WHERE user_id = ?
          ORDER BY CASE WHEN state IN ('draft','submitted','in_review','changes_requested') THEN 0 ELSE 1 END,
                   created_at DESC, rowid DESC
          LIMIT 1`
      )
      .bind(userId)
      .first<{ state: ApplicationState; revision: number; reason_public: string }>();
  } catch (e) {
    if (isMissingSchema(e)) return null;
    throw e;
  }
  if (!row) return null;
  const decided = row.state === 'changes_requested' || row.state === 'approved' || row.state === 'rejected';
  return { state: row.state, revision: Number(row.revision), reason_public: decided ? String(row.reason_public ?? '') : '' };
}

// --------------------------------------------------------------- retention

export interface RetentionReport {
  scanned: number;
  purged: number;
  photo_failures: number;
  /** Rows whose blanking batch failed for a reason other than a concurrent purge (retried next run). */
  failures: number;
}

/**
 * OWNER DECISION C7: 90 days after a rejection or a withdrawal, the sealed
 * values are blanked, the review photo is deleted and `purged_at` is set. The
 * event trail stays (it never held a value) and gains a 'purged' row.
 *
 * The photo goes FIRST: a row blanked while its object survived would lose
 * the only pointer to a personal photograph. EVERY object under the
 * application's own prefix goes, not only the current `photo_key` — a photo
 * replaced while its delete failed, or an upload that lost a race, is still
 * this person's photograph. A photo that cannot be deleted leaves its row for
 * the next run. Bounded per run; a missing table is an empty pass.
 *
 * The 'purged' event takes a FRESH server id: the `purged_at IS NULL` fence
 * with `changedExactlyOne` is what makes a purge happen once. Only a lost
 * race counts as "already purged"; any other failure is reported.
 */
export async function sweepMerchantApplicationRetention(
  env: Pick<Env, 'DB' | 'BUCKET' | 'R2_PUBLIC' | 'R2_PRIVATE'>,
  now: string = new Date().toISOString(),
  limit = 25
): Promise<RetentionReport> {
  return purgeDue(env, now, limit, '');
}

/**
 * THE SAME PURGE FOR ONE APPLICATION, NOW — when its C7 clock is already due.
 * The withdraw route calls it: an application withdrawn from a draft was
 * never a reviewer's and is due at once (see TRANSITIONS), so its sealed
 * values and photo go in the same request instead of waiting for the next
 * scheduled sweep. Anything that fails here is left for that sweep (its
 * `retention_until` is already due); an application not yet due is untouched.
 */
export async function purgeDueApplication(
  env: Pick<Env, 'DB' | 'BUCKET' | 'R2_PUBLIC' | 'R2_PRIVATE'>,
  applicationId: string,
  now: string = new Date().toISOString()
): Promise<RetentionReport> {
  return purgeDue(env, now, 1, applicationId);
}

async function purgeDue(
  env: Pick<Env, 'DB' | 'BUCKET' | 'R2_PUBLIC' | 'R2_PRIVATE'>,
  now: string,
  limit: number,
  only: string
): Promise<RetentionReport> {
  const report: RetentionReport = { scanned: 0, purged: 0, photo_failures: 0, failures: 0 };
  let rows: Array<{ id: string; revision: number; photo_key: string | null }>;
  try {
    rows = (
      await env.DB.prepare(
        `SELECT id, revision, photo_key FROM merchant_applications
          WHERE retention_until IS NOT NULL AND retention_until <= ?1 AND purged_at IS NULL
            AND state IN ('rejected','withdrawn') AND (?3 = '' OR id = ?3)
          ORDER BY retention_until LIMIT ?2`
      )
        .bind(now, limit, only)
        .all<{ id: string; revision: number; photo_key: string | null }>()
    ).results;
  } catch (e) {
    if (isMissingSchema(e)) return report;
    throw e;
  }
  for (const r of rows) {
    report.scanned += 1;
    try {
      for (const key of await reviewObjectKeys(env, r.id, r.photo_key)) await deleteMediaObject(env, 'private', key);
    } catch {
      report.photo_failures += 1;
      console.error('merchant application retention: photo delete failed', r.id);
      continue;
    }
    const res = await env.DB.batch([
      env.DB.prepare(
        `UPDATE merchant_applications
            SET legal_name_enc = '', dob_enc = '', social_link_enc = '', photo_key = NULL,
                note_internal = '', purged_at = ?, updated_at = ?
          WHERE id = ? AND purged_at IS NULL AND state IN ('rejected','withdrawn')`
      ).bind(now, now, r.id),
      ...changedExactlyOne(env.DB),
      eventStatement(env.DB, {
        applicationId: r.id,
        revision: Number(r.revision),
        actorId: null,
        actorKind: 'system',
        action: 'purged',
        at: now,
        operationId: `purge:${newId()}`,
      }),
    ]).then(
      () => 'purged' as const,
      (e: unknown) => {
        // A concurrent sweep purged it first: nothing to do.
        if (isLostRace(e)) return 'raced' as const;
        console.error('merchant application retention: blanking failed', r.id);
        return 'failed' as const;
      }
    );
    if (res === 'purged') report.purged += 1;
    if (res === 'failed') report.failures += 1;
  }
  return report;
}

/** The current photo and every other object stored under this application's own private prefix. */
async function reviewObjectKeys(
  env: Pick<Env, 'BUCKET' | 'R2_PUBLIC' | 'R2_PRIVATE'>,
  applicationId: string,
  photoKey: string | null
): Promise<string[]> {
  const keys = new Set<string>(photoKey ? [photoKey] : []);
  const bucket = mediaBucket(env, 'private');
  let cursor: string | undefined;
  for (let page = 0; page < 20; page++) {
    const listed = await bucket.list({ prefix: `merchant-review/${applicationId}/`, cursor });
    for (const o of listed.objects) keys.add(o.key);
    if (!listed.truncated) return [...keys];
    cursor = listed.cursor;
  }
  // More pages than any application can hold: refuse rather than blank a row whose objects survive.
  throw new Error('merchant application retention: listing did not end');
}
