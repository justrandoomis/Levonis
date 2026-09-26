/**
 * «الاستبدال (Trade-in)» — the admin's desk for trade-in requests, and the
 * rules that price them.
 *
 * THE REQUEST is shown with everything the owner listed for this screen: the
 * original order, how long it has been used, the warranty left, the operating
 * hours, the condition and the photographs, the problems and repairs, the
 * linked accessories (a Combo's AMS is its own card), the estimate with every
 * line that makes it, the final value and the difference the customer pays.
 *
 * THE ACTIONS are the server's (worker/routes/tradeIn.ts) and nothing more:
 *   بدء الفحص         submitted → under_review (any admin)
 *   اعتماد التقدير    the estimate becomes the final value (financial scope)
 *   تغيير القيمة      a new value + optional reason; the customer is asked to
 *                    accept or decline in-app, by email/WhatsApp and with
 *                    Telegram buttons (financial scope)
 *   إتمام الاستبدال   once the customer's order for the new device exists
 *   إلغاء             with a reason, while no live order carries the credit
 * A button the server would refuse is disabled here with the reason beside it;
 * the server still decides.
 *
 * Built on the admin products design system (.ap tokens), like AdminWarranties.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { Repeat, RefreshCw, Search, X, CheckCircle2, ClipboardCheck, PencilLine, Ban, PackageCheck, ExternalLink, SlidersHorizontal } from 'lucide-react';
import * as T from '../adminProducts/theme';
import '../adminProducts/theme.css';
import { Modal } from '../adminProducts/ui';
import { api, ApiError, failureText } from '../../lib/api';
import { useLanguage } from '../../LanguageContext';
import { FAMILY_LABELS, OPTIONAL_PHOTO, REQUIRED_PHOTOS, STATUS_LABELS, TRADE_IN_FAMILIES, checklistOf, tradeInSettlement, type TradeInFamily, type TradeInStatus } from '../../../packages/pricing/src/tradeIn';
import type { RequestView } from '../tradeIn/model';
import RulesEditor from './RulesEditor';

interface Row {
  id: string;
  status: TradeInStatus;
  family: TradeInFamily;
  scope: string;
  order_id: string;
  name: string;
  image: string;
  target_name: string;
  estimated_iqd: number | null;
  admin_value_iqd: number | null;
  final_value_iqd: number | null;
  difference_iqd: number | null;
  target_price_iqd: number | null;
  customer_name: string | null;
  customer_phone: string | null;
  created_at: string;
  submitted_at: string | null;
}

/** The event log's actions, in the desk's words. */
const ACTIONS: Record<string, [string, string]> = {
  create: ['فتح الطلب', 'Opened'],
  submit: ['أرسله الزبون', 'Submitted'],
  inspect: ['بدء الفحص', 'Inspection'],
  approve: ['اعتماد التقدير', 'Estimate approved'],
  change_value: ['قيمة جديدة', 'New value'],
  accept: ['وافق الزبون', 'Customer accepted'],
  reject: ['رفض الزبون', 'Customer declined'],
  awaiting_payment: ['بانتظار الدفع', 'Awaiting payment'],
  credit_reissued: ['إعادة إصدار الرصيد', 'Credit re-issued'],
  complete: ['اكتمل', 'Completed'],
  cancel: ['أُلغي', 'Cancelled'],
};
const ROLES: Record<string, [string, string]> = { customer: ['الزبون', 'customer'], admin: ['الإدارة', 'admin'], system: ['النظام', 'system'] };

const FILTERS: Array<TradeInStatus | ''> = ['', 'submitted', 'under_review', 'value_changed', 'awaiting_payment', 'completed', 'customer_rejected', 'cancelled'];

const iqd = (n: number | null | undefined) => (n === null || n === undefined ? '—' : `${Math.trunc(n).toLocaleString('en-US')} د.ع`);

function initialRequestId(): string | null {
  try {
    const id = new URLSearchParams(window.location.search).get('request') ?? '';
    return /^tin_[0-9a-f]{20}$/.test(id) ? id : null;
  } catch {
    return null;
  }
}

