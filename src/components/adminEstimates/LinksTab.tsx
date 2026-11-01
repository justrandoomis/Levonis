/**
 * «روابط المورّد» — THE OWNER'S SUPPLIER LINKS (docs/SMART_PRICING.md §3.9;
 * the owner's request of 2026-10-31: "for tmall saved id of every product and
 * link for admin so here can easily found the product by tap on link to order
 * it or update the price").
 *
 * Every product with a confirmed or suggested supplier match, or with the
 * owner's own price, 25 a page (`GET /supplier-prices/links?q=&source=&cursor=`):
 * per SKU, the source, the Tmall item id with its copy button, «افتح في Tmall»
 * and «افتح هذا الخيار» (the exact option), the EU store's product and variant
 * links (always with `skr=yes`, built by the server), the captured price with
 * its currency, label and date, and «تحديث السعر» — manual entry, or the
 * one-page store read prefilled with that link (UpdatePriceSheet).
 *
 * The search takes what the owner has in hand: a product name, a Tmall URL or
 * item id, a store URL or handle, an option id, a colour or part code. A
 * product opened from its form (`?product=`) is read alone
 * (`GET /supplier-prices/links/:product_id`).
 */
import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { Link2, Search, X } from 'lucide-react';
import { Button } from '../ui/Button';
import { Field, Input } from '../ui/Field';
import { Segmented } from '../ui/Segmented';
import { Skeleton } from '../ui/Skeleton';
import { fetchLinks, fetchProductLinks, productEditorHref, SUPPLIER_SOURCES, type LinksPage, type LinkSku, type ProductLinks, type SupplierSource } from './api';
import { Failure, Pager, SupplierLinkRow, skuName, useCursorPages, useUiLang } from './parts';
import UpdatePriceSheet, { type PriceTarget } from './UpdatePriceSheet';
import { COMMON, LINKS, REVIEW, SOURCE_LABELS, say, type UiLang } from './strings';
import { nameIn } from './format';

type SourceFilter = '' | SupplierSource;

export default function LinksTab({ focusProduct, onClearFocus }: { focusProduct: string | null; onClearFocus: () => void }) {
  const { lang } = useUiLang();
  const [draft, setDraft] = useState('');
  const [q, setQ] = useState('');
  const [source, setSource] = useState<SourceFilter>('');
  const pages = useCursorPages(`${q}\u0000${source}\u0000${focusProduct ?? ''}`);
  const [data, setData] = useState<LinksPage | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [reload, setReload] = useState(0);
  const [target, setTarget] = useState<PriceTarget | null>(null);

  useEffect(() => {
    const ac = new AbortController();
    setData(null);
    setError(null);
    const read = focusProduct
      ? fetchProductLinks(focusProduct, { signal: ac.signal, mascot: 'silent' }).then((a): LinksPage => ({ products: a.products, next_cursor: null }))
      : fetchLinks({ q, source, cursor: pages.cursor }, { signal: ac.signal, mascot: 'silent' });
    read
      .then((page) => {
        if (!ac.signal.aborted) setData(page);
      })
      .catch((e) => {
        if (!ac.signal.aborted) setError(e);
      });
    return () => ac.abort();
  }, [focusProduct, q, source, pages.cursor, reload]);

  /** After «تحديث السعر»: the product read again, in place. */
  const refreshProduct = useCallback((productId: string) => {
    fetchProductLinks(productId, { mascot: 'silent' })
      .then((a) => {
        const fresh = a.products[0] ?? null;
        setData((d) => (d ? { ...d, products: d.products.flatMap((p) => (p.product_id === productId ? (fresh ? [fresh] : []) : [p])) } : d));
        setTarget((t) => (t && t.product.product_id === productId && fresh ? { ...t, product: fresh } : t));
      })
      .catch(() => setReload((n) => n + 1));
  }, []);

  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    if (focusProduct) onClearFocus();
    setQ(draft.trim());
  };

  const sources = useMemo(
    () => [{ id: 'all', label: say(LINKS.allSources, lang) }, ...SUPPLIER_SOURCES.map((s) => ({ id: s, label: say(SOURCE_LABELS[s], lang) }))],
    [lang]
  );

  return (
    <section className="space-y-4" data-estimates-links>
      <p className="max-w-[72ch] text-[13px] leading-relaxed text-text-secondary">{say(LINKS.intro, lang)}</p>

      <form onSubmit={submit} className="space-y-3" role="search" aria-label={say(LINKS.searchLabel, lang)}>
        <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-end">
          <Field label={say(LINKS.searchLabel, lang)} className="min-w-0 flex-1">
            <Input
              type="search"
              dir="auto"
              autoComplete="off"
              maxLength={300}
              placeholder={say(LINKS.searchPlaceholder, lang)}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              data-links-search
            />
          </Field>
          <div className="flex gap-2">
            <Button type="submit" variant="primary" icon={<Search aria-hidden="true" className="h-4 w-4" />} data-links-search-submit>
              {say(LINKS.search, lang)}
            </Button>
            {q ? (
              <Button
                type="button"
                variant="ghost"
                icon={<X aria-hidden="true" className="h-4 w-4" />}
                onClick={() => {
                  setDraft('');
                  setQ('');
                }}
              >
                {say(LINKS.clear, lang)}
              </Button>
            ) : null}
          </div>
        </div>
        <Segmented group="estimate-links-source" label={say(LINKS.sourceFilter, lang)} value={source || 'all'} onChange={(v) => setSource(v === 'all' ? '' : (v as SourceFilter))} items={sources} size="sm" dataAttr="data-links-source" />
      </form>

      {focusProduct ? (
        <div className="flex flex-wrap items-center gap-2 text-[13px] text-text-secondary" data-links-focus={focusProduct}>
          <span>{say(REVIEW.focus, lang)}</span>
          <Button size="sm" variant="ghost" onClick={onClearFocus}>
            {say(REVIEW.showAll, lang)}
          </Button>
        </div>
      ) : null}

      {error ? (
        <Failure error={error} lang={lang} onRetry={() => setReload((n) => n + 1)} />
      ) : !data ? (
        <div className="space-y-2" aria-busy="true">
          <Skeleton className="h-28 w-full" />
          <Skeleton className="h-28 w-full" />
        </div>
      ) : data.products.length === 0 ? (
        <p className="lv-surface p-4 text-[14px] text-text-secondary" data-links-empty>
          {say(q || focusProduct ? LINKS.emptySearch : LINKS.empty, lang)}
        </p>
      ) : (
        <>
          <p className="text-[12px] text-text-muted">{say(LINKS.productCount, lang, { n: data.products.length })}</p>
          <ul className="space-y-3">
            {data.products.map((p) => (
              <ProductLinksCard key={p.product_id} product={p} lang={lang} onUpdate={(sku, link) => setTarget({ product: p, comboKey: sku.combo_key, link })} />
            ))}
          </ul>
          <Pager lang={lang} page={pages.page} hasPrev={pages.hasPrev} nextCursor={data.next_cursor} onPrev={pages.prev} onNext={() => pages.next(data.next_cursor)} />
        </>
      )}

      <UpdatePriceSheet target={target} onClose={() => setTarget(null)} onSaved={refreshProduct} />
    </section>
  );
}

