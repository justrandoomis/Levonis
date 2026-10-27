/**
 * «مقارنة العروض» (community UI plan C3): opened by the compare chip over the
 * offers when two or more are live. The quick comparison names the offer that
 * wins on each of the three things a customer weighs (the cheapest total, the
 * fastest, the best rated; from the complete offers when a partial one would
 * otherwise win, and said so), sorted as the customer asks; from a wide screen
 * the offers also stand side by side, every one answering the same rows.
 *
 * A lazy chunk, like the details sheet: the request page does not carry it.
 */
import { useId, useMemo, useState, type ReactNode } from 'react';
import { Star } from 'lucide-react';
import { useLanguage } from '../../../LanguageContext';
import { Sheet } from '../../ui/Sheet';
import { Money } from '../../ui/Money';
import { StatusChip } from '../../ui/Badge';
import { SegmentedTrack } from '../kit/controls';
import type { CatalogMaterial, OfferV2 } from './api';
import { OfferFacts } from './OfferDetailsSheet';
import { bestOffers, partialLabel, sortOffers, type OfferSort, type PartRef } from './offerParts';
import { daysLabel, requestLang, useRequestStrings } from './strings';

function CompareRow({ label, o, value, partial = '' }: { label: string; o: OfferV2 | null; value: ReactNode; partial?: string }) {
  return (
    <div className="flex items-center justify-between gap-3 py-2 text-[12.5px]" data-compare-row>
      <dt className="shrink-0 text-text-muted">{label}</dt>
      <dd className="flex min-w-0 items-center gap-2 text-end text-text-primary">
        {o && <bdi className="truncate font-semibold">{o.merchant?.name ?? '—'}</bdi>}
        {/* A pick from the partial pool says it makes only some parts. */}
        {o && partial && (
          <span className="shrink-0" data-compare-partial>
            <StatusChip tone="warning">{partial}</StatusChip>
          </span>
        )}
        <span className="shrink-0 tabular-nums">{value ?? '—'}</span>
      </dd>
    </div>
  );
}

export interface CompareSheetProps {
  open: boolean;
  offers: OfferV2[];
  materials: CatalogMaterial[];
  parts: PartRef[];
  onClose: () => void;
}

export default function CompareSheet({ open, offers, materials, parts, onClose }: CompareSheetProps) {
  const { lang } = useLanguage();
  const s = useRequestStrings();
  const L = requestLang(lang);
  const titleId = useId();
  const [sort, setSort] = useState<OfferSort>('price');
  const sorted = useMemo(() => sortOffers(offers, sort), [offers, sort]);
  const best = useMemo(() => bestOffers(offers), [offers]);
  return (
    <Sheet
      open={open}
      onClose={onClose}
      labelledBy={titleId}
      detents={['medium', 'large']}
      dragHandle
      panelClassName="w-full sm:max-w-md lg:max-w-3xl"
      testId="offer-compare-sheet"
      header={
        <div className="px-5 pb-1 pt-1">
          <h2 id={titleId} className="text-[16px] font-bold text-text-primary">
            {s.compareOffers}
          </h2>
        </div>
      }
    >
      <div className="space-y-4 px-5 pb-4">
        <SegmentedTrack
          group="offer-sort"
          size="sm"
          label={s.sortOffers}
          value={sort}
          onChange={(id) => setSort(id as OfferSort)}
          dataAttr="data-offer-sort"
          items={[
            { id: 'price', label: s.sortPrice },
            { id: 'time', label: s.sortTime },
            { id: 'rating', label: s.sortRating },
          ]}
        />
        <section aria-labelledby={`${titleId}-quick`} className="lv-surface overflow-hidden" data-request-section="compare" data-offer-compare-table>
          <h3 id={`${titleId}-quick`} className="px-4 pt-3 text-[13px] font-bold text-text-primary">
            {s.compare}
          </h3>
          {/* Only when the picks really left a live partial offer out (P1-05 review 3). */}
          {best.completeOnly && <p className="px-4 pt-1 text-[11.5px] text-text-muted" data-compare-complete-only>{s.partialCompareNote}</p>}
          <dl className="divide-y divide-border-subtle/60 px-4 pb-1 pt-1">
            <CompareRow label={s.cheapest} o={best.cheapest} partial={best.cheapest ? partialLabel(best.cheapest, parts.length, s) : ''} value={best.cheapest ? <Money iqd={best.cheapest.total_iqd} /> : null} />
            <CompareRow label={s.fastest} o={best.fastest} partial={best.fastest ? partialLabel(best.fastest, parts.length, s) : ''} value={best.fastest ? daysLabel(best.fastest.completion_days, L) : null} />
            <CompareRow
              label={s.topRated}
              o={best.topRated}
              partial={best.topRated ? partialLabel(best.topRated, parts.length, s) : ''}
              value={
                best.topRated ? (
                  <span className="inline-flex items-center gap-1 tabular-nums">
                    <Star aria-hidden="true" className="h-3 w-3 fill-gold text-gold" />
                    {(best.topRated.merchant?.rating ?? 0).toFixed(1)}
                  </span>
                ) : (
                  <span className="text-text-muted">{s.noRatingYet}</span>
                )
              }
            />
          </dl>
        </section>
        {/* Wide screens: the offers side by side, every one answering the same rows, in the chosen order. */}
        <div className="grid gap-3 lg:grid-cols-2" data-offer-columns>
          {sorted.map((o) => (
            <article key={o.id} className="lv-surface p-4" data-compare-column={o.id}>
              <p className="truncate text-[14px] font-semibold text-text-primary">
                <bdi>{o.merchant?.name ?? s.theMerchant}</bdi>
              </p>
              <p className="mt-1 text-[18px] font-bold text-text-primary">
                <Money iqd={o.total_iqd} />
              </p>
              <OfferFacts o={o} s={s} lang={L} materials={materials} parts={parts} />
            </article>
          ))}
        </div>
      </div>
    </Sheet>
  );
}
