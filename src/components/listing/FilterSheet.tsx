import React, { useEffect, useId, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { useLanguage } from '../../LanguageContext';
import { Sheet } from '../ui/Sheet';
import { Button } from '../ui/Button';
import FilterPanel from './FilterPanel';
import { api, isAborted, type ProductsListResponse } from '../../lib/api';
import { listingApiQuery, serializeListing } from '../../lib/catalog/listingQuery';
import { clearFilters, type SectionType } from '../../lib/catalog/listingModel';
import { showCountLabel, type NounKind } from '../../lib/catalog/copy';
import type { FacetSet, ListingState } from '../../lib/catalog/types';

/**
 * THE FILTER SHEET (docs/ux/CATALOG_DISCOVERY.md §7, mockup 03b).
 *
 * A large-detent sheet over the listing: ✕ | «التصفية» | «مسح الكل» at the
 * top, the sections in the middle, and a sticky footer with «مسح» and the one
 * primary action, «عرض 4 طابعات», carrying the LIVE count of what the draft
 * would show (Arabic dual and plural: «عرض طابعة واحدة», «عرض طابعتين»).
 *
 * APPLY ON TAP. Changes are a draft until that button: the grid behind the
 * scrim does not jump with every toggle, and one request per pause replaces
 * one per tap. The draft's counts come from the same endpoint with
 * `facets=1` — debounced 200 ms, the previous request aborted — and while a
 * count is on its way the button keeps the last known number.
 *
 * Focus returns to «التصفية» on close (the Overlay restores it), Escape and
 * the scrim close without applying, and the whole module is a lazy chunk —
 * fetched on the first `pointerdown` of «التصفية».
 */
export default function FilterSheet({
  open,
  onClose,
  applied,
  facets,
  category,
  type,
  kind,
  onApply,
}: {
  open: boolean;
  onClose: () => void;
  applied: ListingState;
  /** The counts of the applied state (the page's own). */
  facets: FacetSet;
  category: string | null;
  type: SectionType;
  kind: NounKind;
  onApply: (next: ListingState) => void;
}) {
  const { lang, loc } = useLanguage();
  const titleId = useId();
  const [draft, setDraft] = useState(applied);
  const [draftFacets, setDraftFacets] = useState(facets);
  const [counting, setCounting] = useState(false);
  const opened = useRef(false);

  // Every opening starts from what is applied.
  useEffect(() => {
    if (open && !opened.current) {
      setDraft(applied);
      setDraftFacets(facets);
    }
    opened.current = open;
  }, [open, applied, facets]);

  const same = serializeListing(draft) === serializeListing(applied);
  useEffect(() => {
    if (!open) return;
    if (same) {
      setDraftFacets(facets);
      setCounting(false);
      return;
    }
    const ctrl = new AbortController();
    setCounting(true);
    const timer = setTimeout(() => {
      api
        .get<ProductsListResponse>(`/api/products?${listingApiQuery(draft, { category: category ?? undefined, limit: 1, facets: true })}`, {
          signal: ctrl.signal,
          mascot: 'silent',
        })
        .then((res) => {
          if (res.facets) setDraftFacets(res.facets);
        })
        .catch((e) => {
          if (!isAborted(e)) setCounting(false);
        })
        .finally(() => {
          if (!ctrl.signal.aborted) setCounting(false);
        });
    }, 200);
    return () => {
      clearTimeout(timer);
      ctrl.abort();
    };
    // `draft` is compared by its serialisation; the object identity changes on every toggle.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, serializeListing(draft), same, facets, category]);

  const total = draftFacets.total;
  const clear = () => setDraft(clearFilters(draft));
  // OWNER: Sorani to be written by hand (every loc() in this file without a third argument).

  return (
    <Sheet
      open={open}
      onClose={onClose}
      labelledBy={titleId}
      detents={['large']}
      panelClassName="sm:max-w-[520px] sm:w-[92vw]"
      testId="filter-sheet"
      header={
        <div className="flex items-center justify-between border-b border-border-subtle px-2 pb-2 pt-1">
          <button
            type="button"
            onClick={onClose}
            aria-label={loc('إغلاق', 'Close', 'داخستن')}
            className="grid size-11 place-items-center rounded-full text-text-primary hover:bg-surface-selected focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
          >
            <X aria-hidden="true" className="size-5" />
          </button>
          <h2 id={titleId} className="text-[16px] font-extrabold text-text-primary">
            {loc('التصفية', 'Filters')}
          </h2>
          <button
            type="button"
            onClick={clear}
            className="min-h-11 rounded-lg px-2.5 text-[13px] font-bold text-gold hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
          >
            {loc('مسح الكل', 'Clear all')}
          </button>
        </div>
      }
      footer={
        <div className="flex gap-2">
          <Button variant="secondary" className="w-24 shrink-0" onClick={clear}>
            {loc('مسح', 'Clear')}
          </Button>
          <Button
            variant="primary"
            block
            data-filter-apply={total}
            aria-busy={counting || undefined}
            onClick={() => {
              onApply(draft);
              onClose();
            }}
          >
            <span aria-live="polite">{showCountLabel(total, kind, lang)}</span>
          </Button>
        </div>
      }
    >
      <div className="px-4">
        <FilterPanel facets={draftFacets} state={draft} onChange={setDraft} type={type} />
      </div>
    </Sheet>
  );
}
