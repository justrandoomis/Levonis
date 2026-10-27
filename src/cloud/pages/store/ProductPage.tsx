/**
 * ONE PRODUCT (/store/product/:productId, or /store/variant/:variantId for a
 * link that names only a variant — a reorder suggestion; ?variant= and ?qty=
 * preselect).
 *
 * Its variants (colours, options), what the workshop has on the shelf now,
 * and a quantity in the variant's own rule — `min_purchase_qty`,
 * `purchase_step_qty`, `max_purchase_qty`, never above the sellable stock —
 * with the pack sizes as quick choices. THE PRICE IS ASKED, NEVER WORKED OUT:
 * once the quantity settles, POST /pricing/quote prices exactly that line
 * (a pack price, or the bracket rounded up, capped at the next pack — the
 * server's rules, pricing.ts) and the screen shows the answer with how it was
 * reached; signed in, the customer's own limits apply. The figure is today's
 * price, fixed only by a quote.
 *
 * Where it goes: kept at the workshop (the customer's own material, ready for
 * prints), or delivered while delivery is on — only what the variant offers.
 */
import { useState, type ReactNode } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { Button } from '../../../components/ui/Button';
import { Money } from '../../../components/ui/Money';
import { Segmented } from '../../../components/ui/Segmented';
import { Skeleton } from '../../../components/ui/Skeleton';
import { cloudErrorText, listStoreCategories, listStoreProducts, priceQuote } from '../../api';
import { useCloud } from '../../CloudContext';
import { formatIqd, formatNozzle, formatQuantity } from '../../format';
import { goods, store } from '../../strings/store';
import { tx, useCloudText } from '../../text';
import type { PricedLine, StoreProduct } from '../../types';
import { CloudEmptyState, CloudErrorState, CloudPageSkeleton, PackageSearch, PageHeader, ShoppingBag } from '../../ui';
import { useCloudQuery } from '../../useCloudQuery';
import { Chip, ChipRow, QuantityPicker, Swatch, useAddToCart, useDebounced } from './parts';
import { firstQuantity, packSizes, snapQuantity, storeModes, tabOfKind, variantRule, withStock } from './rules';

const HEX = /^#[0-9A-Fa-f]{6}$/;

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3 py-2">
      <dt className="text-[13px] text-text-muted">{label}</dt>
      <dd className="min-w-0 text-end text-[13px] font-semibold text-text-primary">{children}</dd>
    </div>
  );
}

/** How the server reached the price (its breakdown): a pack, a bracket rounded up, a cap at the next pack. */
function HowPriced({ line, unit }: { line: PricedLine; unit: string }) {
  const { t, lang } = useCloudText();
  const b = line.breakdown as { rule?: { type?: string; min_qty?: number; rounded_to_iqd?: number }; capped_by_pack_qty?: number | null };
  const notes: string[] = [];
  if (b.rule?.type === 'pack') notes.push(t(goods.packPrice));
  else if (b.rule?.type === 'bracket' && typeof b.rule.min_qty === 'number') {
    const min = formatQuantity(b.rule.min_qty, unit, lang);
    notes.push(b.rule.rounded_to_iqd ? t(goods.bracketPrice, { min, rounding: formatIqd(b.rule.rounded_to_iqd, lang) }) : t(goods.bracketPlain, { min }));
  }
  if (typeof b.capped_by_pack_qty === 'number') notes.push(t(goods.cappedAtPack, { pack: formatQuantity(b.capped_by_pack_qty, unit, lang) }));
  if (notes.length === 0) return null;
  return <p className="text-[12px] leading-relaxed text-text-muted">{notes.join(' · ')}</p>;
}

