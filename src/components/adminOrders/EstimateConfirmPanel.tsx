/**
 * «تأكيد السعر النهائي» — THE ADMIN HALF OF AN ESTIMATED PRICE (migration
 * 0218; docs/SMART_PRICING.md §6.5, §7; DECISIONS row 280). The server is
 * worker/routes/orderPriceAdjust.ts (`GET /:id/price-estimate`,
 * `POST /:id/price-estimate/confirm`) over worker/lib/orderEstimates.ts.
 *
 * An order holding lines sold at an estimated pre-order price waits at «تم
 * استلام الطلب» until every one of them is settled: the database refuses to
 * confirm, prepare, ship or book a courier before then (trigger T8). This is
 * where they are settled. Per line it shows the price the customer ordered at,
 * the SKU × route's published price today and a final-price input (a line
 * bought under an offer also shows the price before the offer and the same
 * offer on today's price, which «استخدم سعر اليوم بنفس العرض» proposes), and it
 * offers the two acts the owner named:
 *   · «تأكيد السعر كما هو» — every waiting line at its estimate. No money
 *     moves; the customer is told in-app; the order may then move on;
 *   · «إرسال السعر النهائي للزبون» — the typed finals. When the total does not
 *     change the server confirms them the same way. When it does, the ordinary
 *     0140 proposal asks the customer, and nothing extra is ever charged
 *     without their approval (invariant I5).
 *
 * CUSTOMER PRICES ONLY (invariant I6). The read carries the estimate, today's
 * published price and the final — final prices a customer could be charged,
 * never a cost, a supplier price, a rate or a profit — so ANY admin may open
 * the panel. Only a financial admin (the owner or the financial role) may act:
 * the server's `can_confirm`, with `requireFinancialScope` on the POST behind
 * it. Everyone else reads the same lines and one sentence saying who acts.
 *
 * THE PREVIEW IS THE SERVER'S RULE, not a copy of it: each final is checked
 * with the one rounding rule (`isOnPriceRule`, DECISIONS row 245) and the
 * money preview is `planPriceAdjustment` — the functions the Worker settles
 * with — so «سيصبح المستحق عند التسليم» cannot disagree with what approval does.
 *
 * The idempotency key is minted once per panel and kept across retries, so a
 * double press or a lost answer never files two proposals; another body on the
 * same key is refused (IDEMPOTENCY_KEY_REUSED) rather than answered.
 *
 * Every word is in Arabic, English and Sorani (DECISIONS row 183); the estimate
 * refusals and the label are the contract's (packages/contracts/src/
 * priceEstimates.ts), which this lazy admin chunk may import.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { CheckCircle2, Send } from 'lucide-react';
import { useLanguage } from '../../LanguageContext';
import {
  api,
  formatIqd,
  type AdminOrderEstimateConfirmBody,
  type AdminOrderEstimateLine,
  type AdminOrderEstimateRead,
  type EstimateLineState,
} from '../../lib/api';
import { apiRefusal, type Lang } from '../../lib/refusalStrings';
import { planPriceAdjustment, PRICE_ADJUST_MAX_IQD } from '../../../packages/pricing/src/priceAdjustment';
import { isOnPriceRule, PRICE_ROUNDING_STEP_IQD, PRICE_ROUNDING_THRESHOLD_IQD } from '../../../packages/pricing/src/priceRounding';
import { ESTIMATE_STRINGS, estimateRefusalText } from '../../../packages/contracts/src/priceEstimates';
import { Button } from '../ui/Button';
import { Field, Textarea } from '../ui/Field';
import { NumberInput } from '../ui/NumberInput';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { useToast } from '../ui/Toast';
import type { PublicAdjustment } from './PriceAdjustPanel';

// ------------------------------------------------------------------ the read

/** One line of `GET /:id/price-estimate` (`estimateLineView`): customer prices and the state. */
export type EstimatePanelLine = AdminOrderEstimateLine;

/** `GET /api/admin/orders/:id/price-estimate` (class `op`: any admin may read it). */
export interface EstimatePanelData extends AdminOrderEstimateRead {
  /** The estimate proposal waiting on the customer, if any. */
  pending: PublicAdjustment | null;
}

/** What the confirm door answers. */
interface ConfirmAnswer {
  outcome: 'confirmed' | 'proposed';
  replayed: boolean;
}

// ------------------------------------------------------------------ the rule (pure, pinned by tests/estimateAdminOrdersUi.test.ts)

/** The lines a settlement must name: every open or rejected one — the server refuses any other set. */
export const waitingLines = <T extends Pick<AdminOrderEstimateLine, 'state'>>(lines: readonly T[]): T[] =>
  lines.filter((l) => l.state === 'open' || l.state === 'rejected');

/** A final unit price the server accepts: whole dinars on the one rounding rule, under the proposal ceiling. */
export const isFinalUnitPrice = (v: unknown): v is number => typeof v === 'number' && isOnPriceRule(v) && v <= PRICE_ADJUST_MAX_IQD;

