/**
 * THE PRODUCT PAGE'S QUICK BUY, AS A LAZY CHUNK (docs/GIFTS_QUICK_BUY.md §3.5).
 *
 * The page imports this after it has painted, and on the first press of ⚡
 * (warmed on pointerdown and focus), so the product's opening never carries
 * the typed client, the feature's sentences or the refusals.
 *
 * Two questions live here:
 *
 *   READINESS — may an add go through, or does the account first need the
 *   activation sheet? Read from GET /api/quick-buy/profile: not enabled, a
 *   policy to accept again, or a saved address that was deleted opens the
 *   sheet ON THE PAGE; nothing navigates to settings.
 *
 *   THE ADD — POST /api/quick-buy/items with the page's own selection, under
 *   one idempotency key per action: a retry of the same tap (the toast's
 *   «إعادة المحاولة», a second press after a dropped connection) resends the
 *   SAME key, so a lost answer can never become a second item and a second
 *   hold. Success is said in a toast with the server's remaining time and the
 *   way to the order; every refusal is said in the customer's language, with
 *   the numbers the server sent (the wallet's available and required amounts,
 *   the units left). A printer is refused until the customer accepts the
 *   standard-delivery warning once in the session: the page shows it, and on
 *   an explicit accept the same request goes again, same key, with the
 *   acceptance.
 */
import { ApiError } from '../../lib/api';
import {
  addQuickBuyItem,
  getQuickBuyProfile,
  IdempotentAction,
  isQuickBuyRetryable,
  printerPolicyOf,
  quickBuyReady,
  refusalNumber,
  withBusyRetry,
  type QuickBuyAddInput,
  type QuickBuyPrinterAcceptance,
  type QuickBuyPrinterPolicy,
  type QuickBuyProfile,
  type QuickBuySessionView,
} from '../../lib/quickBuy';
import { formatQuickBuyClock } from '../../lib/quickBuyStore';
import { toast } from '../../lib/toastStore';
import { quickBuyRefusal, quickBuyStrings } from './strings';

/** What the account needs before an add can go through. */
export type QuickBuyReadiness = 'ready' | 'activate' | 'reconsent' | 'address' | 'unknown';

/**
 * The sheet's faces: first activation; accepting changed policies again; a
 * new address for one that was deleted; and, for a printer, the
 * standard-delivery warning to accept before the add goes through.
 */
export type QuickBuySheetMode = 'activate' | 'reconsent' | 'address' | 'printer';

export function readinessOf(profile: QuickBuyProfile): QuickBuyReadiness {
  if (quickBuyReady(profile)) return 'ready';
  // Never accepted, or switched off: the whole sheet, consents first.
  if (!profile.enabled || !profile.consent.consented_at) return 'activate';
  // A policy moved: both steps again (the address step offers a new one if it is gone too).
  if (profile.needs_consent) return 'reconsent';
  // On and consented, but the saved address is gone: only a new address.
  return 'address';
}

/**
 * The profile as of the last minute (⚡ pressed twice asks once). A
 * failure is `unknown`: the add itself is still refused by the server if the
 * account is not ready, and that refusal opens the sheet then.
 */
type ReadinessAnswer = { state: QuickBuyReadiness; profile: QuickBuyProfile | null };
let asking: { owner: string; promise: Promise<ReadinessAnswer> } | null = null;

export function quickBuyReadiness(owner: string | null | undefined): Promise<ReadinessAnswer> {
  // The page asks after it paints and again when a finger lands on ⚡: one request answers both.
  if (asking && asking.owner === (owner ?? '')) return asking.promise;
  const promise = getQuickBuyProfile(owner, { maxAgeMs: 60_000 }).then(
    (profile) => ({ state: readinessOf(profile), profile }),
    () => ({ state: 'unknown' as const, profile: null })
  );
  const entry = { owner: owner ?? '', promise };
  asking = entry;
  void promise.then(() => {
    if (asking === entry) asking = null;
  });
  return promise;
}

export interface QuickBuyAddContext {
  /** The signed-in account the session is filed under (src/lib/quickBuyStore.ts). */
  owner: string | null | undefined;
  lang: string;
  /** Formats a dinar amount the way the reader reads prices (the wallet's figures). */
  money: (iqd: number) => string;
  navigate: (to: string) => void;
  /** Press the same button again — the toast's retry. Same selection, same key. */
  retry: () => void;
}