/** One product: its name, its editor, and per SKU every supplier fact with its links and «تحديث السعر». */
export function ProductLinksCard({
  product,
  lang,
  onUpdate,
}: {
  product: ProductLinks;
  lang: UiLang;
  onUpdate: (sku: LinkSku, link: LinkSku['supplier_prices'][number] | null) => void;
}) {
  const editor = productEditorHref(product.product_id);
  const name = nameIn(product.names, lang, product.name);
  return (
    <li className="lv-surface min-w-0 space-y-3 p-3 sm:p-4" data-links-product={product.product_id}>
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
        <h3 dir="auto" className="min-w-0 break-words text-[15px] font-bold leading-snug text-text-primary">
          <Link2 aria-hidden="true" className="me-1.5 inline h-4 w-4 text-text-muted" />
          {name}
        </h3>
        {editor ? (
          <a href={editor} className="inline-flex min-h-11 items-center px-1 text-[13px] font-bold text-text-primary underline underline-offset-2" data-links-open-product>
            {say(COMMON.openProduct, lang)}
          </a>
        ) : null}
      </div>
      <div className="space-y-3">
        {product.skus.map((sku) => (
          <div key={sku.combo_key || '_'} className="min-w-0 rounded-xl bg-surface-raised p-3" data-links-sku={sku.combo_key}>
            <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
              <p dir="auto" className="min-w-0 break-words text-[13px] font-bold text-text-primary">
                {skuName(sku, lang)}
              </p>
              {!sku.supplier_prices.length ? (
                <Button size="sm" variant="ghost" onClick={() => onUpdate(sku, null)} data-links-update={sku.combo_key}>
                  {say(LINKS.updatePrice, lang)}
                </Button>
              ) : null}
            </div>
            {sku.supplier_prices.length ? (
              <ul className="mt-1">
                {sku.supplier_prices.map((link, i) => (
                  <SupplierLinkRow
                    key={`${link.source}-${link.item_key ?? 'manual'}-${link.sku_key ?? ''}-${i}`}
                    link={link}
                    lang={lang}
                    actions={
                      <Button size="sm" variant="secondary" onClick={() => onUpdate(sku, link)} data-links-update={sku.combo_key}>
                        {say(LINKS.updatePrice, lang)}
                      </Button>
                    }
                  />
                ))}
              </ul>
            ) : (
              <p className="mt-1 text-[12px] text-text-muted">{say(LINKS.noLinkForSku, lang)}</p>
            )}
          </div>
        ))}
      </div>
    </li>
  );
}
