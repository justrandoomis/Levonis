/**
 * «المراجعة» — THE OWNER REVIEWS THE MATCHES (docs/SMART_PRICING.md §3.5,
 * §3.6, §3.8, §7).
 *
 *   - the lists: suggested, auto-confirmed (for his audit), rejected, and
 *     confirmed keys gone from the newest capture (`GET /supplier-prices/
 *     matches?state=`), 25 products a page — or one product, opened from its
 *     form (`GET /supplier-prices/links/:product_id`);
 *   - the per-SKU mapping grid: every Levonis option with its candidate items
 *     and SKUs, each with its link and id beside its price (§3.9), confirmed,
 *     re-pointed or rejected (`PUT /supplier-prices/matches/:product_id`,
 *     fenced on the token the view carried). Only the owner divides a pack
 *     price («القطع في العرض», EST_UNITS_DIVIDED);
 *   - bulk accept of the `high` and `medium` suggestions of a product;
 *   - the lookup by URL, id, code or words (`GET /supplier-prices/lookup`), its
 *     SKUs mapped onto the product's options;
 *   - «تحديث السعر»: manual entry and the one-page store read (UpdatePriceSheet);
 *   - the product's type, sourcing and route overrides (`PUT /estimates/
 *     products/:id`) and «احسب من جديد» (`POST /estimates/compute`).
 * Nothing here publishes a price: matching only feeds a preview (§3.5).
 */
import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { Search } from 'lucide-react';
import { Button } from '../ui/Button';
import { Field, Input, Select } from '../ui/Field';
import { Segmented } from '../ui/Segmented';
import { Skeleton } from '../ui/Skeleton';
import {
  ESTIMATE_ROUTES,
  ESTIMATE_SOURCINGS,
  REVIEW_STATES,
  computeEstimates,
  decideMatches,
  fetchEstimate,
  fetchMatches,
  fetchProductLinks,
  fetchTypes,
  lookupSupplier,
  productEditorHref,
  runMatchPage,
  setEstimateProduct,
  type EstimatePreview,
  type EstimateRoute,
  type EstimateSourcing,
  type EstimateType,
  type LinkSku,
  type LookupItem,
  type MatchDecisionBody,
  type MatchesPage,
  type ProductLinks,
  type ReviewState,
  type StoredEstimate,
  type SupplierLink,
  type SupplierSource,
} from './api';
import { wholeNumber } from './input';
import { ActNote, CopyButton, Failure, FlagList, Ltr, Pager, SourceChip, SupplierAnchor, SupplierLinkRow, errorCode, openItemText, skuName, useAct, useCursorPages, useUiLang } from './parts';
import UpdatePriceSheet, { type PriceTarget } from './UpdatePriceSheet';
import { COMMON, ESTIMATE_STATE_LABELS, LINKS, LOOKUP, REVIEW, ROUTE_LABELS, SNAPSHOTS, SOURCING_LABELS, say, type UiLang } from './strings';
import { dayOf, moneyText, nameIn, optionsLine } from './format';

const isStore = (s: string): s is SupplierSource => s === 'tmall_cn' || s === 'bambu_eu' || s === 'bambu_us';

/** The high and medium suggestions of a product that one press accepts: one per option and source, none where that source is already confirmed. */
export function bulkAcceptable(product: ProductLinks): MatchDecisionBody[] {
  const out: MatchDecisionBody[] = [];
  for (const sku of product.skus) {
    const bySource = new Map<string, SupplierLink[]>();
    for (const l of sku.supplier_prices) {
      if (!isStore(l.source) || !l.item_key || !l.sku_key) continue;
      if (!bySource.has(l.source)) bySource.set(l.source, []);
      bySource.get(l.source)!.push(l);
    }
    for (const [source, links] of bySource) {
      if (links.some((l) => l.state === 'confirmed' || l.state === 'auto')) continue;
      const suggestions = links.filter((l) => l.state === 'suggested');
      if (suggestions.length !== 1) continue;
      const s = suggestions[0]!;
      if (s.match_confidence !== 'high' && s.match_confidence !== 'medium') continue;
      out.push({ combo_key: sku.combo_key, source: source as SupplierSource, item_key: s.item_key!, sku_key: s.sku_key! });
    }
  }
  return out;
}

