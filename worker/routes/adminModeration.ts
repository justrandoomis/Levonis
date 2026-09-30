/**
 * THE MODERATION DESK AND THE APPEAL DOOR — Moderation V2 (0162;
 * docs/COMMUNITY_ECOSYSTEM.md §9.6 «Routes»).
 *
 * Two routers, mounted on prefixes worker/index.ts already serves (so the
 * gateway's routing table needs no new row):
 *
 *   adminModerationRoutes  at /api/admin — every path under /moderation,
 *                          behind `requireAdmin` (which carries the apex-only
 *                          host rule) and the `/api/admin/*` host guard;
 *   moderationRoutes       at /api       — /moderation/status and
 *                          /moderation/appeals, the person's own standing and
 *                          appeals, behind `requireAuth` and nothing else: a
 *                          banned account keeps this door (worker/lib/
 *                          userStatus.ts `bannedMayWrite`), and so does an
 *                          account while the community is closed — an appeal
 *                          is about the account, not about the community.
 *
 * THE DESK'S RULES, in the order a reader meets them:
 *
 *   · EVERY DECISION IS THREE ROWS: the change itself, a `moderation_actions`
 *     row (the history the desk and the appeal read) and an `audit_log` row
 *     naming it (`detail.action_id`) — exactly once each. The change and the
 *     action land in ONE batch, the action guarded on the change having
 *     happened (`EXISTS` over the new state and this request's own
 *     timestamp), so a double click or two staff at the same instant record
 *     one decision, and the audit row is written only for an action that
 *     landed. A decision that changes nothing is a replay, not a second row.
 *   · THE PERSON IS TOLD, with the reason and the appeal door
 *     (`moderation_action`, one notice per decision, `moderation:<id>`), in
 *     Arabic, English and Sorani (`meta.title_ckb` / `meta.body_ckb`).
 *   · THE LADDER: warn → restrict → suspend → ban, and `restore` back to
 *     active. A decision LIGHTER than the one in force is refused with 409
 *     MODERATION_LADDER — lowering a sanction is a `restore` first, so it is a
 *     deliberate act with its own row. A restriction or a suspension may end
 *     on `until`, read at request time; a ban ends only by `restore`.
 *   · A BAN ALSO SUSPENDS THE PERSON'S STORE, through the same steps
 *     `POST /api/admin/community/stores/:id/status` takes (the store row, the
 *     `admin.store_status` audit, the merchant's notice, the storefront
 *     purge) plus its own action row. Lifting the ban does NOT reopen the
 *     store: two sanctions are two decisions (worker/routes/adminCommunity.ts
 *     «suspending is not deleting»); the answer names the store's state so
 *     the desk can reopen it deliberately.
 *   · Staff accounts are not moderated here (MODERATION_STAFF_TARGET): a
 *     banned admin would lock the desk out of itself.
 *   · A hide or its lifting drops the guest caches the post appears in
 *     (`afterPostModeration`, worker/routes/communityPosts.ts).
 *
 * THE APPEAL: one per decision per person (the table's UNIQUE), on a decision
 * that concerns them (`subject_user_id`), body ≤ 1000. Accepted → the
 * decision is undone when it is still the one in force (a hide lifted, a
 * standing restored — never over a newer decision), with its own `restore`
 * row; rejected → the decision stands. Either way the person is told.
 *
 * Refusals are codes the client words (src/lib/refusalStrings.ts):
 * MODERATION_LADDER, MODERATION_TARGET_NOT_FOUND, MODERATION_UNTIL_INVALID,
 * MODERATION_STAFF_TARGET, APPEAL_EXISTS, APPEAL_NOT_FOUND, APPEAL_DECIDED.
 */
import { Hono } from 'hono';
import type { Context } from 'hono';
import type { AppContext } from '../lib/types';
import { safeParse } from '../lib/types';
import { HttpError, badRequest, conflict, requireAdmin, requireAuth, int, jsonObject, pickFrom, str } from '../lib/http';
import { newId } from '../lib/crypto';
import { rateLimit } from '../lib/ratelimit';
import { audit } from '../lib/audit';
import { notify } from '../lib/notifications';
import { feedCursor } from '../lib/feedCursor';
import { rootDomainFrom } from '../lib/hosts';
import { afterStorefrontWrite } from '../lib/edgePolicy';
import { notifyStoreStatusChanged } from '../lib/merchantNotify';
import { announceAfterResponse } from '../lib/adminTopicRouting';
import { revokePostViewerGrantsStatement } from '../lib/viewerGrants';
import { STATUS_LEVEL, effectiveStatus, type UserStatus } from '../lib/userStatus';
import { POST_COLUMNS, POST_FROM, afterPostModeration, postCard, postHref } from './communityPosts';

export const adminModerationRoutes = new Hono<AppContext>();
adminModerationRoutes.use('/moderation/*', requireAdmin);

export const moderationRoutes = new Hono<AppContext>();
moderationRoutes.use('/moderation/*', requireAuth);

// ------------------------------------------------------------------ shapes

export const MODERATION_TARGETS = ['post', 'comment', 'request_comment', 'user', 'store', 'product', 'request', 'review'] as const;
export type ModerationTarget = (typeof MODERATION_TARGETS)[number];
export const MODERATION_ACTIONS = ['hide', 'remove', 'warn', 'restrict', 'suspend', 'ban', 'restore'] as const;
export type ModerationAction = (typeof MODERATION_ACTIONS)[number];

/** The ladder the account door takes, in order; `restore` is the way down. */
export const LADDER_STEPS = ['warn', 'restrict', 'suspend', 'ban', 'restore'] as const;
export type LadderStep = (typeof LADDER_STEPS)[number];

/** The step each word names — the steps themselves, and the statuses they lead to. */
const STEP_WORDS: Record<string, LadderStep> = {
  warn: 'warn',
  restrict: 'restrict',
  restricted: 'restrict',
  suspend: 'suspend',
  suspended: 'suspend',
  ban: 'ban',
  banned: 'ban',
  restore: 'restore',
  active: 'restore',
};
const STATUS_OF_STEP: Record<Exclude<LadderStep, 'warn'>, UserStatus> = {
  restrict: 'restricted',
  suspend: 'suspended',
  ban: 'banned',
  restore: 'active',
};

export const REPORT_STATES = ['open', 'reviewed', 'actioned', 'dismissed'] as const;
/** What a report really names — 0154's target types plus 0160's side-table kinds. */
export const REPORT_KINDS = ['post', 'comment', 'request_comment', 'order_update', 'user', 'store', 'product', 'request'] as const;
export const APPEAL_STATES = ['open', 'accepted', 'rejected'] as const;

/** The decisions a person may appeal, on the things a person may appeal about. */
const APPEALABLE_ACTIONS: readonly string[] = ['hide', 'remove', 'warn', 'restrict', 'suspend', 'ban'];
const APPEALABLE_TARGETS: readonly string[] = ['post', 'comment', 'request_comment', 'user'];

const REASON_MAX = 500;
export const APPEAL_BODY_MAX = 1000;
/** The furthest a restriction or a suspension may be set — past this it is a ban, and should say so. */
const UNTIL_MAX_MS = 5 * 365 * 86_400_000;

const nowIso = () => new Date().toISOString();
const idParam = (c: Context<AppContext>, name = 'id') => str(c.req.param(name), name, { min: 1, max: 64 });
const fileUrl = (key: unknown) => (typeof key === 'string' && key ? `/files/${key}` : null);

/** Where a person contests a decision — the notice's link (the client wave's page). */
export const appealDoor = (actionId?: string) => (actionId ? `/moderation?action=${encodeURIComponent(actionId)}` : '/moderation');

const targetMissing = (what: string) => new HttpError(404, `${what} not found`, 'MODERATION_TARGET_NOT_FOUND');

// Literal call sites (bucket, limit, window) — the gateway's parity suite reads
// them as text (services/gateway/test/rateLimitParity.test.ts).
const limitDesk = (c: Context<AppContext>) => rateLimit(c, 'moderation-desk', 300, 60);
const limitAppeal = (c: Context<AppContext>) => rateLimit(c, 'moderation-appeal', 10, 3600);

// ------------------------------------------------------------ the notices

interface Words {
  ar: string;
  en: string;
  ckb: string;
}

const day = (iso: string | null | undefined) => (iso ? iso.slice(0, 10) : '');

/** The reason line, the end date when there is one, and — for a decision that can be contested — the appeal line. */
function noticeBody(reason: string, until: string | null, appealable: boolean): Words {
  const r = reason.trim();
  const d = day(until);
  const lines: Words = { ar: '', en: '', ckb: '' };
  if (r) {
    lines.ar = `السبب: ${r}`;
    lines.en = `Reason: ${r}`;
    lines.ckb = `هۆکار: ${r}`;
  }
  if (d) {
    lines.ar += `${lines.ar ? ' — ' : ''}حتى ${d}`;
    lines.en += `${lines.en ? ' — ' : ''}until ${d}`;
    lines.ckb += `${lines.ckb ? ' — ' : ''}تا ${d}`;
  }
  if (appealable) {
    lines.ar += `${lines.ar ? '\n' : ''}إن رأيت أن القرار خاطئ فاعترض عليه من هنا.`;
    lines.en += `${lines.en ? '\n' : ''}If you think this is a mistake, appeal it from here.`;
    lines.ckb += `${lines.ckb ? '\n' : ''}ئەگەر پێتوایە بڕیارەکە هەڵەیە، لێرەوە ناڕەزایی لەسەری دەرببڕە.`;
  }
  return lines;
}

