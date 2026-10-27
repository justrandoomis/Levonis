/**
 * THE STORE'S FRONT (/store) — the catalogue (search, chips, the goods) in
 * the house clay, every figure the server's:
 *
 *   Printing hours  GET /packages grouped by printer class (the class's name
 *                   and its models from GET /printers). A package shows its
 *                   own price, its hours, its validity as the package states
 *                   it, a per-hour figure derived from nothing but its own
 *                   price and seconds, the material a bundle carries, and the
 *                   owner's limits. ?tier=<id> opens one class.
 *   Filament,       GET /store/categories + /store/products, grouped by
 *   Accessories     product: colours as swatches, the cheapest pack with the
 *                   price the server states for exactly that pack — or «priced
 *                   by the quantity you choose» when the product has no pack.
 *                   ?cat=<code> filters one category.
 *
 * A visitor browses freely; buying asks for an account (a cart is an
 * account's). Lists are capped and grow on «Show more», saying how many of
 * how many are shown.
 */
import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { StatusChip } from '../../../components/ui/Badge';
import { Button } from '../../../components/ui/Button';
import { Money } from '../../../components/ui/Money';
import { Segmented } from '../../../components/ui/Segmented';
import { formatFigure } from '../../../lib/localeNumber';
import { listPackages, listPrinters, listStoreCategories, listStoreProducts } from '../../api';
import { useCloud } from '../../CloudContext';
import { formatDate, formatDays, formatHours, formatIqd, formatQuantity } from '../../format';
import { goods, hours, store } from '../../strings/store';
import { tx, useCloudText } from '../../text';
import type { CreditPackage, StoreProduct } from '../../types';
import { Box, Clock, CloudEmptyState, CloudErrorState, CloudPageSkeleton, Disc3, PageHeader, PackageSearch, Receipt, SectionHeader, ShoppingBag } from '../../ui';
import { useCloudQuery } from '../../useCloudQuery';
import { ProductPage, warm } from './pages';
import { CartLink, Chip, ChipRow, SearchField, Swatch, useAddToCart, variantName } from './parts';
import {
  cheapestPack,
  firstQuantity,
  groupProducts,
  groupPurchasable,
  matchesQuery,
  packageRule,
  perHourIqd,
  productFields,
  storeTab,
  TAB_KINDS,
  tierGroups,
  type ProductGroup,
  type StoreTab,
  type TierGroup,
} from './rules';

/** How many cards a list shows before «Show more». */
const PAGE = 24;

function StoreActions() {
  const { t } = useCloudText();
  const { signedIn } = useCloud();
  if (!signedIn) return null;
  return (
    <>
      <CartLink />
      <Link to="/orders" className="lv-button lv-button-ghost lv-button-sm">
        <Receipt aria-hidden="true" className="h-4 w-4" />
        {t(store.myOrders)}
      </Link>
    </>
  );
}

/** «Showing 24 of 60» and the button that shows more — a list that is capped says so. */
function MoreButton({ shown, total, onMore }: { shown: number; total: number; onMore: () => void }) {
  const { t, lang } = useCloudText();
  if (shown >= total) return null;
  return (
    <div className="flex flex-col items-center gap-2 pt-1">
      <p className="text-[12px] text-text-muted">{t(store.shownOf, { shown: formatFigure(shown, lang), total: formatFigure(total, lang) })}</p>
      <Button variant="secondary" onClick={onMore}>
        {t(store.showMore)}
      </Button>
    </div>
  );
}

// ------------------------------------------------------------------ hours

