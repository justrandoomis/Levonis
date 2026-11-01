/**
 * «بانتظار تأكيد السعر النهائي» — AN ORDER BOUGHT AT AN ESTIMATED PRICE, AS ITS
 * BUYER READS IT (docs/SMART_PRICING.md §5.3–5.5, §6.4–6.5; DECISIONS rows
 * 280–281; WP11).
 *
 * A LAZY CHUNK. The order page, its lines and the order list mount it only for
 * an order holding a line sold at an estimated price — the server's
 * `items[].price_estimate.state` — so no other order ever downloads it, nor the
 * contract of words it reads (packages/contracts/src/priceEstimates.ts, which
 * neither page imports).
 *
 * THREE PIECES, ONE CHUNK:
 *   - the default export, the order page's banner while the final price is not
 *     settled: the state in words, the notice while the price is still open,
 *     the line that says the order can still be cancelled, and «تواصل معنا
 *     لمزيد من المعلومات», which hands the support page the order (`orderId`)
 *     with the ticket subject — and sends nothing by itself;
 *   - `EstimateLineChip`, each estimated line's state on the order page;
 *   - `EstimateOrderChip`, the order list's small «بانتظار تأكيد السعر النهائي».
 *
 * WHAT IT NEVER SAYS: a source, a supplier price, a flag, a type or a measure
 * (invariant I6). It reads line states and the order's own line names; every
 * sentence is the contract's own, in the reader's language.
 *
 * WHY THE BANNER DOES NOT ASK TWICE. A line is `proposed` only inside the 0140
 * proposal that holds the order (`price_hold_id`, trigger T11), and the
 * approval card at the top of the page asks for exactly that decision
 * (src/components/orders/PriceApprovalCard.tsx, its estimate variant). A second
 * «مطلوب موافقتك» under it would be the same question twice, so while that card
 * asks, the banner keeps only what the card does not say: that the order can
 * still be cancelled, and «تواصل معنا» — a customer weighing a new price is the
 * one most likely to want to ask about it.
 */
import { Link } from 'react-router-dom';
import { CheckCircle2, Clock } from 'lucide-react';
import { useLanguage } from '../../LanguageContext';
import type { ApiOrder, EstimateLineState } from '../../lib/api';
import {
  ESTIMATE_SETTLED_STATES,
  ESTIMATE_STRINGS,
  ESTIMATE_UNSETTLED_STATES,
  estimateLineText,
  isEstimateLineState,
  type EstimateLang,
} from '../../../packages/contracts/src/priceEstimates';
import { ESTIMATE_SUPPORT_PATH, estimateSupportState } from '../product/EstimateNotice';

const asEstimateLang = (lang: string): EstimateLang => (lang === 'en' || lang === 'ckb' ? lang : 'ar');

const isUnsettled = (state: EstimateLineState): boolean => (ESTIMATE_UNSETTLED_STATES as readonly string[]).includes(state);
const isSettled = (state: EstimateLineState): boolean => (ESTIMATE_SETTLED_STATES as readonly string[]).includes(state);

/** The states of an order's estimated lines, in line order (the server records ordinary lines only — never a gift or a part). */
export function estimateStatesOf(order: Pick<ApiOrder, 'items'>): EstimateLineState[] {
  return order.items.flatMap((it) => (it.price_estimate && isEstimateLineState(it.price_estimate.state) ? [it.price_estimate.state] : []));
}

/**
 * What the order page's banner says, or null when nothing waits on the final
 * price. A rejection first — the customer chose, and the next move is theirs or
 * ours — then a price still open, then a proposal. A cancelled order holds
 * nothing (its lines are void, trigger T10).
 */
export function estimateBannerState(order: Pick<ApiOrder, 'items' | 'status'>): 'open' | 'proposed' | 'rejected' | null {
  if (order.status === 'cancelled') return null;
  const states = estimateStatesOf(order);
  if (states.includes('rejected')) return 'rejected';
  if (states.includes('open')) return 'open';
  if (states.includes('proposed')) return 'proposed';
  return null;
}

/** A proposed line whose held proposal the approval card above is asking about: the banner does not ask again. */
export function estimateAskedAbove(order: Pick<ApiOrder, 'items' | 'status' | 'price_hold_id'>): boolean {
  return estimateBannerState(order) === 'proposed' && !!order.price_hold_id;
}

/**
 * The order list's chip: «مطلوب موافقتك على السعر النهائي» while a proposal
 * waits on the customer, «بانتظار تأكيد السعر النهائي» while any other line is
 * unsettled, nothing once every line is settled.
 */
export function estimateListState(states: readonly EstimateLineState[]): 'open' | 'proposed' | null {
  if (states.includes('proposed')) return 'proposed';
  return states.some(isUnsettled) ? 'open' : null;
}

