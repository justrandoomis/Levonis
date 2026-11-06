/**
 * ADMIN → المكافآت → الطابعات (owner, 2026-11-05: «coupons with every printer»;
 * docs/DECISIONS.md row 298).
 *
 * Every printer unit the shop delivered: whose it is, which week of how many it is in,
 * when its next coupons come or why they stopped, and how many it has issued and spent.
 * Who earns is the sweep's own definition (worker/lib/rewards/earning.ts): this screen
 * cannot say a printer earns while the sweep passes it over. A row opens that printer's
 * coupons; the order links to the order board.
 */
import { useCallback, useEffect, useId, useState } from 'react';
import { ChevronLeft, ChevronRight, Printer, X } from 'lucide-react';
import { api } from '../../lib/api';
import { useLanguage } from '../../LanguageContext';
import { formatFigure } from '../../lib/localeNumber';
import { formatDate } from '../orders/format';
import { StatusChip } from '../ui/Badge';
import { Button, IconButton } from '../ui/Button';
import { Input } from '../ui/Field';
import { Overlay } from '../ui/Overlay';
import SafeImage from '../ui/SafeImage';
import { Segmented } from '../ui/Segmented';
import { GrantCard, useGrantActions, useRewardsRefusal, type AdminGrant, type CustomerFilter } from './RewardsCoupons';

type Tri = { ar: string; en: string; ckb: string };
type Stopped = 'warranty_closed' | 'warranty_over' | 'returned' | 'traded_in' | 'in_shop' | 'programme_off';

export interface AdminPrinter {
  unit_id: string;
  order_id: string;
  order_item_id: string;
  unit_index: number;
  product_slug: string;
  name: Tri;
  image: string;
  serial: string;
  delivered_at: string | null;
  warranty_end_at: string | null;
  earning: boolean;
  stopped: Stopped | null;
  week: number;
  weeks_total: number;
  next_at: string | null;
  ends_at: string | null;
  coupons_issued: number;
  coupons_spent: number;
  customer: { id: string; name: string; username: string; email: string };
}

type PrinterState = 'all' | 'earning' | 'stopped';