function PackageCard({ pkg, group, variantOf }: { pkg: CreditPackage; group: TierGroup; variantOf: (id: string) => StoreProduct | null }) {
  const { t, lang } = useCloudText();
  const { signedIn } = useCloud();
  const add = useAddToCart();
  const rate = perHourIqd(pkg);
  const rule = packageRule(pkg);
  const first = firstQuantity(rule);
  const items = pkg.bundle.map((b) => {
    const v = variantOf(b.variant_id);
    return v ? `${formatQuantity(b.qty, v.unit_code, lang)} ${variantName(v, lang)}` : formatFigure(b.qty, lang);
  });
  return (
    <li className="lv-surface flex flex-col gap-3 p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-[15px] font-bold leading-snug text-text-primary">{tx(pkg.name, lang) || formatHours(pkg.seconds, lang)}</h3>
          <p className="mt-0.5 text-[12px] text-text-muted">
            {formatHours(pkg.seconds, lang)} · {pkg.expires_after_days ? t(hours.validFor, { days: formatDays(pkg.expires_after_days, lang) }) : t(hours.neverExpires)}
          </p>
        </div>
        {pkg.kind === 'promotional' || pkg.bundle.length > 0 ? (
          <div className="flex shrink-0 flex-col items-end gap-1">
            {pkg.kind === 'promotional' ? <StatusChip tone="accent">{t(hours.offer)}</StatusChip> : null}
            {pkg.bundle.length > 0 ? <StatusChip tone="info">{t(hours.bundle)}</StatusChip> : null}
          </div>
        ) : null}
      </div>
      <div>
        <p className="text-ui-xl font-bold text-text-primary">
          <Money iqd={pkg.price_iqd} />
        </p>
        {rate != null ? <p className="text-[12px] text-text-muted">{t(hours.perHour, { price: formatIqd(rate, lang) })}</p> : null}
      </div>
      {items.length > 0 || pkg.max_per_customer != null || pkg.valid_until ? (
        <ul className="space-y-1 text-[12px] leading-relaxed text-text-secondary">
          {items.length > 0 ? <li>{t(hours.includes, { items: items.join(' · ') })}</li> : null}
          {pkg.max_per_customer != null ? <li>{t(hours.limitPerCustomer, { n: formatFigure(pkg.max_per_customer, lang) })}</li> : null}
          {pkg.valid_until ? <li>{t(hours.offerEnds, { date: formatDate(pkg.valid_until, lang) })}</li> : null}
        </ul>
      ) : null}
      <Button
        variant="primary"
        block
        className="mt-auto"
        disabled={first === null}
        icon={<ShoppingBag aria-hidden="true" className="h-4 w-4" />}
        onClick={() => {
          if (first === null) return;
          add({ kind: 'package', ref: pkg.id, quantity: first, fulfillment: 'credits', rule, label: { name: pkg.name, detail: group.name, unit: null, color: null, seconds: pkg.seconds } });
        }}
      >
        {signedIn ? t(store.addToCart) : t(store.signInToBuy)}
      </Button>
    </li>
  );
}

function HoursTab({ query, tier, onTier }: { query: string; tier: string | null; onTier: (id: string | null) => void }) {
  const { t, lang } = useCloudText();
  const packages = useCloudQuery((signal) => listPackages(undefined, { signal }), []);
  // The class names and models only label the packages: without them the packages still sell, under «printer class».
  const printers = useCloudQuery((signal) => listPrinters({ signal }), []);
  const needNames = !!packages.data?.some((p) => p.bundle.length > 0);
  const products = useCloudQuery<StoreProduct[] | null>((signal) => (needNames ? listStoreProducts(undefined, { signal }) : Promise.resolve(null)), [needNames]);

  if (packages.error) return <CloudErrorState error={packages.error} onRetry={packages.reload} />;
  if (!packages.data || (printers.loading && !printers.data)) return <CloudPageSkeleton />;

  const groups = tierGroups(packages.data, printers.data ?? []);
  if (groups.length === 0) {
    return <CloudEmptyState icon={<Clock className="h-6 w-6" />} title={t(hours.noPackagesTitle)} body={t(hours.noPackagesBody)} />;
  }
  const nameOf = (g: TierGroup) => (g.name ? tx(g.name, lang) : '') || t(hours.classFallback);
  // A class asked for by its address (a printer's «buy hours for this class») that has nothing on sale says so,
  // rather than quietly showing every other class instead.
  if (tier && !groups.some((g) => g.tierId === tier)) {
    const named = printers.data?.find((m) => m.tier_id === tier)?.tier_name;
    return (
      <CloudEmptyState
        compact
        icon={<Clock className="h-6 w-6" />}
        title={t(hours.noPackagesForClass, { class: (named && tx(named, lang)) || t(hours.classFallback) })}
        action={
          <Button variant="secondary" onClick={() => onTier(null)}>
            {t(hours.allClasses)}
          </Button>
        }
      />
    );
  }
  const active = tier;
  const variantOf = (id: string) => products.data?.find((v) => v.id === id) ?? null;
  const shown = groups
    .filter((g) => !active || g.tierId === active)
    .map((g) => {
      const whole = matchesQuery(query, [g.name?.ar, g.name?.en, g.name?.ckb, ...g.models]);
      return { ...g, packages: whole ? g.packages : g.packages.filter((p) => matchesQuery(query, [p.name.ar, p.name.en, p.name.ckb, p.code])) };
    })
    .filter((g) => g.packages.length > 0);

  return (
    <div className="space-y-4">
      <p className="text-[13px] leading-relaxed text-text-muted">{t(hours.intro)}</p>
      {groups.length > 1 ? (
        <ChipRow label={t(hours.classes)}>
          <Chip on={!active} onClick={() => onTier(null)}>
            {t(hours.allClasses)}
          </Chip>
          {groups.map((g) => (
            <Chip key={g.tierId} on={active === g.tierId} onClick={() => onTier(active === g.tierId ? null : g.tierId)}>
              {nameOf(g)}
            </Chip>
          ))}
        </ChipRow>
      ) : null}
      {shown.length === 0 ? (
        <CloudEmptyState compact icon={<PackageSearch className="h-6 w-6" />} title={t(store.noMatchTitle)} body={t(store.noMatchBody)} />
      ) : (
        shown.map((g) => (
          <section key={g.tierId} aria-labelledby={`cloud-store-tier-${g.tierId}`} className="space-y-2">
            <SectionHeader id={`cloud-store-tier-${g.tierId}`} title={nameOf(g)} count={g.packages.length} />
            {g.models.length > 0 ? <p className="text-[12px] text-text-muted">{t(hours.printsOn, { models: g.models.join(' · ') })}</p> : null}
            <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {g.packages.map((p) => (
                <PackageCard key={p.id} pkg={p} group={g} variantOf={variantOf} />
              ))}
            </ul>
          </section>
        ))
      )}
    </div>
  );
}

