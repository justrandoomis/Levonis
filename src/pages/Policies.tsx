/**
 * THE POLICY LIBRARY — /policies, and /policies/:key#art-4-2.
 *
 * WHO OPENS THIS PAGE. Three people, and the page owes each of them something
 * different. Somebody deciding whether to buy wants one answer before they
 * commit, and finds it by section. Somebody mid-argument wants ONE clause and
 * wants to send it, which is why search reaches the article and why every
 * article has a link of its own. And the owner wants to show a document to a
 * customer, a courier or a bank, which is why the version, the date it took
 * effect and a clean printed copy are first-class and not an afterthought.
 *
 * IT IS A LIBRARY, NOT A MARKETING PAGE. Eighteen documents grouped by the
 * registry's own six sections, each stating its own scope in its own words;
 * nothing here summarises, softens or sells a policy.
 *
 * THERE IS NO AUTHORING SURFACE, and that is the point.
 * The seed / prepare-terms / edit / publish / preview panel that used to live
 * here is gone, with every string that supported it. Policy text is written in
 * worker/lib/policies/ and deployed; the endpoints it called no longer exist.
 * The owner's instruction was «يستطيع أي أحد التعديل عليها لا أريد ذلك» — that
 * anyone could edit them, and they did not want that — and a page that cannot
 * write is the only honest way to answer it.
 *
 * WHAT THE URL MEANS, because other pages depend on all three parts:
 *   /policies                     the library index
 *   /policies/:key                one document, current version
 *   /policies/:key?version=N      one ARCHIVED version, never silently today's
 *   /policies/:key?lang=en        one document in a named language
 *   /policies/:key#art-4-2        one ARTICLE of it
 * Checkout links the first three (src/pages/Checkout.tsx), the product page
 * and the cart link the extended-warranty terms, and settings and sign-up link
 * the index.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { ChevronLeft, Library, Link2, Printer, ShieldCheck } from 'lucide-react';
import { useLanguage } from '../LanguageContext';
import { ApiError } from '../lib/api';
import { useMotion } from '../lib/motion';
import { useGoBack } from '../lib/useGoBack';
import { parsePolicyVersion, policyOutline } from '../lib/policyReader';
import { ErrorState } from '../components/ui/AsyncStates';
import Spinner from '../components/ui/Spinner';
import { Segmented } from '../components/ui/Segmented';
import PolicyLibrary from '../components/policies/PolicyLibrary';
import PolicyOutline from '../components/policies/PolicyOutline';
import PolicyPrintStyles from '../components/policies/PolicyPrintStyles';
import PolicyProse from '../components/policies/PolicyProse';
import { PolicySearchField, PolicySearchResults } from '../components/policies/PolicySearch';
import { formatPolicyDate, usePolicyStrings } from '../components/policies/policyStrings';
import { fetchPolicyDoc, usePolicyCorpus, usePolicyLibrary, type PolicyDoc } from '../components/policies/usePolicyCorpus';

const DOC_LANGS = ['ar', 'en', 'ckb'] as const;
type DocLang = (typeof DOC_LANGS)[number];

const asDocLang = (raw: string | null): DocLang | null =>
  raw === 'ar' || raw === 'en' || raw === 'ckb' ? raw : null;

/** The standing statement that the Arabic text governs. */
function GoverningNote({ text, className = '' }: { text: string; className?: string }) {
  return (
    <p className={`lv-alert lv-alert-info text-[13px] leading-[1.8] text-text-secondary ${className}`}>
      {text}
    </p>
  );
}