/** What the admin has typed: a final per waiting line (null while empty or unreadable), and an own total. */
export interface SettlementDraft {
  finals: Readonly<Record<string, number | null | undefined>>;
  /** The financial admin's own final total, or null to take the order's total plus the lines' difference. */
  editedTotal: number | null;
}

export interface SettlementPreview {
  /** Waiting lines whose final is missing or off the rule. */
  invalid: string[];
  /** Some waiting line's final differs from its estimate. */
  changed: boolean;
  /** Σ (final − estimate) × qty over the waiting lines. */
  delta: number;
  /** The order's total now. */
  total: number;
  /** The total the order ends at: the admin's own (only with a changed line), else the total plus the difference. */
  target: number;
  /** The total changes, so the customer is asked: a 0140 proposal. */
  asksCustomer: boolean;
}

/** The settlement the draft describes, computed as worker/lib/orderEstimates.ts `confirmEstimateFinalPrices` does. */
export function settlementPreview(data: Pick<EstimatePanelData, 'order' | 'lines'>, draft: SettlementDraft): SettlementPreview {
  const invalid: string[] = [];
  let delta = 0;
  let changed = false;
  for (const l of waitingLines(data.lines)) {
    const f = draft.finals[l.order_item_id];
    if (!isFinalUnitPrice(f)) {
      invalid.push(l.order_item_id);
      continue;
    }
    if (f !== l.estimate_unit_iqd) changed = true;
    delta += (f - l.estimate_unit_iqd) * l.qty;
  }
  const total = Math.max(0, Math.trunc(Number(data.order.total_iqd) || 0));
  // An own total only rides a changed line: with none, the server keeps the total as it is.
  const edited = changed && typeof draft.editedTotal === 'number' ? draft.editedTotal : null;
  const target = edited ?? total + delta;
  return { invalid, changed, delta, total, target, asksCustomer: invalid.length === 0 && target !== total };
}

/** «تأكيد السعر كما هو»: every waiting line at the price its customer ordered at. */
export function confirmAsIsBody(data: Pick<EstimatePanelData, 'lines'>, key: string): AdminOrderEstimateConfirmBody {
  return {
    idempotency_key: key,
    lines: waitingLines(data.lines).map((l) => ({ order_item_id: l.order_item_id, final_unit_iqd: l.estimate_unit_iqd })),
  };
}

/**
 * «إرسال السعر النهائي للزبون»: every waiting line at its typed final, the own
 * total only when some line changed, the note only when written. Null while a
 * final is unreadable or nothing changed — there is nothing to send then.
 */
export function sendFinalBody(
  data: Pick<EstimatePanelData, 'order' | 'lines'>,
  draft: SettlementDraft,
  key: string,
  note = ''
): AdminOrderEstimateConfirmBody | null {
  const p = settlementPreview(data, draft);
  if (p.invalid.length > 0 || !p.changed) return null;
  const body: AdminOrderEstimateConfirmBody = {
    idempotency_key: key,
    lines: waitingLines(data.lines).map((l) => ({ order_item_id: l.order_item_id, final_unit_iqd: draft.finals[l.order_item_id] as number })),
  };
  if (typeof draft.editedTotal === 'number') body.new_total_iqd = draft.editedTotal;
  const words = note.trim();
  if (words) body.note = words;
  return body;
}

/**
 * What «استخدم سعر اليوم» sets a line's final to, or null to hide it. A line
 * bought under an offer is compared like with like: the same offer on today's
 * price (the server's `offer_today_unit_iqd`), and nothing at all while
 * today's price is still the one before the offer.
 */
export function todayFinalOf(l: Pick<AdminOrderEstimateLine, 'current_unit_iqd' | 'offer_before_unit_iqd' | 'offer_today_unit_iqd'>): number | null {
  const current = l.current_unit_iqd ?? null;
  if (current === null) return null;
  if (typeof l.offer_before_unit_iqd !== 'number') return current;
  if (current === l.offer_before_unit_iqd) return null;
  return isFinalUnitPrice(l.offer_today_unit_iqd) ? l.offer_today_unit_iqd : null;
}

/** The typed finals after a read: what was typed is kept, a new waiting line starts at its estimate. */
function seedFinals(data: Pick<EstimatePanelData, 'lines'> | null, prev: Readonly<Record<string, number | null>>): Record<string, number | null> {
  const next: Record<string, number | null> = {};
  if (!data) return next;
  for (const l of waitingLines(data.lines)) {
    next[l.order_item_id] = Object.prototype.hasOwnProperty.call(prev, l.order_item_id) ? prev[l.order_item_id] : l.estimate_unit_iqd;
  }
  return next;
}

// ------------------------------------------------------------------ words

type Loc = (ar: string, en: string, ckb?: string) => string;

