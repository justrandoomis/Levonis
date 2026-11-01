/**
 * «مطلوب موافقتك على السعر الجديد» — the customer's half of a price change
 * (migration 0140, worker/lib/orderPriceAdjust.ts).
 *
 * Shown ONLY while the order is held for this decision (`order.price_hold_id`),
 * at the top of the order page, because nothing else about the order moves
 * until it is answered. Old price struck through, the new one large, the
 * shop's reason in its own words, and what it means at the door and for the
 * wallet — then two buttons, each behind a ConfirmDialog that states the
 * consequence (Apple HIG «Alerts»: the verb on the button, a way out).
 *
 * The decision names the PROPOSAL id this screen showed, so if the shop
 * withdrew and re-proposed in between, the tap is refused rather than applied
 * to a price the customer never saw. The same decision is also offered as the
 * inline buttons of the Telegram message.
 *
 * THE ESTIMATE VARIANT (migration 0218; docs/SMART_PRICING.md §6.5–6.7; WP11).
 * A proposal whose `reason_code` is ESTIMATE_FINAL_PRICE settles lines the
 * customer ordered at an estimated price: the supplier's final price is now
 * known. The card then speaks in the contract's words
 * (packages/contracts/src/priceEstimates.ts — a lazy chunk, fetched only for
 * such a proposal, so no other order downloads it):
 *   - the reason is the localized `estimateReason`, never the stored sentence
 *     (which carries all three languages at once, for the CHECK and for older
 *     readers);
 *   - each line is one row, the unit price it was ordered at struck and the
 *     final one beside it — customer prices only (invariant I6), drawn from the
 *     proposal's own `lines`; the note keeps only the admin's words;
 *   - what a rejection leads to (`estimateRejectNote`): the shop keeps the
 *     original price or cancels with a full refund, and the customer may cancel
 *     too. The money rule is 0140's, unchanged: nothing extra is charged
 *     without this approval (I5).
 * If the words cannot be fetched the card is the ordinary one, with the stored
 * sentence as the reason: the decision itself never depends on them.
 *
 * SORANI. Every sentence is in Arabic, English and Sorani. The Sorani reuses
 * the words of the customer's own proposal message (`CUSTOMER_COPY.ckb`,
 * worker/lib/orderPriceAdjust.ts): «پەسەند», «ڕەتکردنەوە», «هۆکار»,
 * «وردەکاری», «دەگەڕێتەوە بۆ جزدانەکەت», «کۆی گشتیی نوێ». A native review is
 * still recommended (DECISIONS row 282(k)).
 */
import { useCallback, useEffect, useState } from 'react';
import { BadgeDollarSign } from 'lucide-react';
import { useLanguage } from '../../LanguageContext';
import { api, type ApiOrder, type PriceAdjustmentEstimateLine, type PriceAdjustmentReasonCode } from '../../lib/api';
import { apiRefusal, type Lang } from '../../lib/refusalStrings';
import { useMoney } from '../../CurrencyContext';
import { Button } from '../ui/Button';
import { ConfirmDialog } from '../ui/ConfirmDialog';

/** The words of an estimated price: a lazy chunk, fetched only when the proposal on screen settles one. */
const loadEstimateWords = () => import('../../../packages/contracts/src/priceEstimates');
export type EstimateWords = Awaited<ReturnType<typeof loadEstimateWords>>;

/**
 * One line an estimate proposal re-prices (worker/lib/orderPriceAdjust.ts
 * `AdjustmentEstimateLine`): the name and option the order froze, the quantity,
 * and two customer prices. `final_unit_iqd` is null only on a line the
 * proposal did not price.
 */
export type ProposalEstimateLine = PriceAdjustmentEstimateLine;

export interface PendingAdjustment {
  id: string;
  old_total_iqd: number;
  new_total_iqd: number;
  delta_iqd: number;
  new_due_iqd: number;
  wallet_refund_iqd: number;
  reason: string;
  note: string;
  created_at: string;
  /** Migration 0218: ESTIMATE_FINAL_PRICE on the proposal that settles estimated lines; '' (or absent) otherwise. */
  reason_code?: PriceAdjustmentReasonCode;
  /** Migration 0218: an estimate proposal's per-line old → new rows. */
  lines?: ProposalEstimateLine[];
}

/** Does this proposal settle lines bought at an estimated price? */
export const isEstimateProposal = (p: Pick<PendingAdjustment, 'reason_code'> | null | undefined): boolean =>
  p?.reason_code === 'ESTIMATE_FINAL_PRICE';

/**
 * THE ADMIN'S OWN WORDS under an estimate proposal's rows. The server writes
 * the note as one generated row per changed line («name — option × qty:
 * estimate → final», worker/lib/orderEstimates.ts `estimateProposalNote`), a
 * «+N» when the rows ran out of room, then the admin's words. The card draws
 * the rows from `lines`, so only the words are left to say; with no rows to
 * draw (an unreadable read) the whole note is said, as it always was.
 */
