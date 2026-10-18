/**
 * THE LEDGER, LINE BY LINE — every line that makes up the figures above,
 * newest first, filterable by kind and by period (this month, last month, or
 * two days the merchant picks — Baghdad days, ./ledgerPeriod.ts — so the cash
 * a courier brought can be reconciled against the payouts of the same days),
 * paged by the server's cursor. Each line
 * says which figure it moved (its bucket) and opens what it belongs to: the
 * order, the custom-orders screen, or the payout request.
 *
 * A failed load is an error with retry, never «no entries»; a failed "more"
 * keeps the lines already shown.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useLanguage } from '../../../LanguageContext';
import { Card } from '../../ui/Card';
import { Money } from '../../ui/Money';
import { Button } from '../../ui/Button';
import { Segmented } from '../../ui/Segmented';
import { ErrorState } from '../../ui/AsyncStates';
import { Field, Input } from '../../ui/Field';
import { ListRowsSkeleton } from '../../ui/DashboardSkeletons';
import { financeApi, type LedgerEntry } from './financeApi';
import { bucketLabel, financeStrings, kindLabel, LEDGER_FILTERS } from './strings';
import { baghdadToday, ledgerRange, LEDGER_PERIODS, type LedgerPeriod, type LedgerRange } from './ledgerPeriod';

export default function FinanceLedger({
  version,
  onOpenOrder,
  onOpenPayout,
  onOpenCustomOrders,
}: {
  /** Bumped by the parent after a money action, to reload from the top. */
  version: number;
  onOpenOrder: (id: string) => void;
  onOpenPayout: (id: string) => void;
  onOpenCustomOrders?: () => void;
}) {
  const { loc, lang } = useLanguage();
  const s = financeStrings(loc);
  const [filter, setFilter] = useState('all');
  const [entries, setEntries] = useState<LedgerEntry[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [more, setMore] = useState<'idle' | 'loading' | 'error'>('idle');
  const seq = useRef(0);
  const [period, setPeriod] = useState<LedgerPeriod>('all');
  /** The custom days being typed, and the ones last shown. */
  const [draft, setDraft] = useState<LedgerRange>({ from: '', to: '' });
  const [custom, setCustom] = useState<LedgerRange>({ from: '', to: '' });
  const [rangeError, setRangeError] = useState('');

  const kind = LEDGER_FILTERS.find((f) => f.id === filter)?.kind ?? '';
  const answer = ledgerRange(period, Date.now(), custom);
  const from = answer.ok ? answer.range.from : '';
  const to = answer.ok ? answer.range.to : '';
  const first = useCallback(() => {
    const mine = ++seq.current;
    setError(null);
    setMore('idle');
    financeApi
      .ledger({ kind, from, to })
      .then((d) => {
        if (mine !== seq.current) return;
        setEntries(d.entries);
        setCursor(d.next_cursor);
      })
      .catch((e) => mine === seq.current && setError(e));
  }, [kind, from, to]);
  useEffect(() => {
    setEntries(null);
    first();
  }, [first, version]);

  // A page that answers after the period or the kind changed belongs to the
  // old list: dropped, entries and cursor both, as `first` drops its own.
  const loadMore = () => {
    if (!cursor) return;
    const mine = seq.current;
    setMore('loading');
    financeApi
      .ledger({ kind, from, to, cursor })
      .then((d) => {
        if (mine !== seq.current) return;
        setEntries((was) => [...(was ?? []), ...d.entries]);
        setCursor(d.next_cursor);
        setMore('idle');
      })
      .catch(() => mine === seq.current && setMore('error'));
  };

  const choosePeriod = (id: string) => {
    const next = id as LedgerPeriod;
    setRangeError('');
    // Custom opens on this month so far, already shown, so the list always
    // matches the controls above it; the days are then changed and shown.
    if (next === 'custom' && !custom.from) {
      const today = baghdadToday();
      const start = { from: `${today.slice(0, 7)}-01`, to: today };
      setDraft(start);
      setCustom(start);
    }
    setPeriod(next);
  };
  const applyCustom = () => {
    const a = ledgerRange('custom', Date.now(), draft);
    if (a.ok === false) {
      setRangeError(a.reason === 'order' ? s.periodOrder : s.periodIncomplete);
      return;
    }
    setRangeError('');
    setCustom({ ...draft });
  };
  const periodLabels: Record<LedgerPeriod, string> = {
    all: s.periodAll,
    this_month: s.periodThisMonth,
    last_month: s.periodLastMonth,
    custom: s.periodCustom,
  };

  // In Baghdad days, as the period above filters them — never the device's own zone.
  const date = (iso: string) =>
    new Intl.DateTimeFormat(lang === 'en' ? 'en-GB' : 'ar-IQ', { day: 'numeric', month: 'short', timeZone: 'Asia/Baghdad' }).format(new Date(iso));

  const filterLabels: Record<string, string> = {
    all: s.filterAll,
    sales: s.filterSales,
    commission: s.filterCommission,
    refunds: s.filterRefunds,
    payouts: s.filterPayouts,
  };

  return (
    <Card title={s.ledger} padding="none">
      <div className="-mt-2 px-4 pt-2 pb-3 overflow-x-auto hide-scrollbar">
        <Segmented
          items={LEDGER_FILTERS.map((f) => ({ id: f.id, label: filterLabels[f.id] }))}
          value={filter}
          onChange={setFilter}
          label={s.filterLabel}
          group="finance-ledger-filter"
          size="sm"
          className="min-w-[340px]"
        />
      </div>
      <div className="px-4 pb-3 overflow-x-auto hide-scrollbar">
        <Segmented
          items={LEDGER_PERIODS.map((id) => ({ id, label: periodLabels[id] }))}
          value={period}
          onChange={choosePeriod}
          label={s.periodLabel}
          group="finance-ledger-period"
          size="sm"
          className="min-w-[340px]"
          dataAttr="data-ledger-period"
        />
      </div>
      {period === 'custom' && (
        <form
          className="grid grid-cols-2 items-end gap-2 px-4 pb-3 sm:flex sm:flex-wrap sm:gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            applyCustom();
          }}
          data-ledger-custom
        >
          <Field label={s.periodFrom} className="min-w-0 sm:w-[160px]">
            <Input ltr type="date" value={draft.from} max={baghdadToday()} onChange={(e) => setDraft((d) => ({ ...d, from: e.target.value }))} />
          </Field>
          <Field label={s.periodTo} className="min-w-0 sm:w-[160px]">
            <Input ltr type="date" value={draft.to} max={baghdadToday()} onChange={(e) => setDraft((d) => ({ ...d, to: e.target.value }))} />
          </Field>
          <Button type="submit" variant="secondary" className="col-span-2 sm:col-span-1">
            {s.periodShow}
          </Button>
          <p className={`col-span-2 w-full text-[12px] ${rangeError ? 'lv-field-error' : 'text-text-muted'}`} role={rangeError ? 'alert' : undefined}>
            {rangeError || s.periodBaghdad}
          </p>
        </form>
      )}
      {error && !entries ? (
        <ErrorState error={error} onRetry={first} compact />
      ) : !entries ? (
        <div className="px-4 pb-4"><ListRowsSkeleton rows={4} thumbnail={false} /></div>
      ) : entries.length === 0 ? (
        <p className="px-4 pb-4 text-[13px] text-text-muted">{from || to ? s.ledgerEmptyPeriod : s.ledgerEmpty}</p>
      ) : (
        <>
          <ul className="divide-y divide-white/[0.06]" data-finance-ledger>
            {entries.map((e) => (
              <li key={e.id} className="flex items-start justify-between gap-3 px-4 py-2.5" data-ledger-kind={e.kind} data-ledger-bucket={e.bucket}>
                <div className="min-w-0">
                  <p className="text-[13.5px] text-text-primary truncate">{kindLabel(e.kind, loc)}</p>
                  <p className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[12px] text-text-muted">
                    <span className="rounded-full bg-white/[0.06] px-2 py-0.5 text-text-secondary">{bucketLabel(e.bucket, loc)}</span>
                    <span>{date(e.created_at)}</span>
                    {e.link.type === 'order' && e.link.id && (
                      <LinkChip onClick={() => onOpenOrder(e.link.id!)} label={s.orderRef(e.link.id)} />
                    )}
                    {e.link.type === 'payout' && e.link.id && (
                      <LinkChip onClick={() => onOpenPayout(e.link.id!)} label={s.payoutRef} />
                    )}
                    {e.link.type === 'custom_order' && e.link.id && (
                      onOpenCustomOrders
                        ? <LinkChip onClick={onOpenCustomOrders} label={s.customRef(e.link.id)} />
                        : <span>{s.customRef(e.link.id)}</span>
                    )}
                    {e.legacy && <span>{s.carried}</span>}
                  </p>
                </div>
                <span className={`shrink-0 text-[14px] font-semibold ${e.amount_iqd < 0 ? 'text-text-secondary' : 'text-text-primary'}`}>
                  <Money iqd={e.amount_iqd} signed />
                </span>
              </li>
            ))}
          </ul>
          {(cursor || more === 'error') && (
            <div className="px-4 py-3">
              <Button variant="ghost" size="sm" block loading={more === 'loading'} onClick={loadMore}>
                {more === 'error' ? s.retry : s.loadMore}
              </Button>
            </div>
          )}
        </>
      )}
    </Card>
  );
}

function LinkChip({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="min-h-[28px] rounded-md px-1 -mx-1 text-gold underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
    >
      <bdi>{label}</bdi>
    </button>
  );
}
