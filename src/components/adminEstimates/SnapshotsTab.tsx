/**
 * «لقطات الأسعار» — THE OWNER'S PRICE CAPTURES (docs/SMART_PRICING.md §3.2–§3.5, §7).
 *
 *   - UPLOAD: the owner picks a `levonis.supplier-prices.v1` file; the browser
 *     reads it, checks it with the upload door's own strict parser, hashes it
 *     (SHA-256, crypto.subtle) and posts it in chunks of at most 50 items and
 *     256 KB with a progress bar (`POST /supplier-prices/snapshots`, `…/items`,
 *     `…/complete`). A chunk posted twice writes once, so an interrupted
 *     upload resumes from its first unsent chunk; an abandoned one is
 *     discarded. The Worker never fetches the file;
 *   - THE LIST: per source, every capture with its counts, matched and
 *     unmatched items, price basis and age; discard;
 *   - «طابِق»: matching in pages of 25 products with progress
 *     (`POST /supplier-prices/match {cursor}`) — exact and high matches are
 *     confirmed automatically, the rest wait for the Review tab. Matching
 *     publishes nothing.
 */
import { useCallback, useEffect, useRef, useState, type ChangeEvent } from 'react';
import { FileUp, ListChecks } from 'lucide-react';
import { Button } from '../ui/Button';
import { StatusChip, type Tone } from '../ui/Badge';
import { Skeleton } from '../ui/Skeleton';
import { useConfirm } from '../ui/ConfirmDialog';
import {
  completeSnapshot,
  createSnapshot,
  discardSnapshot,
  fetchSnapshots,
  runMatchPage,
  uploadSnapshotItems,
  type SnapshotDto,
} from './api';
import { UploadPrepareError, prepareUpload, type PreparedUpload } from './upload';
import { RunStopped, matchAllPages, sendUpload } from './runs';
import { ActNote, Failure, Ltr, SourceChip, refusalText, useAct, useUiLang } from './parts';
import { CAPTURE_LABELS, COMMON, PRICE_BASIS_LABELS, SNAPSHOT_STATE_LABELS, SNAPSHOTS, SOURCE_LABELS, formatReasonText, say, type UiLang } from './strings';
import { dayOf, groupWhole } from './format';

const STATE_TONE: Readonly<Record<string, Tone>> = { loading: 'warning', complete: 'success', superseded: 'neutral', discarded: 'neutral' };

/** What an upload is doing now. */
type UploadRun =
  | { phase: 'idle' }
  | { phase: 'reading' }
  | { phase: 'ready'; file: PreparedUpload; name: string }
  | { phase: 'sending'; file: PreparedUpload; snapshotId: string; sent: number }
  | { phase: 'failed'; file: PreparedUpload; snapshotId: string | null; sent: number; reason: string }
  | { phase: 'done' };

export function prepareFailureText(e: unknown, lang: UiLang): string {
  if (!(e instanceof UploadPrepareError)) return say(COMMON.actionFailed, lang);
  const f = e.failure;
  switch (f.kind) {
    case 'format':
      return say(SNAPSHOTS.failures.format, lang, { reason: formatReasonText(f.reason, lang), path: f.path });
    case 'item_too_large':
      return say(SNAPSHOTS.failures.item_too_large, lang, { index: f.index + 1 });
    default:
      return say(SNAPSHOTS.failures[f.kind], lang);
  }
}