const quoteAr = (s: string) => `«${s}»`;
const quoteEn = (s: string) => `“${s}”`;

/** The title of a decision's notice, by what was decided about what. */
function noticeTitle(action: ModerationAction, targetType: ModerationTarget, label: string): Words {
  const t = label.trim().slice(0, 80);
  if (targetType === 'post') {
    return action === 'restore'
      ? { ar: `أعادت Levonis إظهار مشروعك ${quoteAr(t)}`, en: `Levonis restored your project ${quoteEn(t)}`, ckb: `Levonis پڕۆژەکەتی ${quoteAr(t)} گەڕاندەوە` }
      : { ar: `أخفت Levonis مشروعك ${quoteAr(t)}`, en: `Levonis hid your project ${quoteEn(t)}`, ckb: `Levonis پڕۆژەکەتی ${quoteAr(t)} شاردەوە` };
  }
  if (targetType === 'comment' || targetType === 'request_comment') {
    return action === 'restore'
      ? { ar: 'أعادت Levonis إظهار تعليقك', en: 'Levonis restored your comment', ckb: 'Levonis کۆمێنتەکەتی گەڕاندەوە' }
      : { ar: 'أخفت Levonis تعليقك', en: 'Levonis hid your comment', ckb: 'Levonis کۆمێنتەکەتی شاردەوە' };
  }
  switch (action) {
    case 'warn':
      return { ar: 'تنبيه من إدارة Levonis', en: 'A warning from Levonis moderation', ckb: 'ئاگادارکردنەوەیەک لە بەڕێوەبردنی Levonis' };
    case 'restrict':
      return { ar: 'قُيِّد حسابك', en: 'Your account is restricted', ckb: 'هەژمارەکەت سنووردار کرا' };
    case 'suspend':
      return { ar: 'عُلِّق حسابك', en: 'Your account is suspended', ckb: 'هەژمارەکەت ڕاگیرا' };
    case 'ban':
      return { ar: 'حُظر حسابك', en: 'Your account is banned', ckb: 'هەژمارەکەت قەدەغە کرا' };
    case 'restore':
      return { ar: 'عاد حسابك إلى وضعه الطبيعي', en: 'Your account is back to normal', ckb: 'هەژمارەکەت گەڕایەوە دۆخی ئاسایی' };
    default:
      return { ar: 'قرار من إدارة Levonis', en: 'A decision from Levonis moderation', ckb: 'بڕیارێک لە بەڕێوەبردنی Levonis' };
  }
}

/** Tell the person a decision concerns. Never throws (`notify`), one row per decision. */
async function tellSubject(
  c: Context<AppContext>,
  p: { userId: string | null; actionId: string; action: ModerationAction; targetType: ModerationTarget; targetId: string; label: string; reason: string; until: string | null }
): Promise<void> {
  if (!p.userId) return;
  const appealable = APPEALABLE_ACTIONS.includes(p.action) && APPEALABLE_TARGETS.includes(p.targetType);
  const title = noticeTitle(p.action, p.targetType, p.label);
  const body = noticeBody(p.reason, p.until, appealable);
  const link = appealable ? appealDoor(p.actionId) : p.targetType === 'post' ? postHref(p.targetId) : appealDoor();
  await notify(c.env.DB, {
    userId: p.userId,
    kind: 'moderation_action',
    title_ar: title.ar,
    title_en: title.en,
    body_ar: body.ar,
    body_en: body.en,
    link,
    entity_type: 'moderation_action',
    entity_id: p.actionId,
    meta: { action: p.action, target_type: p.targetType, target_id: p.targetId, until: p.until, title_ckb: title.ckb, body_ckb: body.ckb },
    eventKey: `moderation:${p.actionId}`,
  });
}

// ------------------------------------------------------------ the writes

interface ActionRow {
  id: string;
  actorId: string | null;
  subjectUserId: string | null;
  targetType: ModerationTarget;
  targetId: string;
  action: ModerationAction;
  reason: string;
  until: string | null;
  reportId: string | null;
  at: string;
}

/**
 * The action's INSERT, guarded: it lands only when `guard` (a `SELECT 1 …`
 * whose placeholders start at ?11) finds the change it records — so a decision
 * that lost a race, or changed nothing, leaves no row. No guard: it lands.
 */
function actionStatement(db: D1Database, a: ActionRow, guard: { sql: string; binds: unknown[] } | null): D1PreparedStatement {
  const cols = `(id, actor_id, subject_user_id, target_type, target_id, action, reason, until, report_id, created_at)`;
  const vals = [a.id, a.actorId, a.subjectUserId, a.targetType, a.targetId, a.action, a.reason, a.until, a.reportId, a.at];
  if (!guard) {
    return db.prepare(`INSERT INTO moderation_actions ${cols} VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)`).bind(...vals);
  }
  return db
    .prepare(`INSERT INTO moderation_actions ${cols} SELECT ?1,?2,?3,?4,?5,?6,?7,?8,?9,?10 WHERE EXISTS (${guard.sql})`)
    .bind(...vals, ...guard.binds);
}

