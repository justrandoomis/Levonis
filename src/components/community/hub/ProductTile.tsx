/**
 * A PRODUCT OF THE COMMUNITY — and the store that sells it.
 *
 * The whole tile is one link to the page the product can be BOUGHT on (the
 * server's `url`: the store's own product page). The store's name sits under
 * the price, because in a feed of many shops «who makes this» is part of what
 * the product is. «نفد» is the storefront's own word and boolean; a sale shows
 * the struck price the store itself set, never a computed percentage.
 */
import { productName } from '../../../lib/productText';
import { useLanguage } from '../../../LanguageContext';
import { useMoney } from '../../../CurrencyContext';
import SafeImage from '../../ui/SafeImage';
import { HubLink, StoreMark } from './parts';
import { useHubStrings } from './strings';
import type { CommunityProduct } from './api';

export default function ProductTile({ product: p, eager = false }: { product: CommunityProduct; eager?: boolean }) {
  const { lang, loc } = useLanguage();
  const s = useHubStrings();
  const { money } = useMoney();
  const name = productName(p, lang);
  const sale = p.original_price_iqd != null && p.original_price_iqd > p.price_iqd;
  const soldOut = p.in_stock === false;

  return (
    <HubLink
      href={p.url || `/product/${encodeURIComponent(p.slug)}`}
      data-community-product={p.id}
      className="group flex min-w-0 flex-col overflow-hidden rounded-2xl border border-border-subtle/60 bg-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
    >
      <div className="relative">
        <SafeImage
          src={p.images?.[0] ?? null}
          alt=""
          aspect="square"
          eager={eager}
          // The hub grid: 2 across on a phone, 3 from 640 px, 6 from 1024 px.
          sizes="(min-width: 1024px) 16vw, (min-width: 640px) 33vw, 50vw"
          bgClassName="bg-surface-selected"
          imgClassName="transition-transform duration-500 group-hover:scale-[1.03] motion-reduce:transition-none"
        />
        {soldOut && (
          <>
            <span aria-hidden="true" className="absolute inset-0 bg-black/35" />
            <span className="absolute start-2 top-2 rounded-full bg-black/75 px-2 py-0.5 text-[11px] font-semibold text-snow">
              {loc('نفد', 'Sold out', 'تەواو بوو')}
            </span>
          </>
        )}
      </div>
      <div className="flex flex-1 flex-col gap-1.5 p-3">
        <h3 dir="auto" className="line-clamp-2 text-start text-[13.5px] font-medium leading-snug text-text-primary">
          {name}
        </h3>
        <p className="mt-auto flex flex-wrap items-baseline gap-x-1.5">
          <span className="text-[14px] font-bold tabular-nums text-text-primary">{money(p.price_iqd || 0)}</span>
          {sale && (
            <>
              <span className="sr-only">{s.was}</span>
              <s className="text-[11.5px] tabular-nums text-text-muted">{money(p.original_price_iqd ?? 0)}</s>
            </>
          )}
        </p>
        {p.store && (
          <p className="flex min-w-0 items-center gap-1.5 text-[11.5px] text-text-secondary">
            <StoreMark src={p.store.logoUrl} size="xs" />
            <bdi className="truncate">{p.store.name}</bdi>
          </p>
        )}
      </div>
    </HubLink>
  );
}