function ProductBody({ variants, variant, askedQty, onVariant }: { variants: StoreProduct[]; variant: StoreProduct; askedQty: string | null; onVariant: (id: string) => void }) {
  const { t, lang } = useCloudText();
  const { status, signedIn } = useCloud();
  const add = useAddToCart();
  const own = variantRule(variant);
  const rule = withStock(own, variant.sellable_qty);
  const first = firstQuantity(rule);
  // A link's ?qty= is moved to the nearest quantity the server accepts, and the picker says so.
  const [asked] = useState<number | null>(() => {
    const n = askedQty ? Number(askedQty) : Number.NaN;
    return Number.isFinite(n) ? n : null;
  });
  const [qty, setQty] = useState<number | null>(() => (asked !== null ? snapQuantity(asked, rule) : first));
  const modes = storeModes(variant, status?.delivery.enabled === true);
  const [mode, setMode] = useState<'inventory' | 'delivery' | null>(modes[0] ?? null);
  const settledQty = useDebounced(qty, 300);
  const price = useCloudQuery(
    (signal) =>
      settledQty !== null && mode
        ? priceQuote({ lines: [{ kind: 'material', variant_id: variant.id, quantity: settledQty, fulfillment: mode }] }, { signal })
        : Promise.resolve(null),
    [variant.id, settledQty, mode]
  );
  // A price for another quantity than the one on screen is never shown.
  const pending = settledQty !== qty || price.loading;
  const line = !pending ? (price.data?.lines[0] ?? null) : null;
  const packs = packSizes(variant.price_tiers, rule);
  const colourful = variants.some((v) => HEX.test(v.color_hex));
  const unit = variant.unit_code;
  const stockCaps = variant.sellable_qty < own.max;
  const outOfShelf = line?.stock?.available === false;
  // A quantity the server refused to price (a limit reached, no price for it) is not added: its quote would be refused too.
  const refused = !pending && !!price.error;
  const sellsHere = modes.length > 0 && first !== null;

  return (
    <div className="grid gap-3 md:grid-cols-2">
      <div className="space-y-3">
        <section className="lv-surface p-4" aria-labelledby="cloud-product-facts">
          <div className="flex items-center gap-3">
            {HEX.test(variant.color_hex) ? <Swatch hex={variant.color_hex} size="lg" /> : null}
            <h2 id="cloud-product-facts" className="min-w-0 text-[15px] font-bold text-text-primary">
              {tx(variant.name, lang) || variant.color_name || variant.sku}
            </h2>
          </div>
          {variants.length > 1 ? (
            <div className="mt-3 space-y-1">
              <p className="text-[12px] font-semibold text-text-secondary">{t(colourful ? goods.colour : goods.option)}</p>
              <ChipRow inset label={t(colourful ? goods.colour : goods.option)}>
                {variants.map((v) => (
                  <Chip key={v.id} on={v.id === variant.id} onClick={() => onVariant(v.id)} leading={<Swatch hex={v.color_hex} size="sm" />}>
                    {tx(v.name, lang) || v.color_name || v.sku}
                  </Chip>
                ))}
              </ChipRow>
            </div>
          ) : null}
          <dl className="mt-2 divide-y divide-border-subtle">
            <Fact label={t(goods.sku)}>
              <bdi dir="ltr">{variant.sku}</bdi>
            </Fact>
            {variant.diameter_um ? <Fact label={t(goods.diameter)}>{formatNozzle(variant.diameter_um, lang)}</Fact> : null}
            <Fact label={t(goods.stock)}>{variant.sellable_qty > 0 ? formatQuantity(variant.sellable_qty, unit, lang) : t(goods.outOfStock)}</Fact>
          </dl>
        </section>
      </div>

      <div className="space-y-3">
        {!sellsHere ? (
          <CloudEmptyState
            compact
            icon={<PackageSearch className="h-6 w-6" />}
            title={t(goods.notPurchasableTitle)}
            body={
              first === null
                ? t(goods.notPurchasableBody)
                : variant.fulfillment_modes.includes('delivery') && !variant.fulfillment_modes.includes('inventory')
                  ? t(goods.deliveryOff)
                  : t(goods.notPurchasableBody)
            }
          />
        ) : (
          <section className="lv-surface space-y-4 p-4" aria-labelledby="cloud-product-buy">
            <h2 id="cloud-product-buy" className="text-[15px] font-bold text-text-primary">
              {t(goods.quantity)}
            </h2>
            {qty !== null ? <QuantityPicker value={qty} rule={rule} unit={unit} onChange={setQty} label={t(goods.quantity)} asked={asked} /> : null}
            {packs.length > 1 ? (
              <ChipRow inset label={t(goods.packs)}>
                {packs.map((size) => (
                  <Chip key={size} on={qty === size} onClick={() => setQty(size)}>
                    {formatQuantity(size, unit, lang)}
                  </Chip>
                ))}
              </ChipRow>
            ) : null}
            {stockCaps ? <p className="text-[12px] text-text-muted">{t(goods.stockShort, { qty: formatQuantity(variant.sellable_qty, unit, lang) })}</p> : null}
            {variant.max_per_customer_qty != null ? <p className="text-[12px] text-text-muted">{t(goods.limitNote, { qty: formatQuantity(variant.max_per_customer_qty, unit, lang) })}</p> : null}

            {modes.length > 1 ? (
              <div className="space-y-1.5">
                <p className="text-[12px] font-semibold text-text-secondary">{t(goods.whereTo)}</p>
                <Segmented
                  group="cloud-product-mode"
                  label={t(goods.whereTo)}
                  value={mode ?? 'inventory'}
                  onChange={(id) => setMode(id === 'delivery' ? 'delivery' : 'inventory')}
                  items={[
                    { id: 'inventory', label: t(goods.keep) },
                    { id: 'delivery', label: t(goods.deliver) },
                  ]}
                />
              </div>
            ) : null}
            <p className="text-[12px] leading-relaxed text-text-muted">{mode === 'delivery' ? t(goods.deliverNote) : t(goods.keepNote)}</p>

            <div aria-live="polite" aria-busy={pending || undefined} className="space-y-1 rounded-xl lv-well p-3">
              <p className="text-[12px] font-semibold text-text-secondary">{t(goods.priceTitle)}</p>
              {price.error && !pending ? (
                <p role="alert" className="text-[13px] font-medium text-danger">
                  {cloudErrorText(price.error, lang)}
                </p>
              ) : line ? (
                <>
                  <p className="text-ui-xl font-bold text-text-primary">
                    <Money iqd={line.final_price_iqd} />
                  </p>
                  {line.discount_iqd > 0 ? (
                    <p className="text-[12px] text-text-muted">
                      {t(goods.beforeDiscount)} <Money iqd={line.base_price_iqd} /> · {t(goods.discount)} <Money iqd={-line.discount_iqd} />
                    </p>
                  ) : null}
                  <HowPriced line={line} unit={unit} />
                  {outOfShelf ? <p className="text-[13px] font-semibold text-warning">{t(goods.notEnoughStock)}</p> : null}
                </>
              ) : (
                <div>
                  <Skeleton className="h-7 w-32 rounded-md" />
                  <span className="sr-only">{t(goods.askingPrice)}</span>
                </div>
              )}
              <p className="pt-1 text-[12px] leading-relaxed text-text-muted">{t(goods.priceNote)}</p>
            </div>

            <Button
              variant="primary"
              block
              icon={<ShoppingBag aria-hidden="true" className="h-4 w-4" />}
              disabled={signedIn && (qty === null || !mode || outOfShelf || refused)}
              onClick={() => {
                if (signedIn && (qty === null || !mode)) return;
                add({
                  kind: 'material',
                  ref: variant.id,
                  quantity: qty ?? first ?? 0,
                  fulfillment: mode ?? 'inventory',
                  rule,
                  label: { name: variant.product_name, detail: variant.name, unit, color: HEX.test(variant.color_hex) ? variant.color_hex : null, seconds: null },
                });
              }}
            >
              {signedIn ? t(store.addToCart) : t(store.signInToBuy)}
            </Button>
          </section>
        )}
      </div>
    </div>
  );
}

