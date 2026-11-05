/**
 * THE PRODUCT FORM'S ESTIMATE BANNER (docs/SMART_PRICING.md §3.9, §7), e.g.
 * «سعر تقديري — Tmall (الصين) 2026-10-31 · وزن افتراضي».
 *
 * A lazy chunk of its own, mounted by section ٣ «الأسعار»
 * (src/components/adminProducts/form/v2/PricesSectionV2.tsx):
 *   - THE OWNER (the viewer with cost read, the one the server answers as the
 *     pricing owner) reads the product's stored estimate (`GET /api/admin/
 *     pricing/estimates/products/:id`) and its supplier links (`GET /api/admin/
 *     pricing/supplier-prices/links/:id`): the label and state, the sources and
 *     capture dates, the default measures, the links that open Tmall or the EU
 *     store on the exact option, «مراجعة» and «تأكيد» (the confirmation sheet,
 *     in place). A product with no link but an estimate row is offered the
 *     lookup instead. Any refusal or an older database shows nothing: the
 *     banner is a courtesy;
 *   - EVERY OTHER ADMIN sees the state alone, from the product read's
 *     non-financial `price_estimate: {label, state}` (worker/routes/
 *     adminProducts.ts) — no request is made, no source, figure or flag shown.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ChevronDown, Tag } from 'lucide-react';
import { Button } from '../ui/Button';
import { StatusChip } from '../ui/Badge';
import type { AdminProductEstimate } from '../../lib/api';
import { fetchEstimate, fetchProductLinks, workspaceHref, type ProductLinks, type RealMeasures, type StoredEstimate } from './api';
import { Ltr, SupplierLinkRow, errorCode, skuName, useUiLang } from './parts';
import ConfirmSheet from './ConfirmSheet';
import { BANNER, ESTIMATE_STATE_LABELS, SOURCE_LABELS, say, type UiLang } from './strings';
import { dayOf } from './format';

export interface EstimateBannerProps {
  productId: string;
  /** The server answered this reader as the pricing owner (cost read). */
  owner: boolean;
  /** The product read's non-financial state, when the form passes it (every admin may read it). */
  state?: AdminProductEstimate | null;
  /**
   * The confirmation stated the shown measures real (§4.9 step 0): it wrote the product's package, so the form reads
   * the product again. Handed the values stated (the package holds them now).
   */
  onProductChanged?: (stated: RealMeasures) => void;
  /** The form's own «الأبعاد والوزن» (section ٤) and its cost card's weight (section ٣), for the confirmation's «ليست صحيحة؟». */
  onOpenDimensions?: () => void;
  onOpenCost?: () => void;
  /** Read again when this changes: the pricing form's stored answer (a save may write real measures there). */
  revision?: string;
}

export default function EstimateBanner({ productId, owner, state = null, onProductChanged, onOpenDimensions, onOpenCost, revision = '' }: EstimateBannerProps) {
  const { lang, dir } = useUiLang();
  if (!owner) return <StaffEstimateState state={state} lang={lang} dir={dir} />;
  return (
    <OwnerEstimateBanner
      productId={productId}
      lang={lang}
      dir={dir}
      revision={revision}
      onProductChanged={onProductChanged}
      onOpenDimensions={onOpenDimensions}
      onOpenCost={onOpenCost}
    />
  );
}

/** What every other admin may know: whether customers see the label, and where the owner holds the estimate. */
export function StaffEstimateState({ state, lang, dir }: { state: AdminProductEstimate | null; lang: UiLang; dir: 'rtl' | 'ltr' }) {
  if (!state || (!state.label && !state.state)) return null;
  return (
    <div dir={dir} className="lv-alert lv-alert-info mb-3 flex items-start gap-2 px-3 py-2 text-[12px] leading-snug text-text-primary" data-estimate-banner="staff">
      <Tag aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
      <p>{state.label ? say(BANNER.staffLabel, lang) : say(BANNER.staffState, lang, { state: say(ESTIMATE_STATE_LABELS[state.state!], lang) })}</p>
    </div>
  );
}

/** The sources an estimate prices from, each with the capture date its links carry. */
export function sourceDates(estimate: StoredEstimate | null, links: ProductLinks | null): Array<{ source: keyof typeof SOURCE_LABELS; date: string | null }> {
  const sources = [...new Set((estimate?.lines ?? []).map((l) => l.source).filter((s) => s !== 'none'))];
  return sources.map((source) => {
    const dated = (links?.skus ?? []).flatMap((s) => s.supplier_prices).find((l) => l.source === source && !!l.captured_on);
    return { source, date: dated?.captured_on ? dayOf(dated.captured_on) : null };
  });
}

