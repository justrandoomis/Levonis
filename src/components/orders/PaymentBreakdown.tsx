/**
 * The §5 money view, read as-is. Every figure here came from
 * `order.financial` on the server; nothing is added up in the browser, and a
 * line whose amount is zero is simply not drawn.
 *
 * Points EARNED are shown apart from points SPENT: the first is a promise
 * with a date attached (the seven-day hold, then settlement), the second is
 * a payment that already happened.
 */
import { Coins, Clock, CheckCircle2, Ban } from 'lucide-react';
import { formatIqd } from '../../lib/api';
import type { ApiOrder, ApiOrderItem, OrderFinancial } from '../../lib/api';
import { useLanguage } from '../../LanguageContext';
import { asLang, formatDate } from './format';

const STRINGS = {
  ar: {
    title: 'ملخص الدفع',
    merchandise: 'المنتجات',
    fees: 'رسوم التوفر والشحن الدولي والضمان',
    feeKinds: { direct: 'زيادة البيع المباشر', transport: 'عمولة النقل', warranty: 'الضمان' } as Record<FeeKind, string>,
    feesOf: (kinds: string) => `رسوم: ${kinds}`,
    coupon: 'كوبون',
    pointsUsed: 'نقاط مستخدمة',
    shipping: 'التوصيل',
    codTax: 'ضريبة الدفع عند الاستلام',
    free: 'مجانًا',
    waived: 'معفى',
    total: 'المجموع',
    payment: 'الدفع',
    wallet: 'من المحفظة',
    collected: 'المحصَّل',
    outstanding: 'المتبقي عند التسليم',
    bnplOutstanding: 'رصيد BNPL المستحق',
    bnplDueAt: (d: string) => `موعد السداد ${d}`,
    state: { paid: 'مدفوع', partial: 'مدفوع جزئيًا', cod_due: 'الدفع عند التسليم', bnpl_due: 'ممّول عبر BNPL' } as Record<string, string>,
    earned: 'النقاط المكتسبة',
    pending: (n: number) => `${n} نقطة معلّقة`,
    released: (n: number) => `${n} نقطة مُفرَجة`,
    availableAt: (d: string) => `تُتاح ابتداءً من ${d}`,
    holdNote: 'تبقى النقاط معلّقة 7 أيام من الشراء وتُفرَج بعد تسوية الطلب بالكامل. تُلغى إذا أُلغي الطلب.',
    cancelledPoints: 'أُلغيت النقاط المعلّقة مع إلغاء الطلب.',
    support: (u: string) => `طلب داعم لـ @${u} — بلا أي خصم`,
  },
  en: {
    title: 'Payment summary',
    merchandise: 'Merchandise',
    fees: 'Availability, transport & warranty fees',
    feeKinds: { direct: 'direct-sale surcharge', transport: 'transport commission', warranty: 'warranty' } as Record<FeeKind, string>,
    feesOf: (kinds: string) => `Fees: ${kinds}`,
    coupon: 'Coupon',
    pointsUsed: 'Points used',
    shipping: 'Delivery',
    codTax: 'Cash on Delivery Tax',
    free: 'Free',
    waived: 'waived',
    total: 'Total',
    payment: 'Payment',
    wallet: 'Paid from wallet',
    collected: 'Collected',
    outstanding: 'Due on delivery',
    bnplOutstanding: 'BNPL balance due',
    bnplDueAt: (d: string) => `Repayment due ${d}`,
    state: { paid: 'Paid', partial: 'Partially paid', cod_due: 'Due on delivery', bnpl_due: 'Financed with BNPL' } as Record<string, string>,
    earned: 'Points earned',
    pending: (n: number) => `${n} points pending`,
    released: (n: number) => `${n} points released`,
    availableAt: (d: string) => `available from ${d}`,
    holdNote: 'Points stay pending for 7 days after purchase and are released once the order is fully settled. They are cancelled if the order is.',
    cancelledPoints: 'The pending points were cancelled with the order.',
    support: (u: string) => `Supporting @${u} — no discount applied`,
  },
  ckb: {
    title: 'کورتەی پارەدان',
    merchandise: 'کاڵاکان',
    fees: 'کرێی بەردەستبوون و گواستنەوە و گەرەنتی',
    feeKinds: { direct: 'زیادەی فرۆشتنی ڕاستەوخۆ', transport: 'کرێی گواستنەوە', warranty: 'گەرەنتی' } as Record<FeeKind, string>,
    feesOf: (kinds: string) => `کرێ: ${kinds}`,
    coupon: 'کۆپۆن',
    pointsUsed: 'خاڵی بەکارهاتوو',
    shipping: 'گەیاندن',
    codTax: 'باجی پارەدان لە کاتی گەیاندن',
    free: 'بەخۆڕایی',
    waived: 'لێخۆشبوو',
    total: 'کۆی گشتی',
    payment: 'پارەدان',
    wallet: 'لە جزدانەوە',
    collected: 'وەرگیراو',
    outstanding: 'ماوە لە کاتی گەیاندن',
    bnplOutstanding: 'قەرزی BNPL',
    bnplDueAt: (d: string) => `کاتی گەڕاندنەوە ${d}`,
    state: { paid: 'دراوە', partial: 'بەشێک دراوە', cod_due: 'پارەدان لە کاتی گەیاندن', bnpl_due: 'بە BNPL دارایی کراوە' } as Record<string, string>,
    earned: 'خاڵی وەرگیراو',
    pending: (n: number) => `${n} خاڵ چاوەڕوان`,
    released: (n: number) => `${n} خاڵ ئازادکراو`,
    availableAt: (d: string) => `بەردەست دەبێت لە ${d}`,
    holdNote: 'خاڵەکان ٧ ڕۆژ دوای کڕین چاوەڕوان دەمێننەوە و دوای یەکلاکردنەوەی تەواوی داواکاری ئازاد دەکرێن. ئەگەر داواکاری هەڵوەشێنرایەوە، هەڵدەوەشێنرێنەوە.',
    cancelledPoints: 'خاڵە چاوەڕوانەکان لەگەڵ داواکاری هەڵوەشێنرانەوە.',
    support: (u: string) => `پشتگیری @${u} — بێ هیچ داشکاندنێک`,
  },
} as const;