export default function ReviewTab({ focusProduct, onClearFocus }: { focusProduct: string | null; onClearFocus: () => void }) {
  const { lang } = useUiLang();
  const [state, setState] = useState<ReviewState>('suggested');
  const pages = useCursorPages(`${state}\u0000${focusProduct ?? ''}`);
  const [data, setData] = useState<MatchesPage | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [reload, setReload] = useState(0);
  const [types, setTypes] = useState<EstimateType[]>([]);
  const [target, setTarget] = useState<PriceTarget | null>(null);
  const [lookupOpen, setLookupOpen] = useState(false);

  useEffect(() => {
    const ac = new AbortController();
    fetchTypes({ signal: ac.signal, mascot: 'silent' })
      .then((a) => {
        if (!ac.signal.aborted) setTypes(a.types);
      })
      .catch(() => undefined);
    return () => ac.abort();
  }, []);

  useEffect(() => {
    const ac = new AbortController();
    setData(null);
    setError(null);
    const read = focusProduct
      ? fetchProductLinks(focusProduct, { signal: ac.signal, mascot: 'silent' }).then(
          (a): MatchesPage => ({ state, products: a.products.length ? a.products : [], next_cursor: null })
        )
      : fetchMatches(state, pages.cursor, { signal: ac.signal, mascot: 'silent' });
    read
      .then((page) => {
        if (!ac.signal.aborted) setData(page);
      })
      .catch((e) => {
        if (!ac.signal.aborted) setError(e);
      });
    return () => ac.abort();
  }, [state, focusProduct, pages.cursor, reload]);

  const replace = useCallback((productId: string, view: ProductLinks | null) => {
    setData((d) => (d ? { ...d, products: d.products.map((p) => (p.product_id === productId && view ? view : p)) } : d));
  }, []);

  const refreshProduct = useCallback(
    (productId: string) => {
      fetchProductLinks(productId, { mascot: 'silent' })
        .then((a) => {
          if (a.products[0]) replace(productId, a.products[0]);
          setTarget((t) => (t && t.product.product_id === productId && a.products[0] ? { ...t, product: a.products[0] } : t));
        })
        .catch(() => setReload((n) => n + 1));
    },
    [replace]
  );

  const filters = useMemo(() => REVIEW_STATES.map((s) => ({ id: s, label: say(REVIEW.filters[s], lang) })), [lang]);

  return (
    <section className="space-y-4" data-estimates-review>
      <p className="max-w-[72ch] text-[13px] leading-relaxed text-text-secondary">{say(REVIEW.intro, lang)}</p>
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        {focusProduct ? (
          <>
            <span className="text-[13px] font-semibold text-text-secondary" data-review-focus={focusProduct}>
              {say(REVIEW.focus, lang)}
            </span>
            <Button size="sm" variant="ghost" onClick={onClearFocus}>
              {say(REVIEW.showAll, lang)}
            </Button>
          </>
        ) : (
          <Segmented group="estimate-review-state" label={say(REVIEW.filterLabel, lang)} value={state} onChange={(v) => setState(v as ReviewState)} items={filters} size="sm" dataAttr="data-review-state" />
        )}
        <Button size="sm" variant="secondary" icon={<Search aria-hidden="true" className="h-4 w-4" />} aria-expanded={lookupOpen} onClick={() => setLookupOpen((o) => !o)} data-review-lookup-toggle>
          {say(REVIEW.findInCatalogue, lang)}
        </Button>
      </div>

      {lookupOpen ? <CatalogueLookup lang={lang} /> : null}

      {error ? (
        <Failure error={error} lang={lang} onRetry={() => setReload((n) => n + 1)} />
      ) : !data ? (
        <div className="space-y-2" aria-busy="true">
          <Skeleton className="h-32 w-full" />
          <Skeleton className="h-32 w-full" />
        </div>
      ) : data.products.length === 0 ? (
        focusProduct ? (
          <FocusWithoutLinks productId={focusProduct} lang={lang} onMatched={() => setReload((n) => n + 1)} />
        ) : (
          <p className="lv-surface p-4 text-[14px] text-text-secondary" data-review-empty>
            {say(REVIEW.empty, lang)}
          </p>
        )
      ) : (
        <>
          <ul className="space-y-3">
            {data.products.map((p) => (
              <ReviewProductCard
                key={p.product_id}
                product={p}
                types={types}
                lang={lang}
                onChanged={(view) => (view ? replace(p.product_id, view) : refreshProduct(p.product_id))}
                onStale={() => refreshProduct(p.product_id)}
                onPrice={(sku, link) => setTarget({ product: p, comboKey: sku.combo_key, link })}
              />
            ))}
          </ul>
          <Pager lang={lang} page={pages.page} hasPrev={pages.hasPrev} nextCursor={data.next_cursor} onPrev={pages.prev} onNext={() => pages.next(data.next_cursor)} />
        </>
      )}

      <UpdatePriceSheet target={target} onClose={() => setTarget(null)} onSaved={refreshProduct} />
    </section>
  );
}

