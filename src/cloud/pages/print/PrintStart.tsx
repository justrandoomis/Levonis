/**
 * /print — THE WAY IN (the prototype's IMG_8439, top half, in the house clay).
 *
 *   Upload: drag and drop or the picker; STL, 3MF or OBJ; the bytes go up
 *   through POST /files (multipart, field `file`) with the browser's own count
 *   of bytes sent as the progress; then the server's check is followed —
 *   uploaded → being measured → ready, or rejected with ITS reason — and only
 *   a ready model can go on to the print settings.
 *
 *   Import: POST /imports, then the import followed until the server settles
 *   it, and said EXACTLY: «only the link was saved» when no file came down
 *   (`link_saved`), the downloaded file followed like an upload only when the
 *   server says `file_imported` and names it.
 *
 *   The size limit is the server's: nothing here knows a number until a
 *   refusal names one (`FILE_TOO_LARGE.max_bytes`); from then on a larger
 *   file is stopped before a byte is sent, quoting the server's figure.
 *
 *   Quick start is the customer's own: prints still being set up, projects to
 *   print again, the latest files — never a demo model.
 */
import { useEffect, useRef, useState } from 'react';
import type React from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Button } from '../../../components/ui/Button';
import { Field, Input } from '../../../components/ui/Field';
import { Skeleton } from '../../../components/ui/Skeleton';
import { ApiError } from '../../../lib/api';
import { formatFigure } from '../../../lib/localeNumber';
import { cloudErrorCode, cloudErrorText, getFile, getImport, listFiles, listJobs, listProjects, startImport } from '../../api';
import { buildVolumeParts, formatPercent, formatRelative, progressPercent } from '../../format';
import { nav } from '../../strings/common';
import { fileBody, fileStatus as fileStatusWords, importBody, library, print, upload } from '../../strings/print';
import { useCloudText } from '../../text';
import type { ImportView, ModelFileView } from '../../types';
import {
  Box,
  CloudErrorState,
  Boxes,
  History,
  Link2,
  ListRow,
  PageHeader,
  ProgressBar,
  SectionHeader,
  StatusPill,
  Upload,
  X,
  jobPillState,
} from '../../ui';
import { useCloudQuery } from '../../useCloudQuery';
import { FileStatusPill, ImportStatusPill, RefreshNote, startProject, usePoll } from './kit';
import { acceptsFile, fileSettled, formatBytes, geometryWarningText, importOutcome, rejectionText, uploadRefusal, urlRefusalText } from './model';
import { uploadModelFile } from './upload';

type Intake =
  | { kind: 'idle' }
  | { kind: 'uploading'; name: string; size: number; sent: number; total: number }
  | { kind: 'refused'; name: string; size: number; error: unknown }
  | { kind: 'local'; name: string; size: number; problem: 'wrongType' | 'oneFile' | 'overLimit' }
  | { kind: 'stopped' }
  | { kind: 'file'; fileId: string; importId: string | null }
  | { kind: 'import'; importId: string };

/** While the server's check runs: quickly at first, then patiently. */
const FOLLOW_FAST_MS = 3_000;
const FOLLOW_SLOW_MS = 10_000;
const FAST_POLLS = 30;

// ------------------------------------------------------------------ the server's answer to a refused upload

function RefusedUpload({ name, size, error, limit }: { name: string; size: number; error: unknown; limit: number | null }) {
  const { t, lang } = useCloudText();
  const r =
    error instanceof ApiError ? uploadRefusal(error.status, cloudErrorCode(error), error.details) : { code: null, maxBytes: null, reason: null, detected: null };
  const max = r.maxBytes ?? (r.code === 'FILE_TOO_LARGE' ? limit : null);
  const lines: string[] = [];
  if (r.code === 'FILE_TOO_LARGE') lines.push(max ? t(upload.limit, { size: formatBytes(max, lang) }) : t(upload.tooLarge));
  if (r.reason === 'CONTENT_DOES_NOT_MATCH_EXTENSION') lines.push(r.detected && r.detected !== 'unknown' ? t(upload.readAs, { detected: r.detected.toUpperCase() }) : t(upload.notAModel));
  else if (r.reason && r.code === 'FILE_REJECTED') lines.push(rejectionText(r.reason, lang));
  return (
    <div role="alert" className="lv-alert lv-alert-danger space-y-1 text-[13px] leading-relaxed text-text-primary">
      <p className="font-bold">{t(upload.failed)}</p>
      <p className="text-text-secondary">
        <bdi>{name}</bdi> · {formatBytes(size, lang)}
      </p>
      <p>{cloudErrorText(error, lang)}</p>
      {lines.map((l) => (
        <p key={l}>{l}</p>
      ))}
    </div>
  );
}

