/**
 * «استيراد Bambu Lab» — THE OWNER'S IMPORT DASHBOARD (the Bambu import spec
 * §H.1, §H.2, §H.3). A lazy admin chunk, the products' sibling tab in the
 * catalogue section, reading the owner-only, read-only API:
 *
 *   GET /api/admin/catalog-import/runs                 the runs, newest first
 *   GET /api/admin/catalog-import/runs/:id             one run: state, times, the §15 progress
 *                                                      counts, the current item, the last
 *                                                      verified page, the measured rate, the ETA
 *                                                      (an estimate) and the GitHub run link
 *   GET /api/admin/catalog-import/runs/:id/items?state=&q=&cursor=   paged at 50
 *   GET /api/admin/catalog-import/items/:id            events, media rows, conflicts, missing
 *                                                      information by reason, quality counts, the
 *                                                      Worker's d1_checks beside the runner's
 *                                                      edge_evidence, the resume instruction
 *   GET /api/admin/catalog-import/runs/:id/report.json | report.csv   links
 *
 * READ ONLY, AND NOTHING TO SKIP. There is no SKIP button and no «advance the
 * cursor» control (§H.2): a BLOCKED item stops the queue until its cause is
 * fixed and workflow 60 runs again with resume, and the dashboard says exactly
 * that, under the blocker, in three languages.
 *
 * THE API IS BUILT IN ANOTHER STEP (§K.2 step 6). Every answer is read
 * defensively — a field the server does not send is simply not drawn — and a
 * 404 (the router not deployed yet) is a sentence, never a broken screen.
 */
import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, ExternalLink, FileDown, RefreshCw, X } from 'lucide-react';
import { api, ApiError } from '../../lib/api';
import { useLanguage } from '../../LanguageContext';
import * as T from '../adminProducts/theme';
import {
  ITEM_STATES,
  ITEM_STATE_LABELS,
  PROGRESS_LABELS,
  RESUME_INSTRUCTION,
  RUN_STATE_LABELS,
  S,
  tri,
  type ImportLang,
  type ItemState,
  type RunState,
} from './catalogImportStrings';

const BASE = '/api/admin/catalog-import';

type Json = Record<string, unknown>;

export interface RunView {
  id: string;
  state: string;
  started_at: string;
  closed_at: string;
  github_run_url: string;
  progress: Record<string, number>;
  current: { id: string; handle: string; state: string; last_checkpoint_at: string; media: number | null; options: number | null } | null;
  last_verified_url: string;
  rate: { per_hour: number | null; stages: Array<{ stage: string; median_s: number | null; p90_s: number | null }> };
  eta: string;
}

export interface ItemView {
  id: string;
  handle: string;
  title: string;
  state: string;
  position: number | null;
  attempts: number | null;
  blocker_code: string;
  blocker: string;
  live_url: string;
}

// ------------------------------------------------------------------ reading the answers (pure, tolerant)

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const obj = (v: unknown): Json => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
/** Only our own pages and GitHub's are links on this screen. */
const safeUrl = (v: unknown, hosts: RegExp): string => {
  const s = str(v);
  if (!s) return '';
  if (s.startsWith('/') && !s.startsWith('//')) return s;
  try {
    const u = new URL(s);
    return u.protocol === 'https:' && hosts.test(u.hostname) ? u.toString() : '';
  } catch {
    return '';
  }
};
const ownSite = /^(?:[a-z0-9-]+\.)*levonis-iq\.com$|^localhost$|^127\.0\.0\.1$/;
const github = /^github\.com$/;