/** One product of the review: its options, each with its candidates and acts. */
export function ReviewProductCard({
  product,
  types,
  lang,
  onChanged,
  onStale,
  onPrice,
}: {
  product: ProductLinks;
  types: readonly EstimateType[];
  lang: UiLang;
  onChanged: (view: ProductLinks | null) => void;
  onStale: () => void;
  onPrice: (sku: LinkSku, link: SupplierLink | null) => void;
}) {
  const act = useAct(lang, onStale);
  const [units, setUnits] = useState<Record<string, string>>({});
  const [unitsError, setUnitsError] = useState<string | null>(null);
  const [panel, setPanel] = useState<'none' | 'settings' | 'lookup'>('none');
  const [preview, setPreview] = useState<EstimatePreview | null>(null);
  const bulk = useMemo(() => bulkAcceptable(product), [product]);
  const editor = productEditorHref(product.product_id);

  const decide = (key: string, skus: MatchDecisionBody[], done: string) =>
    act.run(key, () => decideMatches(product.product_id, { version: product.versions.matches, skus }), (a) => {
      onChanged(a.product);
      return { tone: 'success', text: done };
    });

  const confirm = (sku: LinkSku, link: SupplierLink) => {
    if (!isStore(link.source) || !link.item_key || !link.sku_key) return;
    const rowKey = `${sku.combo_key}|${link.source}|${link.item_key}|${link.sku_key}`;
    const raw = units[rowKey] ?? '';
    const n = raw.trim() === '' ? 1 : wholeNumber(raw, 1, 1000);
    if (n === null || n === '') {
      setUnitsError(rowKey);
      return;
    }
    setUnitsError(null);
    // One unit is the server's default: `units_per_offer` travels only when the owner divides a pack.
    const decision: MatchDecisionBody = { combo_key: sku.combo_key, source: link.source, item_key: link.item_key, sku_key: link.sku_key, ...(n > 1 ? { units_per_offer: n } : {}) };
    void decide(`confirm:${rowKey}`, [decision], say(REVIEW.confirmed, lang));
  };

  const reject = (sku: LinkSku, link: SupplierLink) => {
    if (!isStore(link.source) || !link.item_key) return;
    void decide(`reject:${sku.combo_key}|${link.source}|${link.item_key}|${link.sku_key ?? ''}`, [{ combo_key: sku.combo_key, source: link.source, item_key: link.item_key, sku_key: null }], say(REVIEW.rejectedDone, lang));
  };

  const compute = () =>
    act.run('compute', () => computeEstimates({ product_ids: [product.product_id] }), (a) => {
      setPreview(a.products[0] ?? null);
      return { tone: 'success', text: say(REVIEW.computed, lang) };
    });

  return (
    <li className="lv-surface min-w-0 space-y-3 p-3 sm:p-4" data-review-product={product.product_id}>
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
        <h3 dir="auto" className="min-w-0 break-words text-[15px] font-bold leading-snug text-text-primary">
          {nameIn(product.names, lang, product.name)}
        </h3>
        {editor ? (
          <a href={editor} className="inline-flex min-h-11 items-center px-1 text-[13px] font-bold text-text-primary underline underline-offset-2">
            {say(COMMON.openProduct, lang)}
          </a>
        ) : null}
      </div>
      <div className="flex flex-wrap gap-2">
        {bulk.length ? (
          <Button size="sm" variant="primary" loading={act.busy === 'bulk'} disabled={!!act.busy && act.busy !== 'bulk'} onClick={() => decide('bulk', bulk, say(REVIEW.acceptedAll, lang, { n: bulk.length }))} data-review-bulk={bulk.length}>
            {say(REVIEW.acceptAll, lang, { n: bulk.length })}
          </Button>
        ) : null}
        <Button size="sm" variant="secondary" aria-expanded={panel === 'lookup'} onClick={() => setPanel((p) => (p === 'lookup' ? 'none' : 'lookup'))}>
          {say(REVIEW.findInCatalogue, lang)}
        </Button>
        <Button size="sm" variant="secondary" aria-expanded={panel === 'settings'} onClick={() => setPanel((p) => (p === 'settings' ? 'none' : 'settings'))} data-review-settings-toggle>
          {say(REVIEW.settings, lang)}
        </Button>
        <Button size="sm" variant="ghost" loading={act.busy === 'compute'} disabled={!!act.busy && act.busy !== 'compute'} onClick={compute} data-review-compute>
          {say(REVIEW.computeAgain, lang)}
        </Button>
      </div>
      <ActNote message={act.message} lang={lang} />
      {preview ? <PreviewSummary preview={preview} lang={lang} /> : null}
      {panel === 'settings' ? <ProductSettings productId={product.product_id} types={types} lang={lang} /> : null}
      {panel === 'lookup' ? <CatalogueLookup lang={lang} target={product} onMapped={onChanged} onStale={onStale} /> : null}

      <div className="space-y-3">
        {product.skus.map((sku) => (
          <div key={sku.combo_key || '_'} className="min-w-0 rounded-xl bg-surface-raised p-3" data-review-sku={sku.combo_key}>
            <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
              <p dir="auto" className="min-w-0 break-words text-[13px] font-bold text-text-primary">
                {skuName(sku, lang)}
              </p>
              <Button size="sm" variant="ghost" onClick={() => onPrice(sku, sku.supplier_prices.find((l) => isStore(l.source)) ?? null)} data-review-price={sku.combo_key}>
                {say(REVIEW.typePrice, lang)}
              </Button>
            </div>
            {sku.supplier_prices.length ? (
              <ul className="mt-1">
                {sku.supplier_prices.map((link, i) => {
                  const rowKey = `${sku.combo_key}|${link.source}|${link.item_key ?? ''}|${link.sku_key ?? ''}`;
                  const store = isStore(link.source);
                  return (
                    <SupplierLinkRow
                      key={`${rowKey}-${i}`}
                      link={link}
                      lang={lang}
                      actions={
                        store ? (
                          <>
                            {link.sku_key ? (
                              <span className="inline-flex items-center gap-1.5">
                                <label className="text-[12px] text-text-muted" htmlFor={`units-${product.product_id}-${i}-${sku.combo_key}`}>
                                  {say(REVIEW.units, lang)}
                                </label>
                                <Input
                                  id={`units-${product.product_id}-${i}-${sku.combo_key}`}
                                  ltr
                                  inputMode="numeric"
                                  className="w-20"
                                  placeholder="1"
                                  aria-invalid={unitsError === rowKey || undefined}
                                  title={say(REVIEW.unitsHint, lang)}
                                  value={units[rowKey] ?? ''}
                                  onChange={(e) => setUnits((u) => ({ ...u, [rowKey]: e.target.value }))}
                                />
                              </span>
                            ) : null}
                            {link.sku_key ? (
                              <Button size="sm" variant={link.state === 'suggested' ? 'primary' : 'secondary'} loading={act.busy === `confirm:${rowKey}`} disabled={!!act.busy && act.busy !== `confirm:${rowKey}`} onClick={() => confirm(sku, link)} data-review-confirm={rowKey}>
                                {say(REVIEW.confirm, lang)}
                              </Button>
                            ) : null}
                            {link.state !== 'rejected' ? (
                              <Button size="sm" variant="ghost" loading={act.busy === `reject:${rowKey}`} disabled={!!act.busy && act.busy !== `reject:${rowKey}`} onClick={() => reject(sku, link)} data-review-reject={rowKey}>
                                {say(REVIEW.reject, lang)}
                              </Button>
                            ) : null}
                            <Button size="sm" variant="ghost" onClick={() => onPrice(sku, link)}>
                              {say(LINKS.updatePrice, lang)}
                            </Button>
                            {unitsError === rowKey ? <span className="text-[12px] text-danger">{say(REVIEW.unitsInvalid, lang)}</span> : null}
                          </>
                        ) : (
                          <Button size="sm" variant="ghost" onClick={() => onPrice(sku, link)}>
                            {say(LINKS.updatePrice, lang)}
                          </Button>
                        )
                      }
                    />
                  );
                })}
              </ul>
            ) : (
              <p className="mt-1 text-[12px] text-text-muted">{say(REVIEW.noCandidates, lang)}</p>
            )}
          </div>
        ))}
      </div>
    </li>
  );
}