type FeeKind = 'direct' | 'transport' | 'warranty';

/**
 * WHICH fees make up `fees_iqd`, read off the frozen line snapshots — so the
 * row can NAME them ("Fees: direct-sale surcharge · warranty") instead of one
 * label that fits every order. Only the kinds actually charged are named: a
 * PRO's waived commission or premium is not a fee the customer paid, and a
 * cash-on-delivery pre-order names the direct-sale surcharge, not the
 * commission it did not pay. Naming only — the AMOUNT stays the server's
 * `fees_iqd`; nothing is added up here.
 */
export function feeKindsOf(items: ApiOrderItem[] | undefined): FeeKind[] {
  const kinds = new Set<FeeKind>();
  for (const it of items ?? []) {
    const direct = it.pricing?.direct;
    if (direct && direct.waived !== true && (direct.surcharge_iqd ?? 0) > 0) kinds.add('direct');
    const t = it.transport ?? it.pricing?.transport;
    if (t && t.waived !== true && (t.commission_iqd ?? 0) > 0) kinds.add('transport');
    if ((it.warranty?.fee_iqd ?? 0) > 0) kinds.add('warranty');
  }
  return (['direct', 'transport', 'warranty'] as FeeKind[]).filter((k) => kinds.has(k));
}

function Row({ label, value, strong = false, muted = false, negative = false }: { label: string; value: string; strong?: boolean; muted?: boolean; negative?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1.5">
      <dt className={`text-[13px] min-w-0 ${strong ? 'text-white font-bold' : muted ? 'text-zinc-500' : 'text-zinc-400'}`}>{label}</dt>
      <dd className={`text-[13px] tabular-nums shrink-0 ${strong ? 'text-[#BAA369] font-bold text-[15px]' : negative ? 'text-emerald-300' : 'text-zinc-200'}`}>
        {negative ? '- ' : ''}
        {value}
      </dd>
    </div>
  );
}