export default function SnapshotsTab() {
  const { lang } = useUiLang();
  const [list, setList] = useState<SnapshotDto[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [reload, setReload] = useState(0);
  const refresh = useCallback(() => setReload((n) => n + 1), []);

  useEffect(() => {
    const ac = new AbortController();
    setError(null);
    fetchSnapshots({ signal: ac.signal, mascot: 'silent' })
      .then((a) => {
        if (!ac.signal.aborted) setList(a.snapshots);
      })
      .catch((e) => {
        if (!ac.signal.aborted) setError(e);
      });
    return () => ac.abort();
  }, [reload]);

  return (
    <section className="space-y-4" data-estimates-snapshots>
      <p className="max-w-[72ch] text-[13px] leading-relaxed text-text-secondary">{say(SNAPSHOTS.intro, lang)}</p>
      {error ? (
        <Failure error={error} lang={lang} onRetry={refresh} />
      ) : (
        <>
          <UploadCard lang={lang} onChanged={refresh} />
          <MatchCard lang={lang} />
          <section className="lv-surface space-y-3 p-4">
            <h3 className="text-[15px] font-bold text-text-primary">{say(SNAPSHOTS.listTitle, lang)}</h3>
            {!list ? (
              <div className="space-y-2" aria-busy="true">
                <Skeleton className="h-14 w-full" />
                <Skeleton className="h-14 w-full" />
              </div>
            ) : list.length === 0 ? (
              <p className="text-[13px] text-text-secondary" data-snapshots-empty>
                {say(SNAPSHOTS.empty, lang)}
              </p>
            ) : (
              <ul className="divide-y divide-border-subtle/60">
                {list.map((s) => (
                  <SnapshotRow key={s.id} snapshot={s} lang={lang} onChanged={refresh} />
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </section>
  );
}

function SnapshotRow({ snapshot: s, lang, onChanged }: { snapshot: SnapshotDto; lang: UiLang; onChanged: () => void }) {
  const act = useAct(lang, onChanged);
  const [confirm, dialog] = useConfirm();
  const state = s.state in SNAPSHOT_STATE_LABELS ? (s.state as keyof typeof SNAPSHOT_STATE_LABELS) : null;
  const basis = s.snapshot_price_basis in PRICE_BASIS_LABELS ? PRICE_BASIS_LABELS[s.snapshot_price_basis as keyof typeof PRICE_BASIS_LABELS] : null;
  const capture = s.capture in CAPTURE_LABELS ? CAPTURE_LABELS[s.capture as keyof typeof CAPTURE_LABELS] : null;
  const discard = async () => {
    const yes = await confirm({ title: say(SNAPSHOTS.discardConfirmTitle, lang), consequence: say(SNAPSHOTS.discardConfirmBody, lang), confirmLabel: say(SNAPSHOTS.discard, lang), cancelLabel: say(COMMON.cancel, lang), destructive: true });
    if (!yes) return;
    await act.run('discard', () => discardSnapshot(s.id), () => {
      onChanged();
      return { tone: 'success', text: say(SNAPSHOTS.discarded, lang) };
    });
  };
  return (
    <li className="min-w-0 space-y-1.5 py-3" data-snapshot={s.id} data-snapshot-state={s.state}>
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        {s.source in SOURCE_LABELS ? <SourceChip source={s.source} lang={lang} /> : null}
        {state ? (
          <StatusChip tone={STATE_TONE[state] ?? 'neutral'} className="shrink-0">
            {say(SNAPSHOT_STATE_LABELS[state], lang)}
          </StatusChip>
        ) : null}
        <Ltr className="text-[13px] font-bold text-text-primary">{s.captured_on}</Ltr>
        {s.age_days !== null ? <span className="text-[12px] text-text-muted">{say(SNAPSHOTS.age, lang, { n: s.age_days })}</span> : null}
      </div>
      <p className="text-[12px] text-text-secondary">
        {s.state === 'loading'
          ? say(SNAPSHOTS.loadingCounts, lang, { items: groupWhole(s.stored_items), total: groupWhole(s.item_count) })
          : say(SNAPSHOTS.counts, lang, { items: groupWhole(s.stored_items), skus: groupWhole(s.stored_skus), matched: groupWhole(s.matched_items), unmatched: groupWhole(s.unmatched_items) })}
      </p>
      <p className="flex flex-wrap gap-x-3 gap-y-0.5 text-[12px] text-text-muted">
        <Ltr>{s.currency}</Ltr>
        {basis ? <span>{say(basis, lang)}</span> : null}
        {capture ? <span>{say(capture, lang)}</span> : null}
        {s.captured_by ? <span dir="auto">{say(SNAPSHOTS.capturedBy, lang, { who: s.captured_by })}</span> : null}
        {s.completed_at ? <Ltr>{dayOf(s.completed_at)}</Ltr> : null}
      </p>
      {s.state !== 'discarded' ? (
        <Button size="sm" variant="ghost" loading={act.busy === 'discard'} onClick={discard} data-snapshot-discard={s.id}>
          {say(SNAPSHOTS.discard, lang)}
        </Button>
      ) : null}
      <ActNote message={act.message} />
      {dialog}
    </li>
  );
}

/** The upload: pick, check and hash in the browser, then send chunk by chunk, then complete. */
function UploadCard({ lang, onChanged }: { lang: UiLang; onChanged: () => void }) {
  const [run, setRun] = useState<UploadRun>({ phase: 'idle' });
  const [message, setMessage] = useState<string | null>(null);
  const stop = useRef(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const pick = async (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    setMessage(null);
    setRun({ phase: 'reading' });
    try {
      const prepared = await prepareUpload(await f.arrayBuffer());
      setRun({ phase: 'ready', file: prepared, name: f.name });
    } catch (err) {
      setRun({ phase: 'idle' });
      setMessage(prepareFailureText(err, lang));
    }
  };

  /** Sends from chunk `from` on (a resumed upload starts at its first unsent chunk). */
  const send = async (file: PreparedUpload, existing: string | null, from: number) => {
    stop.current = false;
    setMessage(null);
    let snapshotId = existing;
    let sent = from;
    try {
      await sendUpload(
        file,
        { create: createSnapshot, items: uploadSnapshotItems, complete: completeSnapshot },
        {
          snapshotId: existing,
          from,
          shouldStop: () => stop.current,
          onProgress: (id, n) => {
            snapshotId = id;
            sent = n;
            setRun({ phase: 'sending', file, snapshotId: id, sent: n });
          },
        }
      );
      setRun({ phase: 'done' });
      setMessage(say(SNAPSHOTS.uploaded, lang));
      onChanged();
    } catch (err) {
      const reason = err instanceof RunStopped ? say(COMMON.stopped, lang) : refusalText(err, lang);
      setRun({ phase: 'failed', file, snapshotId, sent, reason });
      onChanged();
    }
  };

  const discardPartial = async (snapshotId: string) => {
    try {
      await discardSnapshot(snapshotId);
      setRun({ phase: 'idle' });
      setMessage(say(SNAPSHOTS.discarded, lang));
    } catch (err) {
      setMessage(refusalText(err, lang));
    }
    onChanged();
  };

  const itemsSent = (file: PreparedUpload, chunks: number) => file.chunks.slice(0, chunks).reduce((n, c) => n + c.items.length, 0);
  const progress = run.phase === 'sending' || run.phase === 'failed' ? { done: itemsSent(run.file, run.sent), total: run.file.itemCount } : null;
  const summary = (file: PreparedUpload) =>
    say(SNAPSHOTS.fileSummary, lang, {
      source: say(SOURCE_LABELS[file.header.source], lang),
      date: file.header.captured_on,
      items: groupWhole(file.itemCount),
      skus: groupWhole(file.skuCount),
    });

  return (
    <section className="lv-surface space-y-3 p-4" data-snapshot-upload={run.phase}>
      <h3 className="text-[15px] font-bold text-text-primary">{say(SNAPSHOTS.uploadTitle, lang)}</h3>
      <input ref={inputRef} type="file" accept=".json,application/json" className="sr-only" onChange={pick} data-snapshot-file aria-label={say(SNAPSHOTS.chooseFile, lang)} />
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="secondary"
          icon={<FileUp aria-hidden="true" className="h-4 w-4" />}
          disabled={run.phase === 'sending' || run.phase === 'reading'}
          onClick={() => inputRef.current?.click()}
        >
          {say(SNAPSHOTS.chooseFile, lang)}
        </Button>
        {run.phase === 'ready' ? (
          <Button variant="primary" onClick={() => void send(run.file, null, 0)} data-snapshot-send>
            {say(SNAPSHOTS.upload, lang)}
          </Button>
        ) : null}
        {run.phase === 'sending' ? (
          <Button variant="ghost" onClick={() => (stop.current = true)}>
            {say(COMMON.stop, lang)}
          </Button>
        ) : null}
      </div>
      {run.phase === 'reading' ? <p className="text-[13px] text-text-muted">{say(SNAPSHOTS.reading, lang)}</p> : null}
      {run.phase === 'ready' ? (
        <p className="text-[13px] text-text-secondary" data-snapshot-summary>
          <span dir="auto" className="font-semibold text-text-primary">
            {run.name}
          </span>
          {' — '}
          {summary(run.file)}
        </p>
      ) : null}
      {progress ? (
        <div className="space-y-1" data-snapshot-progress>
          <div className="h-2 w-full overflow-hidden rounded-full bg-surface-raised" role="progressbar" aria-valuemin={0} aria-valuemax={progress.total} aria-valuenow={progress.done}>
            <div className="h-full bg-gold/70" style={{ width: `${progress.total ? (progress.done / progress.total) * 100 : 0}%` }} />
          </div>
          <p className="text-[12px] text-text-muted">
            {run.phase === 'sending' && run.sent >= run.file.chunks.length ? say(SNAPSHOTS.completing, lang) : say(SNAPSHOTS.uploading, lang, { done: groupWhole(progress.done), total: groupWhole(progress.total) })}
          </p>
        </div>
      ) : null}
      {run.phase === 'failed' ? (
        <div className="lv-alert lv-alert-danger space-y-2 text-[13px] text-text-primary" role="alert" data-snapshot-failed>
          <p>{say(SNAPSHOTS.uploadFailed, lang, { reason: run.reason })}</p>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="secondary" onClick={() => void send(run.file, run.snapshotId, run.sent)}>
              {say(SNAPSHOTS.resume, lang)}
            </Button>
            {run.snapshotId ? (
              <Button size="sm" variant="ghost" onClick={() => void discardPartial(run.snapshotId!)}>
                {say(SNAPSHOTS.discardPartial, lang)}
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}
      {message ? (
        <p role="status" className="text-[13px] leading-relaxed text-text-secondary" data-snapshot-message>
          {message}
        </p>
      ) : null}
    </section>
  );
}

/** «طابِق»: every page of 25 products, one after another, until the end or «أوقف». */
function MatchCard({ lang }: { lang: UiLang }) {
  const act = useAct(lang);
  const [count, setCount] = useState<number | null>(null);
  const stop = useRef(false);
  const run = () =>
    act.run(
      'match',
      () => {
        stop.current = false;
        setCount(0);
        return matchAllPages(runMatchPage, { shouldStop: () => stop.current, onPage: setCount });
      },
      ({ stopped, ...totals }) => ({ tone: 'success', text: stopped ? `${say(SNAPSHOTS.matchDone, lang, totals)} ${say(COMMON.stopped, lang)}` : say(SNAPSHOTS.matchDone, lang, totals) })
    );
  return (
    <section className="lv-surface space-y-3 p-4" data-snapshot-match>
      <h3 className="text-[15px] font-bold text-text-primary">{say(SNAPSHOTS.matchTitle, lang)}</h3>
      <p className="max-w-[72ch] text-[13px] leading-relaxed text-text-secondary">{say(SNAPSHOTS.matchIntro, lang)}</p>
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="primary" icon={<ListChecks aria-hidden="true" className="h-4 w-4" />} loading={act.busy === 'match'} onClick={() => void run()} data-snapshot-match-run>
          {say(SNAPSHOTS.match, lang)}
        </Button>
        {act.busy === 'match' ? (
          <Button variant="ghost" onClick={() => (stop.current = true)}>
            {say(COMMON.stop, lang)}
          </Button>
        ) : null}
      </div>
      {act.busy === 'match' && count !== null ? <p className="text-[12px] text-text-muted">{say(SNAPSHOTS.matching, lang, { n: count })}</p> : null}
      <ActNote message={act.message} />
    </section>
  );
}
