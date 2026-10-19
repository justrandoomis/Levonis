/**
 * «يُفعَّل بعد اعتماد متجرك» — THE ONE SENTENCE FOR A CONTROL THE APPROVAL GATE
 * HOLDS (Community V3 push 1.3, wave 1; DECISIONS row 260).
 *
 * A merchant no reviewer has approved sees every control that would make a
 * NEW public promise — Publish a product, Send an offer, Publish the design,
 * quick-create — still there, disabled, with this sentence beside it: never a
 * silent grey button (Shopify's blocked-action pattern, our words). A server
 * refusal with the same cause — 403 MERCHANT_NOT_APPROVED — is the same
 * sentence in its toast: `REFUSAL_STRINGS.MERCHANT_NOT_APPROVED` carries these
 * words (src/lib/refusalStrings.ts — written out there so that table does not
 * preload this chunk; tests/merchantApprovalWave1Ui.test.ts holds them
 * equal), so every door that maps a refusal code says it without knowing
 * about approval.
 *
 * ONE mapper for both spellings of the cause: the server's refusal code and
 * the selling reason `/api/merchant/me` reports (`selling.reason`). Drafts —
 * product drafts and the store-page draft — are never held by it.
 *
 * Tiny on purpose: the workspace frame reads it (its byte budget is
 * tests/bundleBudget.test.ts), and it imports nothing.
 */

/** The server's refusal code (worker/lib/merchantApproval.ts `merchantNotApprovedRefusal`). */
export const APPROVAL_GATE_CODE = 'MERCHANT_NOT_APPROVED';
/** The selling reason (worker/lib/merchantAuth.ts `sellingVerdict`). */
export const APPROVAL_GATE_REASON = 'not_approved';

export const APPROVAL_GATE_WORDS = {
  ar: 'يُفعَّل بعد اعتماد متجرك',
  en: 'Available once your store is approved',
  ckb: 'دوای پەسەندکردنی فرۆشگاکەت چالاک دەبێت',
} as const;

type Loc = (ar: string, en: string, ckb?: string) => string;

/** Is this the approval gate — a refusal (`{code}`), an `ApiError`, a code or a selling reason? */
export function isApprovalGate(cause: unknown): boolean {
  const code = typeof cause === 'string' ? cause : cause && typeof cause === 'object' ? (cause as { code?: unknown }).code : undefined;
  return code === APPROVAL_GATE_CODE || code === APPROVAL_GATE_REASON;
}

/** The sentence, in the reader's language. */
export function approvalGateText(loc: Loc): string {
  return loc(APPROVAL_GATE_WORDS.ar, APPROVAL_GATE_WORDS.en, APPROVAL_GATE_WORDS.ckb);
}

/**
 * The hint under a disabled control: the gate's sentence when the gate is
 * what holds it, else the caller's own reason (a pause, a lapsed PLUS…).
 */
export function gateHint(cause: unknown, loc: Loc, otherwise?: string): string | undefined {
  return isApprovalGate(cause) ? approvalGateText(loc) : otherwise;
}