export function readRun(raw: unknown): RunView | null {
  const r = obj(obj(raw).run ?? raw);
  const id = str(r.id);
  if (!id) return null;
  const progress: Record<string, number> = {};
  const p = obj(r.progress ?? r);
  for (const [key] of PROGRESS_LABELS) {
    const n = num(p[key]);
    if (n !== null) progress[key] = n;
  }
  const c = obj(r.current_item ?? r.current);
  const rate = obj(r.rate);
  const stagesRaw = rate.stages;
  const stages = Array.isArray(stagesRaw)
    ? stagesRaw.map((s) => obj(s)).map((s) => ({ stage: str(s.stage), median_s: num(s.median_s ?? s.median), p90_s: num(s.p90_s ?? s.p90) }))
    : Object.entries(obj(stagesRaw)).map(([stage, s]) => ({ stage, median_s: num(obj(s).median_s ?? obj(s).median), p90_s: num(obj(s).p90_s ?? obj(s).p90) }));
  return {
    id,
    state: str(r.state),
    started_at: str(r.started_at),
    closed_at: str(r.closed_at),
    github_run_url: safeUrl(r.github_run_url ?? r.github_run_link, github),
    progress,
    current: str(c.id) || str(c.handle)
      ? {
          id: str(c.id),
          handle: str(c.handle),
          state: str(c.processing_state ?? c.state ?? c.stage),
          last_checkpoint_at: str(c.last_checkpoint_at ?? c.updated_at),
          media: num(c.media_count ?? c.media),
          options: num(c.option_count ?? c.options),
        }
      : null,
    last_verified_url: safeUrl(r.last_verified_url ?? r.public_product_url, ownSite),
    rate: { per_hour: num(rate.items_per_hour ?? rate.per_hour), stages: stages.filter((s) => s.stage) },
    eta: str(obj(r.eta).at ?? r.eta_at ?? (typeof r.eta === 'string' ? r.eta : '')),
  };
}

export function readItems(raw: unknown): { items: ItemView[]; next: string } {
  const r = obj(raw);
  const items = arr(r.items).map((x) => {
    const i = obj(x);
    return {
      id: str(i.id),
      handle: str(i.handle),
      title: str(i.title),
      state: str(i.processing_state ?? i.state),
      position: num(i.queue_position ?? i.position),
      attempts: num(i.attempts),
      blocker_code: str(i.blocker_code),
      blocker: str(i.blocker ?? i.last_error),
      live_url: safeUrl(i.live_url, ownSite),
    };
  });
  return { items: items.filter((i) => i.id), next: cursorOf(r.next_cursor ?? r.cursor) };
}

/** The server's cursor: an opaque string, or the next item's queue position (step 6 answers a number). */
const cursorOf = (v: unknown): string => (typeof v === 'number' && Number.isFinite(v) ? String(v) : str(v));

export type ItemsPage = { items: ItemView[]; next: string };

/**
 * «عرض المزيد»: the next page, or `failed` — never a rejection nobody hears
 * (a 500, a timeout, a dropped connection leaves the list and its button as
 * they were, with a sentence beside the button, and a press tries again).
 */
export async function nextItemsPage(fetchPage: (cursor: string) => Promise<ItemsPage>, cursor: string): Promise<ItemsPage | { failed: true }> {
  try {
    return await fetchPage(cursor);
  } catch {
    return { failed: true };
  }
}

/** The «عرض المزيد» button, busy while a page is on its way, with the failure said beside it. */
export function MoreItems({ busy, failed, lang, onMore }: { busy: boolean; failed: boolean; lang: ImportLang; onMore: () => void }) {
  return (
    <div className="flex flex-wrap items-center gap-3" data-import-more-row>
      <button type="button" className={T.btnSecondary} data-import-more onClick={onMore} disabled={busy} aria-busy={busy || undefined}>
        {tri(S.loadMore, lang)}
      </button>
      {failed ? (
        <p role="alert" className="text-[13px] text-danger" data-import-more-failed>
          {tri(S.loadMoreFailed, lang)}
        </p>
      ) : null}
    </div>
  );
}

const isItemState = (s: string): s is ItemState => (ITEM_STATES as string[]).includes(s);
const isRunState = (s: string): s is RunState => Object.prototype.hasOwnProperty.call(RUN_STATE_LABELS, s);

const TONE: Partial<Record<ItemState, string>> = {
  COMPLETE: 'lv-chip [--chip:var(--color-success)]',
  BLOCKED: 'lv-chip [--chip:var(--color-danger)] [--chip-ink:var(--color-error-ink)]',
  RETRYING: 'lv-chip [--chip:var(--color-warning)]',
  WITHDRAWN_AT_SOURCE: 'lv-chip [--chip:var(--color-warning)]',
};

export function StateChip({ state, lang }: { state: string; lang: ImportLang }) {
  const label = isItemState(state) ? tri(ITEM_STATE_LABELS[state], lang) : state;
  const tone = (isItemState(state) && TONE[state]) || 'lv-chip [--chip:var(--color-info)]';
  return (
    <span className={`${tone} inline-flex shrink-0 items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-bold`} data-item-state={state}>
      <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-current" />
      {label}
    </span>
  );
}