export default function PaymentBreakdown({ order, financial }: { order: ApiOrder; financial: OrderFinancial }) {
  const { lang } = useLanguage();
  const s = STRINGS[asLang(lang)];
  const f = financial;
  const couponCode = order.coupon?.code ? ` (${order.coupon.code})` : '';
  const stateStyle =
    f.payment_state === 'paid'
      ? 'bg-emerald-500/10 text-emerald-300 border-emerald-500/20'
      : f.payment_state === 'bnpl_due'
        ? 'bg-[#B03142]/15 text-[#f3bdc5] border-[#B03142]/35'
      : f.payment_state === 'partial'
        ? 'bg-amber-500/10 text-amber-300 border-amber-500/20'
        : 'bg-zinc-800 text-zinc-300 border-zinc-700';
  const points = f.points ?? null;
  const showEarned = !!points && points.state !== 'none' && (points.pending > 0 || points.released > 0 || points.state === 'cancelled');
  // Name the fees when the line snapshots say which ones were charged; a
  // legacy order with no snapshots keeps the generic label.
  const feeKinds = feeKindsOf(order.items);
  const feesLabel = feeKinds.length > 0 ? s.feesOf(feeKinds.map((k) => s.feeKinds[k]).join(' · ')) : s.fees;

  return (
    <section className="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-4" aria-labelledby="payment-title">
      <div className="flex items-center justify-between gap-3">
        <h3 id="payment-title" className="text-white font-bold text-[14px]">{s.title}</h3>
        <span data-payment-state={f.payment_state} className={`inline-flex items-center rounded-full border px-2.5 py-1 text-[11px] font-bold ${stateStyle}`}>
          {s.state[f.payment_state] ?? f.payment_state}
        </span>
      </div>

      <dl className="mt-3 divide-y divide-zinc-800/60">
        <Row label={s.merchandise} value={formatIqd(f.merchandise_iqd)} />
        {f.fees_iqd > 0 && <Row label={feesLabel} value={formatIqd(f.fees_iqd)} />}
        {f.coupon_discount_iqd > 0 && <Row label={`${s.coupon}${couponCode}`} value={formatIqd(f.coupon_discount_iqd)} negative />}
        {f.points_value_iqd > 0 && <Row label={`${s.pointsUsed} (${f.points_used})`} value={formatIqd(f.points_value_iqd)} negative />}
        <Row
          label={s.shipping}
          value={f.shipping_iqd === 0 ? (f.delivery_waived ? `${s.free} · ${s.waived}` : s.free) : formatIqd(f.shipping_iqd)}
        />
        {f.cod_tax_iqd > 0 && <Row label={s.codTax} value={formatIqd(f.cod_tax_iqd)} />}
        <Row label={s.total} value={formatIqd(f.total_iqd)} strong />
      </dl>

      <dl className="mt-3 pt-3 border-t border-zinc-800 divide-y divide-zinc-800/60">
        <div className="pb-1 text-[11px] font-bold text-zinc-500">{s.payment}</div>
        {f.wallet_applied_iqd > 0 && <Row label={s.wallet} value={formatIqd(f.wallet_applied_iqd)} negative />}
        {f.collected_iqd !== null && f.collected_iqd !== undefined && <Row label={s.collected} value={formatIqd(f.collected_iqd)} />}
        {f.outstanding_iqd > 0 && <Row label={f.payment_state === 'bnpl_due' ? s.bnplOutstanding : s.outstanding} value={formatIqd(f.outstanding_iqd)} />}
        {f.wallet_applied_iqd <= 0 && (f.collected_iqd === null || f.collected_iqd === undefined) && f.outstanding_iqd <= 0 && (
          <Row label={s.state[f.payment_state] ?? f.payment_state} value={formatIqd(f.total_iqd)} muted />
        )}
      </dl>

      {f.payment_state === 'bnpl_due' && f.bnpl_due_at && (
        <p className="mt-2 text-[11.5px] font-medium text-[#f3bdc5]">
          {s.bnplDueAt(formatDate(f.bnpl_due_at, lang))}
        </p>
      )}

      {f.support && f.support.referrer_username && (
        <p className="mt-3 text-[11.5px] text-zinc-500">{s.support(f.support.referrer_username)}</p>
      )}

      {showEarned && points && (
        <div className="mt-4 rounded-xl border border-zinc-800 bg-black/30 p-3" data-points-state={points.state}>
          <p className="text-[12px] font-bold text-zinc-300 inline-flex items-center gap-1.5">
            <Coins className="w-4 h-4 text-[#BAA369]" aria-hidden />
            {s.earned}
          </p>
          <div className="mt-1.5 flex flex-col gap-1 text-[12.5px]">
            {points.pending > 0 && (
              <p className="text-zinc-200 inline-flex items-center gap-1.5 tabular-nums">
                <Clock className="w-3.5 h-3.5 text-amber-300" aria-hidden />
                {s.pending(points.pending)}
                {points.available_at && <span className="text-zinc-500">· {s.availableAt(formatDate(points.available_at, lang))}</span>}
              </p>
            )}
            {points.released > 0 && (
              <p className="text-zinc-200 inline-flex items-center gap-1.5 tabular-nums">
                <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" aria-hidden />
                {s.released(points.released)}
              </p>
            )}
            {points.state === 'cancelled' && (
              <p className="text-zinc-400 inline-flex items-center gap-1.5">
                <Ban className="w-3.5 h-3.5" aria-hidden />
                {s.cancelledPoints}
              </p>
            )}
          </div>
          {points.state === 'pending' && <p className="mt-2 text-[11px] text-zinc-500 leading-relaxed">{s.holdNote}</p>}
        </div>
      )}
    </section>
  );
}