/**
 * The name the support ticket's subject carries: the estimated line's product
 * (English in every language, product-form mandate §3), and how many more when
 * there are several. The order itself travels beside it as `orderId`.
 */
export function estimateSubjectName(order: Pick<ApiOrder, 'id' | 'items'>): string {
  const names = [...new Set(order.items.filter((it) => !!it.price_estimate).map((it) => it.name.trim()).filter(Boolean))];
  if (names.length === 0) return order.id;
  return names.length > 1 ? `${names[0]} +${names.length - 1}` : names[0];
}

/** The router state «تواصل معنا» hands the support page: the subject in the reader's language, and the order. */
export function estimateOrderSupport(order: Pick<ApiOrder, 'id' | 'items'>, lang: EstimateLang): { subject: string; orderId?: string } {
  return estimateSupportState(estimateSubjectName(order), lang, order.id);
}

export default function EstimateStatusCard({ order }: { order: ApiOrder }) {
  const { lang } = useLanguage();
  const l = asEstimateLang(lang);
  const state = estimateBannerState(order);
  if (!state) return null;
  // The customer may leave until the price is settled (§6.4): said wherever the order can still be cancelled —
  // a rejection's own sentence already says it.
  const canCancel = order.status === 'pending' && order.can_cancel !== false && state !== 'rejected';
  const contact = (
    <Link
      to={ESTIMATE_SUPPORT_PATH}
      state={estimateOrderSupport(order, l)}
      data-estimate-contact
      className="inline-flex min-h-11 items-center text-[12px] font-bold text-text-primary underline underline-offset-2 hover:text-text-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus rounded"
    >
      {ESTIMATE_STRINGS.contact[l]}
    </Link>
  );
  if (estimateAskedAbove(order)) {
    // The approval card above asks the question; this keeps the way out and the way to ask.
    return (
      <div data-estimate-status={state} data-estimate-asked-above className="rounded-2xl border border-border-subtle bg-surface px-4 py-2">
        {canCancel && (
          <p data-estimate-cancel className="pt-1 text-[12.5px] leading-relaxed text-text-secondary">
            {ESTIMATE_STRINGS.checkoutCancel[l]}
          </p>
        )}
        {contact}
      </div>
    );
  }
  return (
    <section
      data-estimate-status={state}
      aria-labelledby="estimate-status-title"
      className="rounded-2xl border border-warning/40 bg-warning/10 p-4 space-y-2"
    >
      <div className="flex items-start gap-3">
        <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-warning/15 text-warning" aria-hidden="true">
          <Clock className="h-5 w-5" />
        </span>
        <div className="min-w-0 space-y-1">
          <h2 id="estimate-status-title" className="text-[14px] font-bold leading-snug text-text-primary">
            {estimateLineText(state, l)}
          </h2>
          {state === 'open' && <p className="text-[12.5px] leading-relaxed text-text-secondary">{ESTIMATE_STRINGS.notice[l]}</p>}
          {canCancel && (
            <p data-estimate-cancel className="text-[12.5px] leading-relaxed text-text-secondary">
              {ESTIMATE_STRINGS.checkoutCancel[l]}
            </p>
          )}
        </div>
      </div>
      <div className="ps-12">{contact}</div>
    </section>
  );
}

/** One estimated line's state on the order page — nothing for a void line (a cancelled order's). */
export function EstimateLineChip({ state }: { state: EstimateLineState }) {
  const { lang } = useLanguage();
  const text = estimateLineText(state, asEstimateLang(lang));
  if (!text) return null;
  const settled = isSettled(state);
  return (
    <p
      data-estimate-line={state}
      className={`mt-1 inline-flex max-w-full items-start gap-1 rounded px-2 py-0.5 text-[11px] font-bold leading-relaxed ${
        settled ? 'bg-success/10 text-success' : 'bg-warning/10 text-warning'
      }`}
    >
      {settled ? (
        <CheckCircle2 className="mt-0.5 h-3 w-3 shrink-0" aria-hidden="true" />
      ) : (
        <Clock className="mt-0.5 h-3 w-3 shrink-0" aria-hidden="true" />
      )}
      <span className="min-w-0">{text}</span>
    </p>
  );
}

/** The order list's chip (src/components/orders/OrderCard.tsx): drawn only while a line waits on its final price. */
export function EstimateOrderChip({ states }: { states: readonly EstimateLineState[] }) {
  const { lang } = useLanguage();
  const state = estimateListState(states);
  if (!state) return null;
  return (
    <p
      data-order-card-estimate={state}
      className="mt-1.5 inline-flex items-center gap-1 rounded px-2 py-0.5 w-max max-w-full bg-warning/10 text-warning text-[11px] font-bold"
    >
      <Clock className="w-3 h-3 shrink-0" aria-hidden="true" />
      <span className="truncate">{estimateLineText(state, asEstimateLang(lang))}</span>
    </p>
  );
}
