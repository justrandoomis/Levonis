/**
 * «العضوية مع الطلب» on the admin order window (migration 0235; owner rulings
 * 2026-11-17): the membership the customer bought WITH this order, as its own
 * line at the live plan price. It is pending until the order is delivered AND
 * fully paid, then active — and from then on final (non-refundable). A blocked
 * purchase (a live membership appeared meanwhile) waits for a person: once the
 * conflict is dealt with, «إعادة المحاولة» asks the server to activate it
 * again. The retry moves no money. Every figure is the server's.
 *
 * «تصحيح: إلغاء الطلب وإنهاء العضوية» (owner ruling 2026-11-17 ~10:20): a
 * started membership makes the order uncancellable by staff and customers; the
 * OWNER alone may correct it — the door cancels the order, ends the membership
 * and refunds the order as an ordinary cancel, with a reason, audited. Shown
 * to the owner only (the server refuses anyone else with OWNER_ONLY anyway).
 */
import { useState } from 'react';
import { useLanguage } from '../../LanguageContext';
import { api, ApiError, formatIqd } from '../../lib/api';
import { apiRefusal } from '../../lib/refusalStrings';
import { tierLabel } from '../subscription/tierMeta';
import { usePrompt } from '../ui/PromptDialog';

export interface OrderMembershipPurchase {
  id?: string;
  order_item_id: string;
  printer_item_id: string | null;
  plan_id: string;
  tier: string;
  duration_months: number;
  kind: 'new' | 'upgrade' | 'renew' | string;
  price_iqd: number;
  credit_iqd: number;
  charge_iqd: number;
  state: 'pending' | 'active' | 'cancelled' | 'blocked' | string;
  needs_review: boolean;
  review_reason: string | null;
  starts_at: string | null;
  expires_at: string | null;
  activated_at: string | null;
  cancelled_at: string | null;
  refundable: false;
}

