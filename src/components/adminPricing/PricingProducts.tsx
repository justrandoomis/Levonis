/**
 * «التسعير والشحن» — THE PRODUCT LIST: every ordinary product, its status
 * worst-first, the counts over all of them, a search and a status filter.
 *
 * One list, not pages. The catalogue is bounded (41 products today, the
 * engine's apply cap is 60), so AdminPricing reads every overview page once
 * and the owner searches and filters it here without another request. The
 * counts on the chips are the SERVER's (`status_counts`, over every product),
 * never a recount of what happens to be loaded.
 *
 * A row is one button: name, slug, status, how it sells and how many models.
 * The status is a chip with a dot and a word (never colour alone); the reasons
 * are read on the product's own page, where there is room to say them whole.
 */
import React, { useMemo } from 'react';
import { ChevronLeft, ChevronRight, Search, X } from 'lucide-react';
import { Badge, StatusChip } from '../ui/Badge';
import { EmptyState } from '../ui/AsyncStates';
import { toAsciiDigits } from '../../lib/localeNumber';
import type { Language } from '../../translations';
import { PRICING_MIGRATION_STATUSES, type PricingMigrationStatus } from '../../../packages/contracts/src/pricingMigrationLabels';
import type { PricingOverview, PricingProductSummary } from './api';
import { MigrationStatusChip, STATUS_TONE } from './parts';
import { mixLabel, nameOf, routeLabel, statusLabel, type PricingUiStrings } from './strings';

export type StatusFilter = 'all' | PricingMigrationStatus;

const DOT: Record<string, string> = {
  danger: 'bg-danger',
  warning: 'bg-warning',
  info: 'bg-info',
  accent: 'bg-gold',
  success: 'bg-success',
  neutral: 'bg-text-muted',
};

const norm = (s: string) => toAsciiDigits(s).toLocaleLowerCase().trim();

/** Does a product match the owner's search (any of its three names, or its slug)? */
export function matchesQuery(p: PricingProductSummary, query: string): boolean {
  const q = norm(query);
  if (!q) return true;
  return [p.name_ar, p.name_en, p.name_ckb, p.slug].some((s) => norm(s ?? '').includes(q));
}