const langOf = (lang: string): Lang => (lang === 'en' ? 'en' : lang === 'ckb' ? 'ckb' : 'ar');

/** An estimate refusal in the reader's language first (the contract), then the shop's table, then the fallback. */
const refusalOf = (e: unknown, lang: Lang, fallback: string): string => estimateRefusalText(e, lang) ?? apiRefusal(e, lang, fallback);

/** Every state of an estimated line, as the admin reads it (the customer's own words are the contract's `estimateLineText`). */
export function estimateStateText(state: EstimateLineState, loc: Loc): string {
  switch (state) {
    case 'open':
      return loc('بانتظار التأكيد', 'To confirm', 'چاوەڕێی پشتڕاستکردنەوە');
    case 'proposed':
      return loc('بانتظار موافقة الزبون', 'Awaiting the customer’s approval', 'چاوەڕێی پەسەندکردنی کڕیار');
    case 'confirmed':
      return loc('مؤكَّد', 'Confirmed', 'پشتڕاستکراوە');
    case 'approved':
      return loc('وافق الزبون', 'Approved by the customer', 'کڕیار پەسەندی کرد');
    case 'rejected':
      return loc('رفض الزبون', 'Rejected by the customer', 'کڕیار ڕەتی کردەوە');
    default:
      return loc('أُلغي مع الطلب', 'Voided with the order', 'لەگەڵ داواکارییەکە هەڵوەشایەوە');
  }
}

/** Amber while the line holds the order, green once settled, quiet once void — in words, never colour alone. */
const STATE_TONE: Record<EstimateLineState, string> = {
  open: '[--chip:var(--color-warning)]',
  proposed: '[--chip:var(--color-warning)]',
  rejected: '[--chip:var(--color-warning)]',
  confirmed: '[--chip:var(--color-success)]',
  approved: '[--chip:var(--color-success)]',
  void: '[--chip:var(--color-text-secondary)]',
};

/**
 * One estimated line's state as a chip. `labelled` prefixes the label «سعر
 * تقديري» — the order's item list, where the chip is the only sign the line
 * was sold at an estimate.
 */
export function EstimateLineChip({ state, labelled = false }: { state: EstimateLineState; labelled?: boolean }) {
  const { loc, lang } = useLanguage();
  return (
    <span
      data-estimate-chip={state}
      className={`lv-chip inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] leading-[1.4] font-bold ${STATE_TONE[state] ?? STATE_TONE.open}`}
    >
      {labelled ? `${ESTIMATE_STRINGS.label[langOf(lang)]} · ` : ''}
      {estimateStateText(state, loc)}
    </span>
  );
}

const newKey = () =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `k${Date.now()}${Math.random().toString(16).slice(2)}`;

/** The line a refusal points at (an off-rule final names its `order_item_id`). */
const refusedLine = (e: unknown): string | null => {
  const item = (e as { details?: { order_item_id?: unknown } } | null)?.details?.order_item_id;
  return typeof item === 'string' && item ? item : null;
};

/** The order changed under the panel (a cancel, another admin): its lines are read again. */
const isStale = (e: unknown): boolean => (e as { code?: unknown } | null)?.code === 'PRICE_ADJUST_STALE';

/** A proposal already waits on the customer, or this key already made one: the order has moved past this panel. */
const movedOn = (e: unknown): boolean => {
  const code = (e as { code?: unknown } | null)?.code;
  return code === 'PRICE_APPROVAL_PENDING' || code === 'IDEMPOTENCY_KEY_REUSED';
};

// ------------------------------------------------------------------ the panel

export interface EstimateConfirmPanelProps {
  orderId: string;
  /** After a settlement: the caller re-reads the order (the gate opened, or a proposal now holds it). */
  onChanged: () => void | Promise<void>;
  /** A read the caller already holds; the panel still reads its own on mount. */
  initial?: EstimatePanelData | null;
}