export type QuickBuyAddOutcome =
  | { kind: 'added'; remainingMs: number }
  /** The account must activate, accept again or choose a new address first: open the sheet in that face. */
  | { kind: 'activate' | 'reconsent' | 'address' }
  /** A printer: the warning to accept, then the SAME request again — `quickBuyAdd` with `printerAcceptance`. */
  | { kind: 'printer'; policy: QuickBuyPrinterPolicy }
  /** Refused; `available` is the units the server says are left, when it said. */
  | { kind: 'refused'; code: string; available: number | null }
  | { kind: 'aborted' };

/** One action's key across its retries (src/lib/quickBuy.ts `IdempotentAction`). */
const addAction = new IdempotentAction();

/**
 * The printer warning accepted for the outstanding action: a retry of that
 * action (the toast's «إعادة المحاولة» after a dropped answer) carries it
 * again with the same key. It never outlives the action — the acceptance is
 * for this order, and the next purchase asks on its own if it needs to.
 */
let accepted: { signature: string; acceptance: QuickBuyPrinterAcceptance } | null = null;

/** The server's own remaining time for this session, in ms. */
function remainingOf(session: QuickBuySessionView | null | undefined): number {
  if (!session) return 0;
  if (Number.isFinite(session.remaining_ms)) return Math.max(0, session.remaining_ms);
  const end = Date.parse(session.expires_at);
  const now = Date.parse(session.server_now);
  return Number.isFinite(end) && Number.isFinite(now) ? Math.max(0, end - now) : 0;
}

/**
 * The request as one string: the same request is the same action. It is the
 * selection only, as the server's request hash is (worker/lib/quickBuy/
 * session.ts `requestHash` over the parsed add): the printer acceptance is
 * not part of either, so accepting the warning resends the same request
 * under the same key.
 */
export function addSignature(input: QuickBuyAddInput): string {
  return JSON.stringify([
    input.productId,
    input.qty,
    input.optionId ?? '',
    input.optionValueIds ?? [],
    input.colorId ?? '',
    input.warrantyPlanId ?? '',
  ]);
}

/** «Bidi-isolated» clock: «الوقت المتبقي 28:42» never reorders around its colon. */
const isolate = (text: string) => `⁦${text}⁩`;

export async function quickBuyAdd(input: QuickBuyAddInput, ctx: QuickBuyAddContext): Promise<QuickBuyAddOutcome> {
  const t = quickBuyStrings(ctx.lang);
  const signature = addSignature(input);
  if (input.printerAcceptance) accepted = { signature, acceptance: input.printerAcceptance };
  else if (accepted?.signature !== signature) accepted = null;
  const request: QuickBuyAddInput = accepted ? { ...input, printerAcceptance: accepted.acceptance } : input;
  try {
    const out = await addAction.run(signature, (key) => withBusyRetry(() => addQuickBuyItem(request, key, ctx.owner)));
    accepted = null;
    const remainingMs = remainingOf(out.session);
    toast.success(t.added, {
      id: 'quick-buy',
      description: t.remaining(isolate(formatQuickBuyClock(remainingMs))),
      action: { label: t.viewOrder, onClick: () => ctx.navigate('/orders') },
    });
    return { kind: 'added', remainingMs };
  } catch (err) {
    if (!isQuickBuyRetryable(err)) accepted = null;
    if (err instanceof ApiError && err.code === 'ABORTED') return { kind: 'aborted' };
    const code = err instanceof ApiError ? err.code ?? '' : '';
    // The sheet is the answer, not a sentence: not activated, a policy
    // changed, the saved address is gone, or a printer's warning to accept.
    if (code === 'QUICK_BUY_NOT_ACTIVE') return { kind: 'activate' };
    if (code === 'QUICK_BUY_RECONSENT_REQUIRED') return { kind: 'reconsent' };
    if (code === 'QUICK_BUY_ADDRESS_INVALID') return { kind: 'address' };
    const policy = printerPolicyOf(err);
    if (policy) return { kind: 'printer', policy };
    const said = quickBuyRefusal(err, ctx.lang, ctx.money);
    const action =
      code === 'QUICK_BUY_INSUFFICIENT_BALANCE'
        ? { label: t.topUp, onClick: () => ctx.navigate('/wallet') }
        : code === 'QUICK_BUY_FULL'
          ? { label: t.viewOrder, onClick: () => ctx.navigate('/orders') }
          : isQuickBuyRetryable(err) || code === 'QUICK_BUY_EXPIRED' || code === 'IDEMPOTENCY_KEY_REUSED'
            ? { label: t.retry, onClick: ctx.retry }
            : undefined;
    toast.error(said.title, { id: 'quick-buy', description: said.description, action });
    return { kind: 'refused', code, available: refusalNumber(err, 'available') };
  }
}
