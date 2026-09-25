/**
 * The Farm Coin ledger, newest first, 30 a page from GET /api/farm/ledger.
 * Credits are gold, debits red; the running balance is the server's
 * `balance_after`, never a client sum.
 */
import React, { useEffect, useId, useState } from 'react';
import { ErrorState } from '../../../components/ui/AsyncStates';
import { Skeleton, SkeletonGroup } from '../../../components/ui/Skeleton';
import Spinner from '../../../components/ui/Spinner';
import { farmApi, type LedgerEntry } from '../../../lib/farmApi';
import type { FarmStrings } from '../strings';
import { formatCoins, formatDateTime, formatSignedCoins, ledgerKindLabel } from '../format';
import { BTN_SECONDARY, ROW } from '../ui';
import { Window, WINDOW_BODY } from './Window';

export default function LedgerSheet({
  open,
  onClose,
  anchor,
  lang,
  s,
  currentCoins,
}: {
  open: boolean;
  onClose: () => void;
  anchor: React.RefObject<HTMLElement | null>;
  lang: string;
  s: FarmStrings;
  currentCoins: string;
}) {
  const titleId = useId();
  const [entries, setEntries] = useState<LedgerEntry[] | null>(null);
  const [nextBefore, setNextBefore] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  const load = async (before: string | null) => {
    try {
      const page = await farmApi.ledger(before);
      setEntries((prev) => (before && prev ? [...prev, ...page.entries] : page.entries));
      setNextBefore(page.next_before ?? null);
      setError(null);
    } catch (e) {
      setError(e);
    }
  };

  useEffect(() => {
    if (!open) return;
    setEntries(null);
    setError(null);
    void load(null);
  }, [open]);

  return (
    <Window open={open} onClose={onClose} label={s.ledger} labelledBy={titleId} anchor={anchor} testId="farm-ledger">
      <div className={WINDOW_BODY}>
        <div className="flex items-baseline justify-between gap-3">
          <h3 id={titleId} className="text-white font-bold text-[16px]">
            {s.ledger}
          </h3>
          <span className="text-gold font-black tabular-nums" dir="ltr">
            {currentCoins}
          </span>
        </div>

        {error ? (
          <ErrorState compact error={error} onRetry={() => void load(null)} />
        ) : entries === null ? (
          <SkeletonGroup className="space-y-2">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-12 w-full rounded-xl" />
            ))}
          </SkeletonGroup>
        ) : entries.length === 0 ? (
          <p className="text-[13px] text-zinc-500">{s.noLedger}</p>
        ) : (
          <ul className="space-y-1.5">
            {entries.map((e) => (
              <li key={e.id} className={`${ROW} px-3 py-2 flex items-center gap-3`} data-farm-ledger-kind={e.kind}>
                <div className="min-w-0 flex-1">
                  <p className="text-[12.5px] text-zinc-100 font-bold truncate">{ledgerKindLabel(e.kind, s)}</p>
                  <p className="text-[11px] text-zinc-500 truncate">
                    {e.note ? `${e.note} · ` : ''}
                    <span dir="ltr">{formatDateTime(e.created_at, lang)}</span>
                  </p>
                </div>
                <div className="text-end shrink-0">
                  <p className={`text-[13px] font-black tabular-nums ${e.amount >= 0 ? 'text-gold' : 'text-coral'}`} dir="ltr">
                    {formatSignedCoins(e.amount, lang)}
                  </p>
                  <p className="text-[10.5px] text-zinc-500 tabular-nums">{s.balanceAfter(formatCoins(e.balance_after, lang))}</p>
                </div>
              </li>
            ))}
          </ul>
        )}

        {entries && nextBefore && (
          <button
            type="button"
            disabled={loadingMore}
            onClick={async () => {
              setLoadingMore(true);
              await load(nextBefore);
              setLoadingMore(false);
            }}
            className={`${BTN_SECONDARY} w-full`}
          >
            {loadingMore && <Spinner size="sm" delayMs={0} decorative />}
            {s.loadMore}
          </button>
        )}
      </div>
    </Window>
  );
}
