/**
 * إدارة الضمانات — every warranty receipt the shop has ever issued.
 *
 * The screen answers the question a claim desk actually asks: "this device is
 * in front of me, is it covered?" So the single search box takes the serial
 * from the sticker, the number from the paper, the customer's phone, their
 * name, the order id or the product — whichever the person at the counter
 * has — and the filters are the five states a receipt can be in.
 *
 * Built on the admin products design system (.ap tokens) so this screen and
 * the products screen read as one panel.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  ShieldCheck, RefreshCw, Printer, Eye, FileText, Ban, RotateCcw, Search, X, History, ExternalLink,
} from 'lucide-react';
import * as T from '../adminProducts/theme';
import '../adminProducts/theme.css';
import { Modal } from '../adminProducts/ui';
import { api, ApiError } from '../../lib/api';
import { useLanguage } from '../../LanguageContext';

interface ReceiptRow {
  id: string;
  receipt_no: string;
  status: string;
  status_stored: string;
  serial_raw: string;
  customer_name: string;
  customer_phone: string;
  product_description: string;
  product_model: string;
  order_id: string;
  purchase_date: string | null;
  purchase_price_iqd: number | null;
  warranty_start_at: string | null;
  warranty_end_at: string | null;
  warranty_months: number;
  print_count: number;
  void_reason: string;
  created_at: string;
}

interface ListResponse {
  receipts: ReceiptRow[];
  total: number;
  page: number;
  limit: number;
  counts: Record<string, number>;
}

interface HistoryRow {
  action: string;
  created_at: string;
  username: string | null;
  email: string | null;
  detail: Record<string, unknown>;
}

const STR = {
  ar: {
    title: 'الضمانات',
    subtitle: 'كل وصل ضمان صدر، مربوطًا بجهازه ورقمه التسلسلي.',
    search: 'ابحث برقم تسلسلي، رقم وصل، هاتف، اسم، رقم طلب أو منتج…',
    all: 'الكل',
    active: 'ساري',
    expired: 'منتهٍ',
    draft: 'مسودة',
    replaced: 'مُستبدَل',
    void: 'ملغى',
    receiptNo: 'رقم الوصل',
    customer: 'الزبون',
    product: 'المنتج',
    model: 'الموديل',
    serial: 'الرقم التسلسلي',
    order: 'الطلب',
    purchase: 'تاريخ الشراء',
    start: 'بداية',
    end: 'نهاية',
    status: 'الحالة',
    actions: '',
    view: 'عرض',
    print: 'طباعة',
    pdf: 'PDF',
    reissue: 'إعادة إصدار',
    voidIt: 'إلغاء',
    empty: 'لا توجد وصولات ضمان بعد. تُنشأ من صفحة الطلب بعد إدخال الرقم التسلسلي.',
    noResults: 'لا نتائج لهذا البحث.',
    loading: 'جارٍ التحميل…',
    refresh: 'تحديث',
    history: 'سجل الوصل',
    reissueTitle: 'إعادة إصدار وصل',
    reissueBody: 'يُلغى الوصل الحالي بسبب مسجَّل ويصدر وصل جديد برقم جديد لنفس الجهاز. النسخة القديمة تبقى في السجل.',
    voidTitle: 'إلغاء وصل ضمان',
    voidBody: 'الوصل الملغى لا يتحقق كساري، ويبقى محفوظًا في السجل. لا يمكن التراجع.',
    reason: 'السبب (يُسجَّل في سجل التدقيق)',
    refreshTerms: 'استخدم الشروط الحالية بدل شروط الوصل القديم',
    confirm: 'تنفيذ',
    cancel: 'إلغاء',
    reasonRequired: 'السبب مطلوب (5 أحرف على الأقل).',
    of: 'من',
    page: 'صفحة',
    prints: 'نسخ مطبوعة',
    verify: 'صفحة التحقق العامة',
  },
  en: {
    title: 'Warranties',
    subtitle: 'Every warranty receipt issued, tied to its device and serial.',
    search: 'Search by serial, receipt no., phone, name, order or product…',
    all: 'All',
    active: 'Active',
    expired: 'Expired',
    draft: 'Draft',
    replaced: 'Replaced',
    void: 'Void',
    receiptNo: 'Receipt no.',
    customer: 'Customer',
    product: 'Product',
    model: 'Model',
    serial: 'Serial',
    order: 'Order',
    purchase: 'Purchased',
    start: 'Start',
    end: 'End',
    status: 'Status',
    actions: '',
    view: 'View',
    print: 'Print',
    pdf: 'PDF',
    reissue: 'Reissue',
    voidIt: 'Void',
    empty: 'No warranty receipts yet. They are created from an order once a serial is entered.',
    noResults: 'No results for this search.',
    loading: 'Loading…',
    refresh: 'Refresh',
    history: 'Receipt history',
    reissueTitle: 'Reissue a receipt',
    reissueBody: 'The current receipt is voided with a recorded reason and a new number is issued for the same device. The old copy stays in the record.',
    voidTitle: 'Void a warranty receipt',
    voidBody: 'A void receipt never verifies as covered and stays in the record. This cannot be undone.',
    reason: 'Reason (recorded in the audit log)',
    refreshTerms: 'Use the current terms instead of the old receipt’s',
    confirm: 'Confirm',
    cancel: 'Cancel',
    reasonRequired: 'A reason is required (at least 5 characters).',
    of: 'of',
    page: 'Page',
    prints: 'copies printed',
    verify: 'Public verification page',
  },
};

const FILTERS = ['all', 'active', 'expired', 'draft', 'replaced', 'void'] as const;
type Filter = (typeof FILTERS)[number];

const shortDate = (iso: string | null): string => (iso ? iso.slice(0, 10) : '—');

export default function AdminWarranties() {
  const { lang, dir } = useLanguage();
  const t = lang === 'en' ? STR.en : STR.ar;
  const [rows, setRows] = useState<ReceiptRow[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [filter, setFilter] = useState<Filter>('all');
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [detail, setDetail] = useState<{ receipt: ReceiptRow; history: HistoryRow[] } | null>(null);
  const [action, setAction] = useState<{ kind: 'void' | 'reissue'; row: ReceiptRow } | null>(null);
  const limit = 25;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ page: String(page), limit: String(limit) });
      if (search.trim()) params.set('search', search.trim());
      if (filter !== 'all') params.set('status', filter);
      const res = await api.get<ListResponse>(`/api/admin/warranties?${params.toString()}`);
      setRows(res.receipts ?? []);
      setTotal(res.total ?? 0);
      setCounts(res.counts ?? {});
      setErr(null);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [page, search, filter]);

  useEffect(() => {
    const id = window.setTimeout(() => void load(), search ? 250 : 0);
    return () => window.clearTimeout(id);
  }, [load, search]);

  // The admin shell keeps a slot in its topbar for the page's own strip.
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  useEffect(() => {
    setSlot(document.getElementById('dash-topbar-slot'));
  }, []);

  const openDoc = (id: string, print: boolean) =>
    window.open(`/api/admin/warranties/${id}/document${print ? '?print=1' : ''}`, '_blank', 'noopener');

  const openDetail = async (row: ReceiptRow) => {
    try {
      const res = await api.get<{ receipt: ReceiptRow; history: HistoryRow[] }>(`/api/admin/warranties/${row.id}`);
      setDetail(res);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : String(e));
    }
  };

  const pages = Math.max(1, Math.ceil(total / limit));
  const statusClass = (s: string) =>
    s === 'active'
      ? 'text-[var(--ap-success)] bg-[var(--ap-success-bg)] border-[var(--ap-success-border)]'
      : s === 'expired'
        ? 'text-[var(--ap-warning)] bg-[var(--ap-warning-bg)] border-[var(--ap-warning-border)]'
        : s === 'draft'
          ? 'text-[var(--ap-text-2)] bg-[var(--ap-surface-2)] border-[var(--ap-border)]'
          : 'text-[var(--ap-danger)] bg-[var(--ap-danger-bg)] border-[var(--ap-danger-border)]';
  const statusLabel = (s: string) => (t as Record<string, string>)[s] ?? s;

  return (
    <div className={`${T.AP} space-y-4`} dir={dir} data-panel="warranties">
      {slot &&
        createPortal(
          <nav className={`${T.AP} hidden sm:flex items-center gap-1.5 text-[12.5px] text-[var(--ap-text-3)] min-w-0`} aria-label="breadcrumb" dir={dir}>
            <span>{lang === 'en' ? 'Admin' : 'الإدارة'}</span>
            <span aria-hidden>/</span>
            <span className="text-[var(--ap-text-1)] font-semibold truncate">{t.title}</span>
          </nav>,
          slot
        )}

      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-[20px] font-bold leading-tight text-[var(--ap-text-1)] flex items-center gap-2">
            <ShieldCheck className="w-5 h-5" aria-hidden />
            {t.title}
          </h1>
          <p className="mt-1 text-[12.5px] text-[var(--ap-text-3)] max-w-[60ch]">{t.subtitle}</p>
        </div>
        <button type="button" className={T.btnIconLg} onClick={() => void load()} aria-label={t.refresh} title={t.refresh} data-warranty-refresh>
          <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} aria-hidden />
        </button>
      </header>

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[220px]">
          <Search className="absolute top-1/2 -translate-y-1/2 start-3 w-4 h-4 text-[var(--ap-text-3)]" aria-hidden />
          <input
            type="search"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
            placeholder={t.search}
            aria-label={t.search}
            data-warranty-search
            className={`${T.input} w-full ps-9`}
          />
        </div>
        <div className="flex flex-wrap gap-1.5">
          {FILTERS.map((f) => (
            <button
              key={f}
              type="button"
              aria-pressed={filter === f}
              onClick={() => {
                setFilter(f);
                setPage(1);
              }}
              data-warranty-filter={f}
              className={`${T.chip} h-9 px-3`}
            >
              {(t as Record<string, string>)[f]}
              {f !== 'all' && <span className={`${T.kbd} ms-1`}>{counts[f] ?? 0}</span>}
            </button>
          ))}
        </div>
      </div>

      {err && (
        <div className="rounded-[var(--ap-radius-md)] border border-[var(--ap-danger-border)] bg-[var(--ap-danger-bg)] px-3 py-2.5 text-[13px] text-[var(--ap-danger)]" role="alert">
          {err}
        </div>
      )}
      <div role="status" aria-live="polite" className="sr-only">
        {notice ?? ''}
      </div>
      {notice && (
        <div className="rounded-[var(--ap-radius-md)] border border-[var(--ap-success-border)] bg-[var(--ap-success-bg)] px-3 py-2.5 text-[13px] text-[var(--ap-success)] flex items-center gap-2">
          <span className="flex-1">{notice}</span>
          <button type="button" onClick={() => setNotice(null)} className={T.btnIconGhost} aria-label={t.cancel}>
            <X className="w-4 h-4" aria-hidden />
          </button>
        </div>
      )}

      {loading && rows.length === 0 ? (
        <div className={`${T.surface} p-8 text-center text-[13px] text-[var(--ap-text-3)]`}>{t.loading}</div>
      ) : rows.length === 0 ? (
        <div className={`${T.surface} p-8 text-center text-[13px] text-[var(--ap-text-3)]`}>
          {search || filter !== 'all' ? t.noResults : t.empty}
        </div>
      ) : (
        <div className={`${T.surface} overflow-x-auto`}>
          <table className="w-full border-collapse min-w-[900px]">
            <thead className={T.tableHead}>
              <tr>
                {[t.receiptNo, t.customer, t.product, t.serial, t.order, t.purchase, t.end, t.status, ''].map((h, i) => (
                  <th key={i} scope="col" className="px-3 py-2.5 text-start font-semibold text-[11.5px] whitespace-nowrap">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--ap-hairline)]">
              {rows.map((r) => (
                <tr key={r.id} className={T.tableRow} data-warranty-row={r.receipt_no}>
                  <td className="px-3 py-2.5 text-[12.5px]">
                    <span className="font-mono text-[var(--ap-text-1)]" dir="ltr">
                      {r.receipt_no}
                    </span>
                    {r.print_count > 0 && (
                      <span className="block text-[11px] text-[var(--ap-text-3)]">
                        {r.print_count} {t.prints}
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2.5 text-[12.5px]">
                    <span className="block truncate max-w-[16ch] text-[var(--ap-text-1)]">{r.customer_name}</span>
                    <span className="block text-[11px] text-[var(--ap-text-3)]" dir="ltr">
                      {r.customer_phone}
                    </span>
                  </td>
                  <td className="px-3 py-2.5 text-[12.5px]">
                    <span className="block truncate max-w-[24ch] text-[var(--ap-text-1)]">{r.product_description}</span>
                    <span className="block text-[11px] text-[var(--ap-text-3)] truncate max-w-[24ch]" dir="ltr">
                      {r.product_model}
                    </span>
                  </td>
                  <td className="px-3 py-2.5 text-[12px] font-mono text-[var(--ap-text-2)]" dir="ltr">
                    {r.serial_raw}
                  </td>
                  <td className="px-3 py-2.5 text-[12px] font-mono text-[var(--ap-text-3)]" dir="ltr">
                    {r.order_id}
                  </td>
                  <td className="px-3 py-2.5 text-[12px] text-[var(--ap-text-2)] whitespace-nowrap" dir="ltr">
                    {shortDate(r.purchase_date)}
                  </td>
                  <td className="px-3 py-2.5 text-[12px] text-[var(--ap-text-2)] whitespace-nowrap" dir="ltr">
                    {shortDate(r.warranty_end_at)}
                  </td>
                  <td className="px-3 py-2.5">
                    <span className={`${T.badgeBase} ${statusClass(r.status)}`} data-warranty-status={r.status}>
                      {statusLabel(r.status)}
                    </span>
                  </td>
                  <td className="px-3 py-2.5">
                    <div className="flex items-center justify-end gap-1">
                      <button type="button" className={T.btnIcon} onClick={() => void openDetail(r)} aria-label={t.view} title={t.view} data-warranty-view>
                        <Eye className="w-4 h-4" aria-hidden />
                      </button>
                      <button type="button" className={T.btnIcon} onClick={() => openDoc(r.id, true)} aria-label={t.print} title={t.print} data-warranty-print>
                        <Printer className="w-4 h-4" aria-hidden />
                      </button>
                      <button type="button" className={T.btnIcon} onClick={() => openDoc(r.id, false)} aria-label={t.pdf} title={t.pdf} data-warranty-pdf>
                        <FileText className="w-4 h-4" aria-hidden />
                      </button>
                      <button
                        type="button"
                        className={T.btnIcon}
                        onClick={() => setAction({ kind: 'reissue', row: r })}
                        disabled={r.status === 'replaced'}
                        aria-label={t.reissue}
                        title={t.reissue}
                        data-warranty-reissue
                      >
                        <RotateCcw className="w-4 h-4" aria-hidden />
                      </button>
                      <button
                        type="button"
                        className={T.btnIconDanger}
                        onClick={() => setAction({ kind: 'void', row: r })}
                        disabled={r.status_stored === 'void'}
                        aria-label={t.voidIt}
                        title={t.voidIt}
                        data-warranty-void
                      >
                        <Ban className="w-4 h-4" aria-hidden />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {pages > 1 && (
        <div className="flex items-center justify-center gap-2">
          <button type="button" className={T.pageBtn} disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
            ‹
          </button>
          <span className="text-[12px] text-[var(--ap-text-3)]">
            {t.page} {page} {t.of} {pages}
          </span>
          <button type="button" className={T.pageBtn} disabled={page >= pages} onClick={() => setPage((p) => p + 1)}>
            ›
          </button>
        </div>
      )}

      {detail && <DetailModal detail={detail} t={t} onClose={() => setDetail(null)} onOpenDoc={openDoc} />}
      {action && (
        <ActionModal
          kind={action.kind}
          row={action.row}
          t={t}
          onClose={() => setAction(null)}
          onDone={async (message) => {
            setAction(null);
            setNotice(message);
            await load();
          }}
        />
      )}
    </div>
  );
}

function DetailModal({
  detail,
  t,
  onClose,
  onOpenDoc,
}: {
  detail: { receipt: ReceiptRow; history: HistoryRow[] };
  t: typeof STR.ar;
  onClose: () => void;
  onOpenDoc: (id: string, print: boolean) => void;
}) {
  const r = detail.receipt;
  return (
    <Modal titleAr="وصل ضمان" titleEn="Warranty receipt" onClose={onClose} wide>
      <div className={`${T.AP} space-y-4`}>
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-[15px] font-bold text-[var(--ap-text-1)]" dir="ltr">
            {r.receipt_no}
          </span>
          <button type="button" className={T.btnSecondary} onClick={() => onOpenDoc(r.id, false)}>
            <Eye className="w-4 h-4" aria-hidden /> {t.view}
          </button>
          <button type="button" className={T.btnSecondary} onClick={() => onOpenDoc(r.id, true)}>
            <Printer className="w-4 h-4" aria-hidden /> {t.print}
          </button>
          <a
            className={`${T.btnSecondary} ms-auto`}
            href={`/warranty/${r.receipt_no}`}
            target="_blank"
            rel="noopener noreferrer"
          >
            <ExternalLink className="w-4 h-4" aria-hidden /> {t.verify}
          </a>
        </div>

        <div className="grid gap-2 sm:grid-cols-2">
          {([
            [t.customer, `${r.customer_name} · ${r.customer_phone}`],
            [t.product, `${r.product_description}${r.product_model ? ` · ${r.product_model}` : ''}`],
            [t.serial, r.serial_raw],
            [t.order, r.order_id],
            [t.purchase, shortDate(r.purchase_date)],
            [t.start, shortDate(r.warranty_start_at)],
            [t.end, shortDate(r.warranty_end_at)],
            [t.status, r.status],
          ] as const).map(([label, value]) => (
            <div key={label} className="flex gap-2 text-[12.5px] border-b border-[var(--ap-hairline)] py-1.5">
              <span className="w-28 shrink-0 font-semibold text-[var(--ap-text-2)]">{label}</span>
              <span className="min-w-0 break-words text-[var(--ap-text-1)]">{value}</span>
            </div>
          ))}
        </div>

        {r.void_reason && (
          <p className="text-[12px] text-[var(--ap-danger)]">{r.void_reason}</p>
        )}

        <div>
          <h3 className="text-[13px] font-semibold text-[var(--ap-text-1)] mb-1.5 flex items-center gap-1.5">
            <History className="w-4 h-4" aria-hidden /> {t.history}
          </h3>
          <ul className="space-y-1">
            {detail.history.map((h, i) => (
              <li key={i} className="text-[12px] text-[var(--ap-text-2)] flex flex-wrap gap-2 border-b border-[var(--ap-hairline)] py-1">
                <span className="font-mono text-[var(--ap-text-3)]" dir="ltr">
                  {h.created_at.slice(0, 16).replace('T', ' ')}
                </span>
                <span className="font-semibold">{h.action.replace('warranty.', '')}</span>
                <span className="text-[var(--ap-text-3)]">{h.username || h.email || ''}</span>
                {typeof h.detail?.reason === 'string' && <span className="w-full text-[var(--ap-text-3)]">{h.detail.reason}</span>}
              </li>
            ))}
            {detail.history.length === 0 && <li className="text-[12px] text-[var(--ap-text-3)]">—</li>}
          </ul>
        </div>
      </div>
    </Modal>
  );
}

function ActionModal({
  kind,
  row,
  t,
  onClose,
  onDone,
}: {
  kind: 'void' | 'reissue';
  row: ReceiptRow;
  t: typeof STR.ar;
  onClose: () => void;
  onDone: (message: string) => Promise<void>;
}) {
  const [reason, setReason] = useState('');
  const [refreshTerms, setRefreshTerms] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const run = async () => {
    if (reason.trim().length < 5) {
      setErr(t.reasonRequired);
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      if (kind === 'void') {
        await api.post(`/api/admin/warranties/${row.id}/void`, { reason: reason.trim() });
        await onDone(`${row.receipt_no} — ${t.voidIt}`);
      } else {
        const res = await api.post<{ receipt: { receipt_no: string } }>(`/api/admin/warranties/${row.id}/reissue`, {
          reason: reason.trim(),
          refresh_terms: refreshTerms,
        });
        await onDone(`${row.receipt_no} → ${res.receipt?.receipt_no ?? ''}`);
      }
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      titleAr={kind === 'void' ? t.voidTitle : t.reissueTitle}
      titleEn={kind === 'void' ? 'Void receipt' : 'Reissue receipt'}
      onClose={onClose}
      dirty={reason.length > 0}
      footer={
        <div className={`${T.AP} flex items-center justify-end gap-2`} data-warranty-action={kind}>
          {err && (
            <span className="me-auto text-[12px] text-[var(--ap-danger)]" role="alert">
              {err}
            </span>
          )}
          <button type="button" className={T.btnSecondary} onClick={onClose} disabled={busy}>
            {t.cancel}
          </button>
          <button
            type="button"
            className={kind === 'void' ? T.btnDanger : T.btnPrimary}
            onClick={() => void run()}
            disabled={busy}
            data-warranty-action-confirm
          >
            {busy && <RefreshCw className="w-4 h-4 animate-spin" aria-hidden />}
            {t.confirm}
          </button>
        </div>
      }
    >
      <div className={`${T.AP} space-y-3`}>
        <p className="text-[12.5px] text-[var(--ap-text-2)]">{kind === 'void' ? t.voidBody : t.reissueBody}</p>
        <p className="font-mono text-[13px] text-[var(--ap-text-1)]" dir="ltr">
          {row.receipt_no} · {row.serial_raw}
        </p>
        <label className="block">
          <span className="block mb-1 text-[12px] font-semibold text-[var(--ap-text-2)]">{t.reason}</span>
          <textarea
            ref={inputRef}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={3}
            data-warranty-reason
            className={`${T.input} w-full py-2 h-auto`}
          />
        </label>
        {kind === 'reissue' && (
          <label className="flex items-start gap-2.5 cursor-pointer">
            <input
              type="checkbox"
              checked={refreshTerms}
              onChange={(e) => setRefreshTerms(e.target.checked)}
              className="mt-0.5 h-4 w-4 accent-[var(--ap-accent)]"
            />
            <span className="text-[12.5px] text-[var(--ap-text-1)]">{t.refreshTerms}</span>
          </label>
        )}
      </div>
    </Modal>
  );
}
