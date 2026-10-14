/**
 * «التسعير والشحن» — THE OWNER'S PRICING WORKSPACE, after the clean start
 * (addendum A.6/A.8, DECISIONS row 222).
 *
 * What the owner sees:
 *   - the exchange and shipping rates (RatesPanel, FX-1): approving one
 *     reprices every V2-published product automatically (FX-5);
 *   - the V2 card: how many ordinary products customers can buy, and how many
 *     stay hidden until their first complete V2 write, with the door to the
 *     «يحتاج تسعيرًا» queue (the products tab, `?view=needs-pricing`).
 *
 * The V1 overview, the product sheet, the what-if calculator and the stale
 * list are gone (their routes answer PRICING_V2_MANAGED): every price is the
 * product's own V2 write, opened from the queue and reviewed in its sheet.
 *
 * WHO. Mounted by src/pages/Admin.tsx only on `can_write_cost === true` — a
 * courtesy; the router refuses everyone but the verified owner before a query
 * runs. A refusal is said BY CODE (`PricingFailure`).
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useLanguage } from '../../LanguageContext';
import { Button } from '../ui/Button';
import { Skeleton } from '../ui/Skeleton';
import { fetchPricingV2Counts, type PricingV2Counts } from './api';
import { PricingFailure } from './parts';
import RatesPanel from './RatesPanel';
import { pricingStrings } from './strings';
import { hiddenBanner, NEEDS_PRICING, tri } from '../adminProducts/needsPricingStrings';

const V2_CARD = {
  title: { ar: 'أسعار المنتجات بالدولار', en: 'Product prices in dollars', ckb: 'نرخی بەرهەمەکان بە دۆلار' },
  published: { ar: 'منشور للزبائن', en: 'Published to customers', ckb: 'بۆ کڕیاران بڵاوکراوەتەوە' },
  hidden: { ar: 'مخفي حتى يُسعَّر', en: 'Hidden until priced', ckb: 'شاراوەیە تا نرخی بۆ دادەنرێت' },
  saved: { ar: 'محفوظ، غير مكتمل', en: 'Saved, not complete', ckb: 'پاشەکەوتکراوە، تەواو نییە' },
  bundles: { ar: 'حزم بانتظار قرار التسعير', en: 'Bundles awaiting a pricing decision', ckb: 'پاکێجەکان چاوەڕێی بڕیاری نرخدانانن' },
  allPublished: {
    ar: 'كل المنتجات العادية مسعّرة ومنشورة.',
    en: 'Every ordinary product is priced and published.',
    ckb: 'هەموو بەرهەمە ئاساییەکان نرخیان هەیە و بڵاوکراونەتەوە.',
  },
} as const;

/** The products tab, opened on the «يحتاج تسعيرًا» queue. */
function openQueue() {
  try {
    const url = new URL(window.location.href);
    url.searchParams.set('tab', 'products');
    url.searchParams.set('view', 'needs-pricing');
    window.location.assign(url.toString());
  } catch {
    /* the link is a courtesy */
  }
}

export default function AdminPricing() {
  const { lang: rawLang, dir } = useLanguage();
  const lang = rawLang === 'en' || rawLang === 'ckb' ? rawLang : 'ar';
  const s = useMemo(() => pricingStrings(rawLang), [rawLang]);
  const [counts, setCounts] = useState<PricingV2Counts | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [reload, setReload] = useState(0);
  const refresh = useCallback(() => setReload((n) => n + 1), []);

  useEffect(() => {
    const ac = new AbortController();
    setError(null);
    fetchPricingV2Counts({ signal: ac.signal })
      .then((r) => {
        if (!ac.signal.aborted) setCounts(r.v2);
      })
      .catch((e) => {
        if (!ac.signal.aborted) setError(e);
      });
    return () => ac.abort();
  }, [reload]);

  return (
    <div dir={dir} data-admin-pricing className="mx-auto w-full max-w-[1120px] min-w-0 space-y-4 px-4 pb-16 sm:px-0">
      <header className="space-y-1">
        <h2 className="text-[22px] font-black leading-snug text-text-primary sm:text-[26px]">{s.title}</h2>
      </header>

      <RatesPanel lang={rawLang} dir={dir} onChanged={refresh} reloadKey={reload} />

      <section data-pricing-v2-card className="lv-surface space-y-3 p-4">
        <h3 className="text-[16px] font-bold text-text-primary">{tri(V2_CARD.title, lang)}</h3>
        {error ? (
          <PricingFailure error={error} lang={rawLang} onRetry={refresh} fallback={s.loadFailed} />
        ) : !counts ? (
          <div className="space-y-2" aria-hidden="true">
            <Skeleton className="h-5 w-2/3" />
            <Skeleton className="h-5 w-1/2" />
          </div>
        ) : (
          <>
            <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              {(
                [
                  ['published', V2_CARD.published, counts.published],
                  ['hidden', V2_CARD.hidden, counts.needs_pricing],
                  ['saved', V2_CARD.saved, counts.saved],
                  ['bundles', V2_CARD.bundles, counts.compositions],
                ] as const
              ).map(([key, label, n]) => (
                <div key={key} className="min-w-0 rounded-xl bg-surface-raised p-3" data-pricing-v2-count={key}>
                  <dt className="text-[12px] text-text-muted">{tri(label, lang)}</dt>
                  <dd className="text-[20px] font-black text-text-primary" dir="ltr">{n}</dd>
                </div>
              ))}
            </dl>
            {counts.needs_pricing > 0 ? (
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                <p className="text-[13px] text-text-secondary">{hiddenBanner(counts.needs_pricing, lang)}</p>
                <Button size="sm" variant="primary" className="w-full sm:w-auto" onClick={openQueue} data-pricing-open-queue>
                  {tri(NEEDS_PRICING.title, lang)}
                </Button>
              </div>
            ) : (
              <p className="text-[13px] text-text-secondary">{tri(V2_CARD.allPublished, lang)}</p>
            )}
          </>
        )}
      </section>
    </div>
  );
}
