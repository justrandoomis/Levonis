/**
 * SEARCH ACROSS THE WHOLE LIBRARY, down to the article.
 *
 * THE READER THIS IS FOR is mid-argument. They do not want the Returns
 * document, they want the line about the carton, and they want to be able to
 * send it. So a result is an ARTICLE, not a document: it names the document it
 * belongs to, shows the sentence that matched, and its link opens that exact
 * clause.
 *
 * THE MATCHING IS THE SHOP'S, NOT A NEW ONE. Folding, tokenising and typo
 * tolerance all come from worker/lib/search via src/lib/policyReader, so «الحدود»
 * finds «حدود» and «الكارتون» finds «الكرتون» for the same reason and by the
 * same table that makes «طابعه» find «طابعة» in the catalogue. Writing a second
 * fold here is how the two would drift.
 *
 * TYPING IS DEBOUNCED, NOT THROTTLED. The index is already built, so a search
 * is a scan over a few thousand pre-folded token sets; the delay exists so a
 * fast typist's intermediate words are never scanned at all, not because one
 * scan is slow.
 */
import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Search, X } from 'lucide-react';
import Spinner from '../ui/Spinner';
import {
  policyArticleHref,
  policyHighlight,
  policyQueryTokens,
  searchPolicyIndex,
  type PolicyArticle,
} from '../../lib/policyReader';
import { usePolicyStrings } from './policyStrings';

function Highlighted({ text, tokens }: { text: string; tokens: string[] }) {
  return (
    <>
      {policyHighlight(text, tokens).map((part, i) =>
        part.hit ? (
          <mark key={i} className="rounded-[3px] bg-gold/25 px-0.5 text-text-primary">{part.text}</mark>
        ) : (
          <span key={i}>{part.text}</span>
        )
      )}
    </>
  );
}

export interface PolicySearchProps {
  articles: PolicyArticle[];
  loading: boolean;
  loaded: number;
  total: number;
  query: string;
  onQuery: (value: string) => void;
}

export function PolicySearchField({ query, onQuery, loading, loaded, total }: Omit<PolicySearchProps, 'articles'>) {
  const s = usePolicyStrings();
  const input = useRef<HTMLInputElement>(null);

  return (
    <div className="print:hidden">
      <div className="relative">
        <Search aria-hidden="true" className="pointer-events-none absolute top-1/2 h-4 w-4 -translate-y-1/2 text-text-muted start-3.5" />
        <input
          ref={input}
          type="search"
          value={query}
          onChange={(e) => onQuery(e.target.value)}
          placeholder={s.searchPlaceholder}
          aria-label={s.searchLabel}
          data-policy-search
          // `ps-11`/`pe-12` rather than left/right padding: the magnifier sits
          // at the start of the line in both writing directions.
          className="lv-input ps-11 pe-12 text-[15px] leading-[1.6]"
        />
        {query && (
          <button
            type="button"
            onClick={() => { onQuery(''); input.current?.focus(); }}
            aria-label={s.searchClear}
            className="absolute top-1/2 inline-flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full text-text-muted transition-colors hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus end-0.5"
          >
            <X aria-hidden="true" className="h-4 w-4" />
          </button>
        )}
      </div>
      {loading && (
        <p role="status" className="mt-2 flex items-center gap-2 text-[12px] leading-[1.7] text-text-muted">
          <Spinner size="xs" decorative delayMs={0} />
          {s.searchLoading(loaded, total)}
        </p>
      )}
    </div>
  );
}

export function PolicySearchResults({ articles, query, loading }: { articles: PolicyArticle[]; query: string; loading: boolean }) {
  const s = usePolicyStrings();
  // `useDeferredValue` keeps the field itself responsive while the scan runs:
  // the input paints the new character immediately and the list catches up,
  // which is the difference between a search that feels instant on a phone
  // and one that drops characters.
  const deferred = useDeferredValue(query);
  const hits = useMemo(() => searchPolicyIndex(articles, deferred), [articles, deferred]);
  const tokens = useMemo(() => policyQueryTokens(deferred), [deferred]);

  // Announce the count once the list has settled, not on every keystroke.
  const [announced, setAnnounced] = useState('');
  useEffect(() => {
    const timer = setTimeout(() => setAnnounced(hits.length > 0 ? s.searchResults(hits.length) : s.searchEmpty), 500);
    return () => clearTimeout(timer);
  }, [hits.length, s]);

  return (
    <section aria-label={s.searchLabel} className="print:hidden">
      <p role="status" aria-live="polite" className="sr-only">{announced}</p>
      <div className="mb-4 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 className="text-[13px] font-bold leading-[1.6] text-text-secondary">
          {hits.length > 0 ? s.searchResults(hits.length) : s.searchEmpty}
        </h2>
        {loading && <span className="text-[12px] leading-[1.7] text-text-muted">{s.searchPartial}</span>}
      </div>

      {hits.length === 0 ? (
        <p className="lv-surface p-4 text-[13px] leading-[1.8] text-text-muted">{s.searchEmptyHint}</p>
      ) : (
        <ol className="space-y-2">
          {hits.map((hit) => (
            <li key={`${hit.key}#${hit.anchor}`}>
              <Link
                to={policyArticleHref(hit.key, hit.anchor)}
                data-policy-hit={`${hit.key}#${hit.anchor}`}
                className="lv-surface block rounded-[var(--radius-lg)] p-4 transition-colors hover:border-gold/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
              >
                <p className="mb-1 flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-[11px] leading-[1.6] text-text-muted">
                  <span className="font-bold text-gold">{hit.docTitle}</span>
                  {hit.part && <span className="truncate">· {hit.part}</span>}
                </p>
                <p className="text-[14px] font-bold leading-[1.6] text-text-primary">
                  {hit.number && <span dir="ltr" className="me-1.5 font-mono text-[12px] leading-[1.6] text-gold">{s.article} {hit.number}</span>}
                  <Highlighted text={hit.heading} tokens={tokens} />
                </p>
                {hit.snippet && (
                  <p className="mt-1.5 line-clamp-3 text-[13px] leading-[1.85] text-text-secondary">
                    <Highlighted text={hit.snippet} tokens={tokens} />
                  </p>
                )}
              </Link>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
