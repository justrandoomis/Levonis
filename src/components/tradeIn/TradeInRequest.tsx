/**
 * «طلب الاستبدال» — one request, as its owner follows it.
 *
 * The status and its timeline come from the server's event log; nothing here
 * decides a state. Three moments ask the customer for something:
 *
 *   a draft          «أكمل الطلب» — back into the wizard where it stopped;
 *   value_changed    the admin's new value beside the estimate, the reason,
 *                    and what that leaves to pay — «أوافق» / «أرفض». The
 *                    buttons name the offer they answer, so a value that
 *                    changed again while the screen was open is refused
 *                    rather than accepted blind (TRADE_IN_OFFER_STALE);
 *   awaiting_payment «إتمام الدفع» — the new device goes into the ordinary
 *                    cart, the credit code into the ordinary checkout, and the
 *                    checkout decides what the credit is worth on that cart.
 *
 * Every string is in Arabic, English and Sorani (DECISIONS row 183).
 */
import React, { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { CheckCircle2, Clock, XCircle, CreditCard, Repeat, ChevronDown } from 'lucide-react';
import { useLanguage } from '../../LanguageContext';
import { api, ApiError, failureText, type CartItem } from '../../lib/api';
import { apiRefusal } from '../../lib/refusalStrings';
import { storePromo } from '../PromoCodeField';
import { Button } from '../ui/Button';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { Money } from '../ui/Money';
import Note from '../ui/Note';
import SafeImage from '../ui/SafeImage';
import Spinner from '../ui/Spinner';
import { FAMILY_LABELS, REQUIRED_PHOTOS, OPTIONAL_PHOTO } from '../../../packages/pricing/src/tradeIn';
import { type RequestView, dateText, partLabel } from './model';
import { Breakdown, Card, FactRow, SectionTitle, SettlementRows } from './controls';

const EVENT_LABELS: Record<string, [string, string, string]> = {
  create: ['بدأت الطلب', 'You started the request', 'داواکارییەکەت دەست پێکرد'],
  submit: ['أُرسل للمراجعة', 'Sent for review', 'بۆ پێداچوونەوە نێردرا'],
  inspect: ['بدأ الفحص', 'Inspection started', 'پشکنین دەستی پێکرد'],
  approve: ['اعتُمد التقدير', 'Estimate approved', 'خەمڵاندنەکە پەسەند کرا'],
  change_value: ['قيمة جديدة من الفريق', 'A new value from the team', 'بەهایەکی نوێ لە تیمەکەوە'],
  accept: ['وافقت على القيمة', 'You accepted the value', 'بەهاکەت قبووڵ کرد'],
  reject: ['رفضت القيمة', 'You declined the value', 'بەهاکەت ڕەت کردەوە'],
  awaiting_payment: ['ثُبّتت القيمة — بانتظار الدفع', 'Value fixed — awaiting payment', 'بەهاکە جێگیر کرا — چاوەڕێی پارەدانە'],
  credit_reissued: ['أُعيد إصدار رصيد الاستبدال', 'Trade-in credit re-issued', 'باڵانسی گۆڕینەوە دووبارە دەرکرایەوە'],
  complete: ['اكتمل الاستبدال', 'Trade-in completed', 'گۆڕینەوەکە تەواو بوو'],
  cancel: ['أُلغي الطلب', 'Request cancelled', 'داواکارییەکە هەڵوەشێنرایەوە'],
};

export default function TradeInRequest({ id, onResume, onBack }: { id: string; onResume: (r: RequestView) => void; onBack: () => void }) {
  const { loc, lang } = useLanguage();
  const L = (ar: string, en: string, ckb: string) => loc(ar, en, ckb);
  const navigate = useNavigate();
  const [req, setReq] = useState<RequestView | null>(null);
  const [error, setError] = useState('');
  const [actionError, setActionError] = useState('');
  const [confirm, setConfirm] = useState<null | 'reject' | 'cancel'>(null);
  const [cartConflict, setCartConflict] = useState(false);
  const [showBreakdown, setShowBreakdown] = useState(false);

  const errText = useCallback(
    (e: unknown) => apiRefusal(e, lang === 'en' ? 'en' : lang === 'ckb' ? 'ckb' : 'ar') || failureText(e, loc('حدث خطأ. حاول مرة أخرى.', 'Something went wrong. Try again.', 'هەڵەیەک ڕوویدا. دووبارە هەوڵ بدەرەوە.')),
    [lang, loc]
  );

  const load = useCallback(async () => {
    setError('');
    try {
      const d = await api.get<{ request: RequestView }>(`/api/trade-in/requests/${encodeURIComponent(id)}`);
      setReq(d.request);
    } catch (e) {
      setError(errText(e));
    }
  }, [id, errText]);

  useEffect(() => {
    void load();
  }, [load]);

  const decide = async (d: 'accept' | 'reject') => {
    if (!req?.offer) return;
    setActionError('');
    try {
      const r = await api.post<{ request: RequestView }>(`/api/trade-in/requests/${req.id}/${d}`, { offer_no: req.offer.offer_no });
      setReq(r.request);
      setConfirm(null);
    } catch (e) {
      setActionError(errText(e));
      if (e instanceof ApiError && e.code === 'TRADE_IN_OFFER_STALE') void load();
    }
  };

  const cancel = async () => {
    if (!req) return;
    setActionError('');
    try {
      const r = await api.post<{ request: RequestView }>(`/api/trade-in/requests/${req.id}/cancel`, {});
      setReq(r.request);
      setConfirm(null);
    } catch (e) {
      setActionError(errText(e));
    }
  };

  const pay = async (replaceCart = false) => {
    if (!req) return;
    setActionError('');
    setCartConflict(false);
    try {
      const d = await api.post<{ coupon_code: string | null; order_id: string | null; target: { product_id: string; option_value_ids: string[]; color_id: string | null } }>(
        `/api/trade-in/requests/${req.id}/checkout`
      );
      if (d.order_id) {
        navigate(`/orders/${encodeURIComponent(d.order_id)}`);
        return;
      }
      if (!d.coupon_code) {
        await load();
        return;
      }
      const body: Record<string, unknown> = { productId: d.target.product_id, qty: 1, fulfillmentType: 'direct_sale' };
      if (d.target.option_value_ids.length) body.optionValueIds = d.target.option_value_ids;
      if (d.target.color_id) body.colorId = d.target.color_id;
      if (replaceCart) body.replaceCart = true;
      let items: CartItem[] = [];
      try {
        items = (await api.post<{ items: CartItem[] }>('/api/cart/items', body)).items ?? [];
      } catch (e) {
        if (e instanceof ApiError && (e.code === 'CART_SHIPPING_CONFLICT' || e.code === 'CART_SELLER_CONFLICT')) {
          setCartConflict(true);
          return;
        }
        throw e;
      }
      const line = items.find(
        (it) =>
          it.productId === d.target.product_id &&
          (d.target.option_value_ids.length === 0 || d.target.option_value_ids.every((v) => (it.option_value_ids ?? [it.option_id]).includes(v))) &&
          (!d.target.color_id || it.color_id === d.target.color_id)
      );
      // The code rides to the checkout the way a typed promo does
      // (PromoCodeField's session slot); the checkout re-validates it.
      storePromo(d.coupon_code);
      navigate('/checkout', { state: line ? { itemIds: [line.id] } : undefined });
    } catch (e) {
      setActionError(errText(e));
    }
  };

  if (error) {
    return (
      <Card>
        <p className="text-[13px] text-rose-300">{error}</p>
        <div className="flex gap-2 mt-3">
          <Button variant="secondary" onClick={load}>{L('إعادة المحاولة', 'Try again', 'دووبارە هەوڵ بدەرەوە')}</Button>
          <Button variant="ghost" onClick={onBack}>{L('طلباتي للاستبدال', 'My trade-ins', 'داواکارییەکانی گۆڕینەوەم')}</Button>
        </div>
      </Card>
    );
  }
  if (!req) {
    return (
      <div className="flex justify-center py-16">
        <Spinner />
      </div>
    );
  }

  const tone =
    req.status === 'completed' || req.status === 'awaiting_payment'
      ? 'lv-chip [--chip:var(--color-success)]'
      : req.status === 'cancelled' || req.status === 'customer_rejected'
        ? 'bg-white/[0.06] text-text-secondary'
        : req.status === 'value_changed'
          ? 'lv-chip [--chip:var(--color-warning)]'
          : 'lv-chip [--chip:var(--color-gold)]';
  const target = req.target;

  return (
    <div className="space-y-4 lg:grid lg:grid-cols-[minmax(0,1fr)_340px] lg:gap-6 lg:space-y-0 lg:items-start" data-trade-in-request={req.id} data-status={req.status}>
      <div className="space-y-4 min-w-0">
        <Card>
          <span className={`inline-flex items-center gap-1.5 h-7 px-2.5 rounded-full text-[12px] font-bold ${tone}`} data-status-chip>
            {req.status === 'completed' ? <CheckCircle2 className="w-3.5 h-3.5" aria-hidden /> : req.status === 'cancelled' || req.status === 'customer_rejected' ? <XCircle className="w-3.5 h-3.5" aria-hidden /> : <Clock className="w-3.5 h-3.5" aria-hidden />}
            {loc(req.status_label.ar, req.status_label.en, req.status_label.ckb)}
          </span>
          <div className="flex items-center gap-3 mt-3">
            <SafeImage sizes="56px" src={req.source.image} alt="" aspect="square" className="w-14 h-14 rounded-md shrink-0" bgClassName="bg-surface-raised" />
            <div className="min-w-0 flex-1">
              <p className="text-text-primary font-bold text-[15px] leading-6 line-clamp-2">{req.source.name}</p>
              <p className="text-[12px] text-text-muted">
                {req.scope === 'ams_only' ? L('AMS فقط', 'AMS only', 'تەنها AMS') : req.scope === 'printer_only' ? L('الطابعة فقط', 'Printer only', 'تەنها چاپکەر') : L('الجهاز كاملاً', 'Whole device', 'ئامێرەکە بە تەواوی')}
                {' · '}
                {loc(FAMILY_LABELS[req.family].ar, FAMILY_LABELS[req.family].en, FAMILY_LABELS[req.family].ckb)}
              </p>
            </div>
          </div>
          {target ? (
            <div className="flex items-center gap-2 mt-3 pt-3 border-t border-border-subtle text-[13px] text-text-secondary">
              <Repeat className="w-4 h-4 text-gold shrink-0" aria-hidden />
              <span className="min-w-0 truncate">
                {L('إلى', 'For', 'بۆ')} <strong className="text-text-primary">{loc(target.name_ar, target.name, target.name_ckb || target.name)}</strong>
                {target.options?.length ? <span className="text-text-muted"> · {target.options.map((o) => (loc(o.label_ar, o.label_en, o.label_ckb || o.label_en))).join(' · ')}</span> : null}
              </span>
            </div>
          ) : null}
        </Card>

        {req.status === 'draft' ? (
          <Card>
            <SectionTitle title={L('الطلب لم يُرسل بعد', 'Not sent yet', 'داواکارییەکە هێشتا نەنێردراوە')} hint={L('أكمل الخطوات ثم أرسله للمراجعة.', 'Finish the steps, then send it for review.', 'هەنگاوەکان تەواو بکە، پاشان بۆ پێداچوونەوەی بنێرە.')} />
            <Button variant="primary" block onClick={() => onResume(req)} data-resume>
              {L('أكمل الطلب', 'Continue the request', 'داواکارییەکە تەواو بکە')}
            </Button>
          </Card>
        ) : null}

        {req.status === 'value_changed' && req.offer ? (
          <Card className="border-amber-900/60" data-decision>
            <SectionTitle
              title={L('قيمة جديدة لجهازك', 'A new value for your device', 'بەهایەکی نوێ بۆ ئامێرەکەت')}
              hint={L('فحص فريق LEVONIS جهازك وحدّد قيمة مختلفة عن التقدير الأولي. اقبلها لنكمل، أو ارفضها ويُغلق الطلب.', 'The LEVONIS team inspected your device and set a value different from the estimate. Accept to continue, or decline to close the request.', 'تیمی LEVONIS ئامێرەکەتی پشکنی و بەهایەکی جیاواز لە خەمڵاندنی سەرەتایی دیاری کرد. قبووڵی بکە بۆ ئەوەی بەردەوام بین، یان ڕەتی بکەرەوە و داواکارییەکە دادەخرێت.')}
            />
            <div className="flex items-end justify-between gap-3">
              <div>
                <p className="text-[12px] text-text-muted">{L('التقدير الأولي', 'Estimate', 'خەمڵاندنی سەرەتایی')}</p>
                <p className="text-[15px] text-text-muted line-through">
                  <Money iqd={req.estimated_iqd} />
                </p>
              </div>
              <div className="text-end">
                <p className="text-[12px] text-text-secondary">{L('القيمة الجديدة', 'New value', 'بەها نوێیەکە')}</p>
                <p className="text-[26px] font-black text-text-primary leading-8">
                  <Money iqd={req.offer.value_iqd} />
                </p>
              </div>
            </div>
            {req.offer.reason ? (
              <p className="mt-3 text-[13px] leading-6 text-text-secondary lv-well rounded-md p-3">
                <span className="text-text-muted">{L('السبب: ', 'Reason: ', 'هۆکار: ')}</span>
                {req.offer.reason}
              </p>
            ) : null}
            <div className="mt-3">
              <SettlementRows s={req.offer.settlement} />
            </div>
            <div className="grid grid-cols-2 gap-2 mt-4">
              <Button variant="secondary" onClick={() => setConfirm('reject')} data-reject>
                {L('أرفض', 'Decline', 'ڕەتی دەکەمەوە')}
              </Button>
              <Button variant="accent" onClick={() => decide('accept')} data-accept>
                {L('أوافق على القيمة', 'Accept the value', 'بەهاکە قبووڵ دەکەم')}
              </Button>
            </div>
          </Card>
        ) : null}

        {req.status === 'awaiting_payment' ? (
          <Card className="border-emerald-900/60" data-payment>
            <SectionTitle title={L('ثُبّتت قيمة الاستبدال', 'Your trade-in value is fixed', 'بەهای گۆڕینەوەکەت جێگیر کرا')} hint={L('ادفع الفرق عند طلب الجهاز الجديد، والتوصيل كأي طلب.', 'Pay the difference when you order the new device; delivery as on any order.', 'کاتێک ئامێرە نوێیەکە داوا دەکەیت جیاوازییەکە بدە؛ گەیاندنیش وەک هەر داواکارییەکە.')} />
            <dl>
              <FactRow label={L('قيمة جهازك', 'Your device', 'بەهای ئامێرەکەت')} value={<Money iqd={req.final_value_iqd} />} />
              <FactRow label={L('سعر الجهاز الجديد', 'New device', 'نرخی ئامێرە نوێیەکە')} value={<Money iqd={target?.price_iqd ?? null} />} />
              <FactRow label={L('المطلوب دفعه', 'You pay', 'ئەوەی دەیدەیت')} value={<Money iqd={req.difference_iqd} />} strong />
              {/* Owner decision 2: the credit is usable for a limited time. */}
              {!req.credit_order && req.credit_expires_at ? (
                <FactRow
                  label={loc('الرصيد صالح حتى', 'Credit valid until', 'باڵانس بەردەوامە تا')}
                  value={<span className="tabular-nums">{dateText(req.credit_expires_at, lang)}</span>}
                />
              ) : null}
            </dl>
            {req.credit_expired && !req.credit_order ? (
              <Note tone="amber" compact animate={false} className="mt-3" data-credit-expired>
                {loc(
                  'انتهت صلاحية رصيد الاستبدال. تواصل معنا لمراجعة الطلب.',
                  'The trade-in credit has expired. Contact us to review the request.',
                  'ماوەی باڵانسی گۆڕینەوە بەسەرچووە. پەیوەندیمان پێوە بکە بۆ پێداچوونەوەی داواکارییەکە.'
                )}
              </Note>
            ) : null}
            {req.excess_iqd && req.excess_iqd > 0 ? (
              <Note tone="amber" compact animate={false} className="mt-3">
                {L('يُحتسب من قيمة جهازك ما يغطي سعر الجهاز الجديد فقط.', 'Only the new device’s price is credited from your device’s value.', 'لە بەهای ئامێرەکەت تەنها ئەوەندەی نرخی ئامێرە نوێیەکە دەگرێتەوە حیساب دەکرێت.')}
              </Note>
            ) : null}
            {req.credit_order ? (
              <Link to={`/orders/${encodeURIComponent(req.credit_order.id)}`} className="mt-4 flex items-center justify-between gap-2 min-h-[44px] rounded-md border border-border-subtle px-3 text-[13px] text-text-primary hover:bg-surface-raised">
                <span>{L('طلب الشراء', 'Your order', 'داواکاریی کڕینەکەت')} <span dir="ltr" className="font-mono">{req.credit_order.id}</span></span>
                <CreditCard className="w-4 h-4 text-gold" aria-hidden />
              </Link>
            ) : (
              <Button variant="accent" block className="mt-4" onClick={() => pay(false)} disabled={!req.can.pay} data-pay>
                {L('إتمام الدفع', 'Complete the payment', 'تەواوکردنی پارەدان')}
              </Button>
            )}
            {cartConflict ? (
              <Note tone="amber" animate={false} className="mt-3">
                <p>{L('في سلتك منتجات بنوع شحن آخر أو من متجر آخر، والجهاز الجديد بيع مباشر من LEVONIS.', 'Your cart holds items shipped another way or from another store; the new device is a direct LEVONIS sale.', 'سەبەتەکەت بەرهەمی تێدایە بە جۆرێکی تری ناردن یان لە فرۆشگایەکی ترەوە، و ئامێرە نوێیەکە فرۆشتنی ڕاستەوخۆی LEVONIS ـە.')}</p>
                <Button variant="secondary" size="sm" className="mt-2" onClick={() => pay(true)}>
                  {L('أفرغ السلة وتابع', 'Empty the cart and continue', 'سەبەتەکە بەتاڵ بکە و بەردەوام بە')}
                </Button>
              </Note>
            ) : null}
          </Card>
        ) : null}

        {req.status === 'completed' ? (
          <Note tone="gold" animate={false} icon={<CheckCircle2 className="w-4 h-4" />}>
            {L('اكتمل الاستبدال. شكراً لثقتك بـ LEVONIS.', 'The trade-in is complete. Thank you for trusting LEVONIS.', 'گۆڕینەوەکە تەواو بوو. سوپاس بۆ متمانەت بە LEVONIS.')}
          </Note>
        ) : null}
        {req.status === 'cancelled' && req.cancel_reason ? (
          <Note tone="zinc" animate={false}>
            {L('سبب الإلغاء: ', 'Cancelled: ', 'هۆکاری هەڵوەشاندنەوە: ')}
            {req.cancel_reason}
          </Note>
        ) : null}

        {actionError ? (
          <p role="alert" className="text-[13px] text-rose-300">
            {actionError}
          </p>
        ) : null}

        {req.estimate ? (
          <Card>
            <button type="button" className="w-full flex items-center justify-between gap-2 min-h-[44px]" aria-expanded={showBreakdown} onClick={() => setShowBreakdown((v) => !v)}>
              <span className="text-start">
                <span className="block text-[12px] text-text-muted">{L('التقدير الأولي', 'Preliminary estimate', 'خەمڵاندنی سەرەتایی')}</span>
                <span className="block text-[18px] font-black text-text-primary">
                  <Money iqd={req.estimated_iqd} />
                </span>
              </span>
              <ChevronDown className={`w-5 h-5 text-text-muted transition-transform ${showBreakdown ? 'rotate-180' : ''}`} aria-hidden />
            </button>
            {showBreakdown ? (
              <div className="mt-2 space-y-4">
                {req.estimate.components.map((c) => (
                  <Breakdown key={c.role} valuation={c} title={partLabel(c, loc)} />
                ))}
              </div>
            ) : null}
          </Card>
        ) : null}

        {req.components.some((c) => c.photos.length > 0) ? (
          <Card>
            <SectionTitle title={L('صورك', 'Your photos', 'وێنەکانت')} />
            {req.components.map((c) => (
              <div key={c.role} className="mb-3 last:mb-0">
                {req.components.length > 1 ? <p className="text-[12px] text-text-muted mb-1.5">{c.role === 'ams' ? 'AMS' : L('الطابعة', 'Printer', 'چاپکەر')}</p> : null}
                <div className="grid grid-cols-4 gap-1.5 sm:grid-cols-6">
                  {c.photos.map((p) => {
                    const a = [...REQUIRED_PHOTOS[c.family], OPTIONAL_PHOTO].find((x) => x.id === p.angle);
                    return (
                      <a key={p.id} href={p.url} target="_blank" rel="noreferrer" className="relative block aspect-square rounded-lg overflow-hidden bg-surface-raised" title={a ? (loc(a.label_ar, a.label_en, a.label_ckb)) : p.angle}>
                        <img src={p.url} alt={a ? (loc(a.label_ar, a.label_en, a.label_ckb)) : ''} className="w-full h-full object-cover" loading="lazy" />
                      </a>
                    );
                  })}
                </div>
              </div>
            ))}
          </Card>
        ) : null}
      </div>

      <aside className="space-y-4">
        <Card>
          <SectionTitle title={L('مراحل الطلب', 'Timeline', 'قۆناغەکانی داواکاری')} />
          <ol className="relative ms-2 border-s border-border-subtle">
            {req.events.map((e, i) => {
              const label = EVENT_LABELS[e.action] ?? [e.action, e.action, e.action];
              const v = typeof e.detail.value_iqd === 'number' ? (e.detail.value_iqd as number) : null;
              return (
                <li key={`${e.action}-${i}`} className="ms-4 pb-4 last:pb-0">
                  <span className={`absolute -start-[5px] mt-1.5 h-2.5 w-2.5 rounded-full ${i === req.events.length - 1 ? 'bg-gold' : 'bg-border-subtle'}`} aria-hidden />
                  <p className="text-[13px] font-semibold text-text-primary">{loc(label[0], label[1], label[2])}</p>
                  <p className="text-[11.5px] text-text-muted tabular-nums">
                    {dateText(e.created_at, lang)}
                    {v !== null ? (
                      <>
                        {' · '}
                        <Money iqd={v} />
                      </>
                    ) : null}
                  </p>
                  {typeof e.detail.reason === 'string' && e.detail.reason ? <p className="text-[12px] text-text-secondary mt-0.5">{e.detail.reason}</p> : null}
                </li>
              );
            })}
          </ol>
        </Card>
        {req.can.cancel && req.status !== 'value_changed' ? (
          <Button variant="ghost" block onClick={() => setConfirm('cancel')} data-cancel>
            {L('إلغاء الطلب', 'Cancel the request', 'هەڵوەشاندنەوەی داواکاری')}
          </Button>
        ) : null}
      </aside>

      <ConfirmDialog
        open={confirm === 'reject'}
        title={L('رفض القيمة الجديدة؟', 'Decline the new value?', 'بەها نوێیەکە ڕەت دەکەیتەوە؟')}
        consequence={L('يُغلق طلب الاستبدال ويعود جهازك متاحاً لطلب جديد.', 'The trade-in request closes and your device is free for a new one.', 'داواکاریی گۆڕینەوەکە دادەخرێت و ئامێرەکەت بۆ داواکارییەکی نوێ ئامادە دەبێتەوە.')}
        confirmLabel={L('أرفض', 'Decline', 'ڕەتی دەکەمەوە')}
        destructive
        onConfirm={() => decide('reject')}
        onCancel={() => setConfirm(null)}
        error={actionError || undefined}
      />
      <ConfirmDialog
        open={confirm === 'cancel'}
        title={L('إلغاء طلب الاستبدال؟', 'Cancel this trade-in?', 'ئەم گۆڕینەوەیە هەڵدەوەشێنیتەوە؟')}
        consequence={L('لن نراجع هذا الطلب، ويعود جهازك متاحاً لطلب جديد.', 'We will not review this request, and your device is free for a new one.', 'پێداچوونەوە بەم داواکارییەدا ناکەین، و ئامێرەکەت بۆ داواکارییەکی نوێ ئامادە دەبێتەوە.')}
        confirmLabel={L('إلغاء الطلب', 'Cancel the request', 'هەڵوەشاندنەوەی داواکاری')}
        destructive
        onConfirm={cancel}
        onCancel={() => setConfirm(null)}
        error={actionError || undefined}
      />
    </div>
  );
}
