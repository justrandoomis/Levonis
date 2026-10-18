import { Hono, type Context } from 'hono';
import type { AppContext } from '../lib/types';
import { safeParse } from '../lib/types';
import { HttpError, badRequest, notFound, requireAdmin, unavailable } from '../lib/http';
import { newId } from '../lib/crypto';
import { unseal } from '../lib/sealbox';
import { auditStatements } from '../lib/audit';
import { rateLimit } from '../lib/ratelimit';
import { getMediaObject } from '../lib/mediaStorage';
import { announceAfterResponse } from '../lib/adminTopicRouting';
import { requireFreshSession, requireOwner } from '../lib/costAccess';
import { MERCHANT_REVIEW_GRANT, isOwner, normalizeAdminScope } from '../lib/adminScope';
import {
  APPLICATION_STATES,
  ageOn,
  applyTransition,
  baghdadToday,
  canReviewMerchantsHere,
  isMissingSchema,
  reviewerNoticeText,
  transitionRefusal,
  validClientOperationId,
  type ApplicationAction,
  type ApplicationState,
  type LegalName,
} from '../lib/merchantApproval';

/**
 * «طلبات اعتماد التجار» — THE REVIEWER'S SIDE OF THE MERCHANT APPLICATION
 * (Community V3 push 1.2, DECISIONS row 257; gap §3.2–§3.3, §3.7).
 *
 *   GET  /                          the queue: public draft fields, state, revision, dates — no
 *                                   legal name, no date of birth, no activity link, no photo
 *   GET  /:id                       the audited detail: decrypts ONCE, audits merchant_application.view
 *   GET  /:id/photo                 the review photo: no-store, audited, scope-checked
 *   POST /:id/start-review          submitted → in_review
 *   POST /:id/request-changes       in_review → changes_requested (reason_public required)
 *   POST /:id/approve               in_review → approved (stamps community_merchants; NO store)
 *   POST /:id/reject                in_review → rejected (reason_public required)
 *
 *   GET  /reviewers                 the owner: assistant admins and their MERCHANT_REVIEW grant
 *   POST /reviewers/:userId/grant   the owner issues MERCHANT_REVIEW to an assistant admin
 *   POST /reviewers/:userId/revoke  the owner revokes it
 *
 * ITS OWN ROUTER, ON PURPOSE. Merchant administration lives in
 * adminCommunity.ts, whose money routes sit behind `requireFinancialScope`.
 * Reviewing an application needs none of that, and an assistant who may review
 * must not come one misplaced middleware away from a payout: this file reads
 * no wallet, escrow, payout, cost or price, and the reviewer scope
 * (`canReviewMerchants`) feeds no money or cost predicate.
 *
 * EVERY DOOR RE-CHECKS THE SCOPE (owner decision C5): the owner and full-scope
 * admins by default, an assistant only with a live MERCHANT_REVIEW grant —
 * read from the grant table on every request, so a revoke takes effect on the
 * next click. The session hint `can_review_merchants` only hides the tab.
 *
 * DECISIONS ARE GUARDED, NOT OPTIMISTIC. Every move names the revision the
 * reviewer saw and an operation id: `UPDATE … WHERE id AND state AND revision`
 * in one batch with the event and the audit row (`applyTransition`). Two
 * reviewers on one revision cannot both win; a replayed operation id writes
 * nothing and answers with the state it produced; nobody decides their own
 * application (SELF_DECISION_FORBIDDEN). The answer is the server's state,
 * which the panel waits for before it shows anything.
 *
 * PRIVATE BY CONSTRUCTION. The sealed values leave the server only in the
 * audited detail, to a reviewer, and the audit row is written BEFORE anything
 * is decrypted — no audit, no detail. The «توثيق التجار» Telegram topic hears
 * ids, revisions and the action, nothing else. `note_internal` is staff-only:
 * it is in this file's answers and never in the applicant's.
 */
export const adminMerchantApplicationRoutes = new Hono<AppContext>();
adminMerchantApplicationRoutes.use('*', requireAdmin);

