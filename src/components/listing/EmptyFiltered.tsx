import React, { useEffect, useState } from 'react';
import { SearchX } from 'lucide-react';
import { useLanguage } from '../../LanguageContext';
import { api, type ProductsListResponse } from '../../lib/api';
import { listingApiQuery, serializeListing } from '../../lib/catalog/listingQuery';
import type { UndoOption } from '../../lib/catalog/listingModel';
import { countNoun, type NounKind } from '../../lib/catalog/copy';
import type { ListingState } from '../../lib/catalog/types';

/**
 * ZERO RESULTS, WITH A WAY BACK (§7 «Empty result»): «لا توجد طابعات بهذه
 * الشروط», then one line per active filter — «أزل "24 لونًا فأكثر"» — with the
 * number of products removing it would bring back («← 4 طابعات»), and
 * «مسح الكل». The counts are real: one small request per filter, in parallel,
 * each for the state without that filter. A line whose removal still gives
 * nothing says so and sinks to the end; the best way back is first.
 */
export default function EmptyFiltered({
  options,
  category,
  kind,
  onChange,
  onClear,
}: {
  options: UndoOption[];
  category: string | null;
  kind: NounKind;
  onChange: (next: ListingState) => void;
  onClear: () => void;
}) {
  const { lang, loc } = useLanguage();
  const [counts, setCounts] = useState<Record<string, number>>({});
  const signature = options.map((o) => `${o.group}=${serializeListing(o.next)}`).join('|');

  useEffect(() => {
    const ctrl = new AbortController();
    setCounts({});
    for (const o of options.slice(0, 8)) {
      api
        .get<ProductsListResponse>(`/api/products?${listingApiQuery(o.next, { category: category ?? undefined, limit: 1, facets: true })}`, {
          signal: ctrl.signal,
          mascot: 'silent',
        })
        .then((res) => {
          const n = typeof res.total === 'number' ? res.total : (res.products ?? []).length;
          setCounts((c) => ({ ...c, [o.group]: n }));
        })
        .catch(() => undefined);
    }
    return () => ctrl.abort();
    // The options are rebuilt every render; their serialisation is the identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature, category]);

  const sorted = [...options].sort((a, b) => (counts[b.group] ?? -1) - (counts[a.group] ?? -1));
  const noun = kind === 'printer' ? loc('لا توجد طابعات بهذه الشروط', 'No printers match these filters') : loc('لا توجد منتجات بهذه الشروط', 'No products match these filters');
  // OWNER: Sorani to be written by hand (every loc() in this file without a third argument).

  return (
    <div data-empty-filtered role="status" className="mx-auto flex max-w-[440px] flex-col items-center py-10 text-center">
      <span aria-hidden="true" className="grid size-12 place-items-center rounded-2xl bg-surface-selected text-text-secondary">
        <SearchX className="size-6" />
      </span>
      <h2 className="mt-3 text-[16px] font-extrabold text-text-primary">{noun}</h2>
      <p className="mt-1 text-[13px] leading-5 text-text-muted">{loc('أزل أحد عوامل التصفية لترى ما يقاربها:', 'Remove one filter to see what comes close:')}</p>
      <ul className="mt-4 w-full overflow-hidden rounded-2xl border border-border-subtle bg-surface text-start">
        {sorted.map((o) => {
          const n = counts[o.group];
          return (
            <li key={o.group} className="border-b border-border-subtle last:border-b-0">
              <button
                type="button"
                data-undo={o.group}
                onClick={() => onChange(o.next)}
                className="flex min-h-[52px] w-full items-center gap-3 px-4 text-start transition-colors hover:bg-surface-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus"
              >
                <span className="min-w-0 flex-1 text-[13.5px] font-bold text-text-primary">
                  {loc('أزل', 'Remove')} «<bdi>{o.label}</bdi>»
                </span>
                <span className={`shrink-0 text-[12.5px] tabular-nums ${n ? 'font-bold text-success' : 'text-text-muted'}`}>
                  {n === undefined ? '…' : n === 0 ? loc('لا شيء أيضًا', 'still none') : `${lang === 'en' ? '→' : '←'} ${countNoun(n, kind, lang)}`}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      <button
        type="button"
        onClick={onClear}
        className="lv-button lv-button-secondary mt-4"
      >
        {loc('مسح كل عوامل التصفية', 'Clear every filter')}
      </button>
    </div>
  );
}
