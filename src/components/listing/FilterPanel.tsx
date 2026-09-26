import React from 'react';
import { useLanguage } from '../../LanguageContext';
import { Switch } from '../ui/Switch';
import { Segmented } from '../ui/Segmented';
import FacetSection from './FacetSection';
import PriceFacet from './PriceFacet';
import CheckboxFacet from './CheckboxFacet';
import ChipFacet, { type ChipOption } from './ChipFacet';
import SwatchFacet from './SwatchFacet';
import {
  availabilityShows,
  facetTitle,
  offersShows,
  sheetSections,
  specValueLabel,
  toggleBrand,
  toggleSpec,
  type SectionType,
} from '../../lib/catalog/listingModel';
import type { FacetField, FacetSet, ListingState } from '../../lib/catalog/types';

/**
 * THE FILTERS, ONE SET OF SECTIONS FOR TWO FRAMES (§7): the phone's filter
 * sheet (a draft applied by its footer button) and the desktop's side column
 * (applied as it changes). Which sections exist is decided by
 * `sheetSections` — a facet is drawn only when it offers a real choice in this
 * section (two values or more), or is already on — and every count is the
 * server's disjunctive count for the state being edited.
 *
 * `onChange` receives a whole new state; `q` and `sort` pass through untouched.
 */
