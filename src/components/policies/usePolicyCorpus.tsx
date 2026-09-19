/**
 * LOADING THE LIBRARY — the list first, the eighteen documents behind it.
 *
 * WHY THE WHOLE CORPUS IS FETCHED AT ALL. Two things on this page need text
 * the list endpoint does not carry: the line on each card saying what that
 * document governs, which is quoted from the document's own preamble rather
 * than written for the card, and the search, which has to reach every article
 * in the library or it is not a search. The API serves policies one document
 * at a time and there is no corpus endpoint, so the reader assembles one.
 *
 * AND WHY THAT IS AFFORDABLE. The documents are compile-time constants served
 * from the registry, so this is a few hundred kilobytes of text — about one
 * product photograph — fetched once per language and held for the life of the
 * tab. It is scheduled on an idle callback so it never competes with the first
 * paint or with the document the reader actually opened, it runs three at a
 * time rather than eighteen so a phone on a weak connection is not stalled by
 * its own request queue, and the page stays useful throughout: the index is on
 * screen from the first response, and search says plainly that it covers what
 * has arrived so far.
 *
 * THE CACHE IS KEYED BY DOCUMENT AND LANGUAGE, not by language alone, so
 * opening a document the corpus pass already fetched is instant, and switching
 * language and back does not re-download what is still in hand.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../lib/api';
import { indexPolicyDocument, policySummary, type PolicyArticle } from '../../lib/policyReader';

export interface PolicyListItem {
  key: string;
  version: number;
  effective_at: string | null;
  titles: Record<string, string>;
  section: string | null;
  required_for_checkout: boolean;
}

export interface PolicySectionItem {
  id: string;
  titles: Record<string, string>;
  keys: string[];
}

export interface PolicyDoc {
  key: string;
  version: number;
  lang: string;
  lang_requested: string;
  title: string;
  body: string;
  hash: string;
  status: string;
  published_at: string | null;
  effective_at: string | null;
  section: string | null;
  required_for_checkout: boolean;
}

/** One entry per (key, version, language) actually served. */
const DOC_CACHE = new Map<string, PolicyDoc>();
/** The article index of a cached document, built once and reused per keystroke. */
const INDEX_CACHE = new Map<string, PolicyArticle[]>();

const cacheKey = (key: string, version: number | null, lang: string) =>
  `${key}@${version ?? 'current'}:${lang}`;

/** The document as served, from the cache when it is already in hand. */
export async function fetchPolicyDoc(key: string, version: number | null, lang: string): Promise<PolicyDoc> {
  const id = cacheKey(key, version, lang);
  const cached = DOC_CACHE.get(id);
  if (cached) return cached;
  const locale = lang === 'en' || lang === 'ckb' ? lang : 'ar';
  const url = `/api/policies/${encodeURIComponent(key)}?lang=${locale}${version === null ? '' : `&version=${version}`}`;
  const data = await api.get<{ policy: PolicyDoc }>(url);
  DOC_CACHE.set(id, data.policy);
  return data.policy;
}

function articlesOf(doc: PolicyDoc, version: number | null): PolicyArticle[] {
  const id = cacheKey(doc.key, version, doc.lang);
  let articles = INDEX_CACHE.get(id);
  if (!articles) {
    articles = indexPolicyDocument(doc.key, doc.title, doc.body);
    INDEX_CACHE.set(id, articles);
  }
  return articles;
}

/** Run at most `width` promises at once, in order, stopping when cancelled. */
async function pool<T>(items: readonly T[], width: number, run: (item: T) => Promise<void>, cancelled: () => boolean) {
  let next = 0;
  const worker = async () => {
    while (!cancelled()) {
      const i = next++;
      if (i >= items.length) return;
      await run(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(width, items.length) }, worker));
}

/** `requestIdleCallback` where it exists; a short timer where it does not. */
function onIdle(fn: () => void): () => void {
  const ric = (window as unknown as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number }).requestIdleCallback;
  if (typeof ric === 'function') {
    const handle = ric(fn, { timeout: 1200 });
    const cancel = (window as unknown as { cancelIdleCallback?: (h: number) => void }).cancelIdleCallback;
    return () => cancel?.(handle);
  }
  const timer = setTimeout(fn, 200);
  return () => clearTimeout(timer);
}

export interface PolicyLibrary {
  sections: PolicySectionItem[];
  list: PolicyListItem[];
  loading: boolean;
  error: unknown;
  reload: () => void;
}

/** The index: every document the code publishes, grouped into its sections. */
export function usePolicyLibrary(): PolicyLibrary {
  const [state, setState] = useState<{ sections: PolicySectionItem[]; list: PolicyListItem[]; loading: boolean; error: unknown }>({
    sections: [],
    list: [],
    loading: true,
    error: null,
  });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setState((s) => ({ ...s, loading: true, error: null }));
    api
      .get<{ sections: PolicySectionItem[]; policies: PolicyListItem[] }>('/api/policies')
      .then((data) => {
        if (cancelled) return;
        setState({ sections: data.sections, list: data.policies, loading: false, error: null });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setState({ sections: [], list: [], loading: false, error });
      });
    return () => { cancelled = true; };
  }, [attempt]);

  const reload = useCallback(() => setAttempt((n) => n + 1), []);
  return { ...state, reload };
}

export interface PolicyCorpus {
  /** Every article of every document loaded so far, in registry order. */
  articles: PolicyArticle[];
  /** key → the line that document's own preamble uses to state its scope. */
  summaries: Record<string, string>;
  loaded: number;
  total: number;
  /** True while documents are still arriving, so search can say so. */
  loading: boolean;
}

/**
 * The corpus behind the index and the search.
 *
 * `enabled` is what keeps this off the critical path: the page turns it on
 * once its own first request has settled, so a reader who tapped straight
 * through to one document is never made to wait behind seventeen others.
 */
export function usePolicyCorpus(list: readonly PolicyListItem[], lang: string, enabled: boolean): PolicyCorpus {
  const [state, setState] = useState<{ articles: PolicyArticle[]; summaries: Record<string, string>; loaded: number }>({
    articles: [],
    summaries: {},
    loaded: 0,
  });
  const total = list.length;
  // The list identity changes on every reload; its keys are what actually
  // decides the work, so the effect depends on those rather than the array.
  const keys = list.map((p) => p.key).join(',');
  const cancelRef = useRef(false);

  useEffect(() => {
    setState({ articles: [], summaries: {}, loaded: 0 });
    if (!enabled || total === 0) return;
    cancelRef.current = false;
    const cancelled = () => cancelRef.current;

    const stopIdle = onIdle(() => {
      void pool(
        list,
        3,
        async (item) => {
          try {
            const doc = await fetchPolicyDoc(item.key, null, lang);
            if (cancelled()) return;
            const articles = articlesOf(doc, null);
            setState((s) => ({
              articles: [...s.articles, ...articles],
              summaries: { ...s.summaries, [doc.key]: policySummary(doc.body) },
              loaded: s.loaded + 1,
            }));
          } catch {
            // One document that will not load must not stop the other
            // seventeen: the index still lists it and it still opens on its
            // own page, where the failure is reported properly.
            if (!cancelled()) setState((s) => ({ ...s, loaded: s.loaded + 1 }));
          }
        },
        cancelled
      );
    });

    return () => {
      cancelRef.current = true;
      stopIdle();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keys, lang, enabled, total]);

  return { ...state, total, loading: state.loaded < total };
}
