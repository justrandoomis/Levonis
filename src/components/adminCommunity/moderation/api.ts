/**
 * THE MODERATION DESK'S DOORS — /api/admin/moderation/*
 * (worker/routes/adminModeration.ts `adminModerationRoutes`, migration 0162,
 * docs/COMMUNITY_ECOSYSTEM.md §9.6 «Routes»). Apex only, staff only: the
 * server answers 404 on a merchant host and 403 to anyone else.
 *
 * Every write is a DECISION the server records three ways — the change, a
 * `moderation_actions` row, an audit row — and tells the person about, with
 * the reason and the appeal door; a write that changes nothing answers
 * `replayed: true` and records nothing. The client sends ids and words; the
 * server decides whether the ladder allows the step:
 *
 *   MODERATION_LADDER (409)          lighter than the sanction in force — restore first
 *   MODERATION_TARGET_NOT_FOUND      the post, comment, account or report is gone
 *   MODERATION_UNTIL_INVALID (400)   the end date is not a future date (≤ 5 years)
 *   MODERATION_STAFF_TARGET (403)    staff accounts are not moderated here
 *   APPEAL_DECIDED (409), APPEAL_NOT_FOUND (404)
 *
 * each worded by src/lib/refusalStrings.ts (`apiRefusal`).
 */
import { api } from '../../../lib/api';
import type { PostCard } from '../../community/projects/api';
import type {
  AppealState,
  ModerationAction,
  ModerationTargetType,
  UserStatus,
} from '../../community/moderation/api';

export type { AppealState, ModerationAction, ModerationTargetType, UserStatus } from '../../community/moderation/api';

export const REPORT_STATES = ['open', 'reviewed', 'actioned', 'dismissed'] as const;
export type ReportState = (typeof REPORT_STATES)[number];
/** What a report really names — 0154's types plus 0160's request comment and order update. */
export const REPORT_KINDS = ['post', 'comment', 'request_comment', 'order_update', 'user', 'store', 'product', 'request'] as const;
export type ReportKind = (typeof REPORT_KINDS)[number];
export type ReportReason = 'spam' | 'abuse' | 'nudity' | 'fraud' | 'copyright' | 'offtopic' | 'other';

/** The account ladder, in order; `restore` is the way down. */
export const LADDER_STEPS = ['warn', 'restrict', 'suspend', 'ban', 'restore'] as const;
export type LadderStep = (typeof LADDER_STEPS)[number];
/** The steps that may carry an end date. */
export const STEPS_WITH_UNTIL: readonly LadderStep[] = ['restrict', 'suspend'];

export const MODERATION_REASON_MAX = 500;
export const APPEAL_DECISION_MAX = 1000;

export interface PersonRef {
  id: string;
  name: string;
  username: string | null;
  /** The standing in force now. */
  status?: UserStatus;
}

export interface HiddenMark {
  at: string;
  reason: string;
}

interface TargetBase<K extends ReportKind> {
  kind: K;
  id: string;
  /** False when the thing reported no longer exists. */
  exists: boolean;
}

/** The thing a report names, rendered for the desk — never an email, a phone or a storage key. */
export type RenderedTarget =
  | (TargetBase<'post'> & { card?: PostCard; hidden?: HiddenMark | null; author?: PersonRef })
  | (TargetBase<'comment'> & { post_id?: string; post_url?: string; body?: string; state?: string; hidden_reason?: string; created_at?: string; author?: PersonRef })
  | (TargetBase<'request_comment'> & { request_id?: string; comment_kind?: string; body?: string; state?: string; hidden_reason?: string; created_at?: string; author?: PersonRef })
  | (TargetBase<'order_update'> & { order_id?: string; update_kind?: string; body?: string; has_file?: boolean; created_at?: string; author?: PersonRef })
  | (TargetBase<'user'> & {
      name?: string;
      username?: string | null;
      avatarUrl?: string | null;
      staff?: boolean;
      status?: UserStatus;
      stored_status?: UserStatus;
      status_reason?: string;
      status_until?: string | null;
      creator_public?: boolean;
      created_at?: string;
    })
  | (TargetBase<'store'> & { slug?: string; name?: string; status?: string; status_reason?: string; merchant_status?: string; owner_id?: string; logoUrl?: string | null })
  | (TargetBase<'product'> & { slug?: string; name?: string; name_ar?: string; status?: string; lifecycle?: string; hidden?: HiddenMark | null; merchant_id?: string; store_slug?: string | null })
  | (TargetBase<'request'> & { title?: string; state?: string; visibility?: string; customer?: { id: string; name: string } });

export interface ReportRow {
  id: string;
  state: ReportState;
  reason: ReportReason;
  details: string;
  created_at: string;
  reviewed_by: string | null;
  reviewed_at: string | null;
  resolution: string;
  reporter: PersonRef;
  target: RenderedTarget;
  /** How many reports name this same target, and how many of them are still open. */
  reports_on_target: number;
  open_on_target: number;
}

