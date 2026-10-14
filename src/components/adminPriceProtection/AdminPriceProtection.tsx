/**
 * «حماية السعر» — the admin queue for price-protection claims (Services V2
 * S-P0a; price-protection design B.4, the minimal queue).
 *
 * Until now a claim could only be decided through the raw API, with no screen
 * and no evidence. This lists the claims (state chips with counts, a search by
 * claim, order, customer or product) and opens one in a sheet with what the
 * decision rests on:
 *   - what the customer paid per unit, the lowest price compared, the units;
 *   - the product's price rows inside the claim's window — who wrote each, and
 *     whether it is a row this claim compares (the line's rung and class);
 *   - what approving would credit NOW, or why the server would refuse it.
 *
 * THE ACTIONS are the server's (worker/routes/returns.ts) and nothing more:
 *   اعتماد   credits the wallet (financial scope; above the owner line, or for
 *            the author of a price in the window, the main admin with a
 *            private reason — owner decision 3)
 *   رفض      a reason from the list, optionally a note; the customer reads
 *            both, in their language, on the order page and in the bell
 * A button the server would refuse is disabled here with the reason beside it;
 * the server still decides. No cost, profit or rate is ever on this screen.
 *
 * Built on the admin products design system (.ap tokens), like AdminTradeIn.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { ShieldCheck, RefreshCw, Search, X, CheckCircle2, Ban, ExternalLink } from 'lucide-react';
import * as T from '../adminProducts/theme';
import '../adminProducts/theme.css';
import { Modal } from '../adminProducts/ui';
import { api, ApiError, failureText } from '../../lib/api';
import { apiRefusal, refusalLang, refusalText } from '../../lib/refusalStrings';
import { useLanguage } from '../../LanguageContext';
import {
  PRICE_PROTECTION_REASONS,
  PRICE_PROTECTION_REASON_CODES,
  priceProtectionReasonText,
  type PriceProtectionReasonCode,
} from '../../../packages/contracts/src/priceProtection';

type ClaimState = 'requested' | 'approved' | 'rejected' | 'credited';

interface ClaimView {
  id: string;
  order_id: string;
  order_item_id: string;
  original_unit_iqd: number;
  observed_unit_iqd: number;
  qty: number;
  credited_iqd: number;
  state: ClaimState | string;
  eligible_unit_iqd: number | null;
  decision_reason: { code: string | null; note: string } | null;
  requested_at: string;
  decided_at: string | null;
  policy?: Record<string, unknown>;
  item?: { name: string; variant: string };
  customer_name?: string | null;
  customer_phone?: string | null;
  email?: string | null;
}

interface EvidenceRow {
  at: string;
  key: string;
  field: string;
  old_iqd: number | null;
  new_iqd: number | null;
  author: string | null;
  by_owner: boolean;
  counted: boolean;
}

/** A member price rule or the PRO pricing policy changed inside the claim's window (review F6). */
interface RuleChangeRow {
  at: string;
  kind: 'member_rule' | 'pro_policy';
  author: string | null;
  by_owner: boolean;
}

interface DetailResponse {
  claim: ClaimView;
  item: { name: string; variant: string; qty: number } | null;
  order: { id: string; status: string; created_at: string; delivered_at: string | null } | null;
  customer: { name: string; email: string; phone: string | null } | null;
  evidence: EvidenceRow[];
  rule_changes?: RuleChangeRow[];
  now: { paid_unit_iqd: number; per_unit_iqd: number; units: number; prior_credited_iqd: number; credit_iqd: number } | null;
  blocked: string | null;
  approval: { financial_scope: boolean; owner_scope: boolean; needs_owner: boolean; why: 'above_line' | 'price_author' | 'beneficiary' | null };
}

const FILTERS: Array<ClaimState | ''> = ['requested', 'credited', 'rejected', ''];

type Loc = (ar: string, en: string, ckb?: string) => string;