export default function FilterPanel({
  facets,
  state,
  onChange,
  type,
}: {
  facets: FacetSet;
  state: ListingState;
  onChange: (next: ListingState) => void;
  type: SectionType;
}) {
  const { lang, loc } = useLanguage();
  const sections = sheetSections(type, facets, state);
  // OWNER: Sorani to be written by hand (every loc() in this file without a third argument).

  return (
    <div data-filter-panel>
      {sections.map((section) => {
        switch (section) {
          case 'availability': {
            const show = availabilityShows(facets, state);
            return (
              <FacetSection key={section} id={section} title={loc('التوفر ونوع البيع', 'Availability and sale type')}>
                {() => (
                  <div className="flex flex-col gap-2">
                    {show.avail ? (
                      <Switch
                        checked={state.avail}
                        onChange={(v) => onChange({ ...state, avail: v })}
                        label={
                          <span className="font-bold">
                            {loc('المتوفر الآن فقط', 'Available now only')}
                            <span className="ms-1.5 font-semibold tabular-nums text-text-muted">{facets.avail.now}</span>
                          </span>
                        }
                        description={loc('بيع مباشر من مخزون العراق', 'Direct sale from stock in Iraq')}
                      />
                    ) : null}
                    {show.sale ? (
                      <Segmented
                        group="listing-sale"
                        size="sm"
                        label={loc('نوع البيع', 'Sale type')}
                        value={state.sale ?? 'all'}
                        onChange={(id) => onChange({ ...state, sale: id === 'direct' || id === 'preorder' ? id : null })}
                        items={[
                          { id: 'all', label: loc('الكل', 'All', 'هەموو'), accent: SEG_ACCENT },
                          { id: 'direct', label: loc('بيع مباشر', 'Direct sale'), accent: SEG_ACCENT },
                          { id: 'preorder', label: loc('طلب مسبق', 'Pre-order', 'پێش-داواکاری'), accent: SEG_ACCENT },
                        ]}
                      />
                    ) : null}
                  </div>
                )}
              </FacetSection>
            );
          }
          case 'price':
            return (
              <FacetSection key={section} id={section} title={loc('السعر', 'Price', 'نرخ')} note={loc('د.ع', 'IQD')}>
                {() =>
                  facets.price.min !== null && facets.price.max !== null && facets.price.max > facets.price.min ? (
                    <PriceFacet
                      min={facets.price.min}
                      max={facets.price.max}
                      histogram={facets.price.histogram}
                      value={state.price}
                      onChange={(price) => onChange({ ...state, price })}
                    />
                  ) : (
                    <button
                      type="button"
                      onClick={() => onChange({ ...state, price: null })}
                      className="min-h-11 text-[13px] font-bold text-text-secondary underline underline-offset-4"
                    >
                      {loc('إلغاء حد السعر', 'Clear the price limit')}
                    </button>
                  )
                }
              </FacetSection>
            );
          case 'brands':
            return (
              <FacetSection key={section} id={section} title={loc('العلامة التجارية', 'Brand')}>
                {(labelId) => (
                  <CheckboxFacet
                    labelledBy={labelId}
                    selected={state.brands}
                    onToggle={(slug) => onChange(toggleBrand(state, slug))}
                    options={withSelected(
                      facets.brands.map((b) => ({ value: b.slug, label: b.name_en || b.name_ar, count: b.count })),
                      state.brands,
                      (slug) => ({ value: slug, label: slug, count: 0 })
                    )}
                  />
                )}
              </FacetSection>
            );
          case 'offers': {
            const show = offersShows(facets, state);
            return (
              <FacetSection key={section} id={section} title={loc('العروض والعضوية', 'Offers and membership')}>
                {() => (
                  <div className="flex flex-col gap-1">
                    {show.offer ? (
                      <Switch
                        checked={state.offer}
                        onChange={(v) => onChange({ ...state, offer: v })}
                        label={<CountLabel text={loc('عليها عرض', 'On offer')} count={facets.offer} />}
                        description={loc('سعر مخفّض أو عرض بوقت محدد', 'A reduced price or a timed offer')}
                      />
                    ) : null}
                    {show.member ? (
                      <Switch
                        checked={state.member}
                        onChange={(v) => onChange({ ...state, member: v })}
                        label={<CountLabel text={loc('سعر أقل لأعضاء PRIME / PRO', 'Lower price for PRIME / PRO members')} count={facets.member} />}
                      />
                    ) : null}
                  </div>
                )}
              </FacetSection>
            );
          }
          default: {
            const field = section as FacetField;
            const selected = state.specs[field] ?? [];
            const options = withSelected<ChipOption>(
              (facets.specs[field] ?? []).map((o) => ({ value: o.value, label: specValueLabel(field, o.value, lang, o.label), count: o.count })),
              selected,
              (token) => ({ value: token, label: specValueLabel(field, token, lang), count: null })
            );
            const Facet = field === 'color_name' ? SwatchFacet : ChipFacet;
            return (
              <FacetSection
                key={section}
                id={section}
                title={facetTitle(field, lang)}
                note={field === 'max_colors' || field === 'build_volume' ? loc('من ورقة المواصفات', 'From the spec sheet') : undefined}
              >
                {(labelId) => (
                  <Facet
                    labelledBy={labelId}
                    options={options}
                    selected={selected}
                    onToggle={(token) => onChange(toggleSpec(state, field, token))}
                  />
                )}
              </FacetSection>
            );
          }
        }
      })}
      {sections.length === 0 ? (
        <p className="py-6 text-center text-[13px] text-text-muted">
          {loc('لا توجد عوامل تصفية تفرّق بين منتجات هذا القسم.', 'Nothing here to filter by: the products in this section do not differ.')}
        </p>
      ) : null}
    </div>
  );
}

/** Keeps an applied value visible (and removable) even when the counts no longer list it. */
function withSelected<T extends { value: string }>(options: T[], selected: string[], make: (v: string) => T): T[] {
  const have = new Set(options.map((o) => o.value));
  return [...options, ...selected.filter((v) => !have.has(v)).map(make)];
}

function CountLabel({ text, count }: { text: string; count: number }) {
  return (
    <span className="font-bold">
      {text}
      <span className="ms-1.5 font-semibold tabular-nums text-text-muted">{count}</span>
    </span>
  );
}

const SEG_ACCENT = { indicator: 'bg-surface-raised border-border-subtle shadow-1', text: 'text-text-primary' };