/** 403 for an admin outside the reviewer scope. Says nothing about any application. */
const reviewerRefusal = () =>
  new HttpError(
    403,
    'مراجعة طلبات التجار ليست ضمن صلاحياتك / Reviewing merchant applications is not within your access',
    'MERCHANT_REVIEW_FORBIDDEN'
  );

async function requireReviewer(c: Context<AppContext>): Promise<void> {
  if (!(await canReviewMerchantsHere(c))) throw reviewerRefusal();
}

const schemaUnavailable = () =>
  unavailable(
    'طلبات اعتماد التجار غير متاحة على هذا الخادم بعد / Merchant applications are not available on this server yet',
    'MERCHANT_APPLICATIONS_UNAVAILABLE'
  );

/** A read or write of 0204's tables; their absence is an honest 503 (fails closed). */
async function guarded<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (isMissingSchema(e)) throw schemaUnavailable();
    throw e;
  }
}

/** An application id as the applicant routes mint them (`mapp_…`). Anything else is not one. */
const APPLICATION_ID = /^mapp_[A-Za-z0-9]{6,40}$/;
function applicationIdParam(c: Context<AppContext>): string {
  const id = c.req.param('id') ?? '';
  if (!APPLICATION_ID.test(id)) throw notFound('Application not found');
  return id;
}

// ------------------------------------------------------------------- views

/** The queue's columns: the PUBLIC draft, the review context, state, revision and dates. Nothing sealed. */
const LIST_COLUMNS = `id, user_id, state, revision, created_at, updated_at, submitted_at, decided_at,
  governorate, activity_kind, public_name, public_bio, public_links, purged_at`;

interface ListRow {
  id: string;
  user_id: string;
  state: ApplicationState;
  revision: number;
  created_at: string;
  updated_at: string;
  submitted_at: string | null;
  decided_at: string | null;
  governorate: string;
  activity_kind: string;
  public_name: string;
  public_bio: string;
  public_links: string;
  purged_at: string | null;
}

/**
 * One queue row. `own` tells the reviewer this is their OWN application, so
 * the panel offers no decision on it (the server refuses one regardless). No
 * user id, no legal name, no date of birth, no activity link, no photo — not
 * even whether one was uploaded.
 */
function listView(r: ListRow, reviewerId: string) {
  return {
    id: r.id,
    state: r.state,
    revision: Number(r.revision),
    created_at: r.created_at,
    updated_at: r.updated_at,
    submitted_at: r.submitted_at,
    decided_at: r.decided_at,
    public: { name: r.public_name, bio: r.public_bio, links: safeParse<string[]>(r.public_links, []) },
    review: { governorate: r.governorate, activity_kind: r.activity_kind },
    purged: !!r.purged_at,
    own: r.user_id === reviewerId,
  };
}

/**
 * A DRAFT IS NEVER A REVIEWER'S: it was never sent (or was reopened by its
 * applicant and is being edited). No filter lists it, and neither the detail
 * nor the photo opens it — its private values stay the applicant's alone.
 */
const QUEUE_FILTERS = ['queue', 'all', ...APPLICATION_STATES.filter((s) => s !== 'draft')] as const;

adminMerchantApplicationRoutes.get('/', async (c) => {
  await requireReviewer(c);
  const reviewer = c.get('user')!;
  const raw = c.req.query('state') ?? 'queue';
  if (!(QUEUE_FILTERS as readonly string[]).includes(raw)) throw badRequest('Unknown state filter', 'STATE_FILTER_INVALID');
  let sql = `SELECT ${LIST_COLUMNS} FROM merchant_applications`;
  const binds: unknown[] = [];
  if (raw === 'queue') {
    // What waits on a reviewer: submitted and in review, oldest first.
    sql += ` WHERE state IN ('submitted','in_review') ORDER BY COALESCE(submitted_at, created_at) ASC LIMIT 200`;
  } else if (raw === 'all') {
    sql += ` WHERE state <> 'draft' ORDER BY updated_at DESC LIMIT 200`;
  } else {
    sql += ` WHERE state = ? ORDER BY updated_at DESC LIMIT 200`;
    binds.push(raw);
  }
  let rows: ListRow[];
  try {
    rows = (await c.env.DB.prepare(sql).bind(...binds).all<ListRow>()).results ?? [];
  } catch (e) {
    if (!isMissingSchema(e)) throw e;
    return c.json({ success: true, available: false, applications: [] });
  }
  return c.json({ success: true, available: true, applications: rows.map((r) => listView(r, reviewer.id)) });
});

