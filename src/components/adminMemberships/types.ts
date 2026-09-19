/**
 * The shapes the members console reads, mirrored from the handler that
 * produces them: `GET /api/support/admin/members/:userId` in
 * worker/routes/support.ts.
 *
 * ---------------------------------------------------------------------------
 * EVERY FIGURE OF MONEY IS OPTIONAL HERE, AND THAT IS THE MANDATE WRITTEN AS A
 * TYPE.
 *
 *   «cost وجميع تفاصيل الربح متاحة فقط للمالك/الدور المالي. مساعد الأدمن
 *    العادي لا يراها في API ولا في HTML ولا في export»
 *
 * worker/lib/adminScope.ts states the rule in prose and calls it what it is:
 * "an AUTHORIZATION rule, not a display preference. Every financial field must
 * be removed on the SERVER, before serialization, so that reading the raw API
 * response, the HTML or a downloaded file reveals nothing."
 *
 * The sibling profile already obeys it. `GET /api/admin/users/:id/detail`
 * never even RUNS the money queries for a restricted admin, so the `financial`
 * key is absent from the response, and src/components/adminUsers/types.ts
 * types it `?` for exactly this reason: TypeScript then refuses to let the
 * screen read a lifetime value without first proving it was given one.
 *
 * THIS ENDPOINT NOW OBEYS IT TOO. `/api/support/admin/members/:userId` was
 * mounted behind `requireAdmin` ALONE and sent the BNPL credit limit, the
 * outstanding debt, the available credit, every ledger amount and every
 * membership's `price_paid_iqd` to any administrator — an assistant included.
 * It now computes `canViewFinancials` and OMITS those keys, returning
 * `can_view_financials: false` beside them, and tests/memberFinancialScope.
 * test.ts reads the raw body to prove none of the digits are in it. The gate
 * had to be on the server: hiding a number the response still carries leaves
 * it in the devtools network tab, in a saved copy of the page and in any
 * export, which is the wording §11 uses.
 *
 * Typing the figures `?` was never decoration, and it is why the fix needed no
 * change here: the window draws a figure only where one arrived, so a stripped
 * response becomes the «محجوب» note and not `NaN د.ع` or a crash on
 * `.toLocaleString()` of undefined. `| null` rides with the `?` because a gate
 * written the other common way — nulling the fields rather than deleting the
 * keys — would otherwise reach `Math.round(null)` and print a confident 0.
 */

/** A row of the members table — `GET /api/support/admin/members`. */
export interface MemberRow {
  id: string;
  email: string;
  username: string | null;
  name: string;
  created_at: string;
  tier: 'free' | 'plus' | 'pro' | 'prime';
  membership_state: string;
  expires_at: string | null;
  kyc_state: string | null;
  active_restrictions: number;
  has_approved_address: boolean;
}

export interface RestrictionCase {
  id: string;
  case_type: string;
  kind: string;
  state: 'active' | 'resolved';
  reason: string;
  evidence: string[];
  benefit_flags: string[];
  decision: 'pause' | 'revoke' | null;
  decision_reason: string;
  opened_by: string;
  opened_at: string;
  resolved_by: string | null;
  resolved_at: string | null;
}

/**
 * One purchased or granted membership. `price_paid_iqd` is what this member
 * PAID — revenue attributable to one account, which is the same class of fact
 * as the lifetime value §11 keeps from an assistant, so it is optional like
 * every other figure of money on this screen.
 */
export interface MembershipRow {
  id: string;
  plan_id: string;
  tier: string;
  state: string;
  duration_months: number;
  price_paid_iqd?: number | null;
  purchased_at: string;
  starts_at: string | null;
  expires_at: string | null;
  source: string;
}

/** Identity STATE only — never a decrypted field and never an evidence key. */
export interface KycCaseRow {
  id: string;
  case_type: string;
  doc_type: string | null;
  state: string;
  reason: string;
  submitted_at: string | null;
  decided_at: string | null;
  created_at: string;
}

export interface ApprovedAddressRow {
  id: string;
  version: number;
  state: string;
  name: string;
  address: string;
  landmark: string;
  requested_at: string;
  approved_at: string | null;
}

/** An immutable debt movement. The KIND is operations; the AMOUNT is money. */
export interface BnplLedgerRow {
  id: string;
  kind: string;
  amount_iqd?: number | null;
  due_at: string | null;
  created_at: string;
}

/**
 * The BNPL credit line.
 *
 * The split is the point: whether the line EXISTS and whether this member is
 * ELIGIBLE for it are operational facts an assistant needs in order to answer
 * a customer at all — `account_state` is 'approved' or 'suspended', and
 * `eligible` is a yes or a no. The SIZE of the line, what is owed against it
 * and what is left are money.
 */
export interface MemberDebt {
  bnpl_enabled: boolean;
  eligible: boolean;
  eligibility_reason: string | null;
  account_state: string;
  available_iqd?: number | null;
  credit_limit_iqd?: number | null;
  outstanding_iqd?: number | null;
  ledger?: BnplLedgerRow[];
}

export interface MemberDetailData {
  user: { id: string; email: string; username: string | null; name: string; role: string; created_at: string };
  tier_status: {
    tier: string;
    active: boolean;
    expires_at: string | null;
    pending_launch: { tier: string; duration_months: number } | null;
  };
  memberships: MembershipRow[];
  kyc_cases: KycCaseRow[];
  benefit_context: {
    tier: string;
    tier_active: boolean;
    gated_benefit_flags: string[];
    restrictable_benefits: readonly string[];
    note: string;
  };
  approved_addresses: ApprovedAddressRow[];
  debt: MemberDebt;
  restriction_cases: RestrictionCase[];
  support_ticket_count: number;
}
