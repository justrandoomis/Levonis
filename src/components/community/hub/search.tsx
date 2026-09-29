/**
 * THE SEARCH'S TWO LINES — «3 نتائج لـ «تنين»» above a list, and the empty
 * answer with the way back — shared by every searchable panel of the home.
 */
import { PackageSearch } from 'lucide-react';
import { useLanguage } from '../../../LanguageContext';
import { EmptyState } from '../../ui/AsyncStates';
import { fill, hubLang, resultsCount, useHubStrings } from './strings';

/** «3 نتائج لـ «تنين»» — the search's answer, above the list it describes. */
export function SearchLine({ q, total }: { q: string; total: number | null }) {
  const { lang } = useLanguage();
  const s = useHubStrings();
  if (!q || total === null) return null;
  return (
    <p role="status" className="mb-3 text-[12.5px] text-text-secondary">
      {fill(s.resultsFor, { n: resultsCount(total, hubLang(lang)), q })}
    </p>
  );
}

/** A search that found nothing — say so, and offer the way back. */
export function NoResults({ q, onClear }: { q: string; onClear: () => void }) {
  const s = useHubStrings();
  return (
    <EmptyState
      icon={<PackageSearch aria-hidden="true" className="h-6 w-6" />}
      title={fill(s.noResults, { q })}
      description={s.noResultsHint}
      action={
        <button type="button" onClick={onClear} className="lv-button lv-button-secondary lv-button-sm mt-1">
          {s.clearSearch}
        </button>
      }
    />
  );
}
