/**
 * THE PIECES EVERY ACCOUNT SCREEN SHARES — the grouped menu of the prototype,
 * a sub-page's head with its way back, a row of figures in wells, the state
 * pills of a shipment and a sell-back, a «load more» and a ledger paged on the
 * server's exact cursor, and the one rule of a money door's Idempotency-Key.
 *
 * Every account screen imports this module, so it, logic.ts and the
 * section's words (src/cloud/strings/account.ts) share one importer set and
 * travel as one chunk — never small shared chunks of their own
 * (tests/motionLazy.test.ts counts those).
 */
import React, { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { StatusChip } from '../../../components/ui/Badge';
import { Button } from '../../../components/ui/Button';
import { Money } from '../../../components/ui/Money';
import { formatFigure } from '../../../lib/localeNumber';
import { useIdempotencyKey } from '../../api';
import { formatDateTime, formatDuration, formatQuantity } from '../../format';
import { account, buybackStatus, materialsText, payoutStatus, sect, shipmentStatus } from '../../strings/account';
import { useCloudText } from '../../text';
import type { TopUpQuote, Tri } from '../../types';
import { ExternalLink, PageHeader, forwardChevron } from '../../ui';
import { useCloudQuery } from '../../useCloudQuery';
import { buybackTone, movementSign, nextLedgerCursor, shipmentTone, storeCheckoutLink, type LedgerCursor, type Movement } from './logic';

// ------------------------------------------------------------------ words

/** The word for a status the server stored, or «Status: <code>» for one this build does not know — never a blank. */
export function useStatusWord() {
  const { t } = useCloudText();
  return (record: Record<string, Tri>, code: string): string => {
    const word = Object.prototype.hasOwnProperty.call(record, code) ? record[code] : null;
    return word ? t(word) : t(sect.statusCode, { code });
  };
}

// ------------------------------------------------------------------ heads

/** A sub-page's head: the way back (to the account unless `back` says otherwise), its one h1, a quiet line, its actions. */
export function SubPageHeader({
  title,
  subtitle,
  actions,
  back,
}: {
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  actions?: React.ReactNode;
  back?: { to: string; label: string };
}) {
  const { t } = useCloudText();
  return <PageHeader title={title} subtitle={subtitle} back={back ?? { to: '/account', label: t(account.title) }} actions={actions} />;
}

// ------------------------------------------------------------------ the menu

/** A group of menu rows in one resting card, divided by hairlines — the prototype's grouped menu, in clay. */
export function MenuGroup({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <nav aria-label={label}>
      <ul className="lv-surface divide-y divide-border-subtle overflow-hidden">{children}</ul>
    </nav>
  );
}

export interface MenuRowProps {
  icon: React.ReactNode;
  title: React.ReactNode;
  sub?: React.ReactNode;
  /** A figure at the inline end (the wallet's balance). */
  trailing?: React.ReactNode;
  /** A screen of Print Cloud… */
  to?: string;
  /** …or a page of Levonis itself (the wallet, the support desk), which leaves this app. Neither: a row that only shows. */
  href?: string;
}

export function MenuRow({ icon, title, sub, trailing, to, href }: MenuRowProps) {
  const { t, dir } = useCloudText();
  const Forward = forwardChevron(dir);
  const shell = 'flex min-h-11 items-center gap-3 px-3 py-3';
  const door = `${shell} transition-colors hover:bg-surface-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus`;
  const body = (
    <>
      <span aria-hidden="true" className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl lv-well text-text-secondary">
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[15px] font-semibold text-text-primary">{title}</span>
        {sub ? <span className="mt-0.5 block truncate text-[12px] text-text-muted">{sub}</span> : null}
      </span>
      {trailing ? <span className="shrink-0 text-sm font-semibold tabular-nums text-text-primary">{trailing}</span> : null}
    </>
  );
  return (
    <li>
      {href ? (
        <a href={href} className={door}>
          {body}
          <ExternalLink aria-hidden="true" className="h-4 w-4 shrink-0 text-text-muted" />
          <span className="sr-only">{t(account.opensLevonis)}</span>
        </a>
      ) : to ? (
        <Link to={to} className={door}>
          {body}
          <Forward aria-hidden="true" className="h-4 w-4 shrink-0 text-text-muted" />
        </Link>
      ) : (
        <div className={shell}>{body}</div>
      )}
    </li>
  );
}

// ------------------------------------------------------------------ figures

export interface FigureItem {
  label: React.ReactNode;
  value: React.ReactNode;
}

/** Figures side by side, each in a well sunk into its card: «Yours · Held · Free to use». */
export function Figures({ items, className = '' }: { items: FigureItem[]; className?: string }) {
  return (
    <dl className={`grid gap-2 text-center ${items.length >= 4 ? 'grid-cols-2 sm:grid-cols-4' : 'grid-cols-3'} ${className}`}>
      {items.map((it, i) => (
        <div key={i} className="min-w-0 rounded-xl lv-well px-2 py-2">
          <dt className="truncate text-[11px] text-text-muted">{it.label}</dt>
          <dd className="truncate text-sm font-bold tabular-nums text-text-primary">
            <bdi>{it.value}</bdi>
          </dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * A ledger movement's figure with its sign — «+2h 30m», «−650 g», «45m» —
 * in seconds (`unit` 'seconds') or in a variant's base unit. The figure is
 * isolated in the direction of its own words (dir auto): forced LTR, an
 * Arabic or Sorani «2 کاتژمێر 30 خولەک» would be drawn with its unit words
 * swapped. Only the sign sits in an LTR isolate of its own, ahead of the
 * first figure in the reading direction.
 */
export function MovementFigure({ movement, unit }: { movement: Movement; unit: 'seconds' | string }) {
  const { lang } = useCloudText();
  // A unit this screen could not learn (a material no longer listed) leaves the bare count — never a guessed unit.
  const figure = unit === 'seconds' ? formatDuration(movement.amount, lang) : unit ? formatQuantity(movement.amount, unit, lang) : formatFigure(movement.amount, lang);
  const sign = movementSign(movement.kind);
  return (
    <bdi className={`whitespace-nowrap tabular-nums ${sign === '+' ? 'text-success' : 'text-text-primary'}`}>
      {sign ? <bdi dir="ltr">{sign}</bdi> : null}
      {figure}
    </bdi>
  );
}

/**
 * A sentence with one `{amount}` slot, the amount drawn as `<Money>` — an LTR
 * island with the house's digits and unit — never spliced into the words as
 * text, where an Arabic line would carry its grouping commas off.
 */
export function MoneyLine({ text, iqd, vars }: { text: Tri; iqd: number | null | undefined; vars?: Record<string, string | number> }) {
  const { t } = useCloudText();
  const marker = '\u0000';
  const [before, after = ''] = t(text, { ...vars, amount: marker }).split(marker);
  return (
    <>
      {before}
      <Money iqd={iqd} />
      {after}
    </>
  );
}

// ------------------------------------------------------------------ states

export function ShipmentPill({ status, className = '' }: { status: string; className?: string }) {
  const word = useStatusWord();
  return (
    <StatusChip tone={shipmentTone(status)} className={className}>
      {word(shipmentStatus, status)}
    </StatusChip>
  );
}

export function BuybackPill({ status }: { status: string }) {
  const word = useStatusWord();
  return <StatusChip tone={buybackTone(status)}>{word(buybackStatus, status)}</StatusChip>;
}

export function PayoutPill({ status }: { status: string }) {
  const word = useStatusWord();
  return <StatusChip tone={status === 'paid' ? 'success' : status === 'pending' ? 'warning' : 'neutral'}>{word(payoutStatus, status)}</StatusChip>;
}

/** A material's own colour (the owner's catalogue data, not a theme colour), with a hairline so white shows on cream. */
export function Swatch({ hex, className = 'h-5 w-5' }: { hex: string | null | undefined; className?: string }) {
  if (!hex) return null;
  return <span aria-hidden="true" className={`block shrink-0 rounded-full border border-border-subtle ${className}`} style={{ backgroundColor: hex }} />;
}

// ------------------------------------------------------------------ lists

/** «Load more», while a next page exists; busy while it loads. */
export function LoadMore({ onMore, loading }: { onMore: () => void; loading: boolean }) {
  const { t } = useCloudText();
  return (
    <div className="flex justify-center">
      <Button variant="secondary" loading={loading} onClick={onMore}>
        {t(sect.loadMore)}
      </Button>
    </div>
  );
}

/**
 * A LEDGER, PAGE BY PAGE, on the server's exact cursor (logic.ts
 * `nextLedgerCursor`: the last row's time AND id — GET /me/credits/ledger and
 * /me/inventory/ledger take both), so the rows one batch wrote at one instant
 * are never skipped between pages. The first page reloads with `deps`; pages
 * loaded after it belong to THAT first page and go with it.
 */
export function useLedgerPages<R extends { id: string; created_at: string }>(
  fetchPage: (cursor: LedgerCursor | null, signal?: AbortSignal) => Promise<R[]>,
  limit: number,
  deps: readonly unknown[]
) {
  const first = useCloudQuery((signal) => fetchPage(null, signal), deps);
  const [more, setMore] = useState<{ base: R[]; rows: R[]; next: LedgerCursor | null } | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState<unknown>(null);
  const base = first.data;
  const extra = more && base && more.base === base ? more : null;
  const rows = base ? [...base, ...(extra?.rows ?? [])] : undefined;
  const next = base ? (extra ? extra.next : nextLedgerCursor(base, limit)) : null;
  const loadMore = async () => {
    if (!base || !next) return;
    setLoadingMore(true);
    setMoreError(null);
    try {
      const page = await fetchPage(next);
      setMore((m) => ({ base, rows: [...(m && m.base === base ? m.rows : []), ...page], next: nextLedgerCursor(page, limit) }));
    } catch (e) {
      setMoreError(e);
    } finally {
      setLoadingMore(false);
    }
  };
  return { rows, error: first.error, reload: first.reload, next, loadMore, loadingMore, moreError };
}

/** The honest line under a list the server caps: only the latest are shown, and where the rest is. */
export function CapNote({ shown, cap, history = false }: { shown: number; cap: number; history?: boolean }) {
  const { t, lang } = useCloudText();
  if (shown < cap) return null;
  return (
    <p className="text-[12px] leading-relaxed text-text-muted">
      {t(sect.latestShown, { n: formatFigure(cap, lang) })}{' '}
      {history ? (
        <Link to="/account/transactions" className="font-semibold text-text-secondary underline-offset-2 hover:underline">
          {t(sect.fullHistory)}
        </Link>
      ) : null}
    </p>
  );
}

// ------------------------------------------------------------------ a top-up's price

/**
 * The server's answer to «top up» (POST /me/inventory/top-up-quote): already
 * enough, or the quantity to buy, the balance it leads to and the STORED
 * quote's own total and expiry — then the way on, into the store's cart with
 * that quote (logic.ts `storeCheckoutLink`). Nothing here is priced on the client.
 */
export function TopUpResult({ result, unit }: { result: TopUpQuote; unit: string }) {
  const { t, lang } = useCloudText();
  if (result.quantity <= 0 || !result.quote) {
    return (
      <p role="status" className="rounded-xl lv-well px-3 py-2 text-[13px] text-text-secondary">
        {t(materialsText.topUpEnough, { owned: formatQuantity(result.owned_qty, unit, lang), target: formatQuantity(result.target_qty, unit, lang) })}
      </p>
    );
  }
  const quote = result.quote;
  const after = result.balance_after_qty ?? result.owned_qty + result.quantity;
  return (
    <div role="status" className="space-y-2 rounded-xl lv-well p-3">
      <p className="text-sm font-semibold text-text-primary">
        {t(materialsText.topUpBuy, { qty: formatQuantity(result.quantity, unit, lang), after: formatQuantity(after, unit, lang) })}
      </p>
      <p className="flex items-baseline justify-between gap-3">
        <span className="text-[13px] text-text-secondary">{t(materialsText.price)}</span>
        <span className="text-ui-xl font-bold text-text-primary">
          <Money iqd={quote.total_iqd} />
        </span>
      </p>
      <p className="text-[12px] text-text-muted">{t(materialsText.priceUntil, { time: formatDateTime(quote.expires_at, lang) })}</p>
      {quote.orderable ? (
        <Link to={storeCheckoutLink(quote.quote_id)} className="lv-button lv-button-primary w-full">
          {t(materialsText.continueInStore)}
        </Link>
      ) : (
        <p role="alert" className="text-[13px] font-semibold text-warning">
          {t(materialsText.outOfStock)}
        </p>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ money doors

/**
 * ONE IDEMPOTENCY KEY PER INTENT (src/cloud/api.ts). The key is made for
 * what is about to be sent and kept across every retry of it — an answer lost
 * on the way back, retried, is the SAME request, which the server replays
 * instead of doing twice — and a new one is made only when what is sent
 * changes (`body`) or after a success (`renew()`). Closing the confirmation
 * and opening it again over the same body keeps the key, so a request the
 * server did carry out is never sent a second time as a new one.
 */
export function useIntentKey(scope: string, body: unknown): { key: string; renew: () => void } {
  const intent = useIdempotencyKey(scope);
  const signature = JSON.stringify(body ?? null);
  const seen = useRef(signature);
  const { renew } = intent;
  useEffect(() => {
    if (seen.current === signature) return;
    seen.current = signature;
    renew();
  }, [signature, renew]);
  return intent;
}
