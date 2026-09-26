import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Scale, WifiOff } from 'lucide-react';
import { useAuth } from '../../AuthContext';
import { api, ApiError, isAborted } from '../../lib/api';
import { compareTray, compareHref } from '../../lib/compareTray';
import { productPrimaryImage } from '../../lib/productImage';
import { cardName, compareTypeOf, type CardProduct } from '../../lib/productCard';
import { useSignInPrompt } from '../../lib/guest';
import type { FinderAnswers } from '../../../packages/catalog/src/discovery';
import type { FinderMeta } from '../../../packages/catalog/src/discoveryTypes';
import type { FinderResponse } from '../../lib/catalog/types';
import { Button } from '../ui/Button';
import AnsweredChips from './AnsweredChips';
import ExclusionDisclosure from './ExclusionDisclosure';
import HumanHelpBand from './HumanHelpBand';
import { ResultHero, ResultRow, ResultSkeleton } from './ResultCards';
import { fetchFinderResults, supportHref } from './data';
import { STEPS, type StepKey } from './flow';
import { TECH_COPY, coverageLabel, optionCopy, resultsUi, type FinderLang } from './strings';

/**
 * THE RESULTS (mockup 7; CATALOG_DISCOVERY §8 «Results» and «States»).
 *
 * One call — `GET /api/printer-finder` with the six answers — and everything on
 * screen is that response: the order, every reason and caveat (codes rendered
 * by strings.ts), what was left out, and how much of the data covered each
 * priority. Nothing is scored, ranked or claimed here.
 *
 * States: loading (skeletons + «نبحث في 10 طابعات…»), none at all (support
 * first), an error (retry, answers kept), offline (said so, answers kept).
 */