// ------------------------------------------------------------------ filament and accessories

function ProductCard({ group, tab }: { group: ProductGroup; tab: Exclude<StoreTab, 'hours'> }) {
  const { t, lang } = useCloudText();
  const pack = cheapestPack(group.variants);
  const buyable = groupPurchasable(group);
  const colours = group.variants.map((v) => v.color_hex).filter((hex) => /^#[0-9A-Fa-f]{6}$/.test(hex));
  const sub = [group.brand, group.material, group.grade].filter(Boolean).join(' · ');
  const Fallback = tab === 'materials' ? Disc3 : Box;
  return (
    <li>
      <Link
        to={`/store/product/${encodeURIComponent(group.id)}`}
        onPointerEnter={() => warm(ProductPage)}
        onFocus={() => warm(ProductPage)}
        className="lv-surface flex h-full min-w-0 flex-col gap-2 p-3 no-press transition-colors hover:bg-surface-raised active:shadow-press focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
      >
        <span className="flex min-h-9 flex-wrap items-center gap-1">
          {colours.length > 0 ? (
            <>
              {colours.slice(0, 6).map((hex, i) => (
                <Swatch key={`${hex}-${i}`} hex={hex} />
              ))}
              {colours.length > 6 ? <span className="text-[11px] font-semibold text-text-muted">+{formatFigure(colours.length - 6, lang)}</span> : null}
            </>
          ) : (
            <span aria-hidden="true" className="grid h-9 w-9 place-items-center rounded-xl lv-well text-text-secondary">
              <Fallback className="h-4 w-4" />
            </span>
          )}
        </span>
        <span className="text-[14px] font-bold leading-snug text-text-primary">{tx(group.name, lang)}</span>
        {sub ? <span className="truncate text-[12px] text-text-muted">{sub}</span> : null}
        <span className="mt-auto text-[13px] font-semibold text-text-primary">
          {pack
            ? t(pack.from ? goods.fromPriceFor : goods.priceFor, { price: formatIqd(pack.price, lang), qty: formatQuantity(pack.qty, pack.unit, lang) })
            : t(goods.pricedByQuantity)}
        </span>
        {!buyable ? (
          <StatusChip tone="warning" className="self-start">
            {t(goods.outOfStock)}
          </StatusChip>
        ) : group.variants.length > 1 ? (
          <span className="text-[11px] text-text-muted">{t(colours.length > 0 ? goods.colours : goods.options, { n: formatFigure(group.variants.length, lang) })}</span>
        ) : null}
      </Link>
    </li>
  );
}

function GoodsTab({ tab, query, category, onCategory }: { tab: Exclude<StoreTab, 'hours'>; query: string; category: string | null; onCategory: (code: string | null) => void }) {
  const { t, lang } = useCloudText();
  const cats = useCloudQuery((signal) => listStoreCategories({ signal }), []);
  const products = useCloudQuery((signal) => listStoreProducts(undefined, { signal }), []);
  const [limit, setLimit] = useState(PAGE);
  useEffect(() => setLimit(PAGE), [query, category]);

  const error = cats.error ?? products.error;
  if (error) {
    return (
      <CloudErrorState
        error={error}
        onRetry={() => {
          if (cats.error) cats.reload();
          if (products.error) products.reload();
        }}
      />
    );
  }
  if (!cats.data || !products.data) return <CloudPageSkeleton />;

  const kinds = TAB_KINDS[tab];
  const own = cats.data.filter((c) => kinds.includes(c.kind)).sort((a, b) => a.sort - b.sort);
  const codes = new Set(own.map((c) => c.code));
  const groups = groupProducts(products.data.filter((p) => codes.has(p.category_code)));
  if (groups.length === 0) {
    const Icon = tab === 'materials' ? Disc3 : Box;
    return <CloudEmptyState icon={<Icon className="h-6 w-6" />} title={t(goods.noProductsTitle)} body={t(goods.noProductsBody)} />;
  }
  const present = own.filter((c) => groups.some((g) => g.category === c.code));
  const active = category && present.some((c) => c.code === category) ? category : null;
  const shown = groups.filter((g) => (!active || g.category === active) && matchesQuery(query, productFields(g)));

  return (
    <div className="space-y-4">
      {present.length > 1 ? (
        <ChipRow label={t(store.categories)}>
          <Chip on={!active} onClick={() => onCategory(null)}>
            {t(store.all)}
          </Chip>
          {present.map((c) => (
            <Chip key={c.code} on={active === c.code} onClick={() => onCategory(active === c.code ? null : c.code)}>
              {tx({ ar: c.name_ar, en: c.name_en, ckb: c.name_ckb }, lang) || c.code}
            </Chip>
          ))}
        </ChipRow>
      ) : null}
      {shown.length === 0 ? (
        <CloudEmptyState compact icon={<PackageSearch className="h-6 w-6" />} title={t(store.noMatchTitle)} body={t(store.noMatchBody)} />
      ) : (
        <>
          <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
            {shown.slice(0, limit).map((g) => (
              <ProductCard key={g.id} group={g} tab={tab} />
            ))}
          </ul>
          <MoreButton shown={Math.min(limit, shown.length)} total={shown.length} onMore={() => setLimit((n) => n + PAGE)} />
        </>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ the page

export default function Catalogue() {
  const { t } = useCloudText();
  const [params, setParams] = useSearchParams();
  const tab = storeTab(params.get('tab'));
  const [query, setQuery] = useState('');

  /** Change some of the address's filters, in place (no history entry per chip). */
  const setFilters = (patch: Record<string, string | null>) =>
    setParams(
      (current) => {
        const next = new URLSearchParams(current);
        for (const [key, value] of Object.entries(patch)) {
          if (value) next.set(key, value);
          else next.delete(key);
        }
        return next;
      },
      { replace: true }
    );

  return (
    <div className="space-y-4">
      <PageHeader title={t(store.title)} subtitle={t(store.subtitle)} actions={<StoreActions />} />
      <Segmented
        group="cloud-store-tab"
        label={t(store.tabsLabel)}
        value={tab}
        onChange={(id) => setFilters({ tab: id, tier: null, cat: null })}
        items={[
          { id: 'hours', label: t(store.tabHours) },
          { id: 'materials', label: t(store.tabMaterials) },
          { id: 'accessories', label: t(store.tabAccessories) },
        ]}
      />
      <SearchField value={query} onChange={setQuery} label={t(store.searchLabel)} placeholder={tab === 'hours' ? t(store.searchHours) : t(store.searchGoods)} />
      {tab === 'hours' ? (
        <HoursTab query={query} tier={params.get('tier')} onTier={(id) => setFilters({ tier: id })} />
      ) : (
        <GoodsTab key={tab} tab={tab} query={query} category={params.get('cat')} onCategory={(code) => setFilters({ cat: code })} />
      )}
    </div>
  );
}