export default function ProductPage() {
  const { productId, variantId } = useParams();
  const [params, setParams] = useSearchParams();
  const { t, lang } = useCloudText();
  const products = useCloudQuery((signal) => listStoreProducts(undefined, { signal }), []);
  // Only to send «back» to the right tab: the page works without it.
  const cats = useCloudQuery((signal) => listStoreCategories({ signal }), []);

  if (products.error) {
    return (
      <div>
        <PageHeader title={t(store.title)} back={{ to: '/store', label: t(store.title) }} />
        <CloudErrorState error={products.error} onRetry={products.reload} />
      </div>
    );
  }
  if (!products.data) return <CloudPageSkeleton />;

  const rows = products.data;
  const productOf = variantId ? (rows.find((v) => v.id === variantId)?.product_id ?? null) : (productId ?? null);
  const variants = productOf ? rows.filter((v) => v.product_id === productOf) : [];
  if (variants.length === 0) {
    return (
      <div>
        <PageHeader title={t(goods.notFoundTitle)} back={{ to: '/store', label: t(store.title) }} />
        <CloudEmptyState icon={<PackageSearch className="h-6 w-6" />} title={t(goods.notFoundTitle)} body={t(goods.notFoundBody)} />
      </div>
    );
  }
  const wanted = params.get('variant') ?? variantId ?? null;
  const variant =
    variants.find((v) => v.id === wanted) ?? variants.find((v) => firstQuantity(withStock(variantRule(v), v.sellable_qty)) !== null) ?? variants[0];
  const kind = cats.data?.find((c) => c.code === variant.category_code)?.kind;
  const back = { to: kind ? `/store?tab=${tabOfKind(kind)}` : '/store', label: t(store.title) };
  const sub = [variant.brand, variant.material, variant.grade].filter(Boolean).join(' · ');

  return (
    <div>
      <PageHeader back={back} title={tx(variant.product_name, lang)} subtitle={sub || undefined} />
      <ProductBody
        key={variant.id}
        variants={variants}
        variant={variant}
        askedQty={variant.id === wanted ? params.get('qty') : null}
        onVariant={(id) =>
          setParams(
            (current) => {
              const next = new URLSearchParams(current);
              next.set('variant', id);
              next.delete('qty');
              return next;
            },
            { replace: true }
          )
        }
      />
    </div>
  );
}