/**
 * A product opened from its form that has no supplier fact yet (the links read
 * answers an empty list, §3.9): the matcher is run on it alone
 * (`POST /supplier-prices/match {product_ids}`), and the lookup finds its item.
 */
export function FocusWithoutLinks({ productId, lang, onMatched }: { productId: string; lang: UiLang; onMatched: () => void }) {
  const act = useAct(lang);
  const editor = productEditorHref(productId);
  return (
    <div className="lv-surface space-y-3 p-4" data-review-focus-empty={productId}>
      <p className="text-[14px] text-text-secondary">{say(REVIEW.noLinksYet, lang)}</p>
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="primary"
          loading={act.busy === 'match'}
          onClick={() =>
            act.run('match', () => runMatchPage({ product_ids: [productId] }), (a) => {
              onMatched();
              const s = a.products[0];
              return { tone: 'success', text: say(SNAPSHOTS.matchDone, lang, { products: a.products.length, confirmed: s?.confirmed ?? 0, suggested: s?.suggested ?? 0, missing: s?.missing.length ?? 0 }) };
            })
          }
          data-review-match-one
        >
          {say(REVIEW.matchOne, lang)}
        </Button>
        {editor ? (
          <a href={editor} className="inline-flex min-h-11 items-center px-1 text-[13px] font-bold text-text-primary underline underline-offset-2">
            {say(COMMON.openProduct, lang)}
          </a>
        ) : null}
      </div>
      <ActNote message={act.message} lang={lang} />
      <CatalogueLookup lang={lang} />
    </div>
  );
}