const when = (iso: string, lang: ImportLang): string => {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(lang === 'en' ? 'en-GB' : lang === 'ckb' ? 'ckb-IQ' : 'ar-IQ', { dateStyle: 'medium', timeStyle: 'short', numberingSystem: 'latn' });
};

// ------------------------------------------------------------------ the screen

type Load<T> = { state: 'loading' } | { state: 'absent' } | { state: 'failed' } | { state: 'ready'; data: T };

export default function CatalogImportDashboard() {
  const { lang: rawLang, dir } = useLanguage();
  const lang: ImportLang = rawLang === 'en' || rawLang === 'ckb' ? rawLang : 'ar';
  const [runs, setRuns] = useState<Load<RunView[]>>({ state: 'loading' });
  const [runId, setRunId] = useState('');
  const [run, setRun] = useState<RunView | null>(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    const ac = new AbortController();
    setRuns({ state: 'loading' });
    api
      .get<unknown>(`${BASE}/runs`, { signal: ac.signal })
      .then((r) => {
        if (ac.signal.aborted) return;
        const list = arr(obj(r).runs ?? r).map(readRun).filter((x): x is RunView => x !== null);
        setRuns({ state: 'ready', data: list });
        setRunId((cur) => cur || list[0]?.id || '');
      })
      .catch((e) => {
        if (ac.signal.aborted) return;
        setRuns({ state: e instanceof ApiError && (e.status === 404 || e.status === 405) ? 'absent' : 'failed' });
      });
    return () => ac.abort();
  }, [reload]);

  useEffect(() => {
    if (!runId) return;
    const ac = new AbortController();
    api
      .get<unknown>(`${BASE}/runs/${encodeURIComponent(runId)}`, { signal: ac.signal })
      .then((r) => {
        if (!ac.signal.aborted) setRun(readRun(r));
      })
      .catch(() => {
        if (!ac.signal.aborted) setRun(null);
      });
    return () => ac.abort();
  }, [runId, reload]);

  const shown = run ?? (runs.state === 'ready' ? runs.data.find((r) => r.id === runId) ?? null : null);

  return (
    <div dir={dir} data-catalog-import className={`${T.AP} mx-auto w-full max-w-[1120px] space-y-4 px-4 pb-16 sm:px-0`}>
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h2 className="text-[22px] font-black leading-snug sm:text-[26px]">{tri(S.title, lang)}</h2>
          <p className={`max-w-[68ch] text-[14px] leading-relaxed ${T.text2}`}>{tri(S.intro, lang)}</p>
        </div>
        <button type="button" className={T.btnSecondary} onClick={() => setReload((n) => n + 1)} data-import-refresh>
          <RefreshCw className="h-4 w-4" aria-hidden />
          {tri(S.retry, lang)}
        </button>
      </header>

      {runs.state === 'loading' ? (
        <div className="space-y-2" aria-busy="true">
          {Array.from({ length: 3 }, (_, i) => (
            <div key={i} className={`${T.surface} h-20 animate-pulse`} />
          ))}
        </div>
      ) : runs.state === 'absent' ? (
        <p className={`${T.surface} p-4 text-[14px] ${T.text2}`} data-import-absent>{tri(S.unavailable, lang)}</p>
      ) : runs.state === 'failed' ? (
        <div className={`${T.surface} flex flex-col items-start gap-3 p-4`} data-import-failed>
          <p className="text-[14px]">{tri(S.loadFailed, lang)}</p>
        </div>
      ) : runs.data.length === 0 ? (
        <p className={`${T.surface} p-4 text-[14px] ${T.text2}`} data-import-empty>{tri(S.noRuns, lang)}</p>
      ) : (
        <>
          {runs.data.length > 1 ? (
            <label className="flex flex-wrap items-center gap-2 text-[13px]">
              <span className={T.text2}>{tri(S.run, lang)}</span>
              <select className={T.select} value={runId} onChange={(e) => setRunId(e.target.value)} data-import-run-picker>
                {runs.data.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.id} · {isRunState(r.state) ? tri(RUN_STATE_LABELS[r.state], lang) : r.state}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          {shown ? <RunPanel run={shown} lang={lang} /> : null}
          {runId ? <ItemsPanel runId={runId} lang={lang} key={`${runId}-${reload}`} /> : null}
        </>
      )}
    </div>
  );
}

function RunPanel({ run, lang }: { run: RunView; lang: ImportLang }) {
  const base = `${BASE}/runs/${encodeURIComponent(run.id)}`;
  return (
    <section className="space-y-3" data-import-run={run.id}>
      <div className={`${T.surface} flex flex-wrap items-center gap-x-4 gap-y-2 p-4 text-[13px]`}>
        <span className="font-bold" dir="ltr">{run.id}</span>
        {run.state ? (
          <span className="lv-chip [--chip:var(--color-info)] rounded-full px-2 py-0.5 text-[11px] font-bold" data-run-state={run.state}>
            {isRunState(run.state) ? tri(RUN_STATE_LABELS[run.state], lang) : run.state}
          </span>
        ) : null}
        {run.started_at ? (
          <span className={T.text2}>
            {tri(S.started, lang)}: <bdi>{when(run.started_at, lang)}</bdi>
          </span>
        ) : null}
        {run.closed_at ? (
          <span className={T.text2}>
            {tri(S.ended, lang)}: <bdi>{when(run.closed_at, lang)}</bdi>
          </span>
        ) : null}
        {run.github_run_url ? (
          <a href={run.github_run_url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 underline underline-offset-2">
            {tri(S.githubRun, lang)} <ExternalLink className="h-3.5 w-3.5" aria-hidden />
          </a>
        ) : null}
        <span className="ms-auto flex flex-wrap gap-2">
          <a className={T.btnGhost} href={`${base}/report.json`} target="_blank" rel="noopener noreferrer" data-report="json">
            <FileDown className="h-4 w-4" aria-hidden /> {tri(S.reportJson, lang)}
          </a>
          <a className={T.btnGhost} href={`${base}/report.csv`} data-report="csv">
            <FileDown className="h-4 w-4" aria-hidden /> {tri(S.reportCsv, lang)}
          </a>
        </span>
      </div>

      {Object.keys(run.progress).length ? (
        <div>
          <h3 className="mb-2 text-[14px] font-bold">{tri(S.progress, lang)}</h3>
          <dl className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5" data-import-progress>
            {PROGRESS_LABELS.filter(([k]) => k in run.progress).map(([k, label]) => (
              <div key={k} className={`${T.surface} p-3`} data-progress={k}>
                <dt className={`text-[12px] ${T.text2}`}>{tri(label, lang)}</dt>
                <dd className="mt-1 text-[18px] font-black tabular-nums" dir="ltr">
                  {run.progress[k].toLocaleString('en-US')}
                </dd>
              </div>
            ))}
          </dl>
        </div>
      ) : null}

      <div className="grid gap-3 lg:grid-cols-2">
        <div className={`${T.surface} space-y-2 p-4 text-[13px]`} data-import-current>
          <h3 className="text-[14px] font-bold">{tri(S.current, lang)}</h3>
          {run.current ? (
            <>
              <p className="flex flex-wrap items-center gap-2">
                <bdi className="font-semibold">{run.current.handle || run.current.id}</bdi>
                {run.current.state ? <StateChip state={run.current.state} lang={lang} /> : null}
              </p>
              {run.current.last_checkpoint_at ? (
                <p className={T.text2}>
                  {tri(S.lastCheckpoint, lang)}: <bdi>{when(run.current.last_checkpoint_at, lang)}</bdi>
                </p>
              ) : null}
              <p className={T.text2}>
                {run.current.media !== null ? (
                  <>
                    {tri(S.media, lang)}: <bdi className="tabular-nums">{run.current.media}</bdi>
                  </>
                ) : null}
                {run.current.media !== null && run.current.options !== null ? ' · ' : null}
                {run.current.options !== null ? (
                  <>
                    {tri(S.options, lang)}: <bdi className="tabular-nums">{run.current.options}</bdi>
                  </>
                ) : null}
              </p>
            </>
          ) : (
            <p className={T.text2}>{tri(S.noCurrent, lang)}</p>
          )}
          {run.last_verified_url ? (
            <p className={T.text2}>
              {tri(S.lastVerified, lang)}:{' '}
              <a href={run.last_verified_url} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2" dir="ltr">
                {run.last_verified_url}
              </a>
            </p>
          ) : null}
        </div>
        <div className={`${T.surface} space-y-2 p-4 text-[13px]`} data-import-rate>
          <h3 className="text-[14px] font-bold">{tri(S.rate, lang)}</h3>
          {run.rate.per_hour !== null ? (
            <p>
              <bdi className="text-[18px] font-black tabular-nums">{run.rate.per_hour}</bdi> <span className={T.text2}>{tri(S.perHour, lang)}</span>
            </p>
          ) : null}
          {run.rate.stages.length ? (
            <table className="w-full text-[12px]">
              <thead>
                <tr className={T.text2}>
                  <th className="py-1 text-start font-semibold">{tri(S.stage, lang)}</th>
                  <th className="py-1 text-end font-semibold">{tri(S.median, lang)}</th>
                  <th className="py-1 text-end font-semibold">{tri(S.p90, lang)}</th>
                </tr>
              </thead>
              <tbody>
                {run.rate.stages.map((s) => (
                  <tr key={s.stage} className="border-t border-[var(--ap-border)]">
                    <td className="py-1">{isItemState(s.stage) ? tri(ITEM_STATE_LABELS[s.stage], lang) : s.stage}</td>
                    <td className="py-1 text-end tabular-nums" dir="ltr">{s.median_s ?? '—'} s</td>
                    <td className="py-1 text-end tabular-nums" dir="ltr">{s.p90_s ?? '—'} s</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}
          {run.eta ? (
            <p className={T.text2} data-import-eta>
              {tri(S.eta, lang)}: <bdi>{when(run.eta, lang)}</bdi>
            </p>
          ) : null}
        </div>
      </div>
    </section>
  );
}

function ItemsPanel({ runId, lang }: { runId: string; lang: ImportLang }) {
  const [state, setState] = useState<'' | ItemState>('');
  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  const [items, setItems] = useState<ItemView[]>([]);
  const [next, setNext] = useState('');
  const [status, setStatus] = useState<'loading' | 'ready' | 'failed' | 'absent'>('loading');
  const [open, setOpen] = useState<string>('');
  const [more, setMore] = useState<'idle' | 'busy' | 'failed'>('idle');

  const fetchPage = useCallback(
    async (cursor: string, signal?: AbortSignal) => {
      const params = new URLSearchParams();
      if (state) params.set('state', state);
      if (query) params.set('q', query);
      if (cursor) params.set('cursor', cursor);
      const qs = params.toString();
      return readItems(await api.get<unknown>(`${BASE}/runs/${encodeURIComponent(runId)}/items${qs ? `?${qs}` : ''}`, signal ? { signal } : undefined));
    },
    [runId, state, query]
  );

  useEffect(() => {
    const ac = new AbortController();
    setStatus('loading');
    setMore('idle');
    fetchPage('', ac.signal)
      .then((r) => {
        if (ac.signal.aborted) return;
        setItems(r.items);
        setNext(r.next);
        setStatus('ready');
      })
      .catch((e) => {
        if (!ac.signal.aborted) setStatus(e instanceof ApiError && e.status === 404 ? 'absent' : 'failed');
      });
    return () => ac.abort();
  }, [fetchPage]);

  return (
    <section className="space-y-3" data-import-items>
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="me-auto text-[14px] font-bold">{tri(S.items, lang)}</h3>
        <select className={T.select} value={state} onChange={(e) => setState(e.target.value as '' | ItemState)} aria-label={tri(S.allStates, lang)} data-import-state-filter>
          <option value="">{tri(S.allStates, lang)}</option>
          {ITEM_STATES.map((s) => (
            <option key={s} value={s}>
              {tri(ITEM_STATE_LABELS[s], lang)}
            </option>
          ))}
        </select>
        <form
          className="flex"
          onSubmit={(e) => {
            e.preventDefault();
            setQuery(q.trim());
          }}
        >
          <input className={T.input} value={q} onChange={(e) => setQ(e.target.value)} placeholder={tri(S.search, lang)} aria-label={tri(S.search, lang)} type="search" dir="auto" />
        </form>
      </div>

      {status === 'loading' ? (
        <div className={`${T.surface} h-24 animate-pulse`} aria-busy="true" />
      ) : status === 'absent' ? (
        <p className={`${T.surface} p-4 text-[14px] ${T.text2}`}>{tri(S.unavailable, lang)}</p>
      ) : status === 'failed' ? (
        <p className={`${T.surface} p-4 text-[14px]`}>{tri(S.loadFailed, lang)}</p>
      ) : items.length === 0 ? (
        <p className={`${T.surface} p-4 text-[14px] ${T.text2}`} data-import-no-items>{tri(S.noItems, lang)}</p>
      ) : (
        <ul className="space-y-2">
          {items.map((i) => (
            <li key={i.id} className={`${T.surface} p-3 text-[13px]`} data-import-item={i.id}>
              <div className="flex flex-wrap items-center gap-2">
                {i.position !== null ? <bdi className={`tabular-nums ${T.text3}`}>#{i.position}</bdi> : null}
                <bdi className="min-w-0 truncate font-semibold">{i.title || i.handle}</bdi>
                <StateChip state={i.state} lang={lang} />
                {i.attempts !== null && i.attempts > 1 ? (
                  <span className={T.text3}>
                    {tri(S.attempts, lang)}: <bdi className="tabular-nums">{i.attempts}</bdi>
                  </span>
                ) : null}
                <span className="ms-auto flex items-center gap-2">
                  {i.live_url ? (
                    <a href={i.live_url} target="_blank" rel="noopener noreferrer" className={T.btnGhostSm}>
                      {tri(S.livePage, lang)} <ExternalLink className="h-3.5 w-3.5" aria-hidden />
                    </a>
                  ) : null}
                  <button type="button" className={T.btnGhostSm} onClick={() => setOpen(i.id)} aria-haspopup="dialog" data-item-details={i.id}>
                    {tri(S.details, lang)}
                  </button>
                </span>
              </div>
              {i.state === 'BLOCKED' ? <Blocked code={i.blocker_code} text={i.blocker} lang={lang} /> : null}
            </li>
          ))}
        </ul>
      )}
      {status === 'ready' && next ? (
        <MoreItems
          busy={more === 'busy'}
          failed={more === 'failed'}
          lang={lang}
          onMore={() => {
            // One page at a time: a second press while one is on its way would append it twice.
            if (more === 'busy') return;
            setMore('busy');
            void nextItemsPage((cursor) => fetchPage(cursor), next).then((r) => {
              if ('failed' in r) {
                setMore('failed');
                return;
              }
              setItems((cur) => [...cur, ...r.items]);
              setNext(r.next);
              setMore('idle');
            });
          }}
        />
      ) : null}
      {open ? <ItemDetail id={open} lang={lang} onClose={() => setOpen('')} /> : null}
    </section>
  );
}

/** A blocked item: its blocker, then the one way forward (§H.2). No skip, no cursor. */
export function Blocked({ code, text, lang }: { code: string; text: string; lang: ImportLang }) {
  return (
    <div role="note" className="lv-alert lv-alert-warning mt-2 flex items-start gap-2 rounded-[var(--ap-radius-md)] p-3 text-[13px]" data-import-blocked>
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
      <div className="min-w-0 space-y-1">
        <p>
          <span className="font-semibold">{tri(S.blocker, lang)}:</span> <bdi dir="ltr">{code || '—'}</bdi>
          {text ? <span className={`block ${T.text2}`} dir="auto">{text}</span> : null}
        </p>
        <p data-resume-instruction>{tri(RESUME_INSTRUCTION, lang)}</p>
      </div>
    </div>
  );
}

function KeyCounts({ title, data, lang }: { title: string; data: Json; lang: ImportLang }) {
  const entries = Object.entries(data).filter(([, v]) => typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean');
  return (
    <div>
      <h4 className="mb-1 text-[13px] font-bold">{title}</h4>
      {entries.length ? (
        <dl className="text-[12px]">
          {entries.map(([k, v]) => (
            <div key={k} className="flex justify-between gap-3 border-b border-[var(--ap-border)] py-1 last:border-0">
              <dt className={T.text2} dir="ltr">{k}</dt>
              <dd className="tabular-nums" dir="ltr">{String(v)}</dd>
            </div>
          ))}
        </dl>
      ) : (
        <p className={`text-[12px] ${T.text3}`}>{tri(S.none, lang)}</p>
      )}
    </div>
  );
}

function ItemDetail({ id, lang, onClose }: { id: string; lang: ImportLang; onClose: () => void }) {
  const [data, setData] = useState<Load<Json>>({ state: 'loading' });
  useEffect(() => {
    const ac = new AbortController();
    api
      .get<unknown>(`${BASE}/items/${encodeURIComponent(id)}`, { signal: ac.signal })
      .then((r) => {
        if (!ac.signal.aborted) setData({ state: 'ready', data: obj(r) });
      })
      .catch((e) => {
        if (!ac.signal.aborted) setData({ state: e instanceof ApiError && e.status === 404 ? 'absent' : 'failed' });
      });
    return () => ac.abort();
  }, [id]);
  const d = data.state === 'ready' ? data.data : null;
  const item = obj(d?.item ?? d);
  const state = str(item.processing_state ?? item.state);
  return (
    <div role="dialog" aria-modal="false" aria-label={tri(S.details, lang)} className={`${T.surfaceRaised} space-y-4 p-4`} data-import-item-detail={id}>
      <div className="flex items-center gap-2">
        <bdi className="me-auto font-bold">{str(item.title) || str(item.handle) || id}</bdi>
        {state ? <StateChip state={state} lang={lang} /> : null}
        <button type="button" className={T.btnIcon} onClick={onClose} aria-label={tri(S.close, lang)}>
          <X className="h-4 w-4" aria-hidden />
        </button>
      </div>
      {data.state === 'loading' ? <div className="h-24 animate-pulse" aria-busy="true" /> : null}
      {data.state === 'absent' ? <p className={T.text2}>{tri(S.unavailable, lang)}</p> : null}
      {data.state === 'failed' ? <p>{tri(S.loadFailed, lang)}</p> : null}
      {d ? (
        <>
          {state === 'BLOCKED' ? <Blocked code={str(item.blocker_code)} text={str(item.blocker ?? item.last_error)} lang={lang} /> : null}
          <div className="grid gap-4 lg:grid-cols-2">
            <KeyCounts title={tri(S.d1Checks, lang)} data={obj(d.d1_checks ?? item.d1_checks)} lang={lang} />
            <KeyCounts title={tri(S.edgeEvidence, lang)} data={obj(d.edge_evidence ?? item.edge_evidence)} lang={lang} />
            <KeyCounts title={tri(S.missing, lang)} data={obj(d.missing_by_reason ?? d.missing)} lang={lang} />
            <KeyCounts title={tri(S.quality, lang)} data={obj(d.quality ?? item.quality)} lang={lang} />
          </div>
          <div>
            <h4 className="mb-1 text-[13px] font-bold">{tri(S.conflicts, lang)}</h4>
            {arr(d.conflicts).length ? (
              <ul className="space-y-1 text-[12px]">
                {arr(d.conflicts).map((c, n) => (
                  <li key={n} dir="ltr">
                    {str(obj(c).kind)} {str(obj(c).field)}
                  </li>
                ))}
              </ul>
            ) : (
              <p className={`text-[12px] ${T.text3}`}>{tri(S.none, lang)}</p>
            )}
          </div>
          <div>
            <h4 className="mb-1 text-[13px] font-bold">{tri(S.mediaRows, lang)}</h4>
            <p className={`text-[12px] ${T.text2}`}>
              <bdi className="tabular-nums">{arr(d.media).length}</bdi>
            </p>
          </div>
          <div>
            <h4 className="mb-1 text-[13px] font-bold">{tri(S.events, lang)}</h4>
            {arr(d.events).length ? (
              <ol className="max-h-64 space-y-1 overflow-y-auto text-[12px]">
                {arr(d.events).map((e, n) => {
                  const ev = obj(e);
                  return (
                    <li key={n} className="flex flex-wrap gap-2" dir="ltr">
                      <span className={`tabular-nums ${T.text3}`}>{str(ev.at)}</span>
                      <span className="font-semibold">{str(ev.stage)}</span>
                      <span>{str(ev.outcome)}</span>
                      {str(ev.code) ? <span className={T.text2}>{str(ev.code)}</span> : null}
                    </li>
                  );
                })}
              </ol>
            ) : (
              <p className={`text-[12px] ${T.text3}`}>{tri(S.none, lang)}</p>
            )}
          </div>
        </>
      ) : null}
    </div>
  );
}