// ------------------------------------------------------------------ following a file through the server's check

function FollowFile({ fileId, importId, onAnother }: { fileId: string; importId: string | null; onAnother: () => void }) {
  const { t, lang } = useCloudText();
  const navigate = useNavigate();
  const q = useCloudQuery((signal) => getFile(fileId, { signal }), [fileId]);
  const polls = useRef(0);
  const settled = fileSettled(q.data?.status);
  usePoll(
    () => {
      polls.current += 1;
      q.reload();
    },
    !!q.data && !settled,
    polls.current < FAST_POLLS ? FOLLOW_FAST_MS : FOLLOW_SLOW_MS
  );
  // The ids a «continue» made, so a retry never makes a second project.
  const made = useRef<{ projectId: string | null }>({ projectId: null });
  const [problem, setProblem] = useState<unknown>(null);

  if (q.error && !q.data) return <CloudErrorState compact error={q.error} onRetry={q.reload} />;
  const f = q.data;
  if (!f) return <p className="text-[13px] text-text-muted">{t(fileStatusWords.uploaded)}</p>;

  const go = async () => {
    setProblem(null);
    try {
      const projectId = await startProject(f, importId, made.current);
      navigate(`/projects/${encodeURIComponent(projectId)}/print`);
    } catch (e) {
      setProblem(e);
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex items-start gap-3">
        <span aria-hidden="true" className="grid h-11 w-11 shrink-0 place-items-center rounded-xl lv-well text-text-secondary">
          <Box className="h-5 w-5" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[15px] font-bold text-text-primary">
            <bdi>{f.original_name}</bdi>
          </p>
          <p className="text-[12px] text-text-muted">
            <bdi dir="ltr">{f.format.toUpperCase()}</bdi> · {formatBytes(f.size_bytes, lang)}
          </p>
        </div>
        <FileStatusPill status={f.status} />
      </div>
      <FileVerdict file={f} />
      <RefreshNote error={q.data && q.error ? q.error : null} onRetry={q.reload} />
      {problem ? <CloudErrorState compact error={problem} /> : null}
      <div className="flex flex-wrap items-center gap-2">
        {f.status === 'ready' ? (
          <Button variant="primary" icon={<Box aria-hidden="true" className="h-4 w-4" />} onClick={go}>
            {t(upload.continue)}
          </Button>
        ) : null}
        <Link to={`/library/${encodeURIComponent(f.id)}`} className="lv-button lv-button-secondary lv-button-sm">
          {t(upload.inLibrary)}
        </Link>
        <Button variant="ghost" size="sm" icon={<Upload aria-hidden="true" className="h-4 w-4" />} onClick={onAnother}>
          {t(upload.another)}
        </Button>
      </div>
      {f.status === 'ready' ? <p className="text-[12px] leading-relaxed text-text-muted">{t(upload.continueHint)}</p> : null}
    </div>
  );
}

/** What the check said, in words; the measured size and what the measurement noticed once there is one. */
function FileVerdict({ file }: { file: ModelFileView }) {
  const { t, lang } = useCloudText();
  if (file.status === 'uploaded' || file.status === 'processing') {
    return <p className="text-[13px] leading-relaxed text-text-secondary">{t(fileBody.checking)}</p>;
  }
  if (file.status === 'rejected' || file.status === 'failed') {
    return (
      <p role="alert" className="lv-alert lv-alert-danger text-[13px] leading-relaxed text-text-primary">
        {t(file.status === 'rejected' ? fileBody.rejected : fileBody.failed, { reason: rejectionText(file.rejection_code, lang) })}
      </p>
    );
  }
  const g = file.geometry;
  const dims = g?.dimensions_mm ? buildVolumeParts(roundedMm(g.dimensions_mm), lang) : null;
  const fits = file.printer_compatibility.filter((c) => c.any_orientation).length;
  const warnings = (g?.warnings ?? []).filter((w) => w.severity !== 'info');
  return (
    <div className="space-y-1.5 text-[13px] leading-relaxed text-text-secondary">
      <p className="text-success">{t(fileBody.ready)}</p>
      {dims ? (
        <p>
          {t(library.dimensions)}: <bdi dir="ltr">{dims.figure}</bdi> {dims.unit}
        </p>
      ) : null}
      {file.printer_compatibility.length ? <p>{t(library.fitsCount, { n: formatFigure(fits, lang), total: formatFigure(file.printer_compatibility.length, lang) })}</p> : null}
      {warnings.length ? (
        <ul className="list-disc space-y-0.5 ps-5 text-warning">
          {warnings.slice(0, 3).map((w) => (
            <li key={w.code}>{geometryWarningText(w, lang)}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/** A measured size to a tenth of a millimetre, as a person reads it (display only). */
function roundedMm(d: { x: number; y: number; z: number }) {
  const r = (n: number) => Math.round(n * 10) / 10;
  return { x: r(d.x), y: r(d.y), z: r(d.z) };
}

// ------------------------------------------------------------------ following an import

function FollowImport({ importId, onUpload, onAnother }: { importId: string; onUpload: () => void; onAnother: () => void }) {
  const { t, lang } = useCloudText();
  const q = useCloudQuery((signal) => getImport(importId, { signal }), [importId]);
  const polls = useRef(0);
  const outcome = q.data ? importOutcome(q.data) : null;
  usePoll(
    () => {
      polls.current += 1;
      q.reload();
    },
    !!q.data && !outcome?.settled,
    polls.current < FAST_POLLS ? FOLLOW_FAST_MS : FOLLOW_SLOW_MS
  );
  if (q.error && !q.data) return <CloudErrorState compact error={q.error} onRetry={q.reload} />;
  const imp: ImportView | undefined = q.data;
  if (!imp || !outcome) return <p className="text-[13px] text-text-muted">{t(upload.processing)}</p>;
  const meta = imp.metadata as { name?: unknown; creator?: unknown };
  return (
    <div className="space-y-3">
      <div className="flex items-start gap-3">
        <span aria-hidden="true" className="grid h-11 w-11 shrink-0 place-items-center rounded-xl lv-well text-text-secondary">
          <Link2 className="h-5 w-5" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[15px] font-bold text-text-primary">
            <bdi>{typeof meta.name === 'string' && meta.name ? meta.name : imp.provider}</bdi>
          </p>
          <p className="truncate text-[12px] text-text-muted">
            <bdi dir="ltr">{imp.canonical_url || imp.url}</bdi>
          </p>
        </div>
        <ImportStatusPill status={imp.status} fileId={imp.file_id} />
      </div>
      <p className={`text-[13px] leading-relaxed ${imp.status === 'link_saved' ? 'lv-alert lv-alert-warning text-text-primary' : 'text-text-secondary'}`}>
        {imp.status === 'file_imported' && outcome.fileDownloaded
          ? t(importBody.file_imported, { provider: imp.provider })
          : imp.status === 'rejected'
            ? t(importBody.rejected, { reason: rejectionText(imp.error_code, lang) })
            : imp.status === 'link_saved' || imp.status === 'failed'
              ? t(importBody[imp.status])
              : t(importBody.pending)}
      </p>
      {imp.attribution || imp.license ? (
        <p className="text-[12px] text-text-muted">
          {[imp.attribution, imp.license].filter(Boolean).join(' · ')}
        </p>
      ) : null}
      <RefreshNote error={q.data && q.error ? q.error : null} onRetry={q.reload} />
      {outcome.fileDownloaded && imp.file_id ? (
        <div className="rounded-xl lv-well p-3">
          <FollowFile fileId={imp.file_id} importId={imp.id} onAnother={onAnother} />
        </div>
      ) : outcome.settled ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="primary" icon={<Upload aria-hidden="true" className="h-4 w-4" />} onClick={onUpload}>
            {t(upload.choose)}
          </Button>
          <Link to={`/library/imports/${encodeURIComponent(imp.id)}`} className="lv-button lv-button-secondary lv-button-sm">
            {t(library.whatHappened)}
          </Link>
        </div>
      ) : null}
    </div>
  );
}

// ------------------------------------------------------------------ the two ways in

function Intake({ onSettled }: { onSettled: () => void }) {
  const { t, lang } = useCloudText();
  const [state, setState] = useState<Intake>({ kind: 'idle' });
  const [dragging, setDragging] = useState(false);
  /** The server's own limit, once a refusal has named it. */
  const [limit, setLimit] = useState<number | null>(null);
  const [url, setUrl] = useState('');
  const [urlProblem, setUrlProblem] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const picker = useRef<HTMLInputElement | null>(null);
  const transfer = useRef<{ abort: () => void } | null>(null);
  // Leaving the page stops a transfer whose answer nobody would see.
  useEffect(() => () => transfer.current?.abort(), []);

  const send = (file: File) => {
    if (!acceptsFile(file.name)) {
      setState({ kind: 'local', name: file.name, size: file.size, problem: 'wrongType' });
      return;
    }
    if (limit !== null && file.size > limit) {
      setState({ kind: 'local', name: file.name, size: file.size, problem: 'overLimit' });
      return;
    }
    setState({ kind: 'uploading', name: file.name, size: file.size, sent: 0, total: file.size });
    const handle = uploadModelFile(file, (p) => setState((s) => (s.kind === 'uploading' ? { ...s, sent: p.sent, total: p.total } : s)));
    transfer.current = handle;
    handle.done.then(
      (answer) => {
        transfer.current = null;
        setState({ kind: 'file', fileId: answer.file_id, importId: null });
        onSettled();
      },
      (e: unknown) => {
        transfer.current = null;
        if (e instanceof ApiError && e.code === 'ABORTED') {
          setState({ kind: 'stopped' });
          return;
        }
        if (e instanceof ApiError) {
          const max = uploadRefusal(e.status, cloudErrorCode(e), e.details).maxBytes;
          if (max) setLimit(max);
        }
        setState({ kind: 'refused', name: file.name, size: file.size, error: e });
      }
    );
  };

  const take = (files: FileList | null) => {
    if (!files || files.length === 0) return;
    if (files.length > 1) {
      setState({ kind: 'local', name: files[0].name, size: files[0].size, problem: 'oneFile' });
      return;
    }
    send(files[0]);
  };

  const choose = () => picker.current?.click();

  const importLink = async () => {
    if (importing) return;
    setUrlProblem(null);
    const link = url.trim();
    if (!/^https:\/\//i.test(link)) {
      setUrlProblem(t(upload.needsHttps));
      return;
    }
    setImporting(true);
    try {
      const started = await startImport(link);
      setUrl('');
      setState({ kind: 'import', importId: started.import_id });
      onSettled();
    } catch (e) {
      const reason = e instanceof ApiError ? (e.details as { reason?: unknown } | undefined)?.reason : null;
      setUrlProblem(urlRefusalText(typeof reason === 'string' ? reason : null, lang) ?? cloudErrorText(e, lang));
    } finally {
      setImporting(false);
    }
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    if (state.kind === 'uploading') return;
    take(e.dataTransfer.files);
  };

  const busy = state.kind === 'uploading';
  const percent = state.kind === 'uploading' ? progressPercent(state.sent, state.total) : null;

  return (
    <section aria-label={t(upload.title)} className="space-y-3">
      <div className="grid gap-3 md:grid-cols-2">
        <div
          className="lv-surface p-4"
          onDragOver={(e) => {
            e.preventDefault();
            if (!busy) setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
        >
          <div className={`flex flex-col items-center gap-2 rounded-xl border-2 border-dashed p-4 text-center transition-colors ${dragging ? 'border-gold bg-gold/5' : 'border-border-subtle'}`}>
            <span aria-hidden="true" className="grid h-12 w-12 place-items-center rounded-xl lv-well text-text-secondary">
              <Upload className="h-6 w-6" />
            </span>
            <h2 className="text-[15px] font-bold text-text-primary">{t(upload.title)}</h2>
            <p className="text-[12px] text-text-muted">{t(upload.formats)}</p>
            <input
              ref={picker}
              type="file"
              accept=".stl,.3mf,.obj"
              className="sr-only"
              tabIndex={-1}
              aria-hidden="true"
              onChange={(e) => {
                take(e.target.files);
                e.target.value = '';
              }}
            />
            <Button variant="primary" icon={<Upload aria-hidden="true" className="h-4 w-4" />} onClick={choose} disabled={busy}>
              {t(upload.choose)}
            </Button>
            <p className="text-[12px] text-text-muted">{dragging ? t(upload.dropNow) : t(upload.dropHint)}</p>
            <p className="text-[11px] leading-relaxed text-text-muted">{t(upload.serverChecks)}</p>
          </div>
        </div>

        <div className="lv-surface space-y-3 p-4">
          <div className="flex items-center gap-3">
            <span aria-hidden="true" className="grid h-10 w-10 shrink-0 place-items-center rounded-xl lv-well text-text-secondary">
              <Link2 className="h-5 w-5" />
            </span>
            <div className="min-w-0">
              <h2 className="text-[15px] font-bold text-text-primary">{t(upload.importTitle)}</h2>
              <p className="text-[12px] text-text-muted">{t(upload.importHint)}</p>
            </div>
          </div>
          <form
            className="space-y-2"
            onSubmit={(e) => {
              e.preventDefault();
              void importLink();
            }}
          >
            <Field label={t(upload.importField)} error={urlProblem}>
              <Input ltr type="url" inputMode="url" autoComplete="off" placeholder="https://" value={url} onChange={(e) => setUrl(e.target.value)} />
            </Field>
            <Button type="submit" variant="secondary" block icon={<Link2 aria-hidden="true" className="h-4 w-4" />} loading={importing} disabled={!url.trim()}>
              {t(upload.importButton)}
            </Button>
          </form>
          <p className="text-[11px] leading-relaxed text-text-muted">{t(upload.importHonesty)}</p>
        </div>
      </div>

      {state.kind !== 'idle' ? (
        <div className="lv-surface p-4" aria-live="polite">
          {state.kind === 'uploading' ? (
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-3">
                <p className="min-w-0 truncate text-[14px] font-semibold text-text-primary">{t(upload.uploading, { name: state.name })}</p>
                <Button
                  variant="ghost"
                  size="sm"
                  icon={<X aria-hidden="true" className="h-4 w-4" />}
                  onClick={() => transfer.current?.abort()}
                >
                  {t(upload.stop)}
                </Button>
              </div>
              <ProgressBar value={percent} label={t(upload.progressLabel)} tone="info" />
              <p className="flex flex-wrap items-center justify-between gap-2 text-[12px] text-text-muted">
                <span>{t(upload.sentOf, { done: formatBytes(state.sent, lang), total: formatBytes(state.total, lang) })}</span>
                {percent != null ? <bdi className="font-semibold tabular-nums text-text-primary">{formatPercent(percent, lang)}</bdi> : null}
              </p>
              {state.total > 0 && state.sent >= state.total ? <p className="text-[12px] text-text-secondary">{t(upload.waitingAnswer)}</p> : null}
            </div>
          ) : state.kind === 'refused' ? (
            <div className="space-y-3">
              <RefusedUpload name={state.name} size={state.size} error={state.error} limit={limit} />
              <Button variant="secondary" icon={<Upload aria-hidden="true" className="h-4 w-4" />} onClick={choose}>
                {t(upload.another)}
              </Button>
            </div>
          ) : state.kind === 'local' ? (
            <div className="space-y-3">
              <p role="alert" className="lv-alert lv-alert-warning text-[13px] leading-relaxed text-text-primary">
                {state.problem === 'overLimit' && limit
                  ? t(upload.overLimit, { size: formatBytes(state.size, lang), limit: formatBytes(limit, lang) })
                  : t(state.problem === 'oneFile' ? upload.oneFile : upload.wrongType)}
              </p>
              <Button variant="secondary" icon={<Upload aria-hidden="true" className="h-4 w-4" />} onClick={choose}>
                {t(upload.choose)}
              </Button>
            </div>
          ) : state.kind === 'stopped' ? (
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-[13px] text-text-secondary">{t(upload.stopped)}</p>
              <Button variant="secondary" size="sm" icon={<Upload aria-hidden="true" className="h-4 w-4" />} onClick={choose}>
                {t(upload.choose)}
              </Button>
            </div>
          ) : state.kind === 'file' ? (
            <FollowFile fileId={state.fileId} importId={state.importId} onAnother={choose} />
          ) : (
            <FollowImport importId={state.importId} onUpload={choose} onAnother={choose} />
          )}
        </div>
      ) : null}
    </section>
  );
}

// ------------------------------------------------------------------ the customer's own quick start

function QuickStart() {
  const { t, lang } = useCloudText();
  const jobs = useCloudQuery((signal) => listJobs({ signal }), []);
  const projects = useCloudQuery((signal) => listProjects({ signal }), []);
  const preparing = (jobs.data?.in_preparation ?? []).slice(0, 3);
  const again = (projects.data ?? []).filter((p) => p.status === 'active').slice(0, 3);
  if (jobs.error || projects.error) {
    return <CloudErrorState compact error={jobs.error ?? projects.error} onRetry={jobs.error ? jobs.reload : projects.reload} />;
  }
  if (preparing.length === 0 && again.length === 0) return null;
  return (
    <div className="grid gap-5 md:grid-cols-2">
      {preparing.length ? (
        <section aria-labelledby="print-quick-start" className="space-y-2">
          <SectionHeader id="print-quick-start" title={t(print.quickStart)} link={{ to: '/jobs', label: t(print.myPrints) }} />
          <ul className="space-y-2">
            {preparing.map((job) => (
              <li key={job.id}>
                <ListRow
                  to={`/jobs/${encodeURIComponent(job.id)}`}
                  leading={<History className="h-4 w-4" />}
                  title={job.title.trim() || t(print.untitled)}
                  meta={t(print.updated, { when: formatRelative(job.updated_at, lang) })}
                  trailing={<StatusPill kind="job" state={jobPillState(job.status)} />}
                />
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {again.length ? (
        <section aria-labelledby="print-again" className="space-y-2">
          <SectionHeader id="print-again" title={t(print.printAgain)} link={{ to: '/projects', label: t(print.projects) }} />
          <ul className="space-y-2">
            {again.map((p) => (
              <li key={p.id}>
                <ListRow
                  to={`/projects/${encodeURIComponent(p.id)}/print`}
                  leading={<Boxes className="h-4 w-4" />}
                  title={<bdi>{p.name}</bdi>}
                  meta={t(print.updated, { when: formatRelative(p.updated_at, lang) })}
                />
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

function RecentFiles({ version }: { version: number }) {
  const { t, lang } = useCloudText();
  const files = useCloudQuery((signal) => listFiles({ signal }), [version]);
  return (
    <section aria-labelledby="print-recent-files" className="space-y-2">
      <SectionHeader id="print-recent-files" title={t(print.recentFiles)} link={{ to: '/library', label: t(print.library) }} />
      {files.error && !files.data ? (
        <CloudErrorState compact error={files.error} onRetry={files.reload} />
      ) : !files.data ? (
        <Skeleton className="h-16 rounded-xl" />
      ) : files.data.length === 0 ? (
        <p className="lv-surface p-4 text-[13px] text-text-muted">{t(print.noRecent)}</p>
      ) : (
        <ul className="space-y-2">
          {files.data.slice(0, 5).map((f) => (
            <li key={f.id}>
              <ListRow
                to={`/library/${encodeURIComponent(f.id)}`}
                leading={<Box className="h-4 w-4" />}
                title={<bdi>{f.original_name}</bdi>}
                meta={`${f.extension.toUpperCase()} · ${formatBytes(f.size_bytes, lang)} · ${formatRelative(f.created_at, lang)}`}
                trailing={<FileStatusPill status={f.status} />}
              />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export default function PrintStart() {
  const { t } = useCloudText();
  const [version, setVersion] = useState(0);
  return (
    <div className="space-y-5">
      <PageHeader
        title={t(nav.print)}
        subtitle={t(print.subtitle)}
        actions={
          <nav aria-label={t(print.sections)} className="flex flex-wrap gap-2">
            <Link to="/jobs" className="lv-button lv-button-secondary lv-button-sm">
              {t(print.myPrints)}
            </Link>
            <Link to="/projects" className="lv-button lv-button-ghost lv-button-sm">
              {t(print.projects)}
            </Link>
            <Link to="/library" className="lv-button lv-button-ghost lv-button-sm">
              {t(print.library)}
            </Link>
          </nav>
        }
      />
      <Intake onSettled={() => setVersion((v) => v + 1)} />
      <QuickStart />
      <RecentFiles version={version} />
    </div>
  );
}