/** The report a decision answers, marked `actioned` in the same batch — only if the action landed. */
function reportActionedStatement(db: D1Database, reportId: string, actorId: string, actionId: string, resolution: string, at: string): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE community_reports SET state = 'actioned', reviewed_by = ?1, reviewed_at = ?2, resolution = ?3
        WHERE id = ?4 AND state IN ('open','reviewed') AND EXISTS (SELECT 1 FROM moderation_actions WHERE id = ?5)`
    )
    .bind(actorId, at, resolution.slice(0, REASON_MAX), reportId, actionId);
}

/** A `report_id` in a decision's body: a report that exists, or a refusal; absent is fine. */
async function reportFrom(c: Context<AppContext>, raw: unknown): Promise<string | null> {
  if (raw === undefined || raw === null || raw === '') return null;
  const id = str(raw, 'report_id', { min: 1, max: 64 });
  const row = await c.env.DB.prepare('SELECT id FROM community_reports WHERE id = ?').bind(id).first<{ id: string }>();
  if (!row) throw targetMissing('Report');
  return row.id;
}

/** A restriction's or a suspension's end: a real instant in the future, stored as ISO with a `Z`, or none. */
function readUntil(raw: unknown): string | null {
  if (raw === undefined || raw === null || raw === '') return null;
  const at = typeof raw === 'number' ? raw : typeof raw === 'string' ? Date.parse(raw) : Number.NaN;
  const now = Date.now();
  if (!Number.isFinite(at) || at <= now || at > now + UNTIL_MAX_MS) {
    throw new HttpError(400, 'until must be a date in the future (at most five years ahead)', 'MODERATION_UNTIL_INVALID');
  }
  return new Date(at).toISOString();
}

const readReason = (raw: unknown, required: boolean) =>
  required ? str(raw, 'reason', { min: 3, max: REASON_MAX }) : str(raw, 'reason', { min: 0, max: REASON_MAX, required: false });

const landed = (res: D1Result | undefined) => Number(res?.meta?.changes ?? 0) > 0;

// ------------------------------------------------------------ posts

/**
 * HIDE A PROJECT — or lift the hide. `community_posts.admin_hidden_at/_reason`
 * (0153): every read-side rule already honours it (the lists' POST_PUBLIC_SQL,
 * `mayRead` — a 404 to everybody but the author, who is shown the reason, and
 * staff), the author cannot re-publish over it, and its viewer links close
 * with it. A reason is required to hide: it is what the author is shown.
 */
adminModerationRoutes.post('/moderation/posts/:id/hide', async (c) => {
  await limitDesk(c);
  const admin = c.get('user')!;
  const id = idParam(c);
  const body = await jsonObject(c);
  const hidden = body.hidden !== false;
  const reason = readReason(body.reason, hidden);
  const reportId = await reportFrom(c, body.report_id);
  const db = c.env.DB;
  const p = await db
    .prepare('SELECT id, author_id, title, admin_hidden_at FROM community_posts WHERE id = ?')
    .bind(id)
    .first<{ id: string; author_id: string; title: string; admin_hidden_at: string | null }>();
  if (!p) throw targetMissing('Project');
  if (hidden === !!p.admin_hidden_at) return c.json({ success: true, replayed: true, hidden });

  const ts = nowIso();
  const actionId = newId('mod');
  const action: ModerationAction = hidden ? 'hide' : 'restore';
  const stmts: D1PreparedStatement[] = [
    hidden
      ? db
          .prepare('UPDATE community_posts SET admin_hidden_at = ?1, admin_hidden_reason = ?2, updated_at = ?1 WHERE id = ?3 AND admin_hidden_at IS NULL')
          .bind(ts, reason, id)
      : db
          .prepare("UPDATE community_posts SET admin_hidden_at = NULL, admin_hidden_reason = '', updated_at = ?1 WHERE id = ?2 AND admin_hidden_at IS NOT NULL")
          .bind(ts, id),
    actionStatement(
      db,
      { id: actionId, actorId: admin.id, subjectUserId: p.author_id, targetType: 'post', targetId: id, action, reason, until: null, reportId, at: ts },
      hidden
        ? { sql: 'SELECT 1 FROM community_posts WHERE id = ?11 AND admin_hidden_at = ?12', binds: [id, ts] }
        : { sql: 'SELECT 1 FROM community_posts WHERE id = ?11 AND admin_hidden_at IS NULL AND updated_at = ?12', binds: [id, ts] }
    ),
    // Its viewer links stop with it (§9.4: tokens revoked when the source hides).
    ...(hidden ? [revokePostViewerGrantsStatement(db, [id], ts)] : []),
    ...(reportId ? [reportActionedStatement(db, reportId, admin.id, actionId, reason, ts)] : []),
  ];
  const res = await db.batch(stmts);
  if (!landed(res[1])) return c.json({ success: true, replayed: true, hidden });

  await audit(db, admin.id, hidden ? 'admin.moderation.post_hidden' : 'admin.moderation.post_restored', id, {
    action_id: actionId,
    reason,
    author: p.author_id,
    report_id: reportId,
  });
  await tellSubject(c, { userId: p.author_id, actionId, action, targetType: 'post', targetId: id, label: p.title, reason, until: null });
  await afterPostModeration(c, [id]);
  return c.json({ success: true, hidden, action_id: actionId });
});

// ------------------------------------------------------------ comments

/**
 * HIDE A COMMENT under a project — `state = 'hidden'` with the reason (0154);
 * the post's counter follows through 0154's trigger. Lifting it puts it back
 * as it was. A comment its author removed has nothing left to hide.
 */
adminModerationRoutes.post('/moderation/comments/:id/hide', async (c) => {
  await limitDesk(c);
  const admin = c.get('user')!;
  const id = idParam(c);
  const body = await jsonObject(c);
  const hidden = body.hidden !== false;
  const reason = readReason(body.reason, hidden);
  const reportId = await reportFrom(c, body.report_id);
  const db = c.env.DB;
  const cm = await db
    .prepare('SELECT id, post_id, author_id, body, state FROM community_comments WHERE id = ?')
    .bind(id)
    .first<{ id: string; post_id: string; author_id: string; body: string; state: string }>();
  if (!cm) throw targetMissing('Comment');
  if ((hidden && cm.state !== 'visible') || (!hidden && cm.state !== 'hidden')) return c.json({ success: true, replayed: true, hidden: cm.state === 'hidden' });

  const ts = nowIso();
  const actionId = newId('mod');
  const action: ModerationAction = hidden ? 'hide' : 'restore';
  const res = await db.batch([
    db
      .prepare('UPDATE community_comments SET state = ?1, admin_hidden_reason = ?2, updated_at = ?3 WHERE id = ?4 AND state = ?5')
      .bind(hidden ? 'hidden' : 'visible', hidden ? reason : '', ts, id, hidden ? 'visible' : 'hidden'),
    actionStatement(
      db,
      { id: actionId, actorId: admin.id, subjectUserId: cm.author_id, targetType: 'comment', targetId: id, action, reason, until: null, reportId, at: ts },
      { sql: 'SELECT 1 FROM community_comments WHERE id = ?11 AND state = ?12 AND updated_at = ?13', binds: [id, hidden ? 'hidden' : 'visible', ts] }
    ),
    ...(reportId ? [reportActionedStatement(db, reportId, admin.id, actionId, reason, ts)] : []),
  ]);
  if (!landed(res[1])) return c.json({ success: true, replayed: true, hidden });

  await audit(db, admin.id, hidden ? 'admin.moderation.comment_hidden' : 'admin.moderation.comment_restored', id, {
    action_id: actionId,
    reason,
    post_id: cm.post_id,
    author: cm.author_id,
    report_id: reportId,
  });
  await tellSubject(c, { userId: cm.author_id, actionId, action, targetType: 'comment', targetId: id, label: '', reason, until: null });
  // The post's comment counter moved with it; the trending rail carries it.
  await afterPostModeration(c, [cm.post_id]);
  return c.json({ success: true, hidden, action_id: actionId });
});

/**
 * HIDE A COMMENT UNDER A REQUEST (0160 `community_request_comments`) — the
 * discussion's own rule: a hidden row reaches staff only. Reports of these
 * reach the queue through `community_report_targets` (kind request_comment).
 * The server's own `system_update` rows are not a person's words and are not
 * moderated here.
 */
adminModerationRoutes.post('/moderation/request-comments/:id/hide', async (c) => {
  await limitDesk(c);
  const admin = c.get('user')!;
  const id = idParam(c);
  const body = await jsonObject(c);
  const hidden = body.hidden !== false;
  const reason = readReason(body.reason, hidden);
  const reportId = await reportFrom(c, body.report_id);
  const db = c.env.DB;
  const rc = await db
    .prepare("SELECT id, request_id, author_id, state FROM community_request_comments WHERE id = ? AND kind <> 'system_update'")
    .bind(id)
    .first<{ id: string; request_id: string; author_id: string | null; state: string }>();
  if (!rc) throw targetMissing('Comment');
  if ((hidden && rc.state !== 'visible') || (!hidden && rc.state !== 'hidden')) return c.json({ success: true, replayed: true, hidden: rc.state === 'hidden' });

  const ts = nowIso();
  const actionId = newId('mod');
  const action: ModerationAction = hidden ? 'hide' : 'restore';
  const res = await db.batch([
    db
      .prepare('UPDATE community_request_comments SET state = ?1, admin_hidden_reason = ?2, updated_at = ?3 WHERE id = ?4 AND state = ?5')
      .bind(hidden ? 'hidden' : 'visible', hidden ? reason : '', ts, id, hidden ? 'visible' : 'hidden'),
    actionStatement(
      db,
      { id: actionId, actorId: admin.id, subjectUserId: rc.author_id, targetType: 'request_comment', targetId: id, action, reason, until: null, reportId, at: ts },
      { sql: 'SELECT 1 FROM community_request_comments WHERE id = ?11 AND state = ?12 AND updated_at = ?13', binds: [id, hidden ? 'hidden' : 'visible', ts] }
    ),
    ...(reportId ? [reportActionedStatement(db, reportId, admin.id, actionId, reason, ts)] : []),
  ]);
  if (!landed(res[1])) return c.json({ success: true, replayed: true, hidden });

  await audit(db, admin.id, hidden ? 'admin.moderation.request_comment_hidden' : 'admin.moderation.request_comment_restored', id, {
    action_id: actionId,
    reason,
    request_id: rc.request_id,
    author: rc.author_id,
    report_id: reportId,
  });
  await tellSubject(c, { userId: rc.author_id, actionId, action, targetType: 'request_comment', targetId: id, label: '', reason, until: null });
  return c.json({ success: true, hidden, action_id: actionId });
});

// ------------------------------------------------------------ accounts

/** The account a ladder step is about — the columns the decision and the notice need; never the email or the phone. */
interface AccountRow {
  id: string;
  name: string;
  username: string | null;
  role: string;
  status: string;
  status_reason: string;
  status_until: string | null;
}

/**
 * ONE STEP OF THE LADDER on an account: `{status, reason, until?, report_id?}`
 * where `status` names the step (warn | restrict | suspend | ban | restore;
 * the status words restricted | suspended | banned | active are read as the
 * steps that lead to them). A warning changes nothing but the record and the
 * person's bell; every other step writes the standing (worker/lib/
 * userStatus.ts reads it on the next request). See the file's header for the
 * ladder, the store a ban suspends and the staff rule.
 */
adminModerationRoutes.post('/moderation/users/:id/status', async (c) => {
  await limitDesk(c);
  const admin = c.get('user')!;
  const id = idParam(c);
  const body = await jsonObject(c);
  const step = pickFrom<LadderStep | null>(STEP_WORDS, body.status ?? body.action, null);
  if (!step) throw badRequest(`status must be one of: ${LADDER_STEPS.join(', ')}`);
  const reason = readReason(body.reason, step !== 'restore');
  const until = step === 'restrict' || step === 'suspend' ? readUntil(body.until) : null;
  const reportId = await reportFrom(c, body.report_id);
  const db = c.env.DB;
  const u = await db
    .prepare('SELECT id, name, username, role, status, status_reason, status_until FROM users WHERE id = ?')
    .bind(id)
    .first<AccountRow>();
  if (!u) throw targetMissing('Account');
  if (u.role === 'admin') throw new HttpError(403, 'Staff accounts are not moderated here', 'MODERATION_STAFF_TARGET');

  const current = effectiveStatus(u);
  const stored = (u.status || 'active') as UserStatus;
  const ts = nowIso();
  const actionId = newId('mod');
  const base = { id: actionId, actorId: admin.id, subjectUserId: id, targetType: 'user' as const, targetId: id, reason, until, reportId, at: ts };

  // A WARNING: the record and the bell, nothing else.
  if (step === 'warn') {
    await db.batch([
      actionStatement(db, { ...base, action: 'warn' }, null),
      ...(reportId ? [reportActionedStatement(db, reportId, admin.id, actionId, reason, ts)] : []),
    ]);
    await audit(db, admin.id, 'admin.moderation.user_status', id, { action_id: actionId, action: 'warn', from: current, to: current, reason, report_id: reportId });
    await tellSubject(c, { userId: id, actionId, action: 'warn', targetType: 'user', targetId: id, label: '', reason, until: null });
    return c.json({ success: true, action_id: actionId, status: current, until: null });
  }

  const next = STATUS_OF_STEP[step];
  if (step === 'restore') {
    // Nothing to lift: the stored row is already active (a lapsed suspension
    // is still normalised here, so the desk's record reads what is true).
    if (stored === 'active') return c.json({ success: true, replayed: true, status: 'active', until: null });
  } else if (STATUS_LEVEL[next] < STATUS_LEVEL[current]) {
    throw new HttpError(409, `The account is ${current}; restore it before applying a lighter decision`, 'MODERATION_LADDER', {
      current,
      requested: next,
    });
  } else if (current === next && (u.status_reason ?? '') === reason && (u.status_until ?? null) === until) {
    // The same step, the same words, the same end date: a second press, not a second decision.
    return c.json({ success: true, replayed: true, status: next, until });
  }

  // A BAN ALSO SUSPENDS THE STORE — the same row `POST /stores/:id/status` writes.
  const store =
    step === 'ban'
      ? await db
          .prepare('SELECT id, slug, status, merchant_id FROM merchant_stores WHERE user_id = ?')
          .bind(id)
          .first<{ id: string; slug: string; status: string; merchant_id: string }>()
      : null;
  const suspendStore = !!store && store.status !== 'suspended';
  const storeActionId = suspendStore ? newId('mod') : '';

  const res = await db.batch([
    db
      .prepare(
        `UPDATE users SET status = ?1, status_reason = ?2, status_until = ?3, status_changed_at = ?4
          WHERE id = ?5 AND status = ?6 AND COALESCE(status_until, '') = ?7`
      )
      .bind(next, step === 'restore' ? '' : reason, until, ts, id, stored, u.status_until ?? ''),
    actionStatement(db, { ...base, action: step }, { sql: 'SELECT 1 FROM users WHERE id = ?11 AND status_changed_at = ?12', binds: [id, ts] }),
    ...(reportId ? [reportActionedStatement(db, reportId, admin.id, actionId, reason, ts)] : []),
    ...(suspendStore && store
      ? [
          db
            .prepare("UPDATE merchant_stores SET status = 'suspended', status_reason = ?1, updated_at = ?2 WHERE id = ?3 AND status <> 'suspended' AND EXISTS (SELECT 1 FROM moderation_actions WHERE id = ?4)")
            .bind(reason, ts, store.id, actionId),
          actionStatement(
            db,
            { id: storeActionId, actorId: admin.id, subjectUserId: id, targetType: 'store', targetId: store.id, action: 'suspend', reason, until: null, reportId: null, at: ts },
            { sql: "SELECT 1 FROM merchant_stores WHERE id = ?11 AND status = 'suspended' AND updated_at = ?12", binds: [store.id, ts] }
          ),
        ]
      : []),
  ]);
  if (!landed(res[1])) throw conflict('The account changed while you were deciding — reload it');

  await audit(db, admin.id, 'admin.moderation.user_status', id, {
    action_id: actionId,
    action: step,
    from: current,
    to: next,
    until,
    reason,
    report_id: reportId,
  });
  await tellSubject(c, { userId: id, actionId, action: step, targetType: 'user', targetId: id, label: '', reason, until });
  // Their projects leave (or return to) every public list with them.
  await afterPostModeration(c, []);

  let storeState: { id: string; slug: string; status: string } | null = null;
  if (step === 'ban' && store) {
    storeState = { id: store.id, slug: store.slug, status: store.status };
    // The store's own action row is the last statement of the batch.
    if (suspendStore && landed(res[res.length - 1])) {
      storeState.status = 'suspended';
      // The steps `POST /api/admin/community/stores/:id/status` takes, in its words.
      await audit(db, admin.id, 'admin.store_status', store.id, {
        status: 'suspended',
        reason,
        merchant: store.merchant_id,
        from: store.status,
        via: 'user_ban',
        action_id: storeActionId,
      });
      await notifyStoreStatusChanged(c.env, { scope: 'store', id: store.id, status: 'suspended', reason, at: ts });
      await afterStorefrontWrite(c, { id: store.id, slug: store.slug });
    }
  } else if (step === 'restore') {
    // Lifting the ban leaves the store as it is — reopening it is its own decision.
    storeState = await db
      .prepare('SELECT id, slug, status FROM merchant_stores WHERE user_id = ?')
      .bind(id)
      .first<{ id: string; slug: string; status: string }>();
  }
  return c.json({ success: true, action_id: actionId, status: next, until, store: storeState });
});

// ------------------------------------------------------------ the queue

interface ReportQueueRow {
  id: string;
  reporter_id: string;
  target_type: string;
  target_id: string;
  reason: string;
  details: string;
  state: string;
  reviewed_by: string | null;
  reviewed_at: string | null;
  resolution: string;
  created_at: string;
  reporter_name: string | null;
  reporter_username: string | null;
  real_kind: string | null;
  real_target_id: string | null;
  target_reports: number;
  target_open_reports: number;
}

/** What each report really names: the side table's row (0160), else the report's own target. */
const realKindSql = `COALESCE(t.kind, rp.target_type)`;

/**
 * THE TARGETS OF ONE PAGE OF REPORTS, rendered — one read per kind, every id
 * bound as ONE JSON value (never a list of placeholders: D1's ceiling of 100,
 * tests/d1ParameterCeilings.test.ts). A target that no longer exists renders
 * as `{ exists: false }`. Nothing here carries an email, a phone or a
 * storage key.
 */
async function renderTargets(c: Context<AppContext>, wanted: Map<string, Set<string>>): Promise<Map<string, Record<string, unknown>>> {
  const db = c.env.DB;
  const root = rootDomainFrom(c.env);
  const out = new Map<string, Record<string, unknown>>();
  const ids = (kind: string) => JSON.stringify([...(wanted.get(kind) ?? [])]);
  const has = (kind: string) => (wanted.get(kind)?.size ?? 0) > 0;
  const put = (kind: string, id: string, v: Record<string, unknown>) => out.set(`${kind}:${id}`, { kind, id, exists: true, ...v });
  const author = (r: Record<string, unknown>, prefix = 'a_') => ({
    id: String(r[`${prefix}id`] ?? ''),
    name: String(r[`${prefix}name`] ?? ''),
    username: (r[`${prefix}username`] as string | null) ?? null,
    status: effectiveStatus({ status: r[`${prefix}status`], status_until: r[`${prefix}status_until`] }),
  });
  const reads: Array<Promise<void>> = [];

  if (has('post')) {
    reads.push(
      db
        .prepare(`SELECT ${POST_COLUMNS} ${POST_FROM} WHERE p.id IN (SELECT value FROM json_each(?1))`)
        .bind(ids('post'))
        .all<Record<string, unknown>>()
        .then(({ results }) => {
          for (const p of results ?? []) {
            put('post', String(p.id), {
              card: postCard(p, root),
              hidden: p.admin_hidden_at ? { at: p.admin_hidden_at, reason: String(p.admin_hidden_reason ?? '') } : null,
              author: {
                id: String(p.author_id),
                name: String(p.a_name ?? ''),
                username: (p.a_username as string | null) ?? null,
                status: effectiveStatus({ status: p.a_status, status_until: p.a_status_until }),
              },
            });
          }
        })
    );
  }
  if (has('comment')) {
    reads.push(
      db
        .prepare(
          `SELECT cm.id, cm.post_id, substr(cm.body, 1, 300) AS body, cm.state, cm.admin_hidden_reason, cm.created_at,
                  u.id AS a_id, u.name AS a_name, u.username AS a_username, u.status AS a_status, u.status_until AS a_status_until
             FROM community_comments cm JOIN users u ON u.id = cm.author_id
            WHERE cm.id IN (SELECT value FROM json_each(?1))`
        )
        .bind(ids('comment'))
        .all<Record<string, unknown>>()
        .then(({ results }) => {
          for (const r of results ?? []) {
            put('comment', String(r.id), {
              post_id: String(r.post_id),
              post_url: postHref(String(r.post_id)),
              body: String(r.body ?? ''),
              state: String(r.state),
              hidden_reason: String(r.admin_hidden_reason ?? ''),
              created_at: String(r.created_at),
              author: author(r),
            });
          }
        })
    );
  }
  if (has('request_comment')) {
    reads.push(
      db
        .prepare(
          `SELECT rc.id, rc.request_id, rc.kind AS comment_kind, substr(rc.body, 1, 300) AS body, rc.state, rc.admin_hidden_reason, rc.created_at,
                  u.id AS a_id, u.name AS a_name, u.username AS a_username, u.status AS a_status, u.status_until AS a_status_until
             FROM community_request_comments rc LEFT JOIN users u ON u.id = rc.author_id
            WHERE rc.id IN (SELECT value FROM json_each(?1))`
        )
        .bind(ids('request_comment'))
        .all<Record<string, unknown>>()
        .then(({ results }) => {
          for (const r of results ?? []) {
            put('request_comment', String(r.id), {
              request_id: String(r.request_id),
              comment_kind: String(r.comment_kind),
              body: String(r.body ?? ''),
              state: String(r.state),
              hidden_reason: String(r.admin_hidden_reason ?? ''),
              created_at: String(r.created_at),
              author: author(r),
            });
          }
        })
    );
  }
  if (has('order_update')) {
    reads.push(
      db
        .prepare(
          `SELECT ou.id, ou.community_order_id, ou.kind AS update_kind, substr(ou.body, 1, 300) AS body,
                  CASE WHEN ou.file_key IS NULL THEN 0 ELSE 1 END AS has_file, ou.created_at,
                  u.id AS a_id, u.name AS a_name, u.username AS a_username, u.status AS a_status, u.status_until AS a_status_until
             FROM community_order_updates ou LEFT JOIN users u ON u.id = ou.actor_id
            WHERE ou.id IN (SELECT value FROM json_each(?1))`
        )
        .bind(ids('order_update'))
        .all<Record<string, unknown>>()
        .then(({ results }) => {
          for (const r of results ?? []) {
            put('order_update', String(r.id), {
              order_id: String(r.community_order_id),
              update_kind: String(r.update_kind),
              body: String(r.body ?? ''),
              has_file: Number(r.has_file) === 1,
              created_at: String(r.created_at),
              author: author(r),
            });
          }
        })
    );
  }
  if (has('user')) {
    reads.push(
      db
        .prepare(
          `SELECT id, name, username, avatar_key, role, status, status_reason, status_until, creator_public, created_at
             FROM users WHERE id IN (SELECT value FROM json_each(?1))`
        )
        .bind(ids('user'))
        .all<Record<string, unknown>>()
        .then(({ results }) => {
          for (const r of results ?? []) {
            put('user', String(r.id), {
              name: String(r.name ?? ''),
              username: (r.username as string | null) ?? null,
              avatarUrl: fileUrl(r.avatar_key),
              staff: r.role === 'admin',
              status: effectiveStatus(r),
              stored_status: String(r.status ?? 'active'),
              status_reason: String(r.status_reason ?? ''),
              status_until: (r.status_until as string | null) ?? null,
              creator_public: Number(r.creator_public) === 1,
              created_at: String(r.created_at),
            });
          }
        })
    );
  }
  if (has('store')) {
    reads.push(
      db
        .prepare(
          `SELECT s.id, s.slug, s.name, s.status, s.status_reason, s.logo_key, s.user_id, m.status AS merchant_status
             FROM merchant_stores s JOIN community_merchants m ON m.id = s.merchant_id
            WHERE s.id IN (SELECT value FROM json_each(?1))`
        )
        .bind(ids('store'))
        .all<Record<string, unknown>>()
        .then(({ results }) => {
          for (const r of results ?? []) {
            put('store', String(r.id), {
              slug: String(r.slug ?? ''),
              name: String(r.name ?? ''),
              status: String(r.status ?? ''),
              status_reason: String(r.status_reason ?? ''),
              merchant_status: String(r.merchant_status ?? ''),
              owner_id: String(r.user_id ?? ''),
              logoUrl: fileUrl(r.logo_key),
            });
          }
        })
    );
  }
  if (has('product')) {
    reads.push(
      db
        .prepare(
          `SELECT p.id, p.slug, p.name, p.name_ar, p.status, p.lifecycle, p.admin_hidden_at, p.admin_hidden_reason, p.merchant_id, s.slug AS store_slug
             FROM community_products p LEFT JOIN merchant_stores s ON s.id = p.store_id
            WHERE p.id IN (SELECT value FROM json_each(?1))`
        )
        .bind(ids('product'))
        .all<Record<string, unknown>>()
        .then(({ results }) => {
          for (const r of results ?? []) {
            put('product', String(r.id), {
              slug: String(r.slug ?? ''),
              name: String(r.name ?? ''),
              name_ar: String(r.name_ar ?? ''),
              status: String(r.status ?? ''),
              lifecycle: String(r.lifecycle ?? ''),
              hidden: r.admin_hidden_at ? { at: r.admin_hidden_at, reason: String(r.admin_hidden_reason ?? '') } : null,
              merchant_id: String(r.merchant_id ?? ''),
              store_slug: (r.store_slug as string | null) ?? null,
            });
          }
        })
    );
  }
  if (has('request')) {
    reads.push(
      db
        .prepare(
          `SELECT r.id, r.title, r.state, r.visibility, r.customer_id, u.name AS customer_name
             FROM community_requests r LEFT JOIN users u ON u.id = r.customer_id
            WHERE r.id IN (SELECT value FROM json_each(?1))`
        )
        .bind(ids('request'))
        .all<Record<string, unknown>>()
        .then(({ results }) => {
          for (const r of results ?? []) {
            put('request', String(r.id), {
              title: String(r.title ?? ''),
              state: String(r.state ?? ''),
              visibility: String(r.visibility ?? ''),
              customer: { id: String(r.customer_id ?? ''), name: String(r.customer_name ?? '') },
            });
          }
        })
    );
  }
  await Promise.all(reads);
  return out;
}

/**
 * THE QUEUE — `community_reports` newest first, each with the thing it names
 * rendered (a post card, a comment, an account, a store, a product, a
 * request, a request comment or an order update — 0160's side table says
 * which row a report really means) and how many reports that target has
 * drawn (`reports_on_target`, `open_on_target`). `?state=open|reviewed|
 * actioned|dismissed|all` (open by default), `?type=<kind>`, `?cursor=`
 * `created_at|id`, read one row longer than the page (D8).
 */
adminModerationRoutes.get('/moderation/reports', async (c) => {
  const stateRaw = (c.req.query('state') || 'open').trim();
  const state = (REPORT_STATES as readonly string[]).includes(stateRaw) ? stateRaw : '';
  const typeRaw = (c.req.query('type') || '').trim();
  const type = (REPORT_KINDS as readonly string[]).includes(typeRaw) ? typeRaw : '';
  const limit = int(c.req.query('limit'), 'limit', { min: 1, max: 100, def: 30 });
  const cursor = feedCursor(c.req.query('cursor'));
  const { results } = await c.env.DB.prepare(
    `SELECT rp.id, rp.reporter_id, rp.target_type, rp.target_id, rp.reason, rp.details, rp.state,
            rp.reviewed_by, rp.reviewed_at, rp.resolution, rp.created_at,
            u.name AS reporter_name, u.username AS reporter_username,
            t.kind AS real_kind, t.target_id AS real_target_id,
            (SELECT COUNT(*) FROM community_reports r2 LEFT JOIN community_report_targets t2 ON t2.report_id = r2.id
              WHERE r2.target_type = rp.target_type AND r2.target_id = rp.target_id
                AND COALESCE(t2.kind, '') = COALESCE(t.kind, '')) AS target_reports,
            (SELECT COUNT(*) FROM community_reports r2 LEFT JOIN community_report_targets t2 ON t2.report_id = r2.id
              WHERE r2.target_type = rp.target_type AND r2.target_id = rp.target_id
                AND COALESCE(t2.kind, '') = COALESCE(t.kind, '') AND r2.state = 'open') AS target_open_reports
       FROM community_reports rp
       LEFT JOIN users u ON u.id = rp.reporter_id
       LEFT JOIN community_report_targets t ON t.report_id = rp.id
      WHERE (?1 = '' OR rp.state = ?1)
        AND (?2 = '' OR ${realKindSql} = ?2)
        AND (?3 = '' OR rp.created_at < ?3 OR (rp.created_at = ?3 AND rp.id < ?4))
      ORDER BY rp.created_at DESC, rp.id DESC
      LIMIT ?5`
  )
    .bind(state, type, cursor.at, cursor.id, limit + 1)
    .all<ReportQueueRow>();
  const rows = results ?? [];
  const more = rows.length > limit;
  if (more) rows.length = limit;
  const last = rows[rows.length - 1];
  const next_cursor = more && last ? `${last.created_at}|${last.id}` : null;

  const wanted = new Map<string, Set<string>>();
  const realOf = (r: ReportQueueRow) => ({ kind: r.real_kind ?? r.target_type, id: r.real_target_id ?? r.target_id });
  for (const r of rows) {
    const t = realOf(r);
    if (!wanted.has(t.kind)) wanted.set(t.kind, new Set());
    wanted.get(t.kind)!.add(t.id);
  }
  const targets = await renderTargets(c, wanted);
  c.header('Cache-Control', 'private, no-store');
  return c.json({
    success: true,
    reports: rows.map((r) => {
      const t = realOf(r);
      return {
        id: r.id,
        state: r.state,
        reason: r.reason,
        details: r.details,
        created_at: r.created_at,
        reviewed_by: r.reviewed_by,
        reviewed_at: r.reviewed_at,
        resolution: r.resolution,
        reporter: { id: r.reporter_id, name: String(r.reporter_name ?? ''), username: r.reporter_username ?? null },
        target: targets.get(`${t.kind}:${t.id}`) ?? { kind: t.kind, id: t.id, exists: false },
        reports_on_target: Number(r.target_reports ?? 0),
        open_on_target: Number(r.target_open_reports ?? 0),
      };
    }),
    next_cursor,
  });
});

/**
 * DECIDE A REPORT — reviewed (looked at, nothing to do yet), actioned
 * (answered by a decision; a decision taken with `report_id` marks it on its
 * own), or dismissed. Audited; no account is touched, so no action row and
 * no notice.
 */
adminModerationRoutes.post('/moderation/reports/:id', async (c) => {
  await limitDesk(c);
  const admin = c.get('user')!;
  const id = idParam(c);
  const body = await jsonObject(c);
  const state = pickFrom<string | null>({ reviewed: 'reviewed', actioned: 'actioned', dismissed: 'dismissed' }, body.state, null);
  if (!state) throw badRequest('state must be one of: reviewed, actioned, dismissed');
  const resolution = str(body.resolution, 'resolution', { min: 0, max: REASON_MAX, required: false });
  const db = c.env.DB;
  const r = await db
    .prepare('SELECT id, state, resolution, target_type, target_id FROM community_reports WHERE id = ?')
    .bind(id)
    .first<{ id: string; state: string; resolution: string; target_type: string; target_id: string }>();
  if (!r) throw targetMissing('Report');
  if (r.state === state && r.resolution === resolution) return c.json({ success: true, replayed: true, state });
  const ts = nowIso();
  await db
    .prepare('UPDATE community_reports SET state = ?1, resolution = ?2, reviewed_by = ?3, reviewed_at = ?4 WHERE id = ?5')
    .bind(state, resolution, admin.id, ts, id)
    .run();
  await audit(db, admin.id, 'admin.moderation.report', id, { state, from: r.state, resolution, target_type: r.target_type, target_id: r.target_id });
  return c.json({ success: true, state });
});

// ------------------------------------------------------------ one target's history

/** The audit rows the desk may read about a target: moderation and community actions — never money. */
const DESK_AUDIT_SQL = `(a.action LIKE 'admin.moderation.%' OR a.action LIKE 'moderation.%' OR a.action LIKE 'community.%'
        OR a.action IN ('admin.store_status','admin.merchant_status','admin.product_hidden','admin.product_unhidden',
                        'admin.review_hidden','admin.request_removed','admin.merchant_verified','admin.merchant_badge'))`;

/**
 * THE HISTORY OF ONE TARGET — its `moderation_actions` (for an account, also
 * every decision about its content) with any appeal, and the `audit_log`
 * rows written about it that the desk may read. `?target_type&target_id`
 * (`?target=<type>:<id>` also reads). For an account, a post or a comment,
 * `current` is its standing now.
 */
adminModerationRoutes.get('/moderation/audit', async (c) => {
  let typeRaw = (c.req.query('target_type') ?? '').trim();
  let targetId = (c.req.query('target_id') ?? '').trim();
  const combined = (c.req.query('target') ?? '').trim();
  if ((!typeRaw || !targetId) && combined.includes(':')) {
    typeRaw = combined.slice(0, combined.indexOf(':'));
    targetId = combined.slice(combined.indexOf(':') + 1);
  }
  const targetType = pickFrom<ModerationTarget | null>(
    Object.fromEntries(MODERATION_TARGETS.map((t) => [t, t])) as Record<string, ModerationTarget>,
    typeRaw,
    null
  );
  if (!targetType) throw badRequest(`target_type must be one of: ${MODERATION_TARGETS.join(', ')}`);
  const id = str(targetId, 'target_id', { min: 1, max: 64 });
  const db = c.env.DB;
  const [actions, auditRows, current] = await Promise.all([
    db
      .prepare(
        `SELECT a.id, a.action, a.target_type, a.target_id, a.reason, a.until, a.report_id, a.created_at, a.subject_user_id,
                a.actor_id, u.name AS actor_name,
                ap.id AS appeal_id, ap.state AS appeal_state, ap.body AS appeal_body, ap.decision AS appeal_decision,
                ap.decided_at AS appeal_decided_at, ap.created_at AS appeal_created_at
           FROM moderation_actions a
           LEFT JOIN users u ON u.id = a.actor_id
           LEFT JOIN moderation_appeals ap ON ap.action_id = a.id
          WHERE (a.target_type = ?1 AND a.target_id = ?2) OR (?1 = 'user' AND a.subject_user_id = ?2)
          ORDER BY a.created_at DESC, a.id DESC LIMIT 200`
      )
      .bind(targetType, id)
      .all<Record<string, unknown>>(),
    db
      .prepare(
        `SELECT a.id, a.actor_id, a.action, a.detail, a.created_at, u.name AS actor_name
           FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id
          WHERE a.target = ?1 AND ${DESK_AUDIT_SQL}
          ORDER BY a.id DESC LIMIT 200`
      )
      .bind(id)
      .all<Record<string, unknown>>(),
    currentOf(db, targetType, id),
  ]);
  c.header('Cache-Control', 'private, no-store');
  return c.json({
    success: true,
    target: { type: targetType, id },
    current,
    actions: (actions.results ?? []).map((a) => ({
      id: String(a.id),
      action: String(a.action),
      target_type: String(a.target_type),
      target_id: String(a.target_id),
      reason: String(a.reason ?? ''),
      until: (a.until as string | null) ?? null,
      report_id: (a.report_id as string | null) ?? null,
      subject_user_id: (a.subject_user_id as string | null) ?? null,
      created_at: String(a.created_at),
      actor: a.actor_id ? { id: String(a.actor_id), name: String(a.actor_name ?? '') } : null,
      appeal: a.appeal_id
        ? {
            id: String(a.appeal_id),
            state: String(a.appeal_state),
            body: String(a.appeal_body ?? ''),
            decision: String(a.appeal_decision ?? ''),
            decided_at: (a.appeal_decided_at as string | null) ?? null,
            created_at: String(a.appeal_created_at ?? ''),
          }
        : null,
    })),
    audit: (auditRows.results ?? []).map((a) => ({
      id: Number(a.id),
      action: String(a.action),
      actor: a.actor_id ? { id: String(a.actor_id), name: String(a.actor_name ?? '') } : null,
      detail: safeParse<Record<string, unknown>>(a.detail, {}) ?? {},
      created_at: String(a.created_at),
    })),
  });
});

/** The target's standing now, for the kinds that have one. */
async function currentOf(db: D1Database, type: ModerationTarget, id: string): Promise<Record<string, unknown> | null> {
  if (type === 'user') {
    const u = await db
      .prepare('SELECT status, status_reason, status_until, status_changed_at, role FROM users WHERE id = ?')
      .bind(id)
      .first<Record<string, unknown>>();
    return u
      ? {
          exists: true,
          status: effectiveStatus(u),
          stored_status: String(u.status ?? 'active'),
          reason: String(u.status_reason ?? ''),
          until: (u.status_until as string | null) ?? null,
          changed_at: (u.status_changed_at as string | null) ?? null,
          staff: u.role === 'admin',
        }
      : { exists: false };
  }
  if (type === 'post') {
    const p = await db
      .prepare('SELECT state, visibility, admin_hidden_at, admin_hidden_reason, author_id FROM community_posts WHERE id = ?')
      .bind(id)
      .first<Record<string, unknown>>();
    return p
      ? {
          exists: true,
          state: String(p.state),
          visibility: String(p.visibility),
          hidden: p.admin_hidden_at ? { at: p.admin_hidden_at, reason: String(p.admin_hidden_reason ?? '') } : null,
          author_id: String(p.author_id),
        }
      : { exists: false };
  }
  if (type === 'comment' || type === 'request_comment') {
    const table = type === 'comment' ? 'community_comments' : 'community_request_comments';
    const r = await db.prepare(`SELECT state, admin_hidden_reason, author_id FROM ${table} WHERE id = ?`).bind(id).first<Record<string, unknown>>();
    return r ? { exists: true, state: String(r.state), hidden_reason: String(r.admin_hidden_reason ?? ''), author_id: (r.author_id as string | null) ?? null } : { exists: false };
  }
  return null;
}

// ------------------------------------------------------------ appeals, the desk

interface AppealRow {
  id: string;
  user_id: string;
  action_id: string;
  body: string;
  state: string;
  decided_by: string | null;
  decided_at: string | null;
  decision: string;
  created_at: string;
}

interface ActionRecord {
  id: string;
  actor_id: string | null;
  subject_user_id: string | null;
  target_type: ModerationTarget;
  target_id: string;
  action: ModerationAction;
  reason: string;
  until: string | null;
  created_at: string;
}

const appealPublic = (r: Record<string, unknown>) => ({
  id: String(r.id),
  state: String(r.state),
  body: String(r.body ?? ''),
  decision: String(r.decision ?? ''),
  decided_at: (r.decided_at as string | null) ?? null,
  created_at: String(r.created_at),
  action: {
    id: String(r.action_id),
    action: String(r.a_action),
    target_type: String(r.a_target_type),
    target_id: String(r.a_target_id),
    reason: String(r.a_reason ?? ''),
    until: (r.a_until as string | null) ?? null,
    created_at: String(r.a_created_at ?? ''),
  },
});

/** The appeals queue: `?state=open|accepted|rejected|all` (open by default), newest first, `created_at|id` cursor. */
adminModerationRoutes.get('/moderation/appeals', async (c) => {
  const stateRaw = (c.req.query('state') || 'open').trim();
  const state = (APPEAL_STATES as readonly string[]).includes(stateRaw) ? stateRaw : '';
  const limit = int(c.req.query('limit'), 'limit', { min: 1, max: 100, def: 30 });
  const cursor = feedCursor(c.req.query('cursor'));
  const { results } = await c.env.DB.prepare(
    `SELECT ap.*, a.action AS a_action, a.target_type AS a_target_type, a.target_id AS a_target_id, a.reason AS a_reason,
            a.until AS a_until, a.created_at AS a_created_at,
            u.name AS u_name, u.username AS u_username, u.status AS u_status, u.status_until AS u_status_until
       FROM moderation_appeals ap
       JOIN moderation_actions a ON a.id = ap.action_id
       LEFT JOIN users u ON u.id = ap.user_id
      WHERE (?1 = '' OR ap.state = ?1)
        AND (?2 = '' OR ap.created_at < ?2 OR (ap.created_at = ?2 AND ap.id < ?3))
      ORDER BY ap.created_at DESC, ap.id DESC LIMIT ?4`
  )
    .bind(state, cursor.at, cursor.id, limit + 1)
    .all<Record<string, unknown>>();
  const rows = results ?? [];
  const more = rows.length > limit;
  if (more) rows.length = limit;
  const last = rows[rows.length - 1];
  c.header('Cache-Control', 'private, no-store');
  return c.json({
    success: true,
    appeals: rows.map((r) => ({
      ...appealPublic(r),
      user: {
        id: String(r.user_id),
        name: String(r.u_name ?? ''),
        username: (r.u_username as string | null) ?? null,
        status: effectiveStatus({ status: r.u_status, status_until: r.u_status_until }),
      },
    })),
    next_cursor: more && last ? `${String(last.created_at)}|${String(last.id)}` : null,
  });
});

/**
 * UNDO A DECISION AN APPEAL WON — only while it is still the one in force: a
 * hide still set, an account whose standing THIS action set (a newer
 * decision is left alone; the appeal's answer then says nothing was undone).
 * A warning has nothing to undo. Returns the `restore` action written, or
 * null. Audited (`detail.action_id` = the restore) and batched like every
 * other decision.
 */
async function undoDecision(c: Context<AppContext>, a: ActionRecord, adminId: string, decision: string, appealId: string): Promise<string | null> {
  const db = c.env.DB;
  const ts = nowIso();
  const restoreId = newId('mod');
  const reason = decision || 'appeal accepted';
  const row: ActionRow = {
    id: restoreId,
    actorId: adminId,
    subjectUserId: a.subject_user_id,
    targetType: a.target_type,
    targetId: a.target_id,
    action: 'restore',
    reason,
    until: null,
    reportId: null,
    at: ts,
  };
  let stmts: D1PreparedStatement[] | null = null;
  let auditAction = '';
  if (a.action === 'hide' && a.target_type === 'post') {
    stmts = [
      db
        .prepare("UPDATE community_posts SET admin_hidden_at = NULL, admin_hidden_reason = '', updated_at = ?1 WHERE id = ?2 AND admin_hidden_at IS NOT NULL")
        .bind(ts, a.target_id),
      actionStatement(db, row, { sql: 'SELECT 1 FROM community_posts WHERE id = ?11 AND admin_hidden_at IS NULL AND updated_at = ?12', binds: [a.target_id, ts] }),
    ];
    auditAction = 'admin.moderation.post_restored';
  } else if (a.action === 'hide' && (a.target_type === 'comment' || a.target_type === 'request_comment')) {
    const table = a.target_type === 'comment' ? 'community_comments' : 'community_request_comments';
    stmts = [
      db.prepare(`UPDATE ${table} SET state = 'visible', admin_hidden_reason = '', updated_at = ?1 WHERE id = ?2 AND state = 'hidden'`).bind(ts, a.target_id),
      actionStatement(db, row, { sql: `SELECT 1 FROM ${table} WHERE id = ?11 AND state = 'visible' AND updated_at = ?12`, binds: [a.target_id, ts] }),
    ];
    auditAction = a.target_type === 'comment' ? 'admin.moderation.comment_restored' : 'admin.moderation.request_comment_restored';
  } else if (a.target_type === 'user' && (a.action === 'restrict' || a.action === 'suspend' || a.action === 'ban')) {
    // Still in force only if no later decision moved this account's standing.
    const latest = await db
      .prepare(
        `SELECT id FROM moderation_actions
          WHERE target_type = 'user' AND target_id = ?1 AND action IN ('restrict','suspend','ban','restore')
          ORDER BY created_at DESC, id DESC LIMIT 1`
      )
      .bind(a.target_id)
      .first<{ id: string }>();
    if (!latest || latest.id !== a.id) return null;
    stmts = [
      db
        .prepare(
          `UPDATE users SET status = 'active', status_reason = '', status_until = NULL, status_changed_at = ?1
            WHERE id = ?2 AND status <> 'active'`
        )
        .bind(ts, a.target_id),
      actionStatement(db, row, { sql: 'SELECT 1 FROM users WHERE id = ?11 AND status_changed_at = ?12', binds: [a.target_id, ts] }),
    ];
    auditAction = 'admin.moderation.user_status';
  }
  if (!stmts) return null;
  const res = await db.batch(stmts);
  if (!landed(res[1])) return null;
  await audit(db, adminId, auditAction, a.target_id, {
    action_id: restoreId,
    action: 'restore',
    via: 'appeal',
    appeal_id: appealId,
    appealed_action_id: a.id,
    reason,
  });
  if (a.target_type === 'post' || a.target_type === 'user') await afterPostModeration(c, a.target_type === 'post' ? [a.target_id] : []);
  return restoreId;
}

/**
 * DECIDE AN APPEAL — `{state: accepted|rejected, decision}`. Accepted undoes
 * the decision when it is still in force (`undoDecision`); either way the
 * person is told, with the desk's words. An appeal is decided once.
 */
adminModerationRoutes.post('/moderation/appeals/:id', async (c) => {
  await limitDesk(c);
  const admin = c.get('user')!;
  const id = idParam(c);
  const body = await jsonObject(c);
  const state = pickFrom<'accepted' | 'rejected' | null>({ accepted: 'accepted', rejected: 'rejected' }, body.state, null);
  if (!state) throw badRequest('state must be one of: accepted, rejected');
  const decision = str(body.decision, 'decision', { min: 0, max: APPEAL_BODY_MAX, required: false });
  const db = c.env.DB;
  const ap = await db.prepare('SELECT * FROM moderation_appeals WHERE id = ?').bind(id).first<AppealRow>();
  if (!ap) throw new HttpError(404, 'Appeal not found', 'APPEAL_NOT_FOUND');
  if (ap.state !== 'open') {
    if (ap.state === state) return c.json({ success: true, replayed: true, state, restored: false });
    throw new HttpError(409, 'This appeal has already been decided', 'APPEAL_DECIDED');
  }
  const a = await db.prepare('SELECT * FROM moderation_actions WHERE id = ?').bind(ap.action_id).first<ActionRecord>();
  if (!a) throw new HttpError(404, 'Appeal not found', 'APPEAL_NOT_FOUND');
  const ts = nowIso();
  const res = await db
    .prepare("UPDATE moderation_appeals SET state = ?1, decided_by = ?2, decided_at = ?3, decision = ?4 WHERE id = ?5 AND state = 'open'")
    .bind(state, admin.id, ts, decision, id)
    .run();
  if (!landed(res)) throw new HttpError(409, 'This appeal has already been decided', 'APPEAL_DECIDED');

  const restoreId = state === 'accepted' ? await undoDecision(c, a, admin.id, decision, id) : null;
  await audit(db, admin.id, 'admin.moderation.appeal_decided', id, {
    state,
    decision,
    appealed_action_id: a.id,
    restored: !!restoreId,
    restore_action_id: restoreId,
    user: ap.user_id,
  });
  const accepted = state === 'accepted';
  const words: Words = {
    ar: accepted ? 'قُبل اعتراضك' : 'رُفض اعتراضك',
    en: accepted ? 'Your appeal was accepted' : 'Your appeal was rejected',
    ckb: accepted ? 'ناڕەزاییەکەت پەسەند کرا' : 'ناڕەزاییەکەت ڕەتکرایەوە',
  };
  const outcome: Words = accepted
    ? restoreId
      ? { ar: 'أُلغي القرار.', en: 'The decision was undone.', ckb: 'بڕیارەکە هەڵوەشێنرایەوە.' }
      : { ar: 'سُجّل قبول اعتراضك.', en: 'Your appeal was upheld.', ckb: 'پەسەندکردنی ناڕەزاییەکەت تۆمار کرا.' }
    : { ar: 'يبقى القرار كما هو.', en: 'The decision stands.', ckb: 'بڕیارەکە وەک خۆی دەمێنێتەوە.' };
  const said = decision.trim();
  await notify(db, {
    userId: ap.user_id,
    kind: 'moderation_action',
    title_ar: words.ar,
    title_en: words.en,
    body_ar: said ? `${outcome.ar}\n${said}` : outcome.ar,
    body_en: said ? `${outcome.en}\n${said}` : outcome.en,
    link: appealDoor(a.id),
    entity_type: 'moderation_action',
    entity_id: a.id,
    meta: { appeal_id: id, state, restored: !!restoreId, title_ckb: words.ckb, body_ckb: said ? `${outcome.ckb}\n${said}` : outcome.ckb },
    eventKey: `moderation_appeal:${id}`,
  });
  return c.json({ success: true, state, restored: !!restoreId, restore_action_id: restoreId });
});

// ------------------------------------------------------------ the person's own door

/**
 * «حالة حسابي»: the account's standing now and the decisions that concern it
 * (its account and its content), newest first, each with its appeal — or
 * whether one may still be filed.
 */
moderationRoutes.get('/moderation/status', async (c) => {
  const user = c.get('user')!;
  const { results } = await c.env.DB.prepare(
    `SELECT a.id, a.action, a.target_type, a.target_id, a.reason, a.until, a.created_at,
            ap.id AS appeal_id, ap.state AS appeal_state, ap.decision AS appeal_decision,
            ap.decided_at AS appeal_decided_at, ap.created_at AS appeal_created_at,
            CASE a.target_type
              WHEN 'post' THEN (SELECT title FROM community_posts WHERE id = a.target_id)
              WHEN 'comment' THEN (SELECT substr(body, 1, 140) FROM community_comments WHERE id = a.target_id)
              WHEN 'request_comment' THEN (SELECT substr(body, 1, 140) FROM community_request_comments WHERE id = a.target_id)
              WHEN 'store' THEN (SELECT name FROM merchant_stores WHERE id = a.target_id)
            END AS target_label
       FROM moderation_actions a
       LEFT JOIN moderation_appeals ap ON ap.action_id = a.id AND ap.user_id = ?1
      WHERE a.subject_user_id = ?1
      ORDER BY a.created_at DESC, a.id DESC LIMIT 30`
  )
    .bind(user.id)
    .all<Record<string, unknown>>();
  const status = effectiveStatus(user);
  c.header('Cache-Control', 'private, no-store');
  return c.json({
    success: true,
    standing: {
      status,
      reason: status === 'active' ? '' : String(user.status_reason ?? ''),
      until: status === 'restricted' || status === 'suspended' ? (user.status_until ?? null) : null,
    },
    actions: (results ?? []).map((a) => ({
      id: String(a.id),
      action: String(a.action),
      target_type: String(a.target_type),
      target_id: String(a.target_id),
      target_label: (a.target_label as string | null) ?? null,
      target_url: a.target_type === 'post' ? postHref(String(a.target_id)) : null,
      reason: String(a.reason ?? ''),
      until: (a.until as string | null) ?? null,
      created_at: String(a.created_at),
      appealable: !a.appeal_id && APPEALABLE_ACTIONS.includes(String(a.action)) && APPEALABLE_TARGETS.includes(String(a.target_type)),
      appeal: a.appeal_id
        ? {
            id: String(a.appeal_id),
            state: String(a.appeal_state),
            decision: String(a.appeal_decision ?? ''),
            decided_at: (a.appeal_decided_at as string | null) ?? null,
            created_at: String(a.appeal_created_at ?? ''),
          }
        : null,
    })),
  });
});

/** «اعتراضاتي»: the person's own appeals, newest first, `created_at|id` cursor. */
moderationRoutes.get('/moderation/appeals', async (c) => {
  const user = c.get('user')!;
  const limit = int(c.req.query('limit'), 'limit', { min: 1, max: 50, def: 20 });
  const cursor = feedCursor(c.req.query('cursor'));
  const { results } = await c.env.DB.prepare(
    `SELECT ap.*, a.action AS a_action, a.target_type AS a_target_type, a.target_id AS a_target_id, a.reason AS a_reason,
            a.until AS a_until, a.created_at AS a_created_at
       FROM moderation_appeals ap JOIN moderation_actions a ON a.id = ap.action_id
      WHERE ap.user_id = ?1
        AND (?2 = '' OR ap.created_at < ?2 OR (ap.created_at = ?2 AND ap.id < ?3))
      ORDER BY ap.created_at DESC, ap.id DESC LIMIT ?4`
  )
    .bind(user.id, cursor.at, cursor.id, limit + 1)
    .all<Record<string, unknown>>();
  const rows = results ?? [];
  const more = rows.length > limit;
  if (more) rows.length = limit;
  const last = rows[rows.length - 1];
  c.header('Cache-Control', 'private, no-store');
  return c.json({
    success: true,
    appeals: rows.map(appealPublic),
    next_cursor: more && last ? `${String(last.created_at)}|${String(last.id)}` : null,
  });
});

/**
 * FILE AN APPEAL — `{action_id, body}`: a decision that concerns this account,
 * one it may contest, once. A second appeal on the same decision is 409
 * APPEAL_EXISTS (the table's UNIQUE decides, so two taps in flight file one);
 * a decision that is not theirs, or not appealable, is 404 APPEAL_NOT_FOUND.
 * Open to a banned account — this is the one door a ban leaves.
 */
moderationRoutes.post('/moderation/appeals', async (c) => {
  await limitAppeal(c);
  const user = c.get('user')!;
  const body = await jsonObject(c);
  const actionId = str(body.action_id, 'action_id', { min: 1, max: 64 });
  const text = str(body.body, 'body', { min: 3, max: APPEAL_BODY_MAX });
  const db = c.env.DB;
  const a = await db
    .prepare('SELECT id, action, target_type, target_id FROM moderation_actions WHERE id = ? AND subject_user_id = ?')
    .bind(actionId, user.id)
    .first<{ id: string; action: string; target_type: string; target_id: string }>();
  if (!a || !APPEALABLE_ACTIONS.includes(a.action) || !APPEALABLE_TARGETS.includes(a.target_type)) {
    throw new HttpError(404, 'We could not find that decision', 'APPEAL_NOT_FOUND');
  }
  const appealId = newId('apl');
  const res = await db
    .prepare('INSERT INTO moderation_appeals (id, user_id, action_id, body) VALUES (?1, ?2, ?3, ?4) ON CONFLICT(action_id, user_id) DO NOTHING')
    .bind(appealId, user.id, a.id, text)
    .run();
  if (!landed(res)) throw new HttpError(409, 'You have already appealed this decision', 'APPEAL_EXISTS');
  await audit(db, user.id, 'moderation.appeal_filed', appealId, {
    appealed_action_id: a.id,
    action: a.action,
    target_type: a.target_type,
    target_id: a.target_id,
  });
  announceAfterResponse(
    c,
    'report',
    `⚖️ اعتراض جديد على قرار إشراف` + `\nAction: ${a.action}` + `\nTarget: ${a.target_type} ${a.target_id}` + `\nAppeal: ${appealId}`
  );
  const row = await db
    .prepare(
      `SELECT ap.*, a.action AS a_action, a.target_type AS a_target_type, a.target_id AS a_target_id, a.reason AS a_reason,
              a.until AS a_until, a.created_at AS a_created_at
         FROM moderation_appeals ap JOIN moderation_actions a ON a.id = ap.action_id WHERE ap.id = ?`
    )
    .bind(appealId)
    .first<Record<string, unknown>>();
  return c.json({ success: true, appeal: row ? appealPublic(row) : { id: appealId, state: 'open' } }, 201);
});
