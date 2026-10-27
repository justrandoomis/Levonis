/**
 * THE BOARD FILTERS (community UI plan C3, IMG_8468): «الحالة», «طريقة
 * الطباعة» and «المحافظة», three kit FilterSelects (a chip that opens its
 * options; the chosen one is a radio item that says «محدد») whose values
 * live in the address, so Back, a reload and a shared link keep them.
 *
 *   الحالة         the community board: الكل / بلا عروض / لديه عروض (`offers=`,
 *                  read by the server); «طلباتي»: the owner states
 *   طريقة الطباعة  FDM / ريزن (`process=`)
 *   المحافظة       the eighteen governorates (`governorate=`)
 *
 * And the paging door every list of the page shares: a sentinel the list
 * reads the next page at as it scrolls into view, with «المزيد» kept as the
 * button for a reader with no IntersectionObserver, a failed page, or a
 * keyboard.
 */
import { useEffect, useRef } from 'react';
import { Layers, MapPin } from 'lucide-react';
import { GOVERNORATE_LABELS } from '../../../lib/governorates';
import { FilterSelect, type FilterOption } from '../kit/controls';
import { kitButtonClass } from '../kit/buttons';
import type { RequestLang, RequestStrings } from './strings';

/** The owner states of «طلباتي», by the request states each one gathers. */
export const MINE_STATES: Readonly<Record<string, readonly string[]>> = {
  open: ['open', 'receiving_offers'],
  progress: ['offer_selected', 'awarded', 'in_progress', 'delivered', 'disputed'],
  done: ['completed'],
  draft: ['draft'],
  closed: ['cancelled', 'expired'],
};

/** The filters of the address: only known values survive a hand-typed URL. */
export interface BoardFilterValues {
  state: string | null;
  process: string | null;
  governorate: string | null;
}

export function readBoardFilters(params: URLSearchParams, mine: boolean): BoardFilterValues {
  const state = params.get('state');
  const process = params.get('process');
  const governorate = params.get('governorate');
  return {
    state: state && (mine ? state in MINE_STATES : state === 'none' || state === 'some') ? state : null,
    process: process === 'fdm' || process === 'resin' ? process : null,
    governorate: governorate && governorate in GOVERNORATE_LABELS ? governorate : null,
  };
}

/** A dot that says the status filter, as the reference draws it (no icon module of its own). */
function StateDot() {
  return <span aria-hidden="true" className="size-2 shrink-0 rounded-full bg-success" />;
}

export interface BoardFiltersProps {
  values: BoardFilterValues;
  mine: boolean;
  s: RequestStrings;
  lang: RequestLang;
  onChange: (key: keyof BoardFilterValues, value: string | null) => void;
}

export default function BoardFilters({ values, mine, s, lang, onChange }: BoardFiltersProps) {
  const states: FilterOption[] = mine
    ? [
        { id: 'open', label: s.filterOpen },
        { id: 'progress', label: s.filterProgress },
        { id: 'done', label: s.filterDone },
        { id: 'draft', label: s.filterDraft },
        { id: 'closed', label: s.filterClosed },
      ]
    : [
        { id: 'none', label: s.filterNoOffers },
        { id: 'some', label: s.filterHasOffers },
      ];
  const govs: FilterOption[] = Object.entries(GOVERNORATE_LABELS).map(([id, l]) => ({ id, label: l[lang] }));
  return (
    // Three across from 400px; a narrower phone wraps them whole (plan R7), never a cut label.
    <div className="flex flex-wrap items-center gap-2" data-requests-filters>
      <FilterSelect label={s.filterState} icon={<StateDot />} options={states} value={values.state} onChange={(v) => onChange('state', v)} />
      <FilterSelect
        label={s.filterProcess}
        icon={<Layers aria-hidden="true" className="h-4 w-4" />}
        options={[
          { id: 'fdm', label: s.processFdm },
          { id: 'resin', label: s.processResin },
        ]}
        value={values.process}
        onChange={(v) => onChange('process', v)}
      />
      <FilterSelect label={s.filterGovernorate} icon={<MapPin aria-hidden="true" className="h-4 w-4" />} options={govs} value={values.governorate} onChange={(v) => onChange('governorate', v)} />
    </div>
  );
}

/**
 * The next page as the list end comes into view, and «المزيد» for everyone
 * else: the button stays (a keyboard, a failed page, no observer).
 */
export function PageSentinel({ more, busy, failed, onMore, s }: { more: boolean; busy: boolean; failed: boolean; onMore: () => void; s: RequestStrings }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const latest = useRef(onMore);
  latest.current = onMore;
  useEffect(() => {
    const el = ref.current;
    if (!el || !more || busy || failed || typeof IntersectionObserver !== 'function') return;
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) latest.current();
    }, { rootMargin: '400px 0px' });
    io.observe(el);
    return () => io.disconnect();
  }, [more, busy, failed]);
  if (!more) return null;
  return (
    <div ref={ref} data-requests-sentinel>
      <button type="button" onClick={onMore} disabled={busy} data-requests-more className={kitButtonClass('secondary', 'md', true)}>
        {busy ? s.loadingMore : failed ? s.loadMoreFailed : s.loadMore}
      </button>
    </div>
  );
}