const STATE_LABEL = (loc: Loc, s: string) =>
  s === 'requested'
    ? loc('قيد التدقيق', 'Under review', 'لە پشکنیندایە')
    : s === 'credited'
      ? loc('أُضيف للمحفظة', 'Credited', 'خرایە سەر جزدان')
      : s === 'approved'
        ? loc('مقبولة', 'Approved', 'پەسەندکراو')
        : s === 'rejected'
          ? loc('مرفوضة', 'Declined', 'ڕەتکراوەتەوە')
          : loc('الكل', 'All', 'هەموو');

function stateTone(s: string): string {
  if (s === 'credited' || s === 'approved') return T.badge.active;
  if (s === 'rejected') return T.badge.hidden;
  return T.badge.draft;
}

function initialClaimId(): string | null {
  try {
    const id = new URLSearchParams(window.location.search).get('claim') ?? '';
    return /^ppc_[A-Za-z0-9]{8,40}$/.test(id) ? id : null;
  } catch {
    return null;
  }
}

export default function AdminPriceProtection() {
  const { loc, dir, lang } = useLanguage();
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  useEffect(() => setSlot(document.getElementById('dash-topbar-slot')), []);
  const [state, setState] = useState<ClaimState | ''>('requested');
  const [q, setQ] = useState('');
  const [rows, setRows] = useState<ClaimView[] | null>(null);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [error, setError] = useState('');
  const [open, setOpen] = useState<string | null>(initialClaimId);
  const iqd = useIqd();

  const load = useCallback(async () => {
    setError('');
    const p = new URLSearchParams();
    if (state) p.set('state', state);
    if (q.trim()) p.set('q', q.trim());
    try {
      const d = await api.get<{ claims: ClaimView[]; counts: Record<string, number> }>(`/api/price-protection/admin/claims?${p.toString()}`);
      setRows(d.claims);
      setCounts(d.counts ?? {});
    } catch (e) {
      setError(failureText(e, loc('تعذّر التحميل', 'Could not load', 'بار نەکرا')));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, q]);

  useEffect(() => {
    const id = window.setTimeout(() => void load(), q ? 300 : 0);
    return () => window.clearTimeout(id);
  }, [load, q]);

  return (
    <div className={`${T.AP} space-y-4`} dir={dir} data-panel="price-protection">
      {slot &&
        createPortal(
          <nav className={`${T.AP} hidden sm:flex items-center gap-1.5 text-[12.5px] text-[var(--ap-text-3)] min-w-0`} aria-label="breadcrumb" dir={dir}>
            <span>{loc('الإدارة', 'Admin', 'بەڕێوەبەرایەتی')}</span>
            <span aria-hidden>/</span>
            <span className="text-[var(--ap-text-1)] font-semibold truncate">{loc('حماية السعر', 'Price protection', 'پاراستنی نرخ')}</span>
          </nav>,
          slot
        )}
      <div className="min-w-0">
        <h1 className="text-[20px] font-bold flex items-center gap-2">
          <ShieldCheck className="w-5 h-5 text-[var(--ap-accent-text)]" aria-hidden />
          {loc('حماية السعر', 'Price protection', 'پاراستنی نرخ')}
        </h1>
        <p className={`text-[13px] ${T.text3}`}>
          {loc(
            'مطالبات الزبائن بفرق السعر خلال 7 أيام من الاستلام: دقّق الأسعار ثم اعتمد أو ارفض.',
            'Customers’ claims for a price difference within 7 days of delivery: check the prices, then approve or decline.',
            'داواکارییەکانی کڕیاران بۆ جیاوازیی نرخ لە ماوەی ٧ ڕۆژ دوای گەیاندن: نرخەکان بپشکنە، پاشان پەسەند یان ڕەتی بکەرەوە.'
          )}
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {FILTERS.map((s) => (
          <button key={s || 'all'} type="button" aria-pressed={state === s} className={T.chip} onClick={() => setState(s)} data-filter={s || 'all'}>
            {STATE_LABEL(loc, s)}
            {s && counts[s] ? <span className="ms-1 tabular-nums opacity-80">{counts[s]}</span> : null}
          </button>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[200px]">
          <Search className={`absolute top-1/2 -translate-y-1/2 start-3 w-4 h-4 ${T.text3}`} aria-hidden />
          <input
            className="lv-input w-full ps-9 text-[13px]"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={loc(
              'رقم المطالبة أو الطلب، اسم الزبون أو هاتفه أو بريده، أو المنتج',
              'Claim or order no., customer name, phone or email, or product',
              'ژمارەی داواکاری یان داواکاریی کڕین، ناو یان تەلەفۆن یان ئیمەیڵی کڕیار، یان بەرهەم'
            )}
            aria-label={loc('بحث', 'Search', 'گەڕان')}
          />
          {q ? (
            <button type="button" className={`${T.btnIconGhost} absolute top-1/2 -translate-y-1/2 end-1`} onClick={() => setQ('')} aria-label={loc('مسح', 'Clear', 'سڕینەوە')}>
              <X className="w-4 h-4" aria-hidden />
            </button>
          ) : null}
        </div>
        <button type="button" className={T.btnIconLg} onClick={() => void load()} aria-label={loc('تحديث', 'Refresh', 'نوێکردنەوە')}>
          <RefreshCw className="w-4 h-4" aria-hidden />
        </button>
      </div>
      {error ? <p className="text-[13px] text-[var(--ap-danger)]" role="alert">{error}</p> : null}
      {rows === null ? (
        <p className={`py-12 text-center text-[13px] ${T.text3}`}>{loc('جارٍ التحميل…', 'Loading…', 'بارکردن…')}</p>
      ) : rows.length === 0 ? (
        <div className={`${T.surface} p-8 text-center`}>
          <p className={`text-[13px] ${T.text3}`}>{loc('لا توجد مطالبات بهذه الحالة.', 'No claims in this state.', 'هیچ داواکارییەک بەم دۆخە نییە.')}</p>
        </div>
      ) : (
        <ul className="space-y-2" data-pp-rows>
          {rows.map((r) => {
            const claimed = Number((r.policy ?? {}).computed_eligible_iqd) || 0;
            return (
              <li key={r.id}>
                <button
                  type="button"
                  onClick={() => setOpen(r.id)}
                  data-row={r.id}
                  className={`${T.surface} w-full text-start p-3 flex items-center gap-3 min-h-[56px] hover:border-[var(--ap-border-hover)] transition-colors`}
                >
                  <span className="min-w-0 flex-1">
                    <span className="block text-[13.5px] font-semibold truncate">
                      {r.item?.name ?? r.order_item_id} × {r.qty}
                    </span>
                    <span className={`block text-[12px] ${T.text3} truncate`}>
                      {r.customer_name ?? '—'} · <span dir="ltr">{r.customer_phone ?? r.email ?? ''}</span> · <span dir="ltr">{r.order_id}</span>
                    </span>
                    <span className={`block text-[11.5px] ${T.text3} truncate`}>
                      <span dir="ltr">{r.id}</span> · {day(r.requested_at, lang, true)}
                    </span>
                  </span>
                  <span className="shrink-0 text-end">
                    <span className={`${T.badgeBase} ${stateTone(r.state)}`}>{STATE_LABEL(loc, r.state)}</span>
                    <span className="block text-[13px] font-semibold tabular-nums mt-1">{iqd(r.credited_iqd > 0 ? r.credited_iqd : claimed)}</span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {open ? <Detail id={open} onClose={() => setOpen(null)} onChanged={() => void load()} /> : null}
    </div>
  );
}

function useIqd() {
  const { lang } = useLanguage();
  return (n: number | null | undefined) =>
    n === null || n === undefined || !Number.isFinite(n) ? '—' : `${Math.trunc(n).toLocaleString('en-US')} ${lang === 'en' ? 'IQD' : 'د.ع'}`;
}

function channelLabel(loc: Loc, channel: unknown): string {
  const c = typeof channel === 'string' ? channel : '';
  if (c === 'pre_order_air') return loc('طلب مسبق — شحن جوي', 'Pre-order — air', 'پێشداواکاری — ئاسمانی');
  if (c === 'pre_order_sea') return loc('طلب مسبق — شحن بحري', 'Pre-order — sea', 'پێشداواکاری — دەریایی');
  if (c === 'pre_order_land') return loc('طلب مسبق — شحن بري', 'Pre-order — land', 'پێشداواکاری — وشکانی');
  if (c === 'direct_sale') return loc('بيع مباشر', 'Direct sale', 'فرۆشتنی ڕاستەوخۆ');
  return '—';
}

function classLabel(loc: Loc, cls: unknown): string {
  if (cls === 'prime') return 'PRIME';
  if (cls === 'pro') return 'PRO';
  return loc('عادي', 'Regular', 'ئاسایی');
}

function keyLabel(loc: Loc, key: string): string {
  if (key === '') return loc('السعر الأساسي', 'Base price', 'نرخی بنەڕەتی');
  if (key.startsWith('option:')) return loc('سعر الموديل', 'Model price', 'نرخی مۆدێل');
  if (key.startsWith('color:')) return loc('سعر اللون', 'Colour price', 'نرخی ڕەنگ');
  if (key.startsWith('sku:')) return loc('سعر النظام (موديل × قناة)', 'Engine price (SKU × channel)', 'نرخی سیستەم (مۆدێل × کەناڵ)');
  if (key.startsWith('variant:')) return loc('سعر التركيبة', 'Combination price', 'نرخی تێکەڵە');
  return key;
}

function fieldLabel(loc: Loc, field: string): string {
  if (field === 'prime') return 'PRIME';
  if (field === 'pro') return 'PRO';
  return loc('العادي', 'Regular', 'ئاسایی');
}

function Detail({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: () => void }) {
  const { loc, lang } = useLanguage();
  const iqd = useIqd();
  const [data, setData] = useState<DetailResponse | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [mode, setMode] = useState<'' | 'reject'>('');
  const [reasonCode, setReasonCode] = useState<PriceProtectionReasonCode>('no_drop');
  const [note, setNote] = useState('');
  const [ownerReason, setOwnerReason] = useState('');

  const load = useCallback(async () => {
    try {
      setData(await api.get<DetailResponse>(`/api/price-protection/admin/claims/${encodeURIComponent(id)}`));
    } catch (e) {
      setError(failureText(e, loc('تعذّر التحميل', 'Could not load', 'بار نەکرا')));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);
  useEffect(() => {
    void load();
  }, [load]);

  const decide = async (body: Record<string, unknown>) => {
    setBusy(String(body.decision));
    setError('');
    try {
      await api.post(`/api/price-protection/admin/claims/${encodeURIComponent(id)}/decide`, body);
      setMode('');
      onChanged();
      await load();
    } catch (e) {
      const code = e instanceof ApiError ? e.code : '';
      const text = e instanceof ApiError ? apiRefusal(e, refusalLang(lang), e.message) : failureText(e, loc('تعذّر الحفظ', 'Could not save', 'پاشەکەوت نەکرا'));
      setError(`${text}${code ? ` (${code})` : ''}`);
    } finally {
      setBusy('');
    }
  };

  const c = data?.claim;
  const policy = (c?.policy ?? {}) as Record<string, unknown>;
  const approval = data?.approval;
  const requested = c?.state === 'requested';
  const needsOwner = !!approval?.needs_owner;
  const ownerReady = !needsOwner || (!!approval?.owner_scope && ownerReason.trim().length >= 5);
  const canApprove = requested && !!approval?.financial_scope && !!data?.now && !data?.blocked && ownerReady;

  const footer =
    c && requested ? (
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className={T.btnPrimary}
          disabled={!!busy || !canApprove}
          onClick={() => decide({ decision: 'approved', ...(needsOwner ? { reason: ownerReason.trim() } : {}) })}
          data-act="approve"
        >
          <CheckCircle2 className="w-4 h-4" aria-hidden />
          {data?.now
            ? loc(
                `اعتماد وإضافة ${iqd(data.now.credit_iqd)} للمحفظة`,
                `Approve and credit ${iqd(data.now.credit_iqd)}`,
                `پەسەندکردن و زیادکردنی ${iqd(data.now.credit_iqd)} بۆ جزدان`
              )
            : loc('اعتماد', 'Approve', 'پەسەندکردن')}
        </button>
        <button
          type="button"
          className={T.btnDanger}
          disabled={!!busy || !approval?.financial_scope}
          onClick={() => setMode(mode === 'reject' ? '' : 'reject')}
          aria-expanded={mode === 'reject'}
          data-act="reject"
        >
          <Ban className="w-4 h-4" aria-hidden />
          {loc('رفض', 'Decline', 'ڕەتکردنەوە')}
        </button>
      </div>
    ) : null;

  return (
    <Modal titleAr={loc('مطالبة حماية سعر', 'Price-protection claim', 'داواکاریی پاراستنی نرخ')} titleEn={id} onClose={onClose} wide footer={footer}>
      {!c || !data ? (
        <p className={`py-10 text-center text-[13px] ${T.text3}`}>{error || loc('جارٍ التحميل…', 'Loading…', 'بارکردن…')}</p>
      ) : (
        <div className="space-y-4" data-admin-pp={c.id}>
          {requested && !approval?.financial_scope ? (
            <p className="text-[12.5px] rounded-[var(--ap-radius-md)] border border-[var(--ap-warning-border)] bg-[var(--ap-warning-bg)] text-[var(--ap-warning)] p-2.5">
              {loc(
                'اعتماد المطالبة أو رفضها يحتاج صلاحية مالية.',
                'Approving or declining a claim needs the financial scope.',
                'پەسەندکردن یان ڕەتکردنەوەی داواکاری پێویستی بە دەسەڵاتی دارایی هەیە.'
              )}
            </p>
          ) : null}
          {requested && needsOwner ? (
            approval?.owner_scope ? (
              <label className="block" data-owner-reason>
                <span className={`block text-[12px] ${T.text3} mb-1`}>
                  {loc(
                    'سبب قرارك (خاص، يُسجَّل ويُعلَّم في التقارير، لا يراه الزبون)',
                    'Your reason (private: recorded and flagged in reports, never shown to the customer)',
                    'هۆکاری بڕیارەکەت (تایبەتە: تۆمار دەکرێت و لە ڕاپۆرتەکاندا نیشانە دەکرێت، کڕیار نایبینێت)'
                  )}
                </span>
                <input className="lv-input w-full text-[13px]" maxLength={500} value={ownerReason} onChange={(e) => setOwnerReason(e.target.value)} />
              </label>
            ) : (
              <p className="text-[12.5px] text-[var(--ap-warning)]" role="status" data-needs-owner>
                {approval?.why === 'beneficiary'
                  ? loc(
                      'هذه مطالبة حسابك أنت: يعتمدها الأدمن الرئيسي فقط.',
                      'This is your own account’s claim: only the main admin can approve it.',
                      'ئەمە داواکاریی هەژماری خۆتە: تەنها بەڕێوەبەری سەرەکی دەتوانێت پەسەندی بکات.'
                    )
                  : approval?.why === 'price_author'
                  ? loc(
                      'كتبتَ سعراً لهذا المنتج (أو قاعدة سعر للأعضاء) خلال مدة المطالبة: يعتمدها الأدمن الرئيسي فقط.',
                      'You wrote a price of this product (or a member price rule) within the claim’s period: only the main admin can approve it.',
                      'تۆ لە ماوەی داواکارییەکەدا نرخێکت بۆ ئەم بەرهەمە (یان ڕێسایەکی نرخی ئەندامان) نووسیوە: تەنها بەڕێوەبەری سەرەکی دەتوانێت پەسەندی بکات.'
                    )
                  : loc(
                      'المبلغ فوق حد الموافقة المالية: يعتمده الأدمن الرئيسي فقط بسبب مكتوب.',
                      'The amount is above the financial approval line: only the main admin can approve it, with a written reason.',
                      'بڕەکە سەرووی سنووری پەسەندکردنی داراییە: تەنها بەڕێوەبەری سەرەکی بە هۆکارێکی نووسراو پەسەندی دەکات.'
                    )}
              </p>
            )
          ) : null}
          {requested && data.blocked ? (
            <p className="text-[12.5px] text-[var(--ap-warning)]" role="status" data-blocked={data.blocked}>
              {loc('لا يمكن الاعتماد الآن', 'Cannot be approved now', 'ئێستا پەسەند ناکرێت')}: {refusalText(data.blocked, refusalLang(lang), data.blocked)}
            </p>
          ) : null}
          {mode === 'reject' ? (
            <div className={`${T.surface} p-3 space-y-2`} data-reject-form>
              <label className="block">
                <span className={`block text-[12px] ${T.text3} mb-1`}>{loc('سبب الرفض (يقرؤه الزبون)', 'Reason (the customer reads it)', 'هۆکاری ڕەتکردنەوە (کڕیار دەیخوێنێتەوە)')}</span>
                <select className="lv-input w-full text-[13px]" value={reasonCode} onChange={(e) => setReasonCode(e.target.value as PriceProtectionReasonCode)} data-reason-code>
                  {PRICE_PROTECTION_REASON_CODES.map((code) => (
                    <option key={code} value={code}>
                      {loc(PRICE_PROTECTION_REASONS[code].ar, PRICE_PROTECTION_REASONS[code].en, PRICE_PROTECTION_REASONS[code].ckb)}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className={`block text-[12px] ${T.text3} mb-1`}>{loc('ملاحظة (اختيارية، يقرؤها الزبون)', 'Note (optional, the customer reads it)', 'تێبینی (ئارەزوومەندانە، کڕیار دەیخوێنێتەوە)')}</span>
                <input className="lv-input w-full text-[13px]" maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />
              </label>
              <button
                type="button"
                className={T.btnDanger}
                disabled={!!busy || (reasonCode === 'other' && note.trim().length < 3)}
                onClick={() => decide({ decision: 'rejected', reason_code: reasonCode, reason: note.trim() })}
                data-confirm-reject
              >
                {loc('تأكيد الرفض', 'Confirm decline', 'ڕەتکردنەوە پشتڕاست بکەرەوە')}
              </button>
            </div>
          ) : null}
          {error ? <p className="text-[13px] text-[var(--ap-danger)]" role="alert">{error}</p> : null}

          <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_300px]">
            <div className="space-y-4 min-w-0">
              <section className={`${T.surface} p-4`}>
                <div className="flex items-start gap-3">
                  <div className="min-w-0">
                    <p className="text-[15px] font-bold break-words">{data.item?.name ?? c.order_item_id}</p>
                    {data.item?.variant ? <p className={`text-[12.5px] ${T.text3}`}>{data.item.variant}</p> : null}
                  </div>
                  <span className={`ms-auto shrink-0 ${T.badgeBase} ${stateTone(c.state)}`}>{STATE_LABEL(loc, c.state)}</span>
                </div>
                <dl className="grid grid-cols-2 gap-x-4 gap-y-2 mt-4 text-[13px] sm:grid-cols-3">
                  <Fact
                    k={loc('الطلب', 'Order', 'داواکاری')}
                    v={
                      <a className="underline decoration-dotted" href={`/admin?tab=orders&order=${encodeURIComponent(c.order_id)}`} dir="ltr">
                        {c.order_id} <ExternalLink className="inline w-3 h-3" aria-hidden />
                      </a>
                    }
                  />
                  <Fact k={loc('تاريخ الاستلام', 'Delivered', 'گەیەندرا')} v={day(data.order?.delivered_at, lang)} />
                  <Fact k={loc('تاريخ المطالبة', 'Requested', 'داواکراوە')} v={day(c.requested_at, lang, true)} />
                  <Fact k={loc('فئة السعر', 'Price class', 'پۆلی نرخ')} v={classLabel(loc, policy.buyer_class)} />
                  <Fact k={loc('طريقة الشراء', 'Way of buying', 'شێوازی کڕین')} v={channelLabel(loc, policy.sale_channel)} />
                  <Fact k={loc('الوحدات المشمولة', 'Units covered', 'یەکە گیراوەکان')} v={String(c.qty)} />
                </dl>
              </section>

              <section className={`${T.surface} p-4`} data-evidence>
                <h3 className="text-[14px] font-bold mb-2">{loc('سجل الأسعار خلال المدة', 'Price record in the period', 'تۆماری نرخ لە ماوەکەدا')}</h3>
                {data.evidence.length === 0 ? (
                  <p className={`text-[12.5px] ${T.text3}`}>
                    {loc('لا توجد أسعار مسجّلة لهذا المنتج خلال المدة.', 'No price was recorded for this product in the period.', 'هیچ نرخێک بۆ ئەم بەرهەمە لە ماوەکەدا تۆمار نەکراوە.')}
                  </p>
                ) : (
                  <div className="overflow-x-auto -mx-1">
                    <table className="w-full text-[12.5px] min-w-[480px]">
                      <tbody>
                        {data.evidence.map((h, i) => (
                          <tr key={i} className={`border-t border-[var(--ap-hairline)] first:border-t-0 ${h.counted ? '' : 'opacity-60'}`} data-evidence-row={h.counted ? 'counted' : 'other'}>
                            <td className="py-1.5 pe-2 whitespace-nowrap">{day(h.at, lang, true)}</td>
                            <td className="py-1.5 pe-2" title={h.key}>
                              {keyLabel(loc, h.key)} · {fieldLabel(loc, h.field)}
                            </td>
                            <td className="py-1.5 pe-2 tabular-nums whitespace-nowrap" dir="ltr">
                              {h.old_iqd === null ? '—' : h.old_iqd.toLocaleString('en-US')} → {h.new_iqd === null ? '—' : h.new_iqd.toLocaleString('en-US')}
                            </td>
                            <td className="py-1.5 pe-2">
                              {h.author ?? '—'}
                              {h.by_owner ? <span className={`ms-1 ${T.text3}`}>({loc('المالك', 'Owner', 'خاوەن')})</span> : null}
                            </td>
                            <td className={`py-1.5 text-end ${T.text3}`}>
                              {h.counted ? loc('محتسب', 'Compared', 'بەراورد کراوە') : loc('لا يخص هذا البند', 'Not this line’s price', 'نرخی ئەم دێڕە نییە')}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>

              {data.rule_changes && data.rule_changes.length > 0 ? (
                <section className={`${T.surface} p-4`} data-rule-changes>
                  <h3 className="text-[14px] font-bold mb-2">
                    {loc('تغييرات أسعار الأعضاء خلال المدة', 'Member price changes in the period', 'گۆڕانکارییەکانی نرخی ئەندامان لە ماوەکەدا')}
                  </h3>
                  <ul className="space-y-1.5 text-[12.5px]">
                    {data.rule_changes.map((r, i) => (
                      <li key={i} className="flex flex-wrap gap-x-2" data-rule-change={r.kind}>
                        <span className="whitespace-nowrap">{day(r.at, lang, true)}</span>
                        <span>
                          {r.kind === 'pro_policy'
                            ? loc('سياسة تسعير PRO', 'PRO pricing policy', 'سیاسەتی نرخدانانی PRO')
                            : loc('قاعدة سعر للأعضاء', 'Member price rule', 'ڕێسای نرخی ئەندامان')}
                        </span>
                        <span className={T.text3}>
                          {r.author ?? '—'}
                          {r.by_owner ? ` (${loc('المالك', 'Owner', 'خاوەن')})` : ''}
                        </span>
                      </li>
                    ))}
                  </ul>
                </section>
              ) : null}
            </div>

            <aside className="space-y-4">
              <section className={`${T.surface} p-4`}>
                <h3 className="text-[14px] font-bold mb-2">{loc('الحساب', 'The figures', 'ژمارەکان')}</h3>
                <dl className="space-y-1.5 text-[13px]">
                  <Fact row k={loc('دفع للوحدة', 'Paid per unit', 'بۆ هەر یەکەیەک دراوە')} v={iqd(c.original_unit_iqd)} />
                  <Fact row k={loc('أقل سعر خلال المدة', 'Lowest price in the period', 'کەمترین نرخ لە ماوەکەدا')} v={iqd(c.observed_unit_iqd)} />
                  <Fact
                    row
                    k={loc('سعر اليوم لنفس البند', 'Today’s price, same line', 'نرخی ئەمڕۆ بۆ هەمان دێڕ')}
                    v={policy.today_closed === true || policy.current_applied_iqd === null ? loc('غير معروض للبيع اليوم', 'Not on sale today', 'ئەمڕۆ بۆ فرۆشتن نییە') : iqd(Number(policy.current_applied_iqd))}
                  />
                  {c.eligible_unit_iqd !== null ? <Fact row k={loc('المشمول للوحدة', 'Covered per unit', 'بۆ هەر یەکەیەک دەگیرێتەوە')} v={iqd(c.eligible_unit_iqd)} /> : null}
                  {c.credited_iqd > 0 ? <Fact row k={loc('المضاف للمحفظة', 'Credited', 'خرایە سەر جزدان')} v={<strong>{iqd(c.credited_iqd)}</strong>} /> : null}
                  {requested && data.now ? (
                    <>
                      <Fact row k={loc('تعويضات سابقة', 'Earlier credits', 'قەرەبووی پێشوو')} v={iqd(data.now.prior_credited_iqd)} />
                      <Fact row k={loc('يُضاف عند الاعتماد', 'Credited on approval', 'لە کاتی پەسەندکردن زیاد دەکرێت')} v={<strong>{iqd(data.now.credit_iqd)}</strong>} />
                    </>
                  ) : null}
                </dl>
                {c.state === 'rejected' && c.decision_reason ? (
                  <p className={`mt-3 text-[12.5px] ${T.text2}`} data-decision-reason>
                    {loc('السبب الذي قرأه الزبون', 'Reason the customer read', 'ئەو هۆکارەی کڕیار خوێندییەوە')}:{' '}
                    {priceProtectionReasonText(c.decision_reason.code, c.decision_reason.note, refusalLang(lang))}
                  </p>
                ) : null}
              </section>
              {data.customer ? (
                <section className={`${T.surface} p-4 text-[13px] space-y-1`}>
                  <h3 className="text-[14px] font-bold mb-1">{loc('الزبون', 'Customer', 'کڕیار')}</h3>
                  <p>{data.customer.name}</p>
                  <p dir="ltr" className={T.text2}>{data.customer.phone ?? ''}</p>
                  <p dir="ltr" className={T.text2}>{data.customer.email}</p>
                </section>
              ) : null}
            </aside>
          </div>
        </div>
      )}
    </Modal>
  );
}

function day(iso: string | null | undefined, lang: string, time = false) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return '—';
  return d.toLocaleString(lang === 'en' ? 'en-GB' : 'ar-IQ-u-nu-latn', time ? { dateStyle: 'medium', timeStyle: 'short' } : { dateStyle: 'medium' });
}

function Fact({ k, v, row = false }: { k: string; v: React.ReactNode; row?: boolean }) {
  if (row) {
    return (
      <div className="flex items-baseline justify-between gap-3">
        <dt className={T.text3}>{k}</dt>
        <dd className="text-end tabular-nums">{v}</dd>
      </div>
    );
  }
  return (
    <div className="min-w-0">
      <dt className={`text-[11.5px] ${T.text3}`}>{k}</dt>
      <dd className="min-w-0 break-words">{v}</dd>
    </div>
  );
}
