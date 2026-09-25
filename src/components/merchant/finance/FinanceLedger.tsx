/**
 * THE LEDGER, LINE BY LINE — every line that makes up the figures above,
 * newest first, filterable by kind, paged by the server's cursor. Each line
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
import { ListRowsSkeleton } from '../../ui/DashboardSkeletons';
import { financeApi, type LedgerEntry } from './financeApi';
import { bucketLabel, financeStrings, kindLabel, LEDGER_FILTERS } from './strings';

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

  const kind = LEDGER_FILTERS.find((f) => f.id === filter)?.kind ?? '';
  const first = useCallback(() => {
    const mine = ++seq.current;
    setError(null);
    financeApi
      .ledger({ kind })
      .then((d) => {
        if (mine !== seq.current) return;
        setEntries(d.entries);
        setCursor(d.next_cursor);
      })
      .catch((e) => mine === seq.current && setError(e));
  }, [kind]);
  useEffect(() => {
    setEntries(null);
    first();
  }, [first, version]);

  const loadMore = () => {
    if (!cursor) return;
    setMore('loading');
    financeApi
      .ledger({ kind, cursor })
      .then((d) => {
        setEntries((was) => [...(was ?? []), ...d.entries]);
        setCursor(d.next_cursor);
        setMore('idle');
      })
      .catch(() => setMore('error'));
  };

  const date = (iso: string) =>
    new Intl.DateTimeFormat(lang === 'en' ? 'en-GB' : 'ar-IQ', { day: 'numeric', month: 'short' }).format(new Date(iso));

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
      {error && !entries ? (
        <ErrorState error={error} onRetry={first} compact />
      ) : !entries ? (
        <div className="px-4 pb-4"><ListRowsSkeleton rows={4} thumbnail={false} /></div>
      ) : entries.length === 0 ? (
        <p className="px-4 pb-4 text-[13px] text-text-muted">{s.ledgerEmpty}</p>
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