// ------------------------------------------------- the owner's grants (C5)

/**
 * Registered BEFORE `/:id`, so «reviewers» is never read as an application id
 * (it would be refused as one anyway: ids are `mapp_…`).
 *
 * OWNER ONLY (`requireOwner`: the verified owner; an unverified owner row
 * hears OWNER_EMAIL_UNVERIFIED). The model of `userPatchRefusal`
 * (adminScope.ts): widening an admin's access is the owner's act alone, and
 * issuing one needs a fresh sign-in — a stolen cookie must not be able to
 * open personal review data to a second account.
 */
adminMerchantApplicationRoutes.get('/reviewers', requireOwner, async (c) => {
  const owner = c.get('user')!;
  let rows: Array<{ id: string; username: string | null; name: string | null; admin_scope: string | null; email: string; granted_at: string | null }>;
  try {
    rows =
      (
        await c.env.DB.prepare(
          `SELECT u.id, u.username, u.name, u.admin_scope, u.email, g.granted_at
             FROM users u
             LEFT JOIN admin_capability_grants g
               ON g.user_id = u.id AND g.grant_key = ? AND g.revoked_at IS NULL
            WHERE u.role = 'admin'
            ORDER BY u.username`
        )
          .bind(MERCHANT_REVIEW_GRANT)
          .all<{ id: string; username: string | null; name: string | null; admin_scope: string | null; email: string; granted_at: string | null }>()
      ).results ?? [];
  } catch (e) {
    if (!isMissingSchema(e)) throw e;
    return c.json({ success: true, available: false, reviewers: [] });
  }
  return c.json({
    success: true,
    available: true,
    // The address is used to recognise the owner and then dropped: no email in the answer.
    reviewers: rows
      .filter((r) => r.id !== owner.id && !isOwner(c.env, r))
      .map((r) => {
        const assistant = normalizeAdminScope(r.admin_scope) === 'assistant';
        return {
          id: r.id,
          username: r.username,
          name: r.name,
          scope: assistant ? 'assistant' : 'full',
          // A full admin reviews by default (C5); only an assistant's access is a grant.
          by_default: !assistant,
          granted: assistant && !!r.granted_at,
          granted_at: assistant ? r.granted_at : null,
        };
      }),
  });
});

interface GrantTarget {
  id: string;
  role: string;
  email: string;
  admin_scope: string | null;
}

const grantTargetInvalid = () =>
  badRequest(
    'يُمنح هذا الإذن لمساعد إداري فقط / This access is granted to an assistant admin only',
    'CAPABILITY_GRANT_TARGET_INVALID'
  );

async function grantTarget(c: Context<AppContext>): Promise<GrantTarget> {
  const userId = c.req.param('userId') ?? '';
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(userId)) throw notFound('User not found');
  const target = await c.env.DB.prepare('SELECT id, role, email, admin_scope FROM users WHERE id = ?')
    .bind(userId)
    .first<GrantTarget>();
  if (!target) throw notFound('User not found');
  return target;
}

function shortText(v: unknown, max: number): string {
  return typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '';
}

