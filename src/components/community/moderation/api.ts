/**
 * THE PERSON'S OWN STANDING AND APPEALS — /api/moderation/{status,appeals}
 * (worker/routes/adminModeration.ts `moderationRoutes`, migration 0162,
 * docs/COMMUNITY_ECOSYSTEM.md §9.6).
 *
 * The standing also travels on the session user (`publicUser().moderation`,
 * worker/lib/types.ts) so the banner can draw on the first frame without a
 * request; `standingOf` reads it defensively, because `ApiUser` in
 * src/lib/api.ts predates it and a client older than the server must not
 * crash on its absence. `status()` is the page's own read: the standing plus
 * the decisions about the account and its content, each with its appeal.
 *
 * Nothing here decides anything. A restricted account's post button is not
 * hidden by this module — the server refuses with USER_RESTRICTED /
 * USER_SUSPENDED / USER_BANNED (src/lib/refusalStrings.ts), `details.until`
 * naming the end date, and the screens word that refusal. An appeal is one per
 * decision: a second is APPEAL_EXISTS, a decision that is not the person's is
 * APPEAL_NOT_FOUND. A banned account keeps this door (and signing out).
 */
import { api } from '../../../lib/api';

export const USER_STATUSES = ['active', 'restricted', 'suspended', 'banned'] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

/** What the desk decided. `restore` undoes; it is never appealable. */
export type ModerationAction = 'hide' | 'remove' | 'warn' | 'restrict' | 'suspend' | 'ban' | 'restore';
export type ModerationTargetType = 'post' | 'comment' | 'request_comment' | 'user' | 'store' | 'product' | 'request' | 'review';
export type AppealState = 'open' | 'accepted' | 'rejected';

/** The account's standing in force — a restriction or suspension past its end date already reads `active`. */
export interface Standing {
  status: UserStatus;
  /** What the desk wrote; '' when active. */
  reason: string;
  /** ISO 8601 end of a restriction or a suspension; null for none (a ban has no end). */
  until: string | null;
}

export const ACTIVE_STANDING: Standing = { status: 'active', reason: '', until: null };

export interface AppealSummary {
  id: string;
  state: AppealState;
  decision: string;
  decided_at: string | null;
  created_at: string;
}

/** One decision about the account or its content, as the person reads it. */
export interface ModerationDecision {
  id: string;
  action: ModerationAction;
  target_type: ModerationTargetType;
  target_id: string;
  /** The project's title, the comment's first words, the store's name — whatever names the target. */
  target_label: string | null;
  /** A project's page; null for the rest. */
  target_url: string | null;
  reason: string;
  until: string | null;
  created_at: string;
  /** True while an appeal may still be filed on it (one per decision). */
  appealable: boolean;
  appeal: AppealSummary | null;
}

export interface MyModeration {
  standing: Standing;
  decisions: ModerationDecision[];
}

/** An appeal with the decision it contests. */
export interface Appeal {
  id: string;
  state: AppealState;
  body: string;
  decision: string;
  decided_at: string | null;
  created_at: string;
  action: {
    id: string;
    action: ModerationAction;
    target_type: ModerationTargetType;
    target_id: string;
    reason: string;
    until: string | null;
    created_at: string;
  };
}

export interface AppealPage {
  appeals: Appeal[];
  next: string | null;
}

/** The longest appeal the server keeps (APPEAL_BODY_MAX). */
export const APPEAL_BODY_MAX = 1000;

const isStatus = (v: unknown): v is UserStatus => typeof v === 'string' && (USER_STATUSES as readonly string[]).includes(v);

/**
 * The standing a session user carries (`user.moderation`), or active when the
 * field is absent — an older server, a signed-out visitor.
 */
export function standingOf(user: unknown): Standing {
  const m = user && typeof user === 'object' ? (user as { moderation?: unknown }).moderation : null;
  if (!m || typeof m !== 'object') return ACTIVE_STANDING;
  const s = m as { status?: unknown; reason?: unknown; until?: unknown };
  return {
    status: isStatus(s.status) ? s.status : 'active',
    reason: typeof s.reason === 'string' ? s.reason : '',
    until: typeof s.until === 'string' && s.until ? s.until : null,
  };
}

/** Where a decision's notice sends the person (the notice's `link`). */
export const moderationHref = (actionId?: string) => (actionId ? `/moderation?action=${encodeURIComponent(actionId)}` : '/moderation');

export const moderationApi = {
  /** «حالة حسابي»: the standing now and the latest decisions (≤ 30), newest first. */
  status: () =>
    api
      .get<{ standing?: Partial<Standing>; actions?: ModerationDecision[] }>('/api/moderation/status')
      .then((d): MyModeration => ({
        standing: standingOf({ moderation: d.standing }),
        decisions: Array.isArray(d.actions) ? d.actions : [],
      })),

  /** «اعتراضاتي», newest first, `created_at|id` cursor. */
  appeals: (cursor: string | null = null, limit = 20) => {
    const p = new URLSearchParams({ limit: String(limit) });
    if (cursor) p.set('cursor', cursor);
    return api
      .get<{ appeals?: Appeal[]; next_cursor?: string | null }>(`/api/moderation/appeals?${p.toString()}`)
      .then((d): AppealPage => ({ appeals: Array.isArray(d.appeals) ? d.appeals : [], next: d.next_cursor ?? null }));
  },

  /** File the one appeal a decision allows (body ≤ APPEAL_BODY_MAX). */
  appeal: (actionId: string, body: string) =>
    api.post<{ appeal: Appeal }>('/api/moderation/appeals', { action_id: actionId, body: body.slice(0, APPEAL_BODY_MAX) }).then((d) => d.appeal),
};

/** A decision's id from the page's `?action=` (the notice's link), if any. */
export function actionFromSearch(search: string): string | null {
  const v = (new URLSearchParams(search).get('action') ?? '').trim();
  return v && v.length <= 64 ? v : null;
}