export function proposalNoteWords(note: string, rowsDrawn: boolean): string {
  if (!rowsDrawn) return note;
  return note
    .split('\n')
    .filter((line) => {
      const t = line.trim();
      return !/^.+ × \d+: [\d,]+ → [\d,]+$/.test(t) && !/^\+\d+$/.test(t);
    })
    .join('\n')
    .trim();
}

const asLang = (lang: string): Lang => (lang === 'en' ? 'en' : lang === 'ckb' ? 'ckb' : 'ar');

/**
 * THE CARD ITSELF, without its loading and its dialog: the figures, the
 * reason, an estimate proposal's rows and what rejecting it means, and the
 * two buttons, which only ask (`onAsk`) — the dialog decides.
 */
export function PriceApprovalBody({
  pending,
  words,
  onAsk,
}: {
  pending: PendingAdjustment;
  /** The estimate words, once fetched; null for an ordinary proposal or while they could not be fetched. */
  words: EstimateWords | null;
  onAsk: (decision: 'approve' | 'reject') => void;
}) {
  const { loc, lang } = useLanguage();
  const L = asLang(lang);
  // A wallet refund is a WALLET AMOUNT: at the wallet's own rate, never the market's (Q5; FX-1 review #6).
  const { money, moneyBoth, walletMoney } = useMoney();
  const up = pending.delta_iqd > 0;
  // The estimate words speak only for a proposal that IS an estimate settlement.
  const ew = isEstimateProposal(pending) ? words : null;
  const rows = ew ? pending.lines ?? [] : [];
  const details = ew ? proposalNoteWords(pending.note, rows.length > 0) : pending.note;
  // «old ← new» reads right to left; «old → new» left to right (the in-app notice's own arrows).
  const arrow = L === 'en' ? '→' : '←';

  return (
    <section
      data-price-approval={pending.id}
      data-price-approval-estimate={ew ? 'true' : undefined}
      aria-labelledby="price-approval-title"
      className="rounded-2xl border border-warning/40 bg-warning/10 p-4 space-y-3"
    >
      <div className="flex items-start gap-3">
        <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-warning/15 text-warning" aria-hidden>
          <BadgeDollarSign className="h-5 w-5" />
        </span>
        <div className="min-w-0">
          <h2 id="price-approval-title" className="text-[15px] font-bold text-text-primary">
            {ew
              ? ew.ESTIMATE_STRINGS.line.proposed[L]
              : loc('مطلوب موافقتك على السعر الجديد', 'Your approval is needed for a new price', 'پێویستە نرخە نوێیەکە پەسەند بکەیت')}
          </h2>
          <p className="mt-0.5 text-[12.5px] leading-relaxed text-text-secondary">
            {loc(
              'لن نتابع تجهيز طلبك حتى توافق على السعر أو ترفضه.',
              'We will not continue preparing your order until you approve or reject the price.',
              'تا نرخەکە پەسەند نەکەیت یان ڕەتی نەکەیتەوە، ئامادەکردنی داواکارییەکەت بەردەوام نابێت.'
            )}
          </p>
        </div>
      </div>

      <div className="rounded-xl border border-border-subtle bg-surface p-3">
        <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-2">
          <div>
            <p className="text-[11.5px] text-text-muted">{loc('السعر السابق', 'Previous price', 'نرخی پێشوو')}</p>
            <p className="text-[14px] tabular-nums text-text-muted line-through">{money(pending.old_total_iqd)}</p>
          </div>
          <div className="text-end">
            <p className="text-[11.5px] text-text-muted">{loc('السعر الجديد', 'New price', 'نرخی نوێ')}</p>
            <p className="text-[20px] font-black tabular-nums text-text-primary" data-price-new>
              {moneyBoth(pending.new_total_iqd)}
            </p>
            <p className={`text-[12px] font-bold tabular-nums ${up ? 'text-warning' : 'text-success'}`}>
              {up ? loc('زيادة', 'Increase', 'زیادبوون') : loc('تخفيض', 'Decrease', 'کەمبوونەوە')} {money(Math.abs(pending.delta_iqd))}
            </p>
          </div>
        </div>
        {/* AN ESTIMATE SETTLEMENT, LINE BY LINE: the unit price ordered at, struck, and the final one. */}
        {rows.length > 0 && (
          <div className="mt-3 border-t border-border-subtle pt-3">
            <p className="text-[12px] text-text-muted">{loc('سعر القطعة', 'Price per item', 'نرخی هەر دانەیەک')}</p>
            <ul data-price-approval-lines className="mt-1.5 space-y-1.5 text-[13px]">
              {rows.map((r, i) => {
                const changed = typeof r.final_unit_iqd === 'number' && r.final_unit_iqd !== r.estimate_unit_iqd;
                return (
                  <li
                    key={r.order_item_id ?? `${r.name}:${i}`}
                    data-price-approval-line
                    className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5"
                  >
                    <span className="min-w-0 text-text-primary">
                      {r.name}
                      {r.variant ? <span className="text-text-muted"> — {r.variant}</span> : null}
                      <span className="tabular-nums text-text-muted"> × {r.qty}</span>
                    </span>
                    {changed ? (
                      <span className="tabular-nums">
                        <s className="text-text-muted">{money(r.estimate_unit_iqd)}</s>
                        <span className="text-text-muted" aria-hidden="true">
                          {' '}
                          {arrow}{' '}
                        </span>
                        <span className="sr-only"> {loc('إلى', 'to', 'بۆ')} </span>
                        <span className="font-bold text-text-primary">{money(r.final_unit_iqd as number)}</span>
                      </span>
                    ) : (
                      <span className="tabular-nums text-text-secondary">
                        {money(r.estimate_unit_iqd)} · {loc('دون تغيير', 'No change', 'بەبێ گۆڕانکاری')}
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        )}
        <dl className="mt-3 space-y-1.5 border-t border-border-subtle pt-3 text-[13px]">
          <div>
            <dt className="text-text-muted text-[12px]">{loc('السبب', 'Reason', 'هۆکار')}</dt>
            <dd className="text-text-primary whitespace-pre-wrap" dir="auto">
              {ew ? ew.ESTIMATE_STRINGS.estimateReason[L] : pending.reason}
            </dd>
          </div>
          {details && (
            <div>
              <dt className="text-text-muted text-[12px]">{loc('التفاصيل', 'Details', 'وردەکاری')}</dt>
              <dd className="text-text-secondary whitespace-pre-wrap" dir="auto">{details}</dd>
            </div>
          )}
          <div className="flex items-baseline justify-between gap-3">
            <dt className="text-text-muted text-[12px]">{loc('تدفع عند الاستلام', 'You pay on delivery', 'لە کاتی وەرگرتن دەیدەیت')}</dt>
            <dd className="tabular-nums text-text-primary font-bold">{money(pending.new_due_iqd)}</dd>
          </div>
          {pending.wallet_refund_iqd > 0 && (
            <div className="flex items-baseline justify-between gap-3">
              <dt className="text-text-muted text-[12px]">{loc('يُعاد إلى محفظتك', 'Back to your wallet', 'دەگەڕێتەوە بۆ جزدانەکەت')}</dt>
              <dd className="tabular-nums text-success font-bold">{walletMoney(pending.wallet_refund_iqd)}</dd>
            </div>
          )}
        </dl>
      </div>

      {/* What a rejection of an estimate settlement leads to — read BEFORE the choice, not after it. */}
      {ew && (
        <p data-price-approval-reject-note className="text-[12px] leading-relaxed text-text-secondary">
          {ew.ESTIMATE_STRINGS.estimateRejectNote[L]}
        </p>
      )}

      <div className="grid grid-cols-2 gap-2">
        <Button variant="primary" block onClick={() => onAsk('approve')} data-action="price-approve">
          {loc('موافقة', 'Approve', 'پەسەندکردن')}
        </Button>
        <Button variant="secondary" block onClick={() => onAsk('reject')} data-action="price-reject">
          {loc('رفض', 'Reject', 'ڕەتکردنەوە')}
        </Button>
      </div>
    </section>
  );
}

export default function PriceApprovalCard({
  order,
  onDecided,
}: {
  order: ApiOrder;
  onDecided: (message: string) => void | Promise<void>;
}) {
  const { loc, lang } = useLanguage();
  const L = asLang(lang);
  const { money, walletMoney } = useMoney();
  const [pending, setPending] = useState<PendingAdjustment | null>(null);
  const [words, setWords] = useState<EstimateWords | null>(null);
  const [asking, setAsking] = useState<'approve' | 'reject' | null>(null);
  const [error, setError] = useState('');
  const hold = order.price_hold_id ?? null;

  const load = useCallback(async () => {
    if (!hold) {
      setPending(null);
      return;
    }
    try {
      const r = await api.get<{ pending: PendingAdjustment | null }>(`/api/orders/${encodeURIComponent(order.id)}/price-adjustment`);
      // An estimate settlement brings its words first, so the card never draws the stored sentence and then
      // swaps it; if they cannot be fetched the ordinary card stands (the decision does not depend on them).
      if (isEstimateProposal(r.pending)) {
        try {
          setWords(await loadEstimateWords());
        } catch {
          setWords(null);
        }
      }
      setPending(r.pending);
    } catch {
      setPending(null);
    }
  }, [hold, order.id]);

  useEffect(() => {
    load();
  }, [load]);

  if (!hold || !pending) return null;
  const ew = isEstimateProposal(pending) ? words : null;

  const decide = async () => {
    if (!asking) return;
    setError('');
    try {
      await api.post(`/api/orders/${encodeURIComponent(order.id)}/price-adjustment/${pending.id}/${asking}`, {});
      const msg =
        asking === 'approve'
          ? loc(
              'تمت الموافقة على السعر الجديد — نتابع تجهيز طلبك.',
              'You approved the new price — we are continuing with your order.',
              'نرخە نوێیەکەت پەسەند کرد — ئامادەکردنی داواکارییەکەت بەردەوام دەبێت.'
            )
          : ew
            ? ew.ESTIMATE_STRINGS.line.rejected[L]
            : loc(
                'رفضت السعر الجديد — بقي طلبك على سعره السابق وسنتواصل معك.',
                'You rejected the new price — your order keeps its previous price and we will be in touch.',
                'نرخە نوێیەکەت ڕەت کردەوە — داواکارییەکەت لەسەر نرخە پێشووەکەی دەمێنێتەوە و پەیوەندیت پێوە دەکەین.'
              );
      setAsking(null);
      await onDecided(msg);
    } catch (e) {
      // An estimate refusal is said from the contract first (§5.5), every other one from the trilingual table.
      setError(
        ew?.estimateRefusalText(e, L) ??
          apiRefusal(e, L, loc('تعذّر حفظ قرارك. حاول مرة أخرى.', 'Your decision could not be saved. Try again.', 'بڕیارەکەت پاشەکەوت نەکرا. دووبارە هەوڵ بدەرەوە.'))
      );
    }
  };

  return (
    <>
      <PriceApprovalBody pending={pending} words={words} onAsk={setAsking} />
      <ConfirmDialog
        open={asking !== null}
        title={
          asking === 'approve'
            ? loc('الموافقة على السعر الجديد؟', 'Approve the new price?', 'نرخە نوێیەکە پەسەند دەکەیت؟')
            : loc('رفض السعر الجديد؟', 'Reject the new price?', 'نرخە نوێیەکە ڕەت دەکەیتەوە؟')
        }
        consequence={
          asking === 'approve'
            ? pending.wallet_refund_iqd > 0
              ? loc(
                  `يصبح إجمالي طلبك ${money(pending.new_total_iqd)} ويُعاد ${walletMoney(pending.wallet_refund_iqd)} إلى محفظتك فورًا.`,
                  `Your order total becomes ${money(pending.new_total_iqd)} and ${walletMoney(pending.wallet_refund_iqd)} goes back to your wallet now.`,
                  `کۆی گشتیی داواکارییەکەت دەبێتە ${money(pending.new_total_iqd)} و ${walletMoney(pending.wallet_refund_iqd)} یەکسەر دەگەڕێتەوە بۆ جزدانەکەت.`
                )
              : loc(
                  `يصبح إجمالي طلبك ${money(pending.new_total_iqd)} وتدفع ${money(pending.new_due_iqd)} عند الاستلام.`,
                  `Your order total becomes ${money(pending.new_total_iqd)} and you pay ${money(pending.new_due_iqd)} on delivery.`,
                  `کۆی گشتیی داواکارییەکەت دەبێتە ${money(pending.new_total_iqd)} و ${money(pending.new_due_iqd)} لە کاتی وەرگرتن دەدەیت.`
                )
            : ew
              ? ew.ESTIMATE_STRINGS.estimateRejectNote[L]
              : loc(
                  `يبقى طلبك على ${money(pending.old_total_iqd)}، وقد يتواصل معك المتجر أو يلغي الطلب إن تعذّر توفيره بهذا السعر.`,
                  `Your order stays at ${money(pending.old_total_iqd)}; the shop may contact you or cancel the order if it cannot be supplied at that price.`,
                  `داواکارییەکەت لەسەر ${money(pending.old_total_iqd)} دەمێنێتەوە؛ لەوانەیە فرۆشگاکە پەیوەندیت پێوە بکات، یان ئەگەر بەو نرخە دابین نەکرێت داواکارییەکە هەڵبوەشێنێتەوە.`
                )
        }
        confirmLabel={asking === 'approve' ? loc('موافقة', 'Approve', 'پەسەندکردن') : loc('رفض السعر', 'Reject price', 'ڕەتکردنەوەی نرخ')}
        destructive={asking === 'reject'}
        onConfirm={decide}
        onCancel={() => {
          setAsking(null);
          setError('');
        }}
        error={error || undefined}
        testId="price-approval-confirm"
      />
    </>
  );
}
