/**
 * TWO MORE DESKS ON THE C5 PATTERN (P1-02, DECISIONS row 261).
 *
 * «التحقق والعناوين» (`/api/kyc/admin/*`) and «الشكاوى والنزاعات»
 * (`/api/admin/community/complaints*`) answered any admin, assistants
 * included, while spec acceptance 07 says an assistant without the owner's
 * permission reads no KYC. They now follow the merchant-review rule (owner
 * decision C5): the owner and full-scope admins by default, an assistant
 * admin only with a live KYC_REVIEW or DISPUTES grant the owner issued, read
 * from the grant table on every request (`canUseCapability`).
 *
 * THE REFUSAL SAYS NOTHING ABOUT A CASE. It is thrown by middleware before any
 * handler reads a row, so an assistant learns neither whether a case id
 * exists, nor a name, a document, an evidence index or a file address — the
 * same body for every path under the desk.
 *
 * NOTHING FINANCIAL. Settling a disputed escrow stays behind
 * `requireFinancialScope` (money, S10); DISPUTES opens the complaint thread,
 * its status and its replies, never a release or a refund.
 */
import type { MiddlewareHandler } from 'hono';
import type { AppContext, Env, SessionUser } from './types';
import { HttpError } from './http';
import { canUseCapability } from './merchantApproval';
import { DISPUTES_GRANT, KYC_REVIEW_GRANT } from './adminScope';

type Subject = Pick<SessionUser, 'id' | 'role' | 'email'> & { admin_scope?: string | null };
type ScopeEnv = Pick<Env, 'DB' | 'INITIAL_ADMIN_EMAIL'>;

/** The owner, a full admin, or an assistant holding KYC_REVIEW. */
export function canReviewKyc(env: ScopeEnv, user: Subject | null | undefined): Promise<boolean> {
  return canUseCapability(env, user, KYC_REVIEW_GRANT);
}

/** The owner, a full admin, or an assistant holding DISPUTES. */
export function canHandleDisputes(env: ScopeEnv, user: Subject | null | undefined): Promise<boolean> {
  return canUseCapability(env, user, DISPUTES_GRANT);
}

/** 403 for an admin outside the KYC scope. Names no case, person or file. */
export const kycReviewRefusal = () =>
  new HttpError(
    403,
    'مراجعة التحقق من الهوية والعناوين ليست ضمن صلاحياتك / Reviewing identity and address verification is not within your access',
    'KYC_REVIEW_FORBIDDEN'
  );

/** 403 for an admin outside the disputes scope. Names no complaint or party. */
export const disputesRefusal = () =>
  new HttpError(
    403,
    'معالجة الشكاوى والنزاعات ليست ضمن صلاحياتك / Handling complaints and disputes is not within your access',
    'DISPUTES_FORBIDDEN'
  );

/** After `requireAdmin`: the KYC desk's door. */
export const requireKycReviewer: MiddlewareHandler<AppContext> = async (c, next) => {
  if (!(await canReviewKyc(c.env, c.get('user')))) throw kycReviewRefusal();
  await next();
};

/** After `requireAdmin`: the complaints and disputes desk's door. */
export const requireDisputeHandler: MiddlewareHandler<AppContext> = async (c, next) => {
  if (!(await canHandleDisputes(c.env, c.get('user')))) throw disputesRefusal();
  await next();
};