export default function EstimateConfirmPanel({ orderId, onChanged, initial = null }: EstimateConfirmPanelProps) {
  const { loc, lang, dir } = useLanguage();
  const L = langOf(lang);
  const toast = useToast();
  // «from → to» in reading order: the arrow points the way the line is read.
  const arrow = dir === 'rtl' ? '←' : '→';
  // Words, not a sign glued to an RTL figure (a «+» beside «د.ع» flips sides under bidi).
  const signed = (n: number) =>
    `${n > 0 ? loc('زيادة', 'Increase', 'زیادبوون') : loc('تخفيض', 'Decrease', 'کەمبوونەوە')} ${formatIqd(Math.abs(n))}`;

  const [data, setData] = useState<EstimatePanelData | null>(initial);
  const [loadError, setLoadError] = useState<{ e: unknown } | null>(null);
  const [finals, setFinals] = useState<Record<string, number | null>>(() => seedFinals(initial, {}));
  const [editTotal, setEditTotal] = useState(false);
  const [total, setTotal] = useState<number | null>(null);
  const [totalValid, setTotalValid] = useState(true);
  const [note, setNote] = useState('');
  const [key, setKey] = useState(newKey);
  const [tried, setTried] = useState(false);
  const [formError, setFormError] = useState('');
  const [lineError, setLineError] = useState<string | null>(null);
  // The «as it is» question is mounted on first use and then kept, so it can be seen leaving.
  const [askMounted, setAskMounted] = useState(false);
  const [askOpen, setAskOpen] = useState(false);
  const [askError, setAskError] = useState('');

  // Deps are the order only: the sentence for a failure is chosen at render, in the reader's language.
  const load = useCallback(async () => {
    try {
      const next = await api.get<EstimatePanelData>(`/api/admin/orders/${encodeURIComponent(orderId)}/price-estimate`);
      setData(next);
      setFinals((prev) => seedFinals(next, prev));
      setLoadError(null);
    } catch (e) {
      setLoadError({ e });
    }
  }, [orderId]);

  useEffect(() => {
    void load();
  }, [load]);

  const ownTotal = editTotal && totalValid && total !== null && total > 0 ? total : null;
  const preview = useMemo(
    () => (data ? settlementPreview(data, { finals, editedTotal: ownTotal }) : null),
    [data, finals, ownTotal]
  );
  const plan = useMemo(() => {
    if (!data || !preview || !preview.asksCustomer || preview.target <= 0) return null;
    return planPriceAdjustment({
      totalIqd: data.order.total_iqd,
      dueOnDeliveryIqd: data.order.due_on_delivery_iqd,
      walletAppliedIqd: data.order.wallet_applied_iqd,
      paymentMethodId: data.order.payment_method_id,
      newTotalIqd: preview.target,
    });
  }, [data, preview]);

  /** POSTs one settlement. Empty when nothing is left to show here; else the sentence to show where it was asked. */
  const post = async (body: AdminOrderEstimateConfirmBody): Promise<string> => {
    setLineError(null);
    let res: ConfirmAnswer;
    try {
      res = await api.post<ConfirmAnswer>(`/api/admin/orders/${encodeURIComponent(orderId)}/price-estimate/confirm`, body);
    } catch (e) {
      const sentence = refusalOf(e, L, loc('تعذّر حفظ السعر النهائي.', 'The final price could not be saved.', 'نرخی کۆتایی پاشەکەوت نەکرا.'));
      if (movedOn(e)) {
        // A proposal already holds the order — another admin's, or this very
        // request's whose answer was lost. The caller re-reads and shows it;
        // the sentence travels as a toast, because this panel gives way.
        toast.error(sentence);
        setKey(newKey());
        await onChanged();
        return '';
      }
      setLineError(refusedLine(e));
      if (isStale(e)) void load();
      return sentence;
    }
    // It landed: say what happened, then the panel and the order are read again.
    toast.success(
      res.outcome === 'proposed'
        ? loc(
            'أُرسل السعر النهائي للزبون — الطلب معلّق حتى يقرر.',
            'The final price was sent to the customer — the order is on hold until they decide.',
            'نرخی کۆتایی بۆ کڕیار نێردرا — داواکارییەکە ڕادەگیرێت تا کڕیار بڕیار دەدات.'
          )
        : loc(
            'تأكّد السعر النهائي — يمكن الآن تأكيد الطلب وتجهيزه.',
            'Final price confirmed — the order can now be confirmed and prepared.',
            'نرخی کۆتایی پشتڕاست کرایەوە — ئێستا دەتوانرێت داواکارییەکە پشتڕاست بکرێتەوە و ئامادە بکرێت.'
          )
    );
    setKey(newKey());
    setTried(false);
    setFormError('');
    setEditTotal(false);
    setTotal(null);
    setNote('');
    setFinals({});
    await load();
    await onChanged();
    return '';
  };

  const send = async () => {
    if (!data || !preview) return;
    setTried(true);
    setFormError('');
    if (editTotal && ownTotal === null) return;
    if (plan && plan.ok === false) return;
    const body = sendFinalBody(data, { finals, editedTotal: ownTotal }, key, preview.asksCustomer ? note : '');
    if (!body) return;
    const failed = await post(body);
    if (failed) setFormError(failed);
  };

  const confirmAsIs = async () => {
    if (!data) return;
    setAskError('');
    const failed = await post(confirmAsIsBody(data, key));
    if (failed) setAskError(failed);
    else setAskOpen(false);
  };

  if (loadError) {
    return (
      <div data-estimate-confirm="error" className="space-y-2">
        <p className="text-[12px] text-text-muted">
          {refusalOf(
            loadError.e,
            L,
            loc('تعذّر تحميل الأسعار التقديرية لهذا الطلب.', 'The estimated prices of this order could not be loaded.', 'نرخە خەمڵێنراوەکانی ئەم داواکارییە بار نەکران.')
          )}
        </p>
        <Button variant="secondary" size="sm" onClick={load}>
          {loc('إعادة المحاولة', 'Try again', 'دووبارە هەوڵ بدەرەوە')}
        </Button>
      </div>
    );
  }
  if (!data || !preview) return null;

  const held = !!data.order.price_hold_id || data.lines.some((l) => l.state === 'proposed');
  const readOnly = !data.financial_scope ? 'scope' : held ? 'pending' : 'settled';
  const ruleText = loc(
    `أدخل السعر بالدينار الكامل؛ وما فوق ${formatIqd(PRICE_ROUNDING_THRESHOLD_IQD)} يكون من مضاعفات ${formatIqd(PRICE_ROUNDING_STEP_IQD)}.`,
    `Enter whole dinars; above ${formatIqd(PRICE_ROUNDING_THRESHOLD_IQD)} the price is a multiple of ${formatIqd(PRICE_ROUNDING_STEP_IQD)}.`,
    `نرخەکە بە دیناری تەواو بنووسە؛ سەرووی ${formatIqd(PRICE_ROUNDING_THRESHOLD_IQD)} دەبێت چەندجارەیەکی ${formatIqd(PRICE_ROUNDING_STEP_IQD)} بێت.`
  );
  const totalError =
    tried && editTotal && ownTotal === null
      ? loc('أدخل مبلغًا صحيحًا بالدينار أكبر من صفر.', 'Enter a whole number of dinars above zero.', 'بڕێکی تەواو بە دینار بنووسە کە لە سفر زیاتر بێت.')
      : '';
  const titleId = `estimate-confirm-${orderId}`;

  return (
    <section
      data-estimate-confirm={data.can_confirm ? 'act' : readOnly}
      aria-labelledby={titleId}
      className="rounded-2xl border border-border-subtle bg-surface-raised p-3.5 space-y-3"
    >
      <div className="space-y-1">
        <p id={titleId} className="text-[13px] font-bold text-text-primary">
          {loc('تأكيد السعر النهائي للمنتجات التقديرية', 'Confirm the final price of the estimated items', 'پشتڕاستکردنەوەی نرخی کۆتایی بەرهەمە خەمڵێنراوەکان')}
        </p>
        <p className="text-[12px] leading-relaxed text-text-secondary">
          {loc(
            'طُلبت هذه المنتجات بسعر تقديري. أكّد سعرها النهائي مع المورّد — حتى ذلك يبقى الطلب في «تم استلام الطلب» ولا يُجهَّز ولا يُشحن.',
            'These items were ordered at an estimated price. Confirm their final price with the supplier — until then the order stays at “Order received” and is neither prepared nor shipped.',
            'ئەم بەرهەمانە بە نرخی خەمڵێنراو داوا کراون. نرخی کۆتاییان لەگەڵ دابینکەر پشتڕاست بکەرەوە — تا ئەو کاتە داواکارییەکە لە «داواکاری وەرگیرا» دەمێنێتەوە و ئامادە ناکرێت و نانێردرێت.'
          )}
        </p>
      </div>

      <ul className="space-y-2">
        {data.lines.map((l) => {
          const id = l.order_item_id;
          const editable = data.can_confirm && (l.state === 'open' || l.state === 'rejected');
          const typed = finals[id] ?? null;
          const lineInvalid = editable && (lineError === id || (tried && !isFinalUnitPrice(typed)));
          const offerBefore = typeof l.offer_before_unit_iqd === 'number' ? l.offer_before_unit_iqd : null;
          const today = todayFinalOf(l);
          return (
            <li
              key={id}
              data-estimate-line={id}
              data-estimate-state={l.state}
              className="rounded-xl border border-border-subtle bg-surface p-3 space-y-2 min-w-0"
            >
              <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1.5">
                <p className="min-w-0 flex-1 text-[13px] font-bold leading-relaxed text-text-primary break-words">
                  <span className="tabular-nums">×{l.qty}</span> <bdi>{l.name}</bdi>
                  {l.variant ? (
                    <bdi dir="auto" className="block text-[12px] font-medium text-text-secondary">
                      {l.variant}
                    </bdi>
                  ) : null}
                </p>
                <EstimateLineChip state={l.state} />
              </div>
              <dl className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-1 text-[12.5px]">
                <dt className="text-text-muted">{loc('سعر الطلب (تقديري)', 'Ordered at (estimate)', 'نرخی داواکردن (خەمڵێنراو)')}</dt>
                <dd className="tabular-nums text-end text-text-primary" data-estimate-unit>
                  {formatIqd(l.estimate_unit_iqd)}
                </dd>
                {offerBefore !== null && (
                  <>
                    <dt className="text-text-muted">{loc('السعر قبل العرض يوم الطلب', 'Before the offer, when ordered', 'نرخی پێش ئۆفەر لە کاتی داواکردن')}</dt>
                    <dd className="tabular-nums text-end text-text-primary" data-offer-before-unit>
                      {formatIqd(offerBefore)}
                    </dd>
                  </>
                )}
                <dt className="text-text-muted">{loc('السعر المنشور اليوم', 'Published price today', 'نرخی بڵاوکراوەی ئەمڕۆ')}</dt>
                <dd className="tabular-nums text-end text-text-primary" data-current-unit>
                  {l.current_unit_iqd !== null && l.current_unit_iqd !== undefined
                    ? formatIqd(l.current_unit_iqd)
                    : loc('لا يوجد الآن', 'None now', 'ئێستا نییە')}
                </dd>
                {offerBefore !== null && typeof l.offer_today_unit_iqd === 'number' && (
                  <>
                    <dt className="text-text-muted">{loc('سعر اليوم بنفس العرض', 'Today, under the same offer', 'نرخی ئەمڕۆ بە هەمان ئۆفەر')}</dt>
                    <dd className="tabular-nums text-end text-text-primary" data-offer-today-unit>
                      {formatIqd(l.offer_today_unit_iqd)}
                    </dd>
                  </>
                )}
                {l.final_unit_iqd !== null && l.final_unit_iqd !== undefined && l.state !== 'open' && (
                  <>
                    <dt className="text-text-muted">
                      {l.state === 'rejected'
                        ? loc('السعر الذي رفضه الزبون', 'Price the customer rejected', 'ئەو نرخەی کڕیار ڕەتی کردەوە')
                        : l.state === 'proposed'
                          ? loc('السعر المرسَل للزبون', 'Price sent to the customer', 'ئەو نرخەی بۆ کڕیار نێردرا')
                          : loc('السعر النهائي', 'Final price', 'نرخی کۆتایی')}
                    </dt>
                    <dd className="tabular-nums text-end font-bold text-text-primary">{formatIqd(l.final_unit_iqd)}</dd>
                  </>
                )}
              </dl>
              {offerBefore !== null && (
                <p data-estimate-offer className="text-[12px] leading-relaxed text-text-secondary">
                  {loc(
                    'اشترى الزبون هذا المنتج ضمن عرض، فسعر الطلب هو سعر العرض: قارن السعر المنشور اليوم بالسعر قبل العرض، لا بسعر الطلب.',
                    'The customer bought this item under an offer, so it was ordered at the offer price: compare today’s published price with the price before the offer, not with the order price.',
                    'ئەم بەرهەمە لە ماوەی ئۆفەرێکدا کڕدرا، بۆیە نرخی داواکردنەکەی نرخی ئۆفەرەکەیە: نرخی بڵاوکراوەی ئەمڕۆ لەگەڵ نرخی پێش ئۆفەر بەراورد بکە، نەک لەگەڵ نرخی داواکردن.'
                  )}
                </p>
              )}
              {l.state === 'rejected' && (
                <p className="text-[12px] leading-relaxed text-text-secondary">
                  {loc(
                    'رفض الزبون السعر الجديد: أبقِ السعر التقديري، أو اكتب سعرًا آخر، أو ألغِ الطلب مع الاسترداد.',
                    'The customer rejected the new price: keep the estimate, type another price, or cancel the order with a refund.',
                    'کڕیار نرخە نوێیەکەی ڕەت کردەوە: نرخی خەمڵێنراو بهێڵەرەوە، یان نرخێکی تر بنووسە، یان داواکارییەکە بە گەڕاندنەوەی پارە هەڵبوەشێنەرەوە.'
                  )}
                </p>
              )}
              {editable && (
                <div className="space-y-1.5">
                  <Field
                    label={loc('السعر النهائي للقطعة', 'Final unit price', 'نرخی کۆتایی بۆ یەک دانە')}
                    error={lineInvalid ? ruleText : undefined}
                  >
                    <NumberInput
                      kind="money"
                      value={typed}
                      min={1}
                      max={PRICE_ADJUST_MAX_IQD}
                      data-estimate-final={id}
                      onValueChange={(v, valid) => {
                        setFinals((prev) => ({ ...prev, [id]: valid ? v : null }));
                        if (lineError === id) setLineError(null);
                      }}
                    />
                  </Field>
                  {today !== null && today !== typed && (
                    <Button
                      variant="ghost"
                      size="sm"
                      data-action="estimate-use-current"
                      onClick={() => setFinals((prev) => ({ ...prev, [id]: today }))}
                    >
                      {/* An offer line sets the same offer on today's price, not the published one: the label says so. */}
                      {offerBefore !== null
                        ? loc('استخدم سعر اليوم بنفس العرض', 'Use today’s price under the same offer', 'نرخی ئەمڕۆ بە هەمان ئۆفەر بەکاربهێنە')
                        : loc('استخدم سعر اليوم', 'Use today’s price', 'نرخی ئەمڕۆ بەکاربهێنە')}
                    </Button>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>

      {data.can_confirm ? (
        <div data-estimate-form className="space-y-3">
          {preview.invalid.length === 0 && (
            <dl
              data-estimate-preview
              className="rounded-xl border border-border-subtle bg-surface p-3 grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-1 text-[12.5px]"
            >
              <dt className="text-text-muted">{loc('الفرق على الإجمالي', 'Change to the total', 'جیاوازی لەسەر کۆی گشتی')}</dt>
              <dd className="tabular-nums text-end font-bold text-text-primary">
                {preview.target === preview.total ? loc('بلا تغيير', 'No change', 'بێ گۆڕانکاری') : signed(preview.target - preview.total)}
              </dd>
              <dt className="text-text-muted">{loc('الإجمالي', 'Total', 'کۆی گشتی')}</dt>
              <dd className="tabular-nums text-end text-text-primary">
                {preview.target === preview.total ? formatIqd(preview.total) : `${formatIqd(preview.total)} ${arrow} ${formatIqd(preview.target)}`}
              </dd>
              {plan?.ok && (
                <>
                  <dt className="text-text-muted">{loc('المستحق عند التسليم بعد الموافقة', 'Due on delivery after approval', 'ماوە لە گەیاندن دوای پەسەندکردن')}</dt>
                  <dd className="tabular-nums text-end text-text-primary">
                    {formatIqd(plan.plan.oldDueIqd)} {arrow} {formatIqd(plan.plan.newDueIqd)}
                  </dd>
                  {plan.plan.walletRefundIqd > 0 && (
                    <>
                      <dt className="text-text-muted">{loc('يُعاد إلى المحفظة عند الموافقة', 'Refunded to the wallet on approval', 'لە کاتی پەسەندکردن دەگەڕێتەوە بۆ جزدان')}</dt>
                      <dd className="tabular-nums text-end text-success">{formatIqd(plan.plan.walletRefundIqd)}</dd>
                    </>
                  )}
                </>
              )}
            </dl>
          )}
          {plan && plan.ok === false && (
            <p role="alert" className="lv-field-error">
              {apiRefusal({ code: plan.code }, L, '')}
            </p>
          )}

          {preview.changed &&
            (editTotal ? (
              <div className="space-y-1.5">
                <Field
                  label={loc('الإجمالي النهائي', 'Final total', 'کۆی گشتیی کۆتایی')}
                  hint={loc(
                    'الكوبونات والخصومات بالنسبة المئوية لا يُعاد حسابها تلقائيًا؛ اكتب الإجمالي الذي سيدفعه الزبون فعلًا.',
                    'Coupons and percentage discounts are not re-calculated; type the total the customer will actually pay.',
                    'کۆپۆن و داشکاندنی ڕێژەیی خۆکارانە دووبارە هەژمار ناکرێنەوە؛ ئەو کۆی گشتییە بنووسە کە کڕیار بەڕاستی دەیدات.'
                  )}
                  error={totalError || undefined}
                >
                  <NumberInput
                    kind="money"
                    value={total}
                    min={1}
                    max={PRICE_ADJUST_MAX_IQD}
                    data-estimate-total
                    onValueChange={(v, valid) => {
                      setTotal(v);
                      setTotalValid(valid && v !== null && v > 0);
                    }}
                  />
                </Field>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setEditTotal(false);
                    setTotal(null);
                  }}
                >
                  {loc('العودة إلى الإجمالي المحسوب', 'Back to the computed total', 'گەڕانەوە بۆ کۆی گشتیی هەژمارکراو')}
                </Button>
              </div>
            ) : (
              <Button
                variant="ghost"
                size="sm"
                data-action="estimate-edit-total"
                onClick={() => {
                  setEditTotal(true);
                  setTotal(preview.target);
                  setTotalValid(preview.target > 0);
                }}
              >
                {loc('تعديل الإجمالي يدويًا', 'Edit the total by hand', 'کۆی گشتی بە دەست بگۆڕە')}
              </Button>
            ))}

          {preview.asksCustomer && (
            <Field label={loc('ملاحظة للزبون', 'Note for the customer', 'تێبینی بۆ کڕیار')} optional>
              <Textarea rows={2} maxLength={300} value={note} onChange={(e) => setNote(e.currentTarget.value)} />
            </Field>
          )}

          <p className="text-[11.5px] leading-relaxed text-text-muted" data-estimate-outcome={!preview.changed ? 'none' : preview.asksCustomer ? 'propose' : 'confirm'}>
            {!preview.changed
              ? loc(
                  'لتغيير سعر، اكتب سعره النهائي في سطره؛ أو أكّد السعر كما هو.',
                  'To change a price, type its final price on its line — or confirm the price as it is.',
                  'بۆ گۆڕینی نرخێک، نرخی کۆتایی لە دێڕەکەی خۆیدا بنووسە؛ یان نرخەکە وەک خۆی پشتڕاست بکەرەوە.'
                )
              : preview.asksCustomer
                ? loc(
                    'يتغيّر الإجمالي: يُرسل السعر النهائي للزبون ليوافق عليه أو يرفضه (إشعار + تيليجرام)، ولا يتغيّر أي مبلغ قبل موافقته.',
                    'The total changes: the final price is sent to the customer to approve or reject (notification + Telegram), and no amount changes before they approve.',
                    'کۆی گشتی دەگۆڕێت: نرخی کۆتایی بۆ کڕیار دەنێردرێت تا پەسەندی بکات یان ڕەتی بکاتەوە (ئاگادارکردنەوە + تێلێگرام)، و پێش پەسەندکردنی هیچ بڕێک ناگۆڕێت.'
                  )
                : loc(
                    'لا يتغيّر الإجمالي: تُؤكَّد الأسعار دون سؤال الزبون، ويصله إشعار بذلك.',
                    'The total does not change: the prices are confirmed without asking the customer, who is notified.',
                    'کۆی گشتی ناگۆڕێت: نرخەکان بەبێ پرسیارکردن لە کڕیار پشتڕاست دەکرێنەوە، و ئاگادار دەکرێتەوە.'
                  )}
          </p>
          {formError && (
            <p role="alert" className="lv-field-error">
              {formError}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button
              variant={preview.changed ? 'secondary' : 'primary'}
              size="sm"
              icon={<CheckCircle2 className="h-4 w-4" aria-hidden />}
              data-action="estimate-confirm-as-is"
              onClick={() => {
                setAskError('');
                setAskMounted(true);
                setAskOpen(true);
              }}
            >
              {loc('تأكيد السعر كما هو', 'Confirm the price as it is', 'نرخەکە وەک خۆی پشتڕاست بکەرەوە')}
            </Button>
            <Button
              variant={preview.changed ? 'primary' : 'secondary'}
              size="sm"
              icon={<Send className="h-4 w-4" aria-hidden />}
              data-action="estimate-send-final"
              disabled={!preview.changed}
              onClick={send}
            >
              {preview.changed && !preview.asksCustomer
                ? loc('تأكيد الأسعار النهائية', 'Confirm the final prices', 'نرخە کۆتاییەکان پشتڕاست بکەرەوە')
                : loc('إرسال السعر النهائي للزبون', 'Send the final price to the customer', 'نرخی کۆتایی بۆ کڕیار بنێرە')}
            </Button>
          </div>
        </div>
      ) : (
        <p className="text-[12px] text-text-muted" data-estimate-readonly={readOnly}>
          {readOnly === 'scope'
            ? loc(
                'تأكيد السعر النهائي للمالك أو الدور المالي فقط.',
                'Only the owner or a financial admin can confirm the final price.',
                'تەنها خاوەن یان بەڕێوەبەری دارایی دەتوانێت نرخی کۆتایی پشتڕاست بکاتەوە.'
              )
            : readOnly === 'pending'
              ? loc('بانتظار قرار الزبون على السعر النهائي.', 'Waiting for the customer’s decision on the final price.', 'چاوەڕێی بڕیاری کڕیار لەسەر نرخی کۆتایی.')
              : loc('لا ينتظر أي سعر تأكيدًا.', 'No price is waiting for confirmation.', 'هیچ نرخێک چاوەڕێی پشتڕاستکردنەوە نییە.')}
        </p>
      )}

      {askMounted && (
        <ConfirmDialog
          open={askOpen}
          title={loc('تأكيد السعر التقديري سعرًا نهائيًا؟', 'Confirm the estimate as the final price?', 'نرخی خەمڵێنراو وەک نرخی کۆتایی پشتڕاست بکرێتەوە؟')}
          consequence={loc(
            'يُؤكَّد كل منتج بالسعر الذي طلبه الزبون به، دون أي تغيير في المبلغ، ويصله إشعار. بعدها يمكن تأكيد الطلب وتجهيزه.',
            'Each item is confirmed at the price the customer ordered it at, with no change to any amount, and the customer is notified. The order can then be confirmed and prepared.',
            'هەر بەرهەمێک بەو نرخەی کڕیار پێی داوای کردووە پشتڕاست دەکرێتەوە، بەبێ گۆڕانی هیچ بڕێک، و کڕیار ئاگادار دەکرێتەوە. پاشان دەتوانرێت داواکارییەکە پشتڕاست بکرێتەوە و ئامادە بکرێت.'
          )}
          confirmLabel={loc('تأكيد السعر كما هو', 'Confirm the price as it is', 'نرخەکە وەک خۆی پشتڕاست بکەرەوە')}
          onConfirm={confirmAsIs}
          onCancel={() => {
            setAskOpen(false);
            setAskError('');
          }}
          error={askError || undefined}
        />
      )}
    </section>
  );
}