export default function RewardsPrinters({ onCustomerCoupons }: { onCustomerCoupons?: (customer: CustomerFilter) => void }) {
  const { loc, lang } = useLanguage();
  const l = (lang === 'en' || lang === 'ckb' ? lang : 'ar') as keyof Tri;
  const refusal = useRewardsRefusal();
  const [state, setState] = useState<PrinterState>('all');
  const [typed, setTyped] = useState('');
  const [q, setQ] = useState('');
  const [rows, setRows] = useState<AdminPrinter[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [moreBusy, setMoreBusy] = useState(false);
  const [error, setError] = useState('');
  const [opened, setOpened] = useState<AdminPrinter | null>(null);

  const path = useCallback(
    (cursor?: string) => {
      const p = new URLSearchParams({ state });
      if (q) p.set('q', q);
      if (cursor) p.set('cursor', cursor);
      return `/api/admin/rewards/printers?${p.toString()}`;
    },
    [state, q]
  );

  useEffect(() => {
    const timer = setTimeout(() => setQ(typed.trim()), 300);
    return () => clearTimeout(timer);
  }, [typed]);

  useEffect(() => {
    let alive = true;
    setError('');
    api
      .get<{ printers: AdminPrinter[]; next_cursor: string | null }>(path())
      .then((r) => {
        if (!alive) return;
        setRows(r.printers);
        setNextCursor(r.next_cursor);
      })
      .catch((err) => {
        if (!alive) return;
        setRows([]);
        setNextCursor(null);
        setError(refusal(err));
      });
    return () => {
      alive = false;
    };
  }, [path, refusal]);

  const more = async () => {
    if (!nextCursor || moreBusy) return;
    setMoreBusy(true);
    try {
      const r = await api.get<{ printers: AdminPrinter[]; next_cursor: string | null }>(path(nextCursor));
      setRows((prev) => [...(prev ?? []), ...r.printers]);
      setNextCursor(r.next_cursor);
    } catch (err) {
      setError(refusal(err));
    } finally {
      setMoreBusy(false);
    }
  };

  return (
    <div className="space-y-3">
      <div className="lv-surface p-3 space-y-2">
        <Segmented
          size="sm"
          value={state}
          onChange={(v) => setState(v as PrinterState)}
          group="admin-rewards-printers"
          label={loc('حالة الطابعات', 'Printer state', 'دۆخی چاپکەرەکان')}
          items={[
            { id: 'all', label: loc('الكل', 'All', 'هەموو') },
            { id: 'earning', label: loc('تكسب', 'Earning', 'بەدەست دەهێنێت') },
            { id: 'stopped', label: loc('متوقفة', 'Stopped', 'وەستاوە') },
          ]}
        />
        <Input className="text-sm" value={typed} onChange={(e) => setTyped(e.target.value)} placeholder={loc('الزبون أو الطلب أو الرقم التسلسلي…', 'Customer, order or serial…', 'کڕیار، داواکاری یان ژمارەی زنجیرەیی…')} aria-label={loc('بحث', 'Search', 'گەڕان')} />
      </div>

      {error && <div role="alert" className="lv-alert lv-alert-danger text-xs text-text-primary">{error}</div>}

      {rows === null ? (
        <p className="text-sm text-text-secondary">{loc('جارٍ التحميل…', 'Loading…', 'بار دەکرێت…')}</p>
      ) : rows.length === 0 ? (
        <div className="lv-surface flex flex-col items-center gap-2 p-6 text-center">
          <Printer className="w-6 h-6 text-text-muted" aria-hidden />
          <p className="text-sm text-text-secondary">{loc('لا طابعات هنا.', 'No printers here.', 'هیچ چاپکەرێک لێرە نییە.')}</p>
        </div>
      ) : (
        <>
          <ul className="space-y-2">
            {rows.map((p) => (
              <PrinterCard key={p.unit_id} p={p} l={l} onOpen={() => setOpened(p)} />
            ))}
          </ul>
          {nextCursor && (
            <Button variant="secondary" block loading={moreBusy} onClick={() => void more()}>
              {loc('عرض المزيد', 'Show more', 'زیاتر پیشان بدە')}
            </Button>
          )}
        </>
      )}

      <PrinterCouponsDialog printer={opened} l={l} onClose={() => setOpened(null)} onCustomerCoupons={onCustomerCoupons} />
    </div>
  );
}

/** Why a printer stopped, in the admin's words. */
export function useStoppedWord() {
  const { loc } = useLanguage();
  return (s: Stopped | null): string => {
    switch (s) {
      case 'warranty_closed':
        return loc('أُغلق ضمانها', 'Warranty closed', 'گەرەنتی داخرا');
      case 'warranty_over':
        return loc('انتهت مدتها', 'Period over', 'ماوەکەی تەواو بوو');
      case 'returned':
        return loc('مرتجعة', 'Returned', 'گەڕێنراوەتەوە');
      case 'traded_in':
        return loc('مستبدلة', 'Traded in', 'گۆڕدراوەتەوە');
      case 'in_shop':
        return loc('في المتجر للاستبدال', 'In the shop for a trade-in', 'لە فرۆشگایە بۆ گۆڕینەوە');
      default:
        return loc('البرنامج متوقف', 'Programme off', 'بەرنامەکە ڕاگیراوە');
    }
  };
}

function PrinterCard({ p, l, onOpen }: { p: AdminPrinter; l: keyof Tri; onOpen: () => void }) {
  const { loc, lang, dir } = useLanguage();
  const stoppedWord = useStoppedWord();
  const Forward = dir === 'rtl' ? ChevronLeft : ChevronRight;
  return (
    <li data-admin-reward-printer={p.earning ? 'earning' : (p.stopped ?? 'stopped')} className="lv-surface overflow-hidden">
      <button
        type="button"
        onClick={onOpen}
        className="block w-full p-3 text-start hover:bg-surface-raised transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus"
        aria-label={loc(`كوبونات ${p.name[l] || p.name.en}`, `Coupons of ${p.name[l] || p.name.en}`, `کۆپۆنەکانی ${p.name[l] || p.name.en}`)}
      >
        <span className="flex items-start gap-3">
          <SafeImage src={p.image || null} alt="" aspect="square" sizes="44px" className="size-11 shrink-0 rounded-md" bgClassName="bg-surface-raised" />
          <span className="min-w-0 flex-1">
            <span className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
              <span className="min-w-0 text-[14px] font-bold leading-5 text-text-primary"><bdi>{p.name[l] || p.name.en}</bdi></span>
              {p.earning ? (
                <StatusChip tone="success">{loc('تكسب', 'Earning', 'بەدەست دەهێنێت')}</StatusChip>
              ) : (
                <StatusChip tone="neutral">{stoppedWord(p.stopped)}</StatusChip>
              )}
            </span>
            <span className="mt-0.5 block text-[12px] leading-5 text-text-secondary">
              <span className="font-semibold text-text-primary">{p.customer.name || p.customer.username}</span>
              {p.customer.username && (
                <>
                  {' '}
                  <bdi dir="ltr" className="text-text-muted">@{p.customer.username}</bdi>
                </>
              )}
            </span>
            {p.customer.email && <span className="block truncate text-[12px] leading-5 text-text-muted"><bdi dir="ltr">{p.customer.email}</bdi></span>}
          </span>
          <Forward className="mt-0.5 w-4 h-4 shrink-0 text-text-muted" aria-hidden />
        </span>
        <span className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-[12px] leading-5">
          <Fact label={loc('سُلّمت', 'Delivered', 'گەیشت')} value={formatDate(p.delivered_at, lang) || '—'} />
          <Fact label={loc('نهاية الضمان', 'Warranty ends', 'کۆتایی گەرەنتی')} value={formatDate(p.warranty_end_at, lang) || '—'} />
          <Fact
            label={loc('الأسبوع', 'Week', 'هەفتە')}
            value={
              p.weeks_total > 0
                ? loc(
                    `${formatFigure(p.week + 1, l)} من ${formatFigure(p.weeks_total, l)}`,
                    `${formatFigure(p.week + 1, l)} of ${formatFigure(p.weeks_total, l)}`,
                    `${formatFigure(p.week + 1, l)} لە ${formatFigure(p.weeks_total, l)}`
                  )
                : '—'
            }
          />
          <Fact label={loc('الدفعة القادمة', 'Next coupons', 'کۆپۆنەکانی داهاتوو')} value={p.next_at ? formatDate(p.next_at, lang) : '—'} />
          <Fact label={loc('صدر / صُرف', 'Issued / spent', 'دەرچوو / خەرجکرا')} value={`${formatFigure(p.coupons_issued, l)} / ${formatFigure(p.coupons_spent, l)}`} />
          <Fact label={loc('حتى', 'Until', 'تا')} value={p.ends_at ? formatDate(p.ends_at, lang) : '—'} />
        </span>
      </button>
      <p className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-border-subtle px-3 py-2 text-[12px] leading-5 text-text-muted">
        <span>
          {loc('الطلب', 'Order', 'داواکاری')}{' '}
          <a dir="ltr" href={`/admin?tab=orders&order=${encodeURIComponent(p.order_id)}`} className="font-mono text-text-primary underline underline-offset-2">
            {p.order_id}
          </a>
        </span>
        {p.serial && (
          <span>
            {loc('التسلسلي', 'Serial', 'زنجیرەیی')} <bdi className="font-mono text-text-secondary">{p.serial}</bdi>
          </span>
        )}
      </p>
    </li>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <span className="min-w-0">
      <span className="block text-text-muted">{label}</span>
      <span className="block font-medium tabular-nums text-text-primary">{value}</span>
    </span>
  );
}

function PrinterCouponsDialog({
  printer,
  l,
  onClose,
  onCustomerCoupons,
}: {
  printer: AdminPrinter | null;
  l: keyof Tri;
  onClose: () => void;
  onCustomerCoupons?: (customer: CustomerFilter) => void;
}) {
  const { loc } = useLanguage();
  const titleId = useId();
  const refusal = useRewardsRefusal();
  const [rows, setRows] = useState<AdminGrant[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [moreBusy, setMoreBusy] = useState(false);
  const [error, setError] = useState('');
  const id = printer?.order_item_id ?? '';
  const unit = printer?.unit_index ?? 0;
  const pagePath = useCallback(
    (cursor?: string) => `/api/admin/rewards/grants?order_item_id=${encodeURIComponent(id)}&unit_index=${unit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
    [id, unit]
  );

  const load = useCallback(async () => {
    if (!id) return;
    try {
      const r = await api.get<{ grants: AdminGrant[]; next_cursor?: string | null }>(pagePath());
      setRows(r.grants);
      setNextCursor(r.next_cursor ?? null);
    } catch (err) {
      setRows([]);
      setNextCursor(null);
      setError(refusal(err));
    }
  }, [id, pagePath, refusal]);

  // Two coupons a week reach a page of 50 in half a year: the rest are one press away.
  const more = async () => {
    if (!nextCursor || moreBusy) return;
    setMoreBusy(true);
    try {
      const r = await api.get<{ grants: AdminGrant[]; next_cursor?: string | null }>(pagePath(nextCursor));
      setRows((prev) => [...(prev ?? []), ...r.grants]);
      setNextCursor(r.next_cursor ?? null);
    } catch (err) {
      setError(refusal(err));
    } finally {
      setMoreBusy(false);
    }
  };

  useEffect(() => {
    setRows(null);
    setError('');
    void load();
  }, [load]);

  const actions = useGrantActions(load, setError);

  return (
    <Overlay open={!!printer} onClose={onClose} labelledBy={titleId} placement="bottom" testId="reward-printer-coupons" panelClassName="w-full sm:max-w-lg max-h-[calc(100dvh-3.5rem)] overflow-y-auto">
      <div className="space-y-3 p-4">
        <div className="flex items-center justify-between gap-2">
          <h2 id={titleId} className="min-w-0 line-clamp-2 text-[16px] font-bold leading-6 text-text-primary">
            {loc('كوبونات', 'Coupons of', 'کۆپۆنەکانی')} <bdi>{printer ? printer.name[l] || printer.name.en : ''}</bdi>
          </h2>
          <IconButton onClick={onClose} label={loc('إغلاق', 'Close', 'داخستن')} icon={<X className="w-4 h-4" aria-hidden />} />
        </div>
        {error && <div role="alert" className="lv-alert lv-alert-danger text-xs text-text-primary">{error}</div>}
        {rows === null ? (
          <p className="text-sm text-text-secondary">{loc('جارٍ التحميل…', 'Loading…', 'بار دەکرێت…')}</p>
        ) : rows.length === 0 ? (
          <p className="text-sm text-text-secondary">{loc('لم تُصدر لها كوبونات بعد.', 'No coupons issued for it yet.', 'هێشتا هیچ کۆپۆنێکی بۆ دەرنەچووە.')}</p>
        ) : (
          <ul className="space-y-2">
            {rows.map((g) => (
              <GrantCard key={g.id} g={g} showCustomer={false} busy={actions.busy === g.id} onExtend={(x) => void actions.extend(x)} onRevoke={(x) => void actions.revoke(x)} />
            ))}
          </ul>
        )}
        {rows !== null && nextCursor && (
          <Button variant="secondary" block loading={moreBusy} onClick={() => void more()} data-printer-coupons-more>
            {loc('عرض المزيد', 'Show more', 'زیاتر پیشان بدە')}
          </Button>
        )}
        {printer && onCustomerCoupons && (
          <Button
            variant="ghost"
            block
            onClick={() => {
              onClose();
              onCustomerCoupons({ id: printer.customer.id, label: printer.customer.name || printer.customer.username || printer.customer.email });
            }}
          >
            {loc('كل كوبونات هذا الزبون', 'All this customer’s coupons', 'هەموو کۆپۆنەکانی ئەم کڕیارە')}
          </Button>
        )}
      </div>
      {actions.promptDialog}
    </Overlay>
  );
}