export default function AdminTradeIn() {
  const { loc, dir, lang } = useLanguage();
  const L = (ar: string, en: string) => loc(ar, en);
  const [view, setView] = useState<'requests' | 'rules'>('requests');
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  useEffect(() => setSlot(document.getElementById('dash-topbar-slot')), []);

  return (
    <div className={`${T.AP} space-y-4`} dir={dir} data-panel="trade-in">
      {slot &&
        createPortal(
          <nav className={`${T.AP} hidden sm:flex items-center gap-1.5 text-[12.5px] text-[var(--ap-text-3)] min-w-0`} aria-label="breadcrumb" dir={dir}>
            <span>{L('الإدارة', 'Admin')}</span>
            <span aria-hidden>/</span>
            <span className="text-[var(--ap-text-1)] font-semibold truncate">{L('الاستبدال', 'Trade-in')}</span>
          </nav>,
          slot
        )}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-[20px] font-bold flex items-center gap-2">
            <Repeat className="w-5 h-5 text-[var(--ap-accent-text)]" aria-hidden />
            {L('الاستبدال (Trade-in)', 'Trade-in')}
          </h1>
          <p className={`text-[13px] ${T.text3}`}>{L('طلبات استبدال أجهزة LEVONIS، وقواعد تقييمها.', 'LEVONIS device trade-in requests, and the rules that value them.')}</p>
        </div>
        <div role="group" aria-label={L('العرض', 'View')} className="inline-flex items-center gap-1 p-1 rounded-[var(--ap-radius-md)] bg-[var(--ap-surface-2)] border border-[var(--ap-border)]">
          {(['requests', 'rules'] as const).map((v) => (
            <button
              key={v}
              type="button"
              aria-pressed={view === v}
              onClick={() => setView(v)}
              data-trade-in-view={v}
              className={`min-h-[36px] px-4 rounded-[7px] text-[13px] font-semibold transition-colors ${
                view === v ? 'bg-[var(--ap-surface-4)] text-[var(--ap-text-1)]' : 'text-[var(--ap-text-3)] hover:text-[var(--ap-text-2)]'
              }`}
            >
              {v === 'requests' ? L('الطلبات', 'Requests') : L('القواعد والنسب', 'Rules & weights')}
            </button>
          ))}
        </div>
      </div>
      {view === 'requests' ? <Requests lang={lang} /> : <RulesEditor />}
    </div>
  );
}