export interface ReportPage {
  reports: ReportRow[];
  next: string | null;
}

export interface ReportFilters {
  /** `open` by default; `all` for every state. */
  state?: ReportState | 'all';
  type?: ReportKind;
}

/** A decision's answer: the action written, or a replay that changed nothing. */
export interface DecisionResult {
  action_id?: string;
  replayed?: boolean;
}

export interface HideInput {
  hidden: boolean;
  /** Required to hide (≥ 3 characters): it is what the author is shown. */
  reason?: string;
  /** The report this decision answers — marked `actioned` with it. */
  report_id?: string;
}

export interface StatusInput {
  status: LadderStep;
  /** Required for every step but `restore`. */
  reason?: string;
  /** ISO 8601; only for restrict and suspend. */
  until?: string | null;
  report_id?: string;
}

export interface StatusResult extends DecisionResult {
  status: UserStatus;
  until: string | null;
  /** A ban suspends the person's store; a restore reports it and leaves it as it is. */
  store?: { id: string; slug: string; status: string } | null;
}

export interface HistoryAction {
  id: string;
  action: ModerationAction;
  target_type: ModerationTargetType;
  target_id: string;
  reason: string;
  until: string | null;
  report_id: string | null;
  subject_user_id: string | null;
  created_at: string;
  actor: { id: string; name: string } | null;
  appeal: { id: string; state: AppealState; body: string; decision: string; decided_at: string | null; created_at: string } | null;
}

export interface HistoryAudit {
  id: number;
  action: string;
  actor: { id: string; name: string } | null;
  detail: Record<string, unknown>;
  created_at: string;
}

export interface TargetHistory {
  target: { type: ModerationTargetType; id: string };
  /** The standing now, for an account, a post or a comment; null for the other kinds. */
  current: Record<string, unknown> | null;
  actions: HistoryAction[];
  audit: HistoryAudit[];
}

export interface DeskAppeal {
  id: string;
  state: AppealState;
  body: string;
  decision: string;
  decided_at: string | null;
  created_at: string;
  user: PersonRef;
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

export interface DeskAppealPage {
  appeals: DeskAppeal[];
  next: string | null;
}

export interface AppealDecision {
  state: 'accepted' | 'rejected';
  /** True when accepting undid the decision (it was still the one in force). */
  restored: boolean;
  restore_action_id?: string | null;
  replayed?: boolean;
}

const enc = encodeURIComponent;
const BASE = '/api/admin/moderation';

function query(params: Record<string, string | number | null | undefined>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== null && v !== undefined && v !== '') p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
}

export const moderationDeskApi = {
  // ---- the queue -----------------------------------------------------------
  reports: (filters: ReportFilters = {}, cursor: string | null = null, limit = 30) =>
    api
      .get<{ reports?: ReportRow[]; next_cursor?: string | null }>(
        `${BASE}/reports${query({ state: filters.state, type: filters.type, cursor, limit })}`
      )
      .then((d): ReportPage => ({ reports: Array.isArray(d.reports) ? d.reports : [], next: d.next_cursor ?? null })),
  decideReport: (id: string, state: Exclude<ReportState, 'open'>, resolution = '') =>
    api.post<{ state: ReportState; replayed?: boolean }>(`${BASE}/reports/${enc(id)}`, { state, resolution }),

  // ---- content -------------------------------------------------------------
  hidePost: (id: string, input: HideInput) => api.post<DecisionResult & { hidden: boolean }>(`${BASE}/posts/${enc(id)}/hide`, input),
  hideComment: (id: string, input: HideInput) => api.post<DecisionResult & { hidden: boolean }>(`${BASE}/comments/${enc(id)}/hide`, input),
  hideRequestComment: (id: string, input: HideInput) =>
    api.post<DecisionResult & { hidden: boolean }>(`${BASE}/request-comments/${enc(id)}/hide`, input),

  // ---- accounts ------------------------------------------------------------
  setStatus: (userId: string, input: StatusInput) => api.post<StatusResult>(`${BASE}/users/${enc(userId)}/status`, input),

  // ---- one target's history -----------------------------------------------
  history: (targetType: ModerationTargetType, targetId: string) =>
    api.get<TargetHistory>(`${BASE}/audit${query({ target_type: targetType, target_id: targetId })}`),

  // ---- appeals -------------------------------------------------------------
  appeals: (state: AppealState | 'all' = 'open', cursor: string | null = null, limit = 30) =>
    api
      .get<{ appeals?: DeskAppeal[]; next_cursor?: string | null }>(`${BASE}/appeals${query({ state, cursor, limit })}`)
      .then((d): DeskAppealPage => ({ appeals: Array.isArray(d.appeals) ? d.appeals : [], next: d.next_cursor ?? null })),
  decideAppeal: (id: string, state: 'accepted' | 'rejected', decision = '') =>
    api.post<AppealDecision>(`${BASE}/appeals/${enc(id)}`, { state, decision: decision.slice(0, APPEAL_DECISION_MAX) }),
};
