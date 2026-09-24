/**
 * One product's numbers — every one a server aggregate: views (the W2-E
 * analytics days when they exist, else the product's own counter, and it says
 * which), units, revenue and orders from NON-CANCELLED orders only, and the
 * same per variant.
 */
import { useEffect, useId, useState } from 'react';
import { useLanguage } from '../../../LanguageContext';
import { Sheet } from '../../ui/Sheet';
import { KpiTile } from '../../ui/KpiTile';
import { Money } from '../../ui/Money';
import { ErrorState } from '../../ui/AsyncStates';
import { catalogApi, type CatalogProduct, type ProductInsights } from './catalogApi';
import { catalogStrings } from './strings';

export default function InsightsSheet({ product, onClose }: { product: CatalogProduct | null; onClose: () => void }) {
  const { loc } = useLanguage();
  const s = catalogStrings(loc);
  const titleId = useId();
  const [data, setData] = useState<ProductInsights | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [n, setN] = useState(0);

  useEffect(() => {
    if (!product) return;
    let alive = true;
    setData(null);
    setError(null);
    catalogApi
      .insights(product.id)
      .then((d) => alive && setData(d.insights))
      .catch((e) => alive && setError(e));
    return () => {
      alive = false;
    };
  }, [product, n]);

  const fmt = (x: number) => x.toLocaleString('en-US');
  return (
    <Sheet
      open={!!product}
      onClose={onClose}
      labelledBy={titleId}
      detents={['large']}
      panelClassName="w-full sm:max-w-lg"
      header={
        <div className="px-5 pb-2 pt-1">
          <h2 id={titleId} className="truncate text-[16px] font-bold text-text-primary">{s.insightsTitle(product?.name ?? '')}</h2>
        </div>
      }
    >
      <div className="space-y-4 px-5 pb-6 pt-1" data-insights>
        {error ? (
          <ErrorState error={error} onRetry={() => setN((x) => x + 1)} compact />
        ) : (
          <>
            <div className="grid grid-cols-2 gap-2">
              <KpiTile label={s.views} value={data ? fmt(data.views) : null} loading={!data} hint={data?.views_source === 'counter' ? s.viewsCounter : undefined} />
              <KpiTile label={s.unitsSold} value={data ? fmt(data.units_sold) : null} loading={!data} />
              <KpiTile label={s.revenue} value={data ? <Money iqd={data.revenue_iqd} /> : null} loading={!data} />
              <KpiTile label={s.orders} value={data ? fmt(data.orders) : null} loading={!data} />
            </div>
            {data && data.by_variant.length > 0 && (
              <section aria-labelledby={`${titleId}-v`}>
                <h3 id={`${titleId}-v`} className="mb-2 text-[13.5px] font-semibold text-text-primary">{s.byVariant}</h3>
                <ul className="divide-y divide-border-subtle rounded-xl border border-border-subtle">
                  {data.by_variant.map((v) => (
                    <li key={v.variant_id} className="flex items-center justify-between gap-3 px-3 py-2.5 text-[13px]">
                      <span className="min-w-0 truncate text-text-primary">{v.label}</span>
                      <span className="shrink-0 tabular-nums text-text-secondary">
                        {fmt(v.units)} · <Money iqd={v.revenue_iqd} />
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            )}
            {data && data.units_sold === 0 && <p className="text-[12.5px] text-text-muted">{s.noSalesYet}</p>}
          </>
        )}
      </div>
    </Sheet>
  );
}