adminMerchantApplicationRoutes.post('/reviewers/:userId/grant', requireOwner, async (c) => {
  requireFreshSession(c);
  const owner = c.get('user')!;
  const target = await grantTarget(c);
  if (target.id === owner.id || isOwner(c.env, target) || target.role !== 'admin') throw grantTargetInvalid();
  if (normalizeAdminScope(target.admin_scope) !== 'assistant') {
    throw badRequest(
      'المدير الكامل يراجع طلبات التجار دون إذن إضافي / A full admin reviews merchant applications without an extra grant',
      'CAPABILITY_GRANT_NOT_NEEDED'
    );
  }
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const sentOperation = body?.operation_id;
  const operationId = validClientOperationId(sentOperation) ? sentOperation : `srv:${newId()}`;
  const reason = shortText(body?.reason, 300);
  const db = c.env.DB;
  const id = newId('acg');
  const now = new Date().toISOString();
  const { statements: auditRows } = await auditStatements(db, owner.id, 'admin.capability_grant.issued', target.id, {
    grant_key: MERCHANT_REVIEW_GRANT,
    operation_id: operationId,
  });
  try {
    await guarded(() =>
      db.batch([
        db
          .prepare(
            `INSERT INTO admin_capability_grants (id, user_id, grant_key, granted_by, granted_at, reason, operation_id)
             VALUES (?, ?, ?, ?, ?, ?, ?)`
          )
          .bind(id, target.id, MERCHANT_REVIEW_GRANT, owner.id, now, reason, operationId),
        ...auditRows,
      ])
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // Already granted (the live-grant index), or this very request replayed: the state is what was asked.
    if (!/UNIQUE constraint failed: admin_capability_grants\./.test(msg)) throw e;
    return c.json({ success: true, granted: true, already: true });
  }
  return c.json({ success: true, granted: true, already: false });
});

adminMerchantApplicationRoutes.post('/reviewers/:userId/revoke', requireOwner, async (c) => {
  const owner = c.get('user')!;
  const target = await grantTarget(c);
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const reason = shortText(body?.reason, 300);
  const db = c.env.DB;
  const now = new Date().toISOString();
  const { statements: auditRows } = await auditStatements(db, owner.id, 'admin.capability_grant.revoked', target.id, {
    grant_key: MERCHANT_REVIEW_GRANT,
  });
  const res = await guarded(() =>
    db.batch([
      db
        .prepare(
          `UPDATE admin_capability_grants SET revoked_at = ?, revoked_by = ?, revoke_reason = ?
            WHERE user_id = ? AND grant_key = ? AND revoked_at IS NULL`
        )
        .bind(now, owner.id, reason, target.id, MERCHANT_REVIEW_GRANT),
      ...auditRows,
    ])
  );
  const changed = Number(res[0]?.meta?.changes ?? 0);
  return c.json({ success: true, granted: false, already: changed === 0 });
});

// ------------------------------------------------------------------ detail

interface DetailRow extends ListRow {
  legal_name_enc: string;
  dob_enc: string;
  social_link_enc: string;
  photo_key: string | null;
  activity_description: string;
  reason_public: string;
  note_internal: string;
  decided_by: string | null;
  decided_revision: number | null;
  retention_until: string | null;
}

async function provenIdentity(db: D1Database, userId: string): Promise<boolean> {
  try {
    const row = await db
      .prepare("SELECT 1 AS x FROM kyc_cases WHERE user_id = ? AND case_type = 'identity' AND state = 'verified' LIMIT 1")
      .bind(userId)
      .first();
    return !!row;
  } catch (e) {
    if (isMissingSchema(e)) return false;
    throw e;
  }
}

async function phoneVerified(db: D1Database, userId: string): Promise<boolean> {
  const row = await db
    .prepare('SELECT 1 AS x FROM telegram_links WHERE user_id = ? AND revoked_at IS NULL LIMIT 1')
    .bind(userId)
    .first();
  return !!row;
}

/** Each sealed value, opened once; null when absent, purged or unreadable — never a fake value. */
async function opened(secret: string | undefined, sealed: string): Promise<string | null> {
  if (!sealed) return null;
  try {
    return await unseal(secret, sealed);
  } catch {
    return null;
  }
}

adminMerchantApplicationRoutes.get('/:id', async (c) => {
  await requireReviewer(c);
  await rateLimit(c, 'merchant-review-view', 300, 3600);
  const reviewer = c.get('user')!;
  const id = applicationIdParam(c);
  const db = c.env.DB;
  const row = await guarded(() =>
    db
      .prepare(
        `SELECT ${LIST_COLUMNS}, legal_name_enc, dob_enc, social_link_enc, photo_key, activity_description,
                reason_public, note_internal, decided_by, decided_revision, retention_until
           FROM merchant_applications WHERE id = ?`
      )
      .bind(id)
      .first<DetailRow>()
  );
  // A draft was never sent: nothing of it is opened, not even its existence.
  if (!row || row.state === 'draft') throw notFound('Application not found');
  // A reviewer reading their OWN application is its applicant here: no staff note.
  const own = row.user_id === reviewer.id;

  // NO AUDIT, NO DETAIL: the view is recorded before a single value is opened,
  // and a failed audit write fails the request.
  const { statements: auditRows } = await auditStatements(db, reviewer.id, 'merchant_application.view', id, {
    state: row.state,
    revision: Number(row.revision),
  });
  await db.batch(auditRows);

  const secret = c.env.KYC_ENC_KEY;
  const [nameJson, dob, socialLink, applicant, proIdentity, phone, events] = await Promise.all([
    opened(secret, row.legal_name_enc),
    opened(secret, row.dob_enc),
    opened(secret, row.social_link_enc),
    db.prepare('SELECT id, username FROM users WHERE id = ?').bind(row.user_id).first<{ id: string; username: string | null }>(),
    provenIdentity(db, row.user_id),
    phoneVerified(db, row.user_id),
    db
      .prepare(
        `SELECT revision, actor_kind, action, reason_public, at FROM merchant_application_events
          WHERE application_id = ? ORDER BY at, rowid`
      )
      .bind(id)
      .all<{ revision: number; actor_kind: string; action: string; reason_public: string; at: string }>(),
  ]);
  const legalName = nameJson ? safeParse<LegalName | null>(nameJson, null) : null;
  const sealedPresent = !!(row.legal_name_enc || row.dob_enc || row.social_link_enc);
  const readable = !(row.legal_name_enc && !legalName) && !(row.dob_enc && !dob) && !(row.social_link_enc && !socialLink);

  return c.json({
    success: true,
    application: {
      ...listView(row, reviewer.id),
      decided_revision: row.decided_revision,
      reason_public: row.reason_public,
      // Staff only. The applicant's routes never select this column, and an
      // admin who applied never reads it on their own application either.
      note_internal: own ? '' : row.note_internal,
      retention_until: row.retention_until,
      review: { governorate: row.governorate, activity_kind: row.activity_kind, activity_description: row.activity_description },
      private: {
        legal_name: legalName,
        dob,
        age: dob ? ageOn(dob, baghdadToday()) : null,
        social_link: socialLink,
        has_photo: !!row.photo_key,
        // Honest: a value that exists but could not be opened is said to be unreadable.
        readable: !sealedPresent || readable,
      },
      applicant: { id: row.user_id, username: applicant?.username ?? null },
      // Computed facts, never the KYC values behind them (gap §3.1).
      checks: { pro_identity_verified: proIdentity, phone_verified: phone },
      events: (events.results ?? []).map((e) => ({
        revision: Number(e.revision),
        actor_kind: e.actor_kind,
        action: e.action,
        reason_public: e.reason_public,
        at: e.at,
      })),
    },
  });
});

/**
 * THE REVIEW PHOTO. Served only here: a reviewer, a per-view audit row
 * written before the object is read, `no-store`, sandboxed. The key must live
 * under this application's own prefix — a row cannot point the stream at any
 * other private object.
 */
adminMerchantApplicationRoutes.get('/:id/photo', async (c) => {
  await requireReviewer(c);
  await rateLimit(c, 'merchant-review-view', 300, 3600);
  const reviewer = c.get('user')!;
  const id = applicationIdParam(c);
  const db = c.env.DB;
  const row = await guarded(() =>
    db.prepare('SELECT state, photo_key FROM merchant_applications WHERE id = ?').bind(id).first<{ state: string; photo_key: string | null }>()
  );
  if (!row || row.state === 'draft') throw notFound('Application not found');
  const key = row.photo_key ?? '';
  if (!key || !key.startsWith(`merchant-review/${id}/`)) throw notFound('No photo');

  const { statements: auditRows } = await auditStatements(db, reviewer.id, 'merchant_application.photo_view', id);
  await db.batch(auditRows);

  const obj = await getMediaObject(c.env, 'private', key);
  if (!obj) throw notFound('The photo is missing from storage');
  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set('Cache-Control', 'no-store');
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Content-Security-Policy', "default-src 'none'; sandbox");
  headers.set('Referrer-Policy', 'no-referrer');
  return new Response(obj.body, { headers });
});

// --------------------------------------------------------------- decisions

const DECISIONS: ReadonlyArray<{ path: string; action: ApplicationAction; reasonRequired: boolean }> = [
  { path: '/:id/start-review', action: 'start_review', reasonRequired: false },
  { path: '/:id/request-changes', action: 'request_changes', reasonRequired: true },
  { path: '/:id/approve', action: 'approve', reasonRequired: false },
  { path: '/:id/reject', action: 'reject', reasonRequired: true },
];

const revisionRequired = () =>
  badRequest(
    'أرسل رقم المراجعة التي تقرّر عليها / Send the revision you are deciding on',
    'APPLICATION_REVISION_REQUIRED'
  );

const reasonRequired = () =>
  badRequest(
    'اكتب سببًا يقرؤه مقدّم الطلب (5 أحرف على الأقل) / Write a reason the applicant will read (at least 5 characters)',
    'DECISION_REASON_REQUIRED'
  );

for (const d of DECISIONS) {
  adminMerchantApplicationRoutes.post(d.path, async (c) => {
    await requireReviewer(c);
    await rateLimit(c, 'merchant-review-decide', 120, 3600);
    const reviewer = c.get('user')!;
    const id = applicationIdParam(c);
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const revision = body?.revision;
    if (typeof revision !== 'number' || !Number.isInteger(revision) || revision < 1) throw revisionRequired();
    const operationId = body?.operation_id;
    // A client id never takes a server namespace (`srv:`, `create:`, `purge:`).
    if (!validClientOperationId(operationId)) throw transitionRefusal('OPERATION_ID_INVALID');
    const reasonPublic = typeof body?.reason_public === 'string' ? body.reason_public.trim() : '';
    const noteInternal = typeof body?.note_internal === 'string' ? body.note_internal.trim() : '';
    if (d.action === 'start_review' && (reasonPublic || noteInternal)) {
      throw badRequest('Starting a review carries no reason', 'APPLICATION_FIELD_INVALID', { field: 'reason_public' });
    }
    if (d.reasonRequired && reasonPublic.length < 5) throw reasonRequired();
    if (reasonPublic.length > 1000) throw badRequest('The public reason is at most 1000 characters', 'APPLICATION_FIELD_INVALID', { field: 'reason_public' });
    if (noteInternal.length > 2000) throw badRequest('The internal note is at most 2000 characters', 'APPLICATION_FIELD_INVALID', { field: 'note_internal' });

    const db = c.env.DB;
    const current = await guarded(() =>
      db
        .prepare('SELECT id, user_id, state, revision FROM merchant_applications WHERE id = ?')
        .bind(id)
        .first<{ id: string; user_id: string; state: string; revision: number }>()
    );
    if (!current) throw notFound('Application not found');

    // The revision the REVIEWER saw, not the one stored now: a reviewer whose
    // screen is behind (the applicant edited, another reviewer moved it) loses
    // the conditional UPDATE and hears APPLICATION_CHANGED.
    const out = await guarded(() =>
      applyTransition(db, {
        application: { id: current.id, user_id: current.user_id, state: current.state, revision },
        action: d.action,
        actor: { id: reviewer.id, kind: 'reviewer' },
        operationId,
        reasonPublic: d.action === 'start_review' ? undefined : reasonPublic,
        noteInternal: d.action === 'start_review' ? undefined : noteInternal,
      })
    );
    if (!out.ok) throw transitionRefusal(out.code);
    if (!out.replay) {
      // «توثيق التجار»: ids, revision and the action only (gap §3.7).
      const event = d.action === 'start_review' ? 'review_started' : d.action === 'request_changes' ? 'changes_requested' : d.action === 'approve' ? 'approved' : 'rejected';
      announceAfterResponse(c, 'merchant_verification', reviewerNoticeText(id, out.revision, event));
    }
    const after = await db.prepare(`SELECT ${LIST_COLUMNS} FROM merchant_applications WHERE id = ?`).bind(id).first<ListRow>();
    return c.json({ success: true, replay: out.replay, application: listView(after!, reviewer.id) });
  });
}