export default function FinderResults({
  answers,
  meta,
  lang,
  headingRef,
  onEdit,
}: {
  answers: FinderAnswers;
  meta: FinderMeta | null;
  lang: FinderLang;
  headingRef: React.Ref<HTMLHeadingElement>;
  onEdit: (key: StepKey) => void;
}) {
  const t = resultsUi(lang);
  const navigate = useNavigate();
  const { isAuthenticated } = useAuth();
  const { signIn } = useSignInPrompt();
  const [data, setData] = useState<FinderResponse | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [attempt, setAttempt] = useState(0);
  const key = JSON.stringify(answers);

  useEffect(() => {
    const controller = new AbortController();
    setError(null);
    setData(null);
    fetchFinderResults(answers, { signal: controller.signal })
      .then((res) => setData(res))
      .catch((err) => {
        if (controller.signal.aborted || isAborted(err)) return;
        setError(err);
      });
    return () => controller.abort();
    // `key` is the answers' identity; the object itself is new every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, attempt]);

  // --------------------------------------------------------------- saving
  const [saved, setSaved] = useState<Set<string>>(() => new Set());
  const [busy, setBusy] = useState<Set<string>>(() => new Set());
  const [saveError, setSaveError] = useState('');
  useEffect(() => {
    if (!isAuthenticated) {
      setSaved(new Set());
      return;
    }
    let cancelled = false;
    api
      .get<{ favorites: Array<{ id: string }> }>('/api/profile/favorites', { mascot: 'silent' })
      .then((res) => {
        if (!cancelled) setSaved(new Set((res.favorites ?? []).map((f) => String(f.id))));
      })
      .catch(() => {
        /* the hearts start empty rather than guessed */
      });
    return () => {
      cancelled = true;
    };
  }, [isAuthenticated]);

  const inFlight = useRef(new Set<string>());
  const toggleSave = useCallback(
    async (id: string) => {
      if (!isAuthenticated) {
        signIn();
        return;
      }
      if (inFlight.current.has(id)) return;
      inFlight.current.add(id);
      const was = saved.has(id);
      setSaveError('');
      setSaved((s) => {
        const n = new Set(s);
        if (was) n.delete(id);
        else n.add(id);
        return n;
      });
      setBusy((b) => new Set(b).add(id));
      try {
        if (was) await api.delete(`/api/profile/favorites/${encodeURIComponent(id)}`);
        else await api.put(`/api/profile/favorites/${encodeURIComponent(id)}`);
      } catch (err) {
        setSaved((s) => {
          const n = new Set(s);
          if (was) n.add(id);
          else n.delete(id);
          return n;
        });
        if (err instanceof ApiError && err.status === 401) signIn();
        else setSaveError(t.saveFailed);
      } finally {
        inFlight.current.delete(id);
        setBusy((b) => {
          const n = new Set(b);
          n.delete(id);
          return n;
        });
      }
    },
    [isAuthenticated, saved, signIn, t.saveFailed]
  );

  // -------------------------------------------------------- compare them all
  const results = useMemo(() => data?.results ?? [], [data]);
  const comparable = useMemo(() => {
    const type = results.map((r) => compareTypeOf(r.card as CardProduct)).find(Boolean) ?? null;
    return {
      type,
      items: results
        .filter((r) => compareTypeOf(r.card as CardProduct) === type)
        .map((r) => {
          const p = r.card as CardProduct;
          return { id: p.id, slug: p.slug || p.id, name: cardName(p), image: productPrimaryImage(p) || '' };
        }),
    };
  }, [results]);
  const compareAll = () => {
    if (!comparable.type || comparable.items.length < 2) return;
    compareTray.replaceAll(comparable.items, comparable.type);
    navigate(compareHref({ items: comparable.items }));
  };

  // ------------------------------------------------------------------ render
  const chips = (
    <AnsweredChips
      answers={answers}
      keys={[...STEPS]}
      lang={lang}
      onEdit={onEdit}
      trailing={
        <button
          type="button"
          onClick={() => onEdit('use')}
          className="inline-flex min-h-9 items-center rounded-full px-2 text-[13px] font-bold text-gold underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
        >
          {t.edit}
        </button>
      }
    />
  );
  const help = <HumanHelpBand title={t.helpTitle} body={t.helpBody} cta={t.helpCta} to={supportHref(answers)} />;

  const loading = !data && !error;
  const none = !!data && results.length === 0;
  const offline = !!error && typeof navigator !== 'undefined' && navigator.onLine === false;
  const title = loading || error ? t.label : none ? t.noneTitle : t.title(results.length);

  const coverage = (data?.coverage ?? []).filter((c) => c.total > 0 && c.known < c.total);
  const [first, ...rest] = results;

  return (
    <div className="flex flex-col gap-5" aria-busy={loading}>
      <header>
        <h1
          ref={headingRef}
          tabIndex={-1}
          className="text-[28px] font-extrabold leading-[36px] tracking-[-0.015em] text-text-primary outline-none sm:text-[32px] sm:leading-[42px]"
        >
          {title}
        </h1>
        {!none && !error ? <p className="mt-2 text-[13.5px] leading-[22px] text-text-secondary">{t.honesty}</p> : null}
        <div className="mt-4">{chips}</div>
      </header>

      {loading ? (
        <div className="flex flex-col gap-3">
          <p aria-live="polite" className="text-[13px] font-semibold text-text-muted">
            {t.searching(meta?.total ?? null)}
          </p>
          <ResultSkeleton hero />
          <ResultSkeleton />
          <ResultSkeleton />
        </div>
      ) : null}

      {error ? (
        <div role="alert" className="rounded-[20px] border border-border-subtle bg-surface p-5 text-center">
          {offline ? <WifiOff aria-hidden="true" className="mx-auto mb-2 size-6 text-text-muted" /> : null}
          <p className="text-[14px] font-bold text-text-primary">{offline ? t.offline : t.errorTitle}</p>
          <Button variant="secondary" className="mt-4" onClick={() => setAttempt((n) => n + 1)}>
            {t.retry}
          </Button>
        </div>
      ) : null}

      {none ? (
        <>
          <div className="rounded-[20px] border border-border-subtle bg-surface p-5">
            <p className="text-[14px] leading-[22px] text-text-secondary">
              {data && data.tech_matches === 0 && answers.tech && answers.tech !== 'any'
                ? t.noneTechBody(optionCopy(TECH_COPY, answers.tech, lang).title)
                : t.noneBody}
            </p>
          </div>
          {help}
        </>
      ) : null}

      {first && data && data.tech_matches === 0 && answers.tech && answers.tech !== 'any' ? (
        // The technology asked for is not sold here: support comes FIRST, and
        // the printers below are shown only as the labelled alternatives.
        <div data-support-first className="flex flex-col gap-3">
          <p className="rounded-[18px] border border-border-subtle bg-surface p-4 text-[14px] leading-[22px] text-text-secondary">
            {t.noneTechBody(optionCopy(TECH_COPY, answers.tech, lang).title)}
          </p>
          {help}
        </div>
      ) : null}

      {first ? (
        <>
          <div className="grid gap-3 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)] lg:items-start lg:gap-4">
            <ResultHero
              result={first}
              lang={lang}
              saved={saved.has(first.card.id)}
              saveBusy={busy.has(first.card.id)}
              onSave={() => void toggleSave(first.card.id)}
            />
            {rest.length ? (
              <div className="flex flex-col gap-3">
                {rest.map((r) => (
                  <ResultRow
                    key={r.card.id}
                    result={r}
                    lang={lang}
                    saved={saved.has(r.card.id)}
                    saveBusy={busy.has(r.card.id)}
                    onSave={() => void toggleSave(r.card.id)}
                  />
                ))}
              </div>
            ) : null}
          </div>
          {saveError ? (
            <p role="alert" className="text-[13px] font-semibold text-danger">
              {saveError}
            </p>
          ) : null}

          {comparable.items.length >= 2 ? (
            <button
              type="button"
              onClick={compareAll}
              className="inline-flex min-h-14 w-full items-center justify-center gap-2 rounded-[18px] border border-border-subtle bg-surface text-[15px] font-extrabold text-text-primary transition-[background-color,transform] duration-150 hover:bg-surface-raised active:scale-[0.99] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus motion-reduce:transition-none"
            >
              <Scale aria-hidden="true" className="size-[18px]" />
              {t.compareAll(comparable.items.length)}
            </button>
          ) : null}

          {coverage.length ? (
            <ul className="flex flex-col gap-1.5">
              {coverage.map((c) => (
                <li key={c.criterion} data-coverage={c.criterion} className="text-[12.5px] leading-[19px] text-text-muted">
                  {t.coverage(coverageLabel(c.field_id, c.criterion, lang), c.known, c.total)}
                </li>
              ))}
            </ul>
          ) : null}

          {data ? <ExclusionDisclosure excluded={data.excluded} anchorId={first.card.id} lang={lang} /> : null}
          {data && data.tech_matches === 0 && answers.tech && answers.tech !== 'any' ? null : help}
        </>
      ) : null}

      {error ? help : null}
    </div>
  );
}