function Requests({ lang }: { lang: string }) {
  const { loc } = useLanguage();
  const L = (ar: string, en: string) => loc(ar, en);
  const [status, setStatus] = useState<TradeInStatus | ''>('submitted');
  const [family, setFamily] = useState<TradeInFamily | ''>('');
  const [q, setQ] = useState('');
  const [rows, setRows] = useState<Row[] | null>(null);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [error, setError] = useState('');
  const [open, setOpen] = useState<string | null>(initialRequestId);

  const load = useCallback(async () => {
    setError('');
    const p = new URLSearchParams();
    if (status) p.set('status', status);
    if (family) p.set('family', family);
    if (q.trim()) p.set('q', q.trim());
    try {
      const d = await api.get<{ requests: Row[]; counts: Record<string, number> }>(`/api/admin/trade-in/requests?${p.toString()}`);
      setRows(d.requests);
      setCounts(d.counts);
    } catch (e) {
      setError(failureText(e, L('تعذّر التحميل', 'Could not load')));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, family, q]);

  useEffect(() => {
    const id = window.setTimeout(() => void load(), q ? 300 : 0);
    return () => window.clearTimeout(id);
  }, [load, q]);

  const label = (s: TradeInStatus | '') => (s ? loc(STATUS_LABELS[s].ar, STATUS_LABELS[s].en) : L('الكل', 'All'));

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        {FILTERS.map((s) => (
          <button key={s || 'all'} type="button" aria-pressed={status === s} className={T.chip} onClick={() => setStatus(s)} data-filter={s || 'all'}>
            {label(s)}
            {s && counts[s] ? <span className="ms-1 tabular-nums opacity-80">{counts[s]}</span> : null}
          </button>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[200px]">
          <Search className={`absolute top-1/2 -translate-y-1/2 start-3 w-4 h-4 ${T.text3}`} aria-hidden />
          <input className={`${T.input} w-full ps-9`} value={q} onChange={(e) => setQ(e.target.value)} placeholder={L('رقم الطلب، رقم الاستبدال، هاتف أو بريد الزبون', 'Order no., request id, customer phone or email')} aria-label={L('بحث', 'Search')} />
          {q ? (
            <button type="button" className={`${T.btnIconGhost} absolute top-1/2 -translate-y-1/2 end-1`} onClick={() => setQ('')} aria-label={L('مسح', 'Clear')}>
              <X className="w-4 h-4" aria-hidden />
            </button>
          ) : null}
        </div>
        <select className={`${T.select} w-44`} value={family} onChange={(e) => setFamily(e.target.value as TradeInFamily | '')} aria-label={L('النوع', 'Family')}>
          <option value="">{L('كل الأنواع', 'All families')}</option>
          {TRADE_IN_FAMILIES.map((f) => (
            <option key={f} value={f}>
              {loc(FAMILY_LABELS[f].ar, FAMILY_LABELS[f].en)}
            </option>
          ))}
        </select>
        <button type="button" className={T.btnIconLg} onClick={() => void load()} aria-label={L('تحديث', 'Refresh')}>
          <RefreshCw className="w-4 h-4" aria-hidden />
        </button>
      </div>
      {error ? <p className="text-[13px] text-[var(--ap-danger)]">{error}</p> : null}
      {rows === null ? (
        <p className={`py-12 text-center text-[13px] ${T.text3}`}>{L('جارٍ التحميل…', 'Loading…')}</p>
      ) : rows.length === 0 ? (
        <div className={`${T.surface} p-8 text-center`}>
          <p className={`text-[13px] ${T.text3}`}>{L('لا توجد طلبات بهذه الحالة.', 'No requests in this state.')}</p>
        </div>
      ) : (
        <ul className="space-y-2" data-trade-in-rows>
          {rows.map((r) => {
            const value = r.final_value_iqd ?? r.admin_value_iqd ?? r.estimated_iqd;
            return (
              <li key={r.id}>
                <button type="button" onClick={() => setOpen(r.id)} data-row={r.id} className={`${T.surface} w-full text-start p-3 flex items-center gap-3 hover:border-[var(--ap-border-hover)] transition-colors`}>
                  <span className="w-12 h-12 shrink-0 rounded-[var(--ap-radius-sm)] bg-[var(--ap-surface-3)] overflow-hidden">
                    {r.image ? <img src={r.image} alt="" className="w-full h-full object-cover" loading="lazy" /> : null}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-[13.5px] font-semibold truncate">{r.name}</span>
                    <span className={`block text-[12px] ${T.text3} truncate`}>
                      {loc(FAMILY_LABELS[r.family].ar, FAMILY_LABELS[r.family].en)} · {r.scope === 'ams_only' ? 'AMS' : r.scope === 'printer_only' ? L('الطابعة فقط', 'Printer only') : L('كامل', 'Whole')} → {r.target_name || '—'}
                    </span>
                    <span className={`block text-[11.5px] ${T.text3} truncate`}>
                      {r.customer_name ?? '—'} · <span dir="ltr">{r.customer_phone ?? ''}</span> · <span dir="ltr">{r.order_id}</span>
                    </span>
                  </span>
                  <span className="shrink-0 text-end">
                    <span className={`${T.badgeBase} ${statusTone(r.status)}`}>{label(r.status)}</span>
                    <span className="block text-[13px] font-semibold tabular-nums mt-1">{iqd(value)}</span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {open ? <Detail id={open} lang={lang} onClose={() => setOpen(null)} onChanged={() => void load()} /> : null}
    </div>
  );
}

function statusTone(s: TradeInStatus): string {
  if (s === 'completed' || s === 'awaiting_payment') return T.badge.active;
  if (s === 'cancelled' || s === 'customer_rejected') return T.badge.hidden;
  return T.badge.draft;
}

interface DetailResponse {
  request: RequestView;
  customer: { id: string; name: string; email: string; phone_e164: string | null; username: string | null } | null;
  financial_scope: boolean;
}

function Detail({ id, onClose, onChanged }: { id: string; lang: string; onClose: () => void; onChanged: () => void }) {
  const { loc, lang } = useLanguage();
  const L = (ar: string, en: string) => loc(ar, en);
  const [data, setData] = useState<DetailResponse | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [value, setValue] = useState('');
  const [reason, setReason] = useState('');
  const [cancelReason, setCancelReason] = useState('');
  const [mode, setMode] = useState<'' | 'value' | 'cancel'>('');
  const [photo, setPhoto] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await api.get<DetailResponse>(`/api/admin/trade-in/requests/${id}`));
    } catch (e) {
      setError(failureText(e, 'Could not load'));
    }
  }, [id]);
  useEffect(() => {
    void load();
  }, [load]);

  const act = async (name: string, path: string, body?: unknown) => {
    setBusy(name);
    setError('');
    try {
      const d = await api.post<{ request: RequestView }>(`/api/admin/trade-in/requests/${id}/${path}`, body ?? {});
      setData((cur) => (cur ? { ...cur, request: d.request } : cur));
      setMode('');
      onChanged();
    } catch (e) {
      const code = e instanceof ApiError ? e.code : '';
      setError(`${failureText(e, 'Failed')}${code ? ` (${code})` : ''}`);
    } finally {
      setBusy('');
    }
  };

  const r = data?.request;
  const proposed = Number(value.replace(/[^0-9]/g, ''));
  const preview = useMemo(() => (r && value ? tradeInSettlement(r.target?.price_iqd ?? 0, proposed) : null), [r, value, proposed]);

  const footer = r ? (
    <div className="flex flex-wrap items-center gap-2">
      {r.status === 'submitted' ? (
        <button type="button" className={T.btnSecondary} disabled={!!busy} onClick={() => act('inspect', 'inspect')} data-act="inspect">
          <ClipboardCheck className="w-4 h-4" aria-hidden />
          {L('بدء الفحص', 'Start inspection')}
        </button>
      ) : null}
      {(r.status === 'submitted' || r.status === 'under_review') ? (
        <button type="button" className={T.btnPrimary} disabled={!!busy || !data?.financial_scope} onClick={() => act('approve', 'approve')} data-act="approve">
          <CheckCircle2 className="w-4 h-4" aria-hidden />
          {L('اعتماد التقدير كما هو', 'Approve the estimate')}
        </button>
      ) : null}
      {(r.status === 'submitted' || r.status === 'under_review' || r.status === 'value_changed') ? (
        <button type="button" className={T.btnSecondary} disabled={!!busy || !data?.financial_scope} onClick={() => setMode(mode === 'value' ? '' : 'value')} aria-expanded={mode === 'value'} data-act="value">
          <PencilLine className="w-4 h-4" aria-hidden />
          {L('تغيير القيمة', 'Change the value')}
        </button>
      ) : null}
      {r.status === 'awaiting_payment' ? (
        <button type="button" className={T.btnPrimary} disabled={!!busy || ((r.credit_iqd ?? 0) > 0 && !r.credit_order)} onClick={() => act('complete', 'complete')} data-act="complete">
          <PackageCheck className="w-4 h-4" aria-hidden />
          {L('إتمام الاستبدال', 'Complete the trade-in')}
        </button>
      ) : null}
      {!['completed', 'cancelled', 'customer_rejected'].includes(r.status) ? (
        <button type="button" className={T.btnDanger} disabled={!!busy || !!r.credit_order} onClick={() => setMode(mode === 'cancel' ? '' : 'cancel')} aria-expanded={mode === 'cancel'} data-act="cancel">
          <Ban className="w-4 h-4" aria-hidden />
          {L('إلغاء', 'Cancel')}
        </button>
      ) : null}
    </div>
  ) : null;

  return (
    <Modal titleAr="طلب استبدال" titleEn="Trade-in request" onClose={onClose} wide footer={footer}>
      {!r ? (
        <p className={`py-10 text-center text-[13px] ${T.text3}`}>{error || L('جارٍ التحميل…', 'Loading…')}</p>
      ) : (
        <div className="space-y-4" data-admin-trade-in={r.id}>
          {!data?.financial_scope ? (
            <p className="text-[12.5px] rounded-[var(--ap-radius-md)] border border-[var(--ap-warning-border)] bg-[var(--ap-warning-bg)] text-[var(--ap-warning)] p-2.5">
              {L('اعتماد القيمة أو تغييرها يحتاج صلاحية مالية.', 'Approving or changing a value needs the financial scope.')}
            </p>
          ) : null}
          {mode === 'value' ? (
            <div className={`${T.surface} p-3 space-y-2`} data-value-form>
              <div className="grid gap-2 sm:grid-cols-2">
                <label className="block">
                  <span className={`block text-[12px] ${T.text3} mb-1`}>{L('القيمة الجديدة (د.ع)', 'New value (IQD)')}</span>
                  <input className={`${T.input} w-full tabular-nums`} inputMode="numeric" dir="ltr" value={value} onChange={(e) => setValue(e.target.value.replace(/[^0-9]/g, ''))} data-value-input />
                </label>
                <label className="block">
                  <span className={`block text-[12px] ${T.text3} mb-1`}>{L('السبب (اختياري، يراه الزبون)', 'Reason (optional, the customer reads it)')}</span>
                  <input className={`${T.input} w-full`} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
                </label>
              </div>
              {preview ? (
                <p className={`text-[12.5px] ${T.text2}`}>
                  {L('الفرق الذي سيدفعه الزبون', 'The customer would pay')}: <strong className="text-[var(--ap-text-1)]">{iqd(preview.difference_iqd)}</strong>
                  {preview.excess_iqd > 0 ? ` · ${L('فائض غير محتسب', 'uncredited excess')} ${iqd(preview.excess_iqd)}` : ''}
                </p>
              ) : null}
              <button type="button" className={T.btnPrimary} disabled={!value || !!busy} onClick={() => act('value', 'value', { value_iqd: proposed, reason: reason.trim() })} data-send-value>
                {L('أرسل للزبون للموافقة', 'Send to the customer')}
              </button>
            </div>
          ) : null}
          {mode === 'cancel' ? (
            <div className={`${T.surface} p-3 space-y-2`}>
              <label className="block">
                <span className={`block text-[12px] ${T.text3} mb-1`}>{L('سبب الإلغاء (يراه الزبون)', 'Reason (the customer reads it)')}</span>
                <input className={`${T.input} w-full`} maxLength={500} value={cancelReason} onChange={(e) => setCancelReason(e.target.value)} />
              </label>
              <button type="button" className={T.btnDanger} disabled={cancelReason.trim().length < 3 || !!busy} onClick={() => act('cancel', 'cancel', { reason: cancelReason.trim() })}>
                {L('تأكيد الإلغاء', 'Confirm cancellation')}
              </button>
            </div>
          ) : null}
          {error ? <p className="text-[13px] text-[var(--ap-danger)]" role="alert">{error}</p> : null}

          <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
            <div className="space-y-4 min-w-0">
              <section className={`${T.surface} p-4`}>
                <div className="flex items-center gap-3">
                  <span className="w-14 h-14 shrink-0 rounded-[var(--ap-radius-sm)] bg-[var(--ap-surface-3)] overflow-hidden">
                    {r.source.image ? <img src={r.source.image} alt="" className="w-full h-full object-cover" /> : null}
                  </span>
                  <div className="min-w-0">
                    <p className="text-[15px] font-bold">{r.source.name}</p>
                    <p className={`text-[12.5px] ${T.text3}`}>
                      {r.source.variant} · {loc(FAMILY_LABELS[r.family].ar, FAMILY_LABELS[r.family].en)} ·{' '}
                      {r.scope === 'ams_only' ? L('AMS فقط', 'AMS only') : r.scope === 'printer_only' ? L('الطابعة فقط', 'Printer only') : L('الجهاز كاملاً', 'Whole device')}
                    </p>
                  </div>
                  <span className={`ms-auto ${T.badgeBase} ${statusTone(r.status)}`}>{loc(r.status_label.ar, r.status_label.en)}</span>
                </div>
                <dl className="grid grid-cols-2 gap-x-4 gap-y-2 mt-4 text-[13px] sm:grid-cols-3">
                  <Fact k={L('الطلب الأصلي', 'Original order')} v={<a className="underline decoration-dotted" href={`/admin?tab=orders&order=${encodeURIComponent(r.order_id)}`} dir="ltr">{r.order_id} <ExternalLink className="inline w-3 h-3" aria-hidden /></a>} />
                  <Fact k={L('تاريخ الشراء', 'Ordered')} v={day(r.source.ordered_at, lang)} />
                  <Fact k={L('تاريخ الاستلام', 'Received')} v={day(r.source.delivered_at, lang)} />
                  <Fact k={L('السعر المدفوع', 'Paid')} v={iqd(r.source.paid_iqd)} />
                  <Fact k={L('نهاية الضمان', 'Warranty ends')} v={day(r.source.warranty_end_at, lang)} />
                  <Fact k={L('مدة الاستخدام', 'In use')} v={loc(`${r.estimate?.usage_months ?? 0} شهر`, `${r.estimate?.usage_months ?? 0} months`)} />
                  <Fact k={L('المتبقي من الضمان', 'Warranty left')} v={loc(`${r.estimate?.warranty_remaining_months ?? 0} شهر`, `${r.estimate?.warranty_remaining_months ?? 0} months`)} />
                  {r.source.ams_split && r.is_combo ? (
                    <Fact
                      k={L('حصة AMS', 'AMS share')}
                      v={r.source.ams_split.method === 'option_gap' ? `${((r.source.ams_split.share_bp ?? 0) / 100).toFixed(1)}% · ${L('فرق الخيار', 'option gap')}` : r.source.ams_split.method === 'reference' ? L('القيمة المرجعية', 'reference value') : L('غير محددة', 'unknown')}
                    />
                  ) : null}
                </dl>
              </section>

              {r.components.map((c) => {
                const rules = r.rules[c.family];
                const faultLabel = (id: string) => {
                  const it = rules ? [...checklistOf(rules, 'faults'), ...checklistOf(rules, 'replaced_parts')].find((x) => x.id === id) : null;
                  return it ? loc(it.label_ar, it.label_en) : id;
                };
                const i = c.inputs as Record<string, unknown>;
                const list = (v: unknown) => (Array.isArray(v) && v.length ? (v as string[]).map(faultLabel).join('، ') : L('لا شيء', 'None'));
                return (
                  <section key={c.role} className={`${T.surface} p-4 space-y-3`} data-component={c.role}>
                    <div className="flex items-center justify-between gap-2">
                      <h3 className="text-[14px] font-bold">{loc(c.label_ar, c.label_en)}</h3>
                      <span className={`text-[12px] ${T.text3}`}>{L('الأساس', 'Base')}: {iqd(c.base_iqd)}</span>
                    </div>
                    <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-[13px] sm:grid-cols-3">
                      {i.hours !== null && i.hours !== undefined ? <Fact k={L('ساعات التشغيل', 'Hours')} v={String(i.hours)} /> : null}
                      <Fact k={L('النظافة', 'Cleanliness')} v={`${i.cleanliness ?? '—'}/5`} />
                      <Fact k={L('الخارجية', 'Exterior')} v={`${i.exterior ?? '—'}/5`} />
                      <Fact k={L('الخدوش', 'Scratches')} v={`${i.scratches ?? '—'}/5`} />
                      <Fact k={L('الملحقات المرفقة', 'Accessories')} v={`${i.accessory_condition ?? '—'}/5`} />
                      <Fact k={L('الملحقات الأصلية', 'Originals')} v={i.original_accessories === 'all' ? L('كاملة', 'All') : i.original_accessories === 'partial' ? L('بعضها', 'Some') : L('لا شيء', 'None')} />
                      <Fact k={L('الإصلاحات', 'Repairs')} v={String(i.repairs_count ?? 0)} />
                    </dl>
                    <dl className="text-[13px] space-y-1.5">
                      <Fact k={L('المشاكل والأعطال', 'Problems & faults')} v={list(i.faults)} wide />
                      {i.fault_notes ? <Fact k={L('وصف المشكلة', 'Fault notes')} v={String(i.fault_notes)} wide /> : null}
                      <Fact k={L('القطع المستبدلة', 'Replaced parts')} v={list(i.replaced_parts)} wide />
                      {i.repair_notes ? <Fact k={L('تفاصيل الإصلاح', 'Repair notes')} v={String(i.repair_notes)} wide /> : null}
                      {i.notes ? <Fact k={L('ملاحظات', 'Notes')} v={String(i.notes)} wide /> : null}
                    </dl>
                    <div>
                      <p className={`text-[12px] ${T.text3} mb-1.5`}>
                        {L('الصور', 'Photos')} ({c.photos.length})
                      </p>
                      <div className="grid grid-cols-4 gap-1.5 sm:grid-cols-6">
                        {c.photos.map((p) => {
                          const a = [...REQUIRED_PHOTOS[c.family], OPTIONAL_PHOTO].find((x) => x.id === p.angle);
                          return (
                            <button key={p.id} type="button" onClick={() => setPhoto(p.url)} className="relative aspect-square rounded-[var(--ap-radius-sm)] overflow-hidden bg-[var(--ap-surface-3)]" title={a ? loc(a.label_ar, a.label_en) : p.angle}>
                              <img src={p.url} alt={a ? loc(a.label_ar, a.label_en) : p.angle} className="w-full h-full object-cover" loading="lazy" />
                              <span className="absolute inset-x-0 bottom-0 bg-black/60 text-white text-[10px] px-1 truncate">{a ? loc(a.label_ar, a.label_en) : p.angle}</span>
                            </button>
                          );
                        })}
                      </div>
                    </div>
                    {c.estimate ? <AdminBreakdown v={c.estimate} /> : null}
                  </section>
                );
              })}
              {r.customer_note ? (
                <section className={`${T.surface} p-4 text-[13px]`}>
                  <p className={`text-[12px] ${T.text3} mb-1`}>{L('ملاحظة الزبون', 'Customer note')}</p>
                  {r.customer_note}
                </section>
              ) : null}
            </div>

            <aside className="space-y-4">
              <section className={`${T.surface} p-4`}>
                <h3 className="text-[14px] font-bold mb-2">{L('القيمة والفرق', 'Value & difference')}</h3>
                <dl className="space-y-1.5 text-[13px]">
                  <Fact k={L('القيمة التقديرية', 'Estimated value')} v={iqd(r.estimated_iqd)} row />
                  <Fact k={L('القيمة المقترحة من الإدارة', 'Admin value')} v={r.offer ? `${iqd(r.offer.value_iqd)} (#${r.offer.offer_no})` : '—'} row />
                  <Fact k={L('قيمة الاستبدال النهائية', 'Final value')} v={iqd(r.final_value_iqd)} row />
                  <Fact k={L('الجهاز الجديد', 'New device')} v={r.target ? `${loc(r.target.name_ar, r.target.name)}` : '—'} row />
                  <Fact k={L('سعره (بيع مباشر)', 'Its price (direct)')} v={iqd(r.target?.price_iqd)} row />
                  <Fact k={L('الرصيد المحتسب', 'Credit')} v={iqd(r.credit_iqd ?? r.estimate?.settlement?.credit_iqd)} row />
                  <Fact k={L('الفرق المطلوب دفعه', 'Difference to pay')} v={<strong>{iqd(r.difference_iqd ?? r.estimate?.settlement?.difference_iqd)}</strong>} row />
                </dl>
                {r.credit_order ? (
                  <p className={`mt-2 text-[12.5px] ${T.text2}`}>
                    {L('طلب الشراء', 'Order')}: <span dir="ltr">{r.credit_order.id}</span> ({r.credit_order.status})
                  </p>
                ) : r.status === 'awaiting_payment' ? (
                  <p className={`mt-2 text-[12.5px] ${T.text3}`}>{L('بانتظار أن يطلب الزبون الجهاز الجديد.', 'Waiting for the customer to order the new device.')}</p>
                ) : null}
              </section>
              {data?.customer ? (
                <section className={`${T.surface} p-4 text-[13px] space-y-1`}>
                  <h3 className="text-[14px] font-bold mb-1">{L('الزبون', 'Customer')}</h3>
                  <p>{data.customer.name}</p>
                  <p dir="ltr" className={T.text2}>{data.customer.phone_e164 ?? ''}</p>
                  <p dir="ltr" className={T.text2}>{data.customer.email}</p>
                </section>
              ) : null}
              <section className={`${T.surface} p-4`}>
                <h3 className="text-[14px] font-bold mb-2">{L('السجل', 'History')}</h3>
                <ol className="space-y-2 text-[12.5px]">
                  {r.events.map((e, n) => (
                    <li key={n}>
                      <span className="font-semibold">{ACTIONS[e.action] ? loc(ACTIONS[e.action][0], ACTIONS[e.action][1]) : e.action}</span>
                      <span className={T.text3}> · {ROLES[e.actor_role] ? loc(ROLES[e.actor_role][0], ROLES[e.actor_role][1]) : e.actor_role} · {day(e.created_at, lang, true)}</span>
                      {typeof e.detail.value_iqd === 'number' ? <span className={T.text2}> · {iqd(e.detail.value_iqd as number)}</span> : null}
                      {typeof e.detail.reason === 'string' && e.detail.reason ? <p className={T.text3}>{e.detail.reason as string}</p> : null}
                    </li>
                  ))}
                </ol>
              </section>
            </aside>
          </div>
          {photo ? (
            <div className="fixed inset-0 z-[200] bg-black/85 flex items-center justify-center p-4" role="dialog" aria-modal="true" onClick={() => setPhoto(null)}>
              <img src={photo} alt="" className="max-w-full max-h-full rounded-[var(--ap-radius-md)]" />
            </div>
          ) : null}
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

function Fact({ k, v, wide = false, row = false }: { k: string; v: React.ReactNode; wide?: boolean; row?: boolean }) {
  if (row) {
    return (
      <div className="flex items-baseline justify-between gap-3">
        <dt className={T.text3}>{k}</dt>
        <dd className="text-end tabular-nums">{v}</dd>
      </div>
    );
  }
  return (
    <div className={wide ? '' : 'min-w-0'}>
      <dt className={`text-[11.5px] ${T.text3}`}>{k}</dt>
      <dd className="min-w-0 break-words">{v}</dd>
    </div>
  );
}

function AdminBreakdown({ v }: { v: NonNullable<RequestView['components'][number]['estimate']> }) {
  const { loc } = useLanguage();
  return (
    <div className="rounded-[var(--ap-radius-md)] bg-[var(--ap-surface-2)] p-3">
      <p className={`text-[12px] ${T.text3} mb-1 flex items-center gap-1.5`}>
        <SlidersHorizontal className="w-3.5 h-3.5" aria-hidden />
        {loc('تفصيل التقدير', 'Estimate breakdown')} · v{v.rule_version}
      </p>
      <table className="w-full text-[12.5px]">
        <tbody>
          {v.lines.map((l, i) => (
            <tr key={i} className="border-t border-[var(--ap-hairline)] first:border-t-0">
              <td className="py-1">{loc(l.label_ar, l.label_en)}</td>
              <td className={`py-1 text-center tabular-nums ${T.text3}`} dir="ltr">
                {l.effect_bp ? `${l.effect_bp > 0 ? '+' : ''}${(l.effect_bp / 100).toFixed(1)}%` : ''}
              </td>
              <td className="py-1 text-end tabular-nums" dir="ltr">
                {l.amount_iqd.toLocaleString('en-US')}
              </td>
            </tr>
          ))}
          <tr className="border-t border-[var(--ap-border-strong)] font-bold">
            <td className="py-1">{loc('القيمة', 'Value')}</td>
            <td />
            <td className="py-1 text-end tabular-nums" dir="ltr">
              {v.value_iqd.toLocaleString('en-US')}
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}
