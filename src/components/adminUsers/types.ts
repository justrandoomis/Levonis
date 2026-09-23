/**
 * The shapes the member/authority screens read, mirrored from the handlers
 * that produce them in worker/routes/admin.ts and worker/routes/telegram.ts.
 *
 * `financial` IS OPTIONAL HERE BECAUSE IT IS OPTIONAL ON THE WIRE — that is the
 * whole mandate, expressed as a type.
 *
 *   «cost وجميع تفاصيل الربح متاحة فقط للمالك/الدور المالي. مساعد الأدمن
 *    العادي لا يراها في API ولا في HTML ولا في export»
 *
 * The server does not send an empty object, a zero or a null for a restricted
 * admin: it never runs the queries, so the KEY IS ABSENT. Typing it as `?`
 * rather than `| null` means TypeScript refuses to let this screen read a
 * lifetime value without first proving it was given one, and every financial
 * figure below is therefore unreachable in a build where the account may not
 * see money. A `| null` would have let `financial!.lifetime_value_iqd` compile.
 */

export type AdminScope = 'full' | 'assistant' | null;

/** The identity-only answer of GET /api/admin/users/lookup. */
export interface UserLookupResult {
  id: string;
  email: string;
  username: string | null;
  name: string;
  role: 'customer' | 'merchant' | 'admin';
  admin_scope: AdminScope;
  membership_tier: string;
  created_at: string;
  /** INITIAL_ADMIN_EMAIL — can never be demoted or restricted. */
  is_owner: boolean;
  /** The acting admin's own row — nobody removes their own administrator role. */
  is_self: boolean;
}

export interface MemberRestriction {
  id: string;
  kind: string;
  case_type: string;
  state: string;
  reason: string;
  benefit_flags: string[];
  opened_at: string;
  resolved_at: string | null;
}

export interface MemberChannel {
  channel: string;
  enabled: boolean;
  is_primary: boolean;
  updated_at: string;
}

export interface MemberDetail {
  identity: {
    id: string;
    email: string;
    username: string | null;
    name: string;
    role: 'customer' | 'merchant' | 'admin';
    admin_scope: AdminScope;
    is_owner: boolean;
    is_self: boolean;
    phone_e164: string | null;
    country: string | null;
    locale: string;
    email_verified_at: string | null;
    onboarding_state: string | null;
    created_at: string;
    updated_at: string;
  };
  membership: {
    tier: string;
    legacy_plan: string;
    /** Epoch ms; 0 = no term. */
    expiry: number;
    term_days: number;
    is_investor: boolean;
    checkin_streak: number;
  };
  activity: {
    orders_total: number;
    orders_delivered: number;
    orders_cancelled: number;
    orders_open: number;
    last_order_at: string | null;
    /** A FLOOR, not a fact: expired and signed-out sessions are deleted. */
    newest_session_at: string | null;
    live_sessions: number;
  };
  kyc: { state: string; reason: string; submitted_at: string | null; decided_at: string | null } | null;
  restrictions: MemberRestriction[];
  active_restrictions: number;
  channels: MemberChannel[];
  approved_address: { version: number; state: string; requested_at: string | null; approved_at: string | null } | null;
  bnpl_state: string;
}

/** Present ONLY for an account the server judged financial. */
export interface MemberFinancial {
  lifetime_value_iqd: number;
  delivered_value_iqd: number;
  /** SPENDABLE cents (settled minus holds) — what the member can use. */
  wallet_usd_cents: number;
  /** The same balance in the member's dinars (migration 0108), as their own
   *  wallet page shows it; absent from a server older than the field. */
  wallet_iqd?: number;
  wallet_points: number;
  bnpl_credit_limit_iqd: number;
  bnpl_outstanding_iqd: number;
}

export interface MemberDetailResponse {
  can_view_financials: boolean;
  member: MemberDetail;
  financial?: MemberFinancial;
}

/** A row of GET /api/telegram/admin/tg-identities. */
export interface TelegramIdentity {
  telegram_user_id: number;
  user_id: string;
  name: string;
  username: string | null;
  /** Live AND the site account is still an admin — the server decides this. */
  active: boolean;
  site_role: string;
  label: string;
  created_at: string;
  created_by: string | null;
  revoked_at: string | null;
  revoke_reason: string;
}