/** What «احسب من جديد» answered for one product: its state, type and route, and its flags. */
export function PreviewSummary({ preview, lang }: { preview: EstimatePreview; lang: UiLang }) {
  return (
    <div className="space-y-2 rounded-xl border border-border-subtle/60 p-3" data-review-preview={preview.blocking ? 'blocked' : 'ready'}>
      <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-text-secondary">
        <span className="font-bold text-text-primary">{say(ESTIMATE_STATE_LABELS[preview.state], lang)}</span>
        {preview.type ? <span dir="ltr">{preview.type}</span> : null}
        {preview.sourcing ? <span>{say(SOURCING_LABELS[preview.sourcing], lang)}</span> : null}
        {preview.route ? <span>{say(ROUTE_LABELS[preview.route], lang)}</span> : null}
      </p>
      <FlagList flags={preview.flags} lang={lang} />
    </div>
  );
}

/**
 * The owner's type, sourcing and route for one product (§3.8, §4.1): "as the
 * type" leaves the override empty. The 0218 trigger holds the same rules as
 * the type table (filament by sea, the EU store by land, air only where the
 * type allows it) and answers PRICE_ESTIMATE_TYPE_RULE otherwise.
 */
export function ProductSettings({ productId, types, lang }: { productId: string; types: readonly EstimateType[]; lang: UiLang }) {
  const act = useAct(lang);
  const [stored, setStored] = useState<StoredEstimate | null | undefined>(undefined);
  const [error, setError] = useState<unknown>(null);
  const [reload, setReload] = useState(0);
  const [typeKey, setTypeKey] = useState('');
  const [sourcing, setSourcing] = useState('');
  const [route, setRoute] = useState('');
  const [needType, setNeedType] = useState(false);

  useEffect(() => {
    const ac = new AbortController();
    setError(null);
    fetchEstimate(productId, { signal: ac.signal, mascot: 'silent' })
      .then((a) => {
        if (ac.signal.aborted) return;
        setStored(a.product);
        setTypeKey(a.product.type_source === 'owner' && a.product.type ? a.product.type : '');
        setSourcing(a.product.sourcing_override ?? '');
        setRoute(a.product.route_override ?? '');
      })
      .catch((e) => {
        if (ac.signal.aborted) return;
        // No bookkeeping row yet: the product is enrolled by its first setting (version 0).
        if (errorCode(e) === 'NOT_FOUND') {
          setStored(null);
          setTypeKey('');
          setSourcing('');
          setRoute('');
        } else setError(e);
      });
    return () => ac.abort();
  }, [productId, reload]);

  if (error) return <Failure error={error} lang={lang} listRead={false} onRetry={() => setReload((n) => n + 1)} />;
  if (stored === undefined) return <Skeleton className="h-24 w-full" />;

  const save = async () => {
    const chosenType = typeKey || (stored?.type ?? '');
    if ((sourcing || route) && !chosenType) {
      setNeedType(true);
      return;
    }
    setNeedType(false);
    const body: Parameters<typeof setEstimateProduct>[1] = { version: stored?.version ?? 0 };
    const ownerType = stored?.type_source === 'owner' ? (stored.type ?? '') : '';
    if (typeKey !== ownerType) body.type_key = typeKey || null;
    if (sourcing !== (stored?.sourcing_override ?? '')) body.sourcing_override = (sourcing || null) as EstimateSourcing | null;
    if (route !== (stored?.route_override ?? '')) body.route_override = (route || null) as EstimateRoute | null;
    if (Object.keys(body).length === 1) return;
    await act.run('settings', () => setEstimateProduct(productId, body), () => {
      setReload((n) => n + 1);
      return { tone: 'success', text: say(REVIEW.settingsSaved, lang) };
    });
  };

  const typeName = (t: EstimateType) => (lang === 'en' ? t.name_en : lang === 'ckb' ? t.name_ckb : t.name_ar) || t.key;
  return (
    <div className="space-y-3 rounded-xl border border-border-subtle/60 p-3" data-review-settings={productId}>
      {stored ? (
        <p className="text-[12px] text-text-secondary">
          {say(ESTIMATE_STATE_LABELS[stored.state], lang)}
          {stored.type ? (
            <>
              {' · '}
              <span dir="ltr">{stored.type}</span>
            </>
          ) : null}
        </p>
      ) : null}
      <div className="grid gap-3 [grid-template-columns:minmax(0,1fr)] sm:[grid-template-columns:repeat(3,minmax(0,1fr))]">
        <Field label={say(REVIEW.type, lang)}>
          <Select value={typeKey} onChange={(e) => setTypeKey(e.target.value)} data-review-type>
            <option value="">{say(REVIEW.typeAuto, lang)}</option>
            {types.map((t) => (
              <option key={t.key} value={t.key}>
                {typeName(t)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={say(REVIEW.sourcing, lang)}>
          <Select value={sourcing} onChange={(e) => setSourcing(e.target.value)} data-review-sourcing>
            <option value="">{say(REVIEW.asType, lang)}</option>
            {ESTIMATE_SOURCINGS.map((s) => (
              <option key={s} value={s}>
                {say(SOURCING_LABELS[s], lang)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={say(REVIEW.route, lang)}>
          <Select value={route} onChange={(e) => setRoute(e.target.value)} data-review-route>
            <option value="">{say(REVIEW.asType, lang)}</option>
            {ESTIMATE_ROUTES.map((r) => (
              <option key={r} value={r}>
                {say(ROUTE_LABELS[r], lang)}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      {needType ? <p className="text-[12px] text-danger">{say(REVIEW.settingsNeedType, lang)}</p> : null}
      <Button size="sm" variant="primary" loading={act.busy === 'settings'} onClick={save} data-review-settings-save>
        {say(COMMON.save, lang)}
      </Button>
      <ActNote message={act.message} lang={lang} />
    </div>
  );
}

/**
 * «ابحث في لقطات الأسعار»: the owner's text in any form the lookup reads; each
 * item with its id, link and capture date, each SKU with its price, link and
 * the products already matched to it. With a `target`, a SKU is mapped onto
 * one of the product's options in one press.
 */
export function CatalogueLookup({ lang, target, onMapped, onStale }: { lang: UiLang; target?: ProductLinks; onMapped?: (view: ProductLinks | null) => void; onStale?: () => void }) {
  const act = useAct(lang, onStale);
  const [draft, setDraft] = useState('');
  const [items, setItems] = useState<LookupItem[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [mapTo, setMapTo] = useState<Record<string, string>>({});

  const search = async (e?: FormEvent) => {
    e?.preventDefault();
    const q = draft.trim();
    if (!q) return;
    setBusy(true);
    setError(null);
    try {
      setItems((await lookupSupplier(q, { mascot: 'silent' })).supplier_prices);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const map = (item: LookupItem, skuKey: string) => {
    if (!target) return;
    const rowKey = `${item.source}|${item.item_key}|${skuKey}`;
    const combo = mapTo[rowKey] ?? target.skus[0]?.combo_key ?? '';
    void act.run(
      `map:${rowKey}`,
      () => decideMatches(target.product_id, { version: target.versions.matches, skus: [{ combo_key: combo, source: item.source, item_key: item.item_key, sku_key: skuKey }] }),
      (a) => {
        onMapped?.(a.product);
        return { tone: 'success', text: say(REVIEW.confirmed, lang) };
      }
    );
  };

  return (
    <div className="space-y-3 rounded-xl border border-border-subtle/60 p-3" data-catalogue-lookup>
      <form onSubmit={search} className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-end" role="search" aria-label={say(LOOKUP.title, lang)}>
        <Field label={say(LOOKUP.title, lang)} className="min-w-0 flex-1">
          <Input type="search" dir="auto" maxLength={300} autoComplete="off" placeholder={say(LOOKUP.placeholder, lang)} value={draft} onChange={(e) => setDraft(e.target.value)} data-lookup-input />
        </Field>
        <Button type="submit" variant="secondary" loading={busy} icon={<Search aria-hidden="true" className="h-4 w-4" />}>
          {say(LINKS.search, lang)}
        </Button>
      </form>
      <ActNote message={act.message} lang={lang} />
      {error ? <Failure error={error} lang={lang} listRead={false} /> : null}
      {items ? (
        items.length ? (
          <div className="space-y-2">
            <p className="text-[12px] text-text-muted">{say(LOOKUP.results, lang, { n: items.length })}</p>
            <ul className="space-y-2">
              {items.map((item) => (
                <li key={`${item.source}-${item.item_key}`} className="min-w-0 space-y-1.5 rounded-xl bg-surface-raised p-3" data-lookup-item={`${item.source}:${item.item_key}`}>
                  <div className="flex min-w-0 flex-wrap items-center gap-2">
                    <SourceChip source={item.source} lang={lang} />
                    <span className="text-[12px] text-text-muted">{say(LINKS.captured, lang, { date: dayOf(item.captured_on) })}</span>
                  </div>
                  {item.title ? (
                    <p dir="auto" className="break-words text-[13px] font-semibold text-text-primary">
                      {item.title}
                    </p>
                  ) : null}
                  {item.name_en && item.name_en !== item.title ? (
                    <p dir="ltr" className="break-words text-start text-[12px] text-text-secondary">
                      {item.name_en}
                    </p>
                  ) : null}
                  <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
                    <span className="inline-flex min-w-0 items-center gap-1 text-[12px] text-text-secondary">
                      {say(item.source === 'tmall_cn' ? LINKS.tmallId : LINKS.storeHandle, lang)}: <Ltr className="break-all font-mono text-text-primary">{item.item_key}</Ltr>
                      <CopyButton value={item.item_key} what={say(item.source === 'tmall_cn' ? LINKS.tmallId : LINKS.storeHandle, lang)} lang={lang} />
                    </span>
                    <SupplierAnchor href={item.item_url} label={openItemText(item.source, lang)} lang={lang} />
                  </div>
                  <ul className="space-y-1.5">
                    {item.skus.map((sku) => {
                      const rowKey = `${item.source}|${item.item_key}|${sku.sku_key}`;
                      return (
                        <li key={sku.sku_key} className={`min-w-0 space-y-1 border-t border-border-subtle/60 pt-1.5 ${sku.highlight ? 'font-semibold' : ''}`} data-lookup-sku={sku.sku_key}>
                          <p className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-[12px] text-text-secondary">
                            {sku.highlight ? <span className="text-success">{say(LOOKUP.highlight, lang)}</span> : null}
                            <span dir="auto" className="min-w-0 break-words">
                              {optionsLine(sku.options) || optionsLine(sku.options_en)}
                            </span>
                            <Ltr className="font-bold text-text-primary">{moneyText(sku.price, item.currency)}</Ltr>
                            {sku.price_label ? <span dir="auto">{sku.price_label}</span> : null}
                          </p>
                          <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
                            <span className="inline-flex items-center gap-1 text-[12px] text-text-secondary">
                              {say(LINKS.skuId, lang)}: <Ltr className="break-all font-mono text-text-primary">{sku.sku_key}</Ltr>
                              <CopyButton value={sku.sku_key} what={say(LINKS.skuId, lang)} lang={lang} />
                            </span>
                            <SupplierAnchor href={sku.sku_url} label={say(LINKS.openOption, lang)} lang={lang} />
                          </div>
                          {sku.products.length ? (
                            <p dir="auto" className="break-words text-[12px] text-text-muted">
                              {say(LOOKUP.matchedTo, lang, { names: sku.products.map((p) => p.name).join(' · ') })}
                            </p>
                          ) : null}
                          {target && target.skus.length ? (
                            <div className="flex flex-wrap items-end gap-2">
                              {target.skus.length > 1 ? (
                                <Select
                                  aria-label={say(REVIEW.mapTo, lang)}
                                  value={mapTo[rowKey] ?? target.skus[0]!.combo_key}
                                  onChange={(e) => setMapTo((m) => ({ ...m, [rowKey]: e.target.value }))}
                                  className="max-w-xs"
                                >
                                  {target.skus.map((s) => (
                                    <option key={s.combo_key || '_'} value={s.combo_key}>
                                      {skuName(s, lang)}
                                    </option>
                                  ))}
                                </Select>
                              ) : null}
                              <Button size="sm" variant="secondary" loading={act.busy === `map:${rowKey}`} disabled={!!act.busy && act.busy !== `map:${rowKey}`} onClick={() => map(item, sku.sku_key)} data-lookup-map={rowKey}>
                                {say(REVIEW.map, lang)}
                              </Button>
                            </div>
                          ) : null}
                        </li>
                      );
                    })}
                  </ul>
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <p className="text-[13px] text-text-secondary">{say(LOOKUP.none, lang)}</p>
        )
      ) : null}
    </div>
  );
}