export default function Policies() {
  const { key: routeKey } = useParams<{ key: string }>();
  const { lang, dir } = useLanguage();
  const s = usePolicyStrings();
  const m = useMotion();
  const navigate = useNavigate();
  const location = useLocation();
  const goBack = useGoBack('/');
  const [searchParams] = useSearchParams();

  const { version: requestedVersion, valid: validVersion } = parsePolicyVersion(searchParams.get('version'));
  // The document's language is its own: a reader may keep the interface in
  // Arabic and show an English copy to a courier without the app changing
  // under them. Absent a `?lang`, it follows the interface.
  const docLang: DocLang = asDocLang(searchParams.get('lang')) ?? (asDocLang(lang) ?? 'ar');
  // A pasted link can carry a malformed escape («#100%»), and
  // `decodeURIComponent` throws on one — during render, which would blank the
  // page for a reader whose only mistake was copying a URL badly. The raw
  // fragment simply fails to match an anchor, which is the right outcome.
  const anchor = useMemo(() => {
    const raw = location.hash.replace(/^#/, '');
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  }, [location.hash]);

  const library = usePolicyLibrary();
  const [query, setQuery] = useState('');
  const [doc, setDoc] = useState<PolicyDoc | null>(null);
  const [docError, setDocError] = useState<unknown>(null);
  const [docLoading, setDocLoading] = useState(false);
  const [copiedDoc, setCopiedDoc] = useState(false);
  const [attempt, setAttempt] = useState(0);
  // A stale response from a document the reader has already navigated away
  // from must never replace the one they are looking at.
  const sequence = useRef(0);

  // The corpus is what search and the index summaries are built from, and it
  // is loaded ONLY on the index, where both of them live. A reader who
  // followed a link to one article wants that article; making them download
  // the other seventeen documents to read it would be a few hundred kilobytes
  // spent on nothing they asked for. The cache is shared, so opening a
  // document after browsing the index costs no request at all.
  const corpusEnabled = !routeKey && library.list.length > 0;
  const corpus = usePolicyCorpus(library.list, docLang, corpusEnabled);

  useEffect(() => {
    if (!routeKey) {
      setDoc(null);
      setDocError(null);
      setDocLoading(false);
      return;
    }
    if (!validVersion) {
      setDoc(null);
      setDocError(null);
      setDocLoading(false);
      return;
    }
    const mine = ++sequence.current;
    setDoc(null);
    setDocError(null);
    setDocLoading(true);
    fetchPolicyDoc(routeKey, requestedVersion, docLang)
      .then((policy) => {
        if (mine !== sequence.current) return;
        setDoc(policy);
        setDocLoading(false);
      })
      .catch((error: unknown) => {
        if (mine !== sequence.current) return;
        setDocError(error);
        setDocLoading(false);
      });
    return () => { sequence.current += 1; };
  }, [routeKey, requestedVersion, docLang, validVersion, attempt]);

  const headings = useMemo(() => (doc ? policyOutline(doc.body) : []), [doc]);

  // Arriving at /policies/:key#art-4-2 has to LAND on article 4.2. The router
  // does not scroll for a fragment, and the app scrolls inside a container
  // rather than the window, so `scrollIntoView` is what actually works here —
  // it walks every scrollable ancestor instead of assuming the document.
  useEffect(() => {
    if (!doc) return;
    if (!anchor) return;
    const target = document.getElementById(anchor);
    if (!target) return;
    target.scrollIntoView({ block: 'start', behavior: m.reduced ? 'auto' : 'smooth' });
  }, [doc, anchor, m.reduced]);

  // A new document opens at its beginning, not at the scroll position of the
  // one before it.
  useEffect(() => {
    if (anchor) return;
    document.getElementById('main-scroll-container')?.scrollTo({ top: 0 });
  }, [routeKey, anchor]);

  const setDocLang = useCallback(
    (next: string) => {
      const params = new URLSearchParams(searchParams);
      params.set('lang', next);
      navigate({ pathname: location.pathname, search: `?${params.toString()}`, hash: location.hash }, { replace: true });
    },
    [navigate, location.pathname, location.hash, searchParams]
  );

  const copyDocumentLink = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setCopiedDoc(true);
      setTimeout(() => setCopiedDoc(false), 2400);
    } catch {
      setCopiedDoc(false);
    }
  }, []);

  const searching = query.trim().length > 0;
  const showGoverning = docLang !== 'ar';

  // ------------------------------------------------------------- one document

  if (routeKey) {
    const title = doc?.title || library.list.find((p) => p.key === routeKey)?.titles[docLang] || '';
    const effective = formatPolicyDate(doc?.effective_at, docLang);
    // "Is this today's text?" is answered by the registry's current version for
    // this key, not by the archive row's own status: a superseded row keeps
    // `status='published'` on purpose (worker/lib/policySync.ts), so trusting
    // the status would show a customer a retired version with no warning.
    const current = library.list.find((p) => p.key === routeKey)?.version ?? null;
    const isArchived = doc !== null && (current !== null ? doc.version !== current : doc.status === 'archived');

    return (
      <div data-policy-print-root className="flex min-h-screen w-full flex-col bg-canvas font-sans">
        <PolicyPrintStyles />

        <header
          data-policy-screen-only
          className="sticky top-0 z-10 border-b border-border-subtle bg-canvas/92 backdrop-blur-md"
        >
          <div className="mx-auto flex w-full max-w-6xl items-center gap-2 px-4 py-2">
            <Link
              to="/policies"
              aria-label={s.toLibrary}
              className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-text-secondary transition-colors hover:bg-white/5 hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
            >
              <ChevronLeft aria-hidden="true" className="h-5 w-5 rtl:rotate-180" />
            </Link>
            <p className="min-w-0 flex-1 truncate text-[15px] font-bold leading-[1.5] text-text-primary">{title}</p>
            <button
              type="button"
              onClick={copyDocumentLink}
              aria-label={s.copyLink}
              className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-text-secondary transition-colors hover:bg-white/5 hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
            >
              <Link2 aria-hidden="true" className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={() => window.print()}
              aria-label={s.print}
              className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-text-secondary transition-colors hover:bg-white/5 hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
            >
              <Printer aria-hidden="true" className="h-4 w-4" />
            </button>
          </div>
          <p role="status" aria-live="polite" className="sr-only">{copiedDoc ? s.copied : ''}</p>
        </header>

        <div className="mx-auto w-full max-w-6xl flex-1 px-4 py-6">
          {!validVersion && (
            <div role="status" data-policy-notice className="lv-alert lv-alert-warning mb-6 text-[13px] leading-[1.8] text-text-secondary">
              {s.invalidVersion}
            </div>
          )}

          {docLoading && (
            <p role="status" className="flex items-center gap-2 py-10 text-[14px] leading-[1.7] text-text-secondary">
              <Spinner size="sm" decorative />
              {s.loading}
            </p>
          )}

          {docError !== null &&
            (docError instanceof ApiError && docError.status === 404 ? (
              // Not an error page: the store simply has no document by that
              // name, and the reader's next move is the library, not a retry.
              <div role="status" data-policy-notice className="py-10 text-center">
                <p className="text-[15px] leading-[1.8] text-text-primary">{s.notFound}</p>
                <Link
                  to="/policies"
                  className="lv-button lv-button-secondary mt-4 inline-flex"
                >
                  {s.toLibrary}
                </Link>
              </div>
            ) : (
              <ErrorState error={docError} onRetry={() => setAttempt((n) => n + 1)} />
            ))}

          {doc && (
            <article dir={doc.lang === 'en' ? 'ltr' : 'rtl'} lang={doc.lang}>
              {/* Printed masthead: the facts a document handed to a third party
                  has to carry on paper — which version, from when, and from
                  where it was taken. */}
              <div data-policy-print-only className="mb-6 border-b border-border-subtle pb-4">
                <h1 className="text-[18px] font-bold leading-[1.5] text-text-primary">{doc.title}</h1>
                <p dir="ltr" className="mt-1 font-mono text-[11px] leading-[1.7] text-text-muted text-start">
                  {s.version} {doc.version}
                  {effective ? ` · ${s.effective}: ${effective}` : ''}
                </p>
                <p dir="ltr" className="font-mono text-[10px] leading-[1.7] text-text-muted text-start">
                  {s.printedFrom}: {typeof window === 'undefined' ? '' : window.location.href}
                </p>
                {/* On paper the governing statement travels with EVERY copy,
                    in every language: the person holding a printed English
                    page has no other way to learn that the Arabic governs. */}
                <p className="mt-2 text-[11px] leading-[1.8] text-text-secondary">{s.governing}</p>
              </div>

              <header data-policy-screen-only className="mb-7">
                <h1 className="text-[24px] font-bold leading-[1.45] text-text-primary sm:text-[28px]">{doc.title}</h1>
                <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
                  <p dir="ltr" className="font-mono text-[12px] leading-[1.7] text-text-muted text-start">
                    {s.version} {doc.version}
                    {effective ? ` · ${s.effective}: ${effective}` : ''}
                  </p>
                  {doc.required_for_checkout && (
                    <span
                      title={s.requiredExplain}
                      className="inline-flex items-center gap-1 rounded-full bg-gold/12 px-2 py-1 text-[10px] font-bold leading-[1.4] text-gold"
                    >
                      <ShieldCheck aria-hidden="true" className="h-3 w-3" />
                      {s.requiredBadge}
                    </span>
                  )}
                </div>

                <div className="mt-4 max-w-sm">
                  <Segmented
                    group="policy-doc-lang"
                    label={s.readingLang}
                    value={docLang}
                    onChange={setDocLang}
                    dataAttr="data-policy-lang"
                    items={DOC_LANGS.map((code) => ({ id: code, label: s.langName[code] }))}
                  />
                </div>

                {isArchived && (
                  <p role="status" className="lv-alert lv-alert-warning mt-4 text-[13px] leading-[1.8] text-text-secondary">
                    {s.historical(doc.version)}
                  </p>
                )}
                {doc.lang !== doc.lang_requested && (
                  <p role="status" className="lv-alert lv-alert-warning mt-4 text-[13px] leading-[1.8] text-text-secondary">
                    {s.langFallback}
                  </p>
                )}
                {showGoverning && doc.lang === doc.lang_requested && <GoverningNote text={s.governing} className="mt-4" />}
              </header>

              <div className="lg:grid lg:grid-cols-[17rem_minmax(0,1fr)] lg:gap-10">
                <PolicyOutline headings={headings} policyKey={doc.key} version={requestedVersion} activeAnchor={anchor} />
                <PolicyProse body={doc.body} policyKey={doc.key} version={requestedVersion} activeAnchor={anchor} />
              </div>
            </article>
          )}
        </div>
      </div>
    );
  }

  // --------------------------------------------------------- the library index

  return (
    <div className="flex min-h-screen w-full flex-col bg-canvas font-sans" dir={dir}>
      <header className="sticky top-0 z-10 border-b border-border-subtle bg-canvas/92 backdrop-blur-md">
        <div className="mx-auto flex w-full max-w-5xl items-center gap-2 px-4 py-2">
          <button
            type="button"
            onClick={goBack}
            aria-label={s.back}
            className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-text-secondary transition-colors hover:bg-white/5 hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
          >
            <ChevronLeft aria-hidden="true" className="h-5 w-5 rtl:rotate-180" />
          </button>
          <h1 className="min-w-0 flex-1 truncate text-[16px] font-bold leading-[1.5] text-text-primary">
            {s.libraryTitle}
          </h1>
          <Library aria-hidden="true" className="h-5 w-5 shrink-0 text-gold" />
        </div>
      </header>

      <div className="mx-auto w-full max-w-5xl flex-1 px-4 py-6">
        <p className="mb-5 max-w-[62ch] text-[14px] leading-[1.9] text-text-secondary">{s.libraryIntro}</p>

        {/* The governing statement belongs where a reader in another language
            will actually meet it: on the index they are browsing, before they
            open anything. */}
        {showGoverning && <GoverningNote text={s.governing} className="mb-5" />}

        <div className="mb-8">
          <PolicySearchField
            query={query}
            onQuery={setQuery}
            loading={corpus.loading && corpus.total > 0}
            loaded={corpus.loaded}
            total={corpus.total}
          />
        </div>

        {library.loading ? (
          <p role="status" className="flex items-center gap-2 py-10 text-[14px] leading-[1.7] text-text-secondary">
            <Spinner size="sm" decorative />
            {s.loading}
          </p>
        ) : library.error !== null ? (
          <ErrorState error={library.error} onRetry={library.reload} />
        ) : searching ? (
          <PolicySearchResults articles={corpus.articles} query={query} loading={corpus.loading} />
        ) : (
          <>
            <p className="mb-4 text-[12px] leading-[1.7] text-text-muted">{s.documentCount(library.list.length)}</p>
            <PolicyLibrary sections={library.sections} list={library.list} summaries={corpus.summaries} lang={docLang} />
          </>
        )}
      </div>
    </div>
  );
}