export default function PricingProducts({
  overview,
  products,
  truncatedAt,
  query,
  onQuery,
  filter,
  onFilter,
  onOpen,
  lang,
  dir,
  s,
}: {
  overview: PricingOverview;
  products: PricingProductSummary[];
  /** The number of products shown when the list was cut short, else null. */
  truncatedAt: number | null;
  query: string;
  onQuery: (q: string) => void;
  filter: StatusFilter;
  onFilter: (f: StatusFilter) => void;
  onOpen: (id: string) => void;
  lang: Language;
  dir: 'rtl' | 'ltr';
  s: PricingUiStrings;
}) {
  const counts = useMemo(() => new Map(overview.status_counts.map((c) => [c.migration_status, c.count] as const)), [overview]);
  const shown = useMemo(
    () => products.filter((p) => (filter === 'all' || p.migration_status === filter) && matchesQuery(p, query)),
    [products, filter, query]
  );
  // Only statuses that hold a product are offered as filters; the chip row
  // stays a short, honest summary rather than six zeros.
  const statuses = PRICING_MIGRATION_STATUSES.filter((st) => (counts.get(st) ?? 0) > 0);
  const Chevron = dir === 'rtl' ? ChevronLeft : ChevronRight;

  return (
    <section aria-labelledby="pricing-products-title" data-pricing-products className="space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h3 id="pricing-products-title" className="text-[17px] font-bold leading-snug text-text-primary">
          {s.productsHeading}
        </h3>
        <p className="text-[13px] text-text-muted">
          {s.productsCount(overview.total)}
          {overview.typed_member_price_products > 0 && <> · {s.typedMemberSummary(overview.typed_member_price_products)}</>}
        </p>
      </div>

      {/* Status filter: a row of toggle buttons with the server's counts. */}
      <div
        role="group"
        aria-label={s.filterLabel}
        data-pricing-status-filter
        className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1 [scrollbar-width:none]"
      >
        <button
          type="button"
          aria-pressed={filter === 'all'}
          onClick={() => onFilter('all')}
          className="lv-choice press-scale inline-flex shrink-0 items-center gap-2 px-3 text-[13px] font-semibold"
        >
          {s.all}
          <Badge>{overview.total}</Badge>
        </button>
        {statuses.map((st) => (
          <button
            key={st}
            type="button"
            data-status-filter={st}
            aria-pressed={filter === st}
            onClick={() => onFilter(filter === st ? 'all' : st)}
            className="lv-choice press-scale inline-flex shrink-0 items-center gap-2 px-3 text-[13px] font-semibold"
          >
            <span aria-hidden="true" className={`h-2 w-2 shrink-0 rounded-full ${DOT[STATUS_TONE[st]]}`} />
            <span className="whitespace-nowrap">{statusLabel(st, lang)}</span>
            <Badge>{counts.get(st) ?? 0}</Badge>
          </button>
        ))}
      </div>

      <div className="relative">
        <label htmlFor="pricing-search" className="sr-only">
          {s.searchLabel}
        </label>
        <Search aria-hidden="true" className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-muted" />
        <input
          id="pricing-search"
          type="search"
          value={query}
          onChange={(e) => onQuery(e.target.value)}
          placeholder={s.searchPlaceholder}
          autoComplete="off"
          enterKeyHint="search"
          className="lv-input ps-9 pe-10"
        />
        {query && (
          <button
            type="button"
            onClick={() => onQuery('')}
            aria-label={s.clearFilters}
            className="lv-hit absolute end-2 top-1/2 inline-flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-full text-text-muted hover:text-text-primary"
          >
            <X aria-hidden="true" className="h-4 w-4" />
          </button>
        )}
      </div>

      {truncatedAt !== null && <p className="text-[12px] text-text-muted">{s.truncated(truncatedAt)}</p>}

      {shown.length === 0 ? (
        <EmptyState
          compact
          title={products.length === 0 ? s.noProducts : s.noMatch}
          action={
            products.length > 0 ? (
              <button
                type="button"
                className="lv-button lv-button-secondary lv-button-sm"
                onClick={() => {
                  onQuery('');
                  onFilter('all');
                }}
              >
                {s.clearFilters}
              </button>
            ) : undefined
          }
        />
      ) : (
        <ul className="lv-surface divide-y divide-border-subtle/70 overflow-hidden" data-pricing-product-list aria-live="polite">
          {shown.map((p) => {
            const name = nameOf(p, lang, p.slug);
            const routes = p.routes.map((r) => routeLabel(r, lang)).join(lang === 'en' ? ', ' : '، ');
            return (
              <li key={p.id}>
                <button
                  type="button"
                  data-pricing-product={p.id}
                  onClick={() => onOpen(p.id)}
                  className="group flex w-full items-center gap-3 px-4 py-3 text-start transition-colors hover:bg-white/[0.03] focus-visible:bg-white/[0.04] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus"
                >
                  <div className="min-w-0 flex-1 md:grid md:grid-cols-[minmax(0,1.5fr)_minmax(0,1.1fr)_minmax(0,1.2fr)] md:items-center md:gap-4">
                    <div className="min-w-0">
                      <p className="line-clamp-2 text-[15px] font-semibold leading-snug text-text-primary">{name}</p>
                      <p className="mt-0.5 truncate text-[12px] text-text-muted">
                        <bdi dir="ltr">{p.slug}</bdi>
                      </p>
                    </div>
                    <p className="mt-1.5 text-[13px] leading-snug text-text-secondary md:mt-0">
                      {mixLabel(p.channel_mix, lang)}
                      {routes && <span className="text-text-muted"> · {routes}</span>}
                      <span className="text-text-muted md:block md:text-[12px]">
                        <span className="md:hidden"> · </span>
                        {s.models(p.model_count)}
                      </span>
                    </p>
                    <div className="mt-2 flex flex-wrap items-center gap-1.5 md:mt-0">
                      <MigrationStatusChip status={p.migration_status} lang={lang} />
                      {p.typed_member_prices && <StatusChip tone="neutral">{s.typedMemberPrices}</StatusChip>}
                      {p.status !== 'active' && <StatusChip tone="neutral" dot={false}>{s.notLive}</StatusChip>}
                    </div>
                  </div>
                  <Chevron aria-hidden="true" className="h-4 w-4 shrink-0 text-text-muted transition-transform group-hover:translate-x-0.5 rtl:group-hover:-translate-x-0.5" />
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