function OwnerEstimateBanner({
  productId,
  lang,
  dir,
  revision,
  onProductChanged,
  onOpenDimensions,
  onOpenCost,
}: { productId: string; lang: UiLang; dir: 'rtl' | 'ltr'; revision: string } & Pick<EstimateBannerProps, 'onProductChanged' | 'onOpenDimensions' | 'onOpenCost'>) {
  const [estimate, setEstimate] = useState<StoredEstimate | null>(null);
  const [links, setLinks] = useState<ProductLinks | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    const ac = new AbortController();
    const opts = { signal: ac.signal, mascot: 'silent' as const };
    Promise.all([
      fetchEstimate(productId, opts)
        .then((a) => a.product)
        // No bookkeeping row (404), an older database (503) or any refusal: no estimate to show.
        .catch((e) => (errorCode(e) === 'ABORTED' ? Promise.reject(e) : null)),
      fetchProductLinks(productId, opts)
        .then((a) => a.products[0] ?? null)
        .catch((e) => (errorCode(e) === 'ABORTED' ? Promise.reject(e) : null)),
    ])
      .then(([e, l]) => {
        if (ac.signal.aborted) return;
        setEstimate(e);
        setLinks(l);
        setLoaded(true);
      })
      .catch(() => undefined);
    return () => ac.abort();
  }, [productId, reload, revision]);

  const done = useCallback(() => {
    setConfirming(false);
    setReload((n) => n + 1);
  }, []);
  // The sheet moved the server's state (a compute, a stale version): the banner's chips are read again too.
  const stale = useCallback(() => setReload((n) => n + 1), []);
  const dates = useMemo(() => sourceDates(estimate, links), [estimate, links]);
  const factCount = useMemo(() => (links?.skus ?? []).reduce((n, s) => n + s.supplier_prices.length, 0), [links]);

  if (!loaded || (!estimate && !links)) return null;
  const flags = new Set((estimate?.flags ?? []).map((f) => f.code));

  return (
    <section dir={dir} className="lv-surface mb-3 min-w-0 space-y-2 p-3" data-estimate-banner="owner" data-estimate-banner-state={estimate?.state ?? 'none'}>
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <Tag aria-hidden="true" className="h-4 w-4 shrink-0 text-text-muted" />
        {estimate?.label ? (
          <StatusChip tone="accent" className="shrink-0">
            {say(BANNER.label, lang)}
          </StatusChip>
        ) : (
          <span className="text-[13px] font-bold text-text-primary">{say(BANNER.title, lang)}</span>
        )}
        {estimate ? <span className="text-[12px] text-text-secondary">{say(ESTIMATE_STATE_LABELS[estimate.state], lang)}</span> : null}
        {dates.map((d) => (
          <span key={d.source} className="text-[12px] text-text-secondary" data-estimate-banner-source={d.source}>
            {say(SOURCE_LABELS[d.source], lang)}
            {d.date ? (
              <>
                {' '}
                <Ltr>{d.date}</Ltr>
              </>
            ) : null}
          </span>
        ))}
        {flags.has('EST_DEFAULT_WEIGHT') ? <span className="text-[12px] font-semibold text-warning">{say(BANNER.defaultWeight, lang)}</span> : null}
        {flags.has('EST_DEFAULT_BOX') ? <span className="text-[12px] font-semibold text-warning">{say(BANNER.defaultBox, lang)}</span> : null}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <a href={workspaceHref('review', productId)} className="lv-button lv-button-secondary lv-button-sm" data-estimate-banner-review>
          {say(BANNER.review, lang)}
        </a>
        {estimate?.state === 'estimated' ? (
          <Button size="sm" variant="primary" onClick={() => setConfirming(true)} data-estimate-banner-confirm>
            {say(BANNER.confirm, lang)}
          </Button>
        ) : null}
        {links && factCount > 0 ? (
          <button type="button" className="inline-flex min-h-11 items-center gap-1 px-1 text-[13px] font-bold text-text-primary underline underline-offset-2" aria-expanded={open} onClick={() => setOpen((o) => !o)} data-estimate-banner-links>
            {say(BANNER.links, lang, { n: factCount })}
            <ChevronDown aria-hidden="true" className={`h-4 w-4 transition-transform ${open ? 'rotate-180' : ''}`} />
          </button>
        ) : (
          <>
            <span className="text-[12px] text-text-muted">{say(BANNER.none, lang)}</span>
            <a href={workspaceHref('review', productId)} className="inline-flex min-h-11 items-center px-1 text-[13px] font-bold text-text-primary underline underline-offset-2" data-estimate-banner-find>
              {say(BANNER.find, lang)}
            </a>
          </>
        )}
      </div>
      {open && links ? (
        <div className="space-y-2" data-estimate-banner-list>
          {links.skus
            .filter((s) => s.supplier_prices.length)
            .map((s) => (
              <div key={s.combo_key || '_'} className="min-w-0 rounded-xl bg-surface-raised p-2.5">
                <p dir="auto" className="break-words text-[12px] font-bold text-text-primary">
                  {skuName(s, lang)}
                </p>
                <ul>
                  {s.supplier_prices.map((l, i) => (
                    <SupplierLinkRow key={`${l.source}-${l.item_key ?? 'manual'}-${l.sku_key ?? ''}-${i}`} link={l} lang={lang} />
                  ))}
                </ul>
              </div>
            ))}
          <a href={workspaceHref('links', productId)} className="inline-flex min-h-11 items-center px-1 text-[13px] font-bold text-text-primary underline underline-offset-2">
            {say(BANNER.allLinks, lang)}
          </a>
        </div>
      ) : null}
      <ConfirmSheet
        estimate={confirming ? estimate : null}
        onClose={() => setConfirming(false)}
        onDone={done}
        onStale={stale}
        onProductChanged={onProductChanged}
        onOpenDimensions={onOpenDimensions}
        onOpenCost={onOpenCost}
      />
    </section>
  );
}