export default function OrderMembershipSection({ orderId, purchases, viewerOwner, onChanged }: {
  orderId: string;
  purchases: OrderMembershipPurchase[];
  /** The owner alone sees the correction (the server's own hint, `user.is_owner`). */
  viewerOwner: boolean;
  onChanged: () => void;
}) {
  const { loc, lang } = useLanguage();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [said, setSaid] = useState<Record<string, { state: string; review_reason: string | null }>>({});
  const [corrected, setCorrected] = useState(false);
  const [prompt, promptDialog] = usePrompt();
  if (!purchases.length) return null;
  const L = lang === 'en' || lang === 'ckb' ? lang : 'ar';
  const started = purchases.some((p) => (said[p.id ?? `omp_${p.order_item_id}`]?.state ?? p.state) === 'active');

  const correct = async () => {
    const reason = await prompt({
      title: loc('تصحيح: إلغاء الطلب وإنهاء العضوية', 'Correction: cancel the order and end the membership', 'ڕاستکردنەوە: هەڵوەشاندنەوەی داواکاری و کۆتاییهێنان بە ئەندامێتی'),
      description: loc(
        'تنتهي العضوية التي بدأت مع هذا الطلب، ويُلغى الطلب ويُسترد كأي إلغاء عادي. يُسجَّل السبب في السجل.',
        'The membership that started with this order ends, and the order is cancelled and refunded like any ordinary cancel. The reason is kept in the audit log.',
        'ئەو ئەندامێتییەی لەگەڵ ئەم داواکارییە دەستی پێکرد کۆتایی دێت، و داواکارییەکە هەڵدەوەشێتەوە و پارەکەی وەک هەر هەڵوەشاندنەوەیەکی ئاسایی دەگەڕێتەوە. هۆکارەکە لە تۆماردا دەمێنێتەوە.'
      ),
      label: loc('السبب', 'Reason', 'هۆکار'),
      multiline: true,
      required: true,
      maxLength: 500,
      validate: (v) => (v.trim().length < 3 ? loc('اكتب سبباً من 3 أحرف على الأقل.', 'Write a reason of at least 3 characters.', 'هۆکارێک بنووسە کە لانیکەم 3 پیت بێت.') : null),
      confirmLabel: loc('إلغاء الطلب وإنهاء العضوية', 'Cancel the order and end the membership', 'داواکارییەکە هەڵبوەشێنەوە و ئەندامێتییەکە کۆتایی پێبهێنە'),
      destructive: true,
    });
    if (reason === null) return;
    setBusy('correction');
    setError(null);
    try {
      await api.post(`/api/admin/orders/${encodeURIComponent(orderId)}/membership-correction`, { reason });
      setCorrected(true);
      onChanged();
    } catch (e) {
      setError(e instanceof ApiError ? apiRefusal(e, L, e.message) : String(e));
    } finally {
      setBusy(null);
    }
  };

  const retry = async (p: OrderMembershipPurchase) => {
    const id = p.id ?? `omp_${p.order_item_id}`;
    setBusy(id);
    setError(null);
    try {
      const res = await api.post<{ state: string; review_reason?: string | null }>(`/api/memberships/admin/order-purchases/${id}/retry`, {});
      setSaid((m) => ({ ...m, [id]: { state: res.state, review_reason: res.review_reason ?? null } }));
      onChanged();
    } catch (e) {
      setError(e instanceof ApiError ? apiRefusal(e, L, e.message) : String(e));
    } finally {
      setBusy(null);
    }
  };

  const kindText = (k: string) =>
    k === 'upgrade' ? loc('ترقية', 'Upgrade', 'بەرزکردنەوە')
    : k === 'renew' ? loc('تجديد — يمتد من انتهاء العضوية الحالية', 'Renewal — extends from the current expiry', 'نوێکردنەوە — لە کۆتایی ئەندامێتی ئێستاوە درێژ دەبێتەوە')
    : loc('جديدة', 'New', 'نوێ');
  const stateText = (st: string, everStarted = false) =>
    st === 'active' ? loc('فعّالة — بدأت، ولا تُسترد', 'Active — started, non-refundable', 'چالاک — دەستی پێکردووە، پارەکەی ناگەڕێتەوە')
    : st === 'blocked' ? loc('متوقفة — تحتاج مراجعة شخص', 'Blocked — needs a person', 'ڕاگیراوە — پێویستی بە پێداچوونەوەی کەسێک هەیە')
    : st === 'cancelled' && everStarted ? loc('منتهية بتصحيح المالك — أُلغي الطلب', 'Ended by the owner’s correction — the order was cancelled', 'بە ڕاستکردنەوەی خاوەن کۆتایی هات — داواکارییەکە هەڵوەشێندرایەوە')
    : st === 'cancelled' ? loc('ملغاة — لم تبدأ', 'Cancelled — never started', 'هەڵوەشێنراوە — دەستی پێنەکرد')
    : loc('بانتظار التفعيل — تبدأ عند تسليم الطلب ودفعه كاملاً', 'Pending — starts when the order is delivered and fully paid', 'چاوەڕێی چالاککردن — کاتێک داواکارییەکە گەیەندرا و هەموو پارەکەی درا دەست پێدەکات');
  const day = (iso: string | null) => (iso ? iso.slice(0, 10) : '');

  return (
    <section data-order-membership>
      <h3 className="text-[13px] font-bold text-text-secondary mb-2">{loc('العضوية مع الطلب', 'Membership with the order', 'ئەندامێتی لەگەڵ داواکاری')}</h3>
      <ul className="space-y-2">
        {purchases.map((p) => {
          const id = p.id ?? `omp_${p.order_item_id}`;
          const st = said[id]?.state ?? p.state;
          const reason = said[id] ? said[id].review_reason : p.review_reason;
          return (
            <li key={id} className="lv-well rounded-md p-3 text-sm" data-order-membership-state={st}>
              <p className="flex items-start gap-2 text-text-primary">
                <span className="min-w-0 flex-1 font-bold">
                  {tierLabel(p.tier)} — {loc(`${p.duration_months} شهر`, `${p.duration_months} months`, `${p.duration_months} مانگ`)} · {kindText(p.kind)}
                </span>
              </p>
              <p className="mt-1 ps-6 text-[12px] text-text-secondary tabular-nums">
                {loc('السعر', 'Price', 'نرخ')}: {formatIqd(p.price_iqd)}
                {p.credit_iqd > 0 ? <> · {loc('رصيد الترقية', 'Upgrade credit', 'باڵانسی بەرزکردنەوە')}: −{formatIqd(p.credit_iqd)}</> : null}
                {' · '}<span className="font-bold text-text-primary">{loc('المدفوع', 'Charged', 'پارەی دراو')}: {formatIqd(p.charge_iqd)}</span>
              </p>
              <p className="mt-1 ps-6 text-[12px] text-text-primary">{stateText(st, !!p.activated_at)}</p>
              {p.starts_at || p.expires_at ? (
                <p className="mt-1 ps-6 text-[11px] text-text-muted tabular-nums">
                  {p.starts_at ? `${loc('تبدأ', 'Starts', 'دەست پێدەکات')}: ${day(p.starts_at)}` : ''}
                  {p.starts_at && p.expires_at ? ' · ' : ''}
                  {p.expires_at ? `${loc('تنتهي', 'Expires', 'کۆتایی دێت')}: ${day(p.expires_at)}` : ''}
                </p>
              ) : null}
              {st === 'blocked' ? (
                <div className="mt-2 ps-6">
                  {reason ? <p className="text-[12px] text-text-secondary whitespace-pre-wrap">{reason}</p> : null}
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <button type="button" className="lv-button lv-button-secondary lv-button-sm" disabled={busy === id} onClick={() => void retry(p)}>
                      {loc('إعادة المحاولة', 'Retry', 'دووبارە هەوڵدانەوە')}
                    </button>
                    <span className="text-[11px] text-text-muted">
                      {loc('بعد معالجة العضوية المتعارضة. لا تحرّك أي مال.', 'After the conflicting membership was dealt with. Moves no money.', 'دوای چارەسەرکردنی ئەندامێتییە ناکۆکەکە. هیچ پارەیەک ناجوڵێنێت.')}
                    </span>
                  </div>
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
      {viewerOwner && started && !corrected ? (
        <div className="mt-2 flex flex-wrap items-center gap-2" data-order-membership-correction>
          <button type="button" className="lv-button lv-button-secondary lv-button-sm" disabled={busy === 'correction'} onClick={() => void correct()}>
            {loc('تصحيح: إلغاء الطلب وإنهاء العضوية', 'Correction: cancel the order and end the membership', 'ڕاستکردنەوە: هەڵوەشاندنەوەی داواکاری و کۆتاییهێنان بە ئەندامێتی')}
          </button>
          <span className="text-[11px] text-text-muted">
            {loc(
              'للمالك فقط: تنتهي العضوية ويُسترد الطلب كإلغاء عادي.',
              'Owner only: ends the membership and refunds the order as an ordinary cancel.',
              'تەنها بۆ خاوەن: ئەندامێتییەکە کۆتایی دێت و پارەی داواکارییەکە وەک هەڵوەشاندنەوەی ئاسایی دەگەڕێتەوە.'
            )}
          </span>
        </div>
      ) : null}
      {corrected ? (
        <p role="status" className="mt-2 text-[12px] text-text-primary">
          {loc('أُلغي الطلب وانتهت العضوية، ويُسترد الطلب كإلغاء عادي.', 'The order was cancelled and the membership ended; the order is refunded as an ordinary cancel.', 'داواکارییەکە هەڵوەشێندرایەوە و ئەندامێتییەکە کۆتایی هات؛ پارەی داواکارییەکە وەک هەڵوەشاندنەوەی ئاسایی دەگەڕێتەوە.')}
        </p>
      ) : null}
      {error ? <p role="alert" className="mt-2 text-[12px] text-text-primary">{error}</p> : null}
      {promptDialog}
    </section>
  );
}
