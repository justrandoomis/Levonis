/**
 * THE FILE LIBRARY (GET /files, /imports, /files/{id}, /imports/{id}).
 *
 *   /files              the customer's models and link imports, newest first
 *                       (the server keeps the 200 most recent of each);
 *   /files/:id          one model: the server's check and its reason, the
 *                       measured size and what the measurement noticed, which
 *                       printer models it fits, download, print, delete;
 *   /files/imports/:id  one link import: its status said exactly — a saved
 *                       link is never «imported» — and the server's own log.
 *
 * Measurements exist only once the background check has run; until then the
 * page says it is being measured and shows no figure. A model a live print
 * needs cannot be deleted: the server refuses and its sentence is shown.
 */
import { useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { StatusChip } from '../../../components/ui/Badge';
import { Button } from '../../../components/ui/Button';
import { ConfirmDialog } from '../../../components/ui/ConfirmDialog';
import { Segmented } from '../../../components/ui/Segmented';
import { formatFigure } from '../../../lib/localeNumber';
import { toast } from '../../../lib/toastStore';
import { cloudErrorText, deleteFile, fileDownloadPath, getFile, getImport, listFiles, listImports } from '../../api';
import { buildVolumeParts, formatDateTime, formatPercent, formatRelative } from '../../format';
import { common, nav } from '../../strings/common';
import { fileBody, importBody, library, print, upload } from '../../strings/print';
import { useCloudText } from '../../text';
import type { ImportSummary, ModelFileSummary, ModelFileView } from '../../types';
import {
  Box,
  CloudEmptyState,
  CloudErrorState,
  CloudPageSkeleton,
  Download,
  ExternalLink,
  Link2,
  ListRow,
  PageHeader,
  SectionHeader,
  Trash2,
  Upload,
} from '../../ui';
import { useCloudQuery } from '../../useCloudQuery';
import { Fact, FileStatusPill, ImportStatusPill, MoreRow, RefreshNote, printerName, startProject, usePoll, usePrinterModels, useShown } from './kit';
import { fileSettled, formatBytes, geometryWarningText, importLogText, importOutcome, rejectionText } from './model';

/** The server keeps this many of each (worker/lib/printCloud/reports.ts `dashboardFiles`). */
const SERVER_CAP = 200;
const FOLLOW_MS = 5_000;

// ------------------------------------------------------------------ /files

function FileRows({ rows }: { rows: ModelFileSummary[] }) {
  const { t, lang } = useCloudText();
  const { shown, hasMore, more } = useShown(rows);
  if (rows.length === 0) {
    return (
      <CloudEmptyState
        icon={<Box className="h-6 w-6" />}
        title={t(library.noFiles)}
        body={t(library.noFilesBody)}
        action={
          <Link to="/print" className="lv-button lv-button-primary">
            {t(library.uploadModel)}
          </Link>
        }
      />
    );
  }
  return (
    <div className="space-y-2">
      <ul className="space-y-2">
        {shown.map((f) => (
          <li key={f.id}>
            <ListRow
              to={`/files/${encodeURIComponent(f.id)}`}
              leading={<Box className="h-4 w-4" />}
              title={<bdi>{f.original_name}</bdi>}
              meta={`${f.extension.toUpperCase()} · ${formatBytes(f.size_bytes, lang)} · ${f.source === 'url_import' ? t(library.fromLink) : t(library.uploaded)} · ${formatRelative(f.created_at, lang)}`}
              trailing={<FileStatusPill status={f.status} />}
            />
          </li>
        ))}
      </ul>
      <MoreRow hasMore={hasMore} onMore={more} total={rows.length} cap={SERVER_CAP} />
    </div>
  );
}

/** A link's host, for a row title the URL would make unreadable. */
function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

function ImportRows({ rows }: { rows: ImportSummary[] }) {
  const { t, lang } = useCloudText();
  const { shown, hasMore, more } = useShown(rows);
  if (rows.length === 0) {
    return (
      <CloudEmptyState
        icon={<Link2 className="h-6 w-6" />}
        title={t(library.noLinks)}
        body={t(upload.importHint)}
        action={
          <Link to="/print" className="lv-button lv-button-primary">
            {t(upload.importTitle)}
          </Link>
        }
      />
    );
  }
  return (
    <div className="space-y-2">
      <ul className="space-y-2">
        {shown.map((i) => (
          <li key={i.id}>
            <ListRow
              to={`/files/imports/${encodeURIComponent(i.id)}`}
              leading={<Link2 className="h-4 w-4" />}
              title={i.attribution ? <bdi>{i.attribution}</bdi> : <bdi dir="ltr">{hostOf(i.url)}</bdi>}
              meta={`${i.provider} · ${formatRelative(i.created_at, lang)}`}
              trailing={<ImportStatusPill status={i.status} fileId={i.file_id} />}
            />
          </li>
        ))}
      </ul>
      <MoreRow hasMore={hasMore} onMore={more} total={rows.length} cap={SERVER_CAP} />
    </div>
  );
}

function FilesPage() {
  const { t } = useCloudText();
  const [tab, setTab] = useState<'files' | 'links'>('files');
  const files = useCloudQuery((signal) => listFiles({ signal }), []);
  const imports = useCloudQuery((signal) => listImports({ signal }), []);
  const q = tab === 'files' ? files : imports;
  return (
    <div className="space-y-4">
      <PageHeader
        title={t(print.library)}
        subtitle={t(library.subtitle)}
        back={{ to: '/print', label: t(nav.print) }}
        actions={
          <Link to="/print" className="lv-button lv-button-primary lv-button-sm">
            <Upload aria-hidden="true" className="h-4 w-4" />
            {t(library.uploadModel)}
          </Link>
        }
      />
      <Segmented
        group="print-library"
        label={t(library.tabsLabel)}
        value={tab}
        onChange={(id) => setTab(id as 'files' | 'links')}
        items={[
          { id: 'files', label: t(library.tabFiles) },
          { id: 'links', label: t(library.tabLinks) },
        ]}
      />
      {q.error && !q.data ? (
        <CloudErrorState error={q.error} onRetry={q.reload} />
      ) : tab === 'files' ? (
        files.data ? <FileRows rows={files.data} /> : <CloudPageSkeleton />
      ) : imports.data ? (
        <ImportRows rows={imports.data} />
      ) : (
        <CloudPageSkeleton />
      )}
    </div>
  );
}

// ------------------------------------------------------------------ /files/:id

function Measurements({ file }: { file: ModelFileView }) {
  const { t, lang } = useCloudText();
  const g = file.geometry;
  if (!g) return null;
  const r = (n: number) => Math.round(n * 10) / 10;
  const dims = g.dimensions_mm ? buildVolumeParts({ x: r(g.dimensions_mm.x), y: r(g.dimensions_mm.y), z: r(g.dimensions_mm.z) }, lang) : null;
  return (
    <section aria-labelledby="print-file-measures" className="lv-surface p-4">
      <SectionHeader id="print-file-measures" title={t(library.measurements)} />
      <dl className="mt-2 divide-y divide-border-subtle">
        {dims ? (
          <Fact label={t(library.dimensions)}>
            <bdi dir="ltr">{dims.figure}</bdi> {dims.unit}
          </Fact>
        ) : null}
        {g.volume_mm3 != null ? (
          <Fact label={t(library.volume)}>{t(library.volumeValue, { n: formatFigure(Math.floor(g.volume_mm3 / 100) / 10, lang, 1) })}</Fact>
        ) : null}
        {g.triangle_count != null ? <Fact label={t(library.triangles)}>{formatFigure(g.triangle_count, lang)}</Fact> : null}
        {g.shell_count != null ? <Fact label={t(library.parts)}>{formatFigure(g.shell_count, lang)}</Fact> : null}
        {g.watertight != null ? <Fact label={t(library.closed)}>{g.watertight ? t(common.yes) : t(common.no)}</Fact> : null}
        {g.unit_source ? <Fact label={t(library.unit)}>{g.unit_source === 'declared' ? t(library.unitDeclared) : t(library.unitAssumed)}</Fact> : null}
        {g.overhang_ratio != null ? <Fact label={t(library.overhang)}>{formatPercent(Math.floor(g.overhang_ratio * 100), lang)}</Fact> : null}
      </dl>
      {g.warnings.length ? (
        <div className="mt-3 space-y-1.5">
          <h3 className="text-[13px] font-bold text-text-primary">{t(library.notes)}</h3>
          <ul className="space-y-1">
            {g.warnings.map((w) => (
              <li key={w.code} className={`text-[13px] leading-relaxed ${w.severity === 'info' ? 'text-text-secondary' : 'text-warning'}`}>
                {geometryWarningText(w, lang)}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}

function PrinterFit({ file }: { file: ModelFileView }) {
  const { t } = useCloudText();
  const printers = usePrinterModels();
  if (!file.printer_compatibility.length) return null;
  return (
    <section aria-labelledby="print-file-fit" className="lv-surface p-4">
      <SectionHeader id="print-file-fit" title={t(library.fit)} />
      <p className="mt-1 text-[12px] leading-relaxed text-text-muted">{t(library.fitNote)}</p>
      <ul className="mt-2 divide-y divide-border-subtle">
        {file.printer_compatibility.map((c) => {
          const m = printers.byId.get(c.printer_model_id);
          return (
            <li key={c.printer_model_id} className="flex items-center justify-between gap-3 py-2">
              <span className="min-w-0 truncate text-[13px] font-semibold text-text-primary">
                <bdi>{m ? printerName(m) : c.code}</bdi>
              </span>
              <StatusChip tone={c.as_oriented ? 'success' : c.any_orientation ? 'info' : 'neutral'}>
                {c.as_oriented ? t(library.fitsAsIs) : c.any_orientation ? t(library.fitsRotated) : t(library.noFit)}
              </StatusChip>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function FileDetail() {
  const { t, lang } = useCloudText();
  const navigate = useNavigate();
  const { id = '' } = useParams();
  const q = useCloudQuery((signal) => getFile(id, { signal }), [id]);
  usePoll(q.reload, !!q.data && !fileSettled(q.data.status), FOLLOW_MS);
  const made = useRef<{ projectId: string | null }>({ projectId: null });
  const [problem, setProblem] = useState<unknown>(null);
  const [asking, setAsking] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  if (q.error && !q.data) return <CloudErrorState error={q.error} onRetry={q.reload} />;
  const f = q.data;
  if (!f) return <CloudPageSkeleton />;

  const printThis = async () => {
    setProblem(null);
    try {
      const projectId = await startProject(f, f.import_id, made.current);
      navigate(`/projects/${encodeURIComponent(projectId)}/print`);
    } catch (e) {
      setProblem(e);
    }
  };
  const remove = async () => {
    setDeleteError(null);
    try {
      await deleteFile(f.id);
      setAsking(false);
      toast.success(t(library.deleted));
      navigate('/files', { replace: true });
    } catch (e) {
      setDeleteError(cloudErrorText(e, lang));
    }
  };

  return (
    <div className="space-y-4">
      <PageHeader
        back={{ to: '/files', label: t(print.library) }}
        title={<bdi>{f.original_name}</bdi>}
        subtitle={`${f.format.toUpperCase()} · ${formatBytes(f.size_bytes, lang)} · ${formatDateTime(f.created_at, lang)}`}
        actions={
          <>
            {f.status === 'ready' ? (
              <Button variant="primary" size="sm" icon={<Box aria-hidden="true" className="h-4 w-4" />} onClick={printThis}>
                {t(library.printThis)}
              </Button>
            ) : null}
            <a href={fileDownloadPath(f.id)} download className="lv-button lv-button-secondary lv-button-sm">
              <Download aria-hidden="true" className="h-4 w-4" />
              {t(library.download)}
            </a>
            <Button variant="ghost" size="sm" icon={<Trash2 aria-hidden="true" className="h-4 w-4" />} onClick={() => setAsking(true)}>
              {t(library.delete)}
            </Button>
          </>
        }
      />
      {problem ? <CloudErrorState compact error={problem} /> : null}
      <RefreshNote error={q.data && q.error ? q.error : null} onRetry={q.reload} />

      <section aria-labelledby="print-file-status" className="lv-surface space-y-2 p-4">
        <SectionHeader id="print-file-status" title={t(library.details)} action={<FileStatusPill status={f.status} />} />
        <p className={`text-[13px] leading-relaxed ${f.status === 'rejected' || f.status === 'failed' ? 'text-danger' : 'text-text-secondary'}`}>
          {f.status === 'ready'
            ? t(fileBody.ready)
            : f.status === 'rejected' || f.status === 'failed'
              ? t(f.status === 'rejected' ? fileBody.rejected : fileBody.failed, { reason: rejectionText(f.rejection_code, lang) })
              : t(fileBody.checking)}
        </p>
        <dl className="divide-y divide-border-subtle">
          <Fact label={t(library.format)}>
            <bdi dir="ltr">{f.format.toUpperCase()}</bdi>
          </Fact>
          <Fact label={t(library.fileSize)}>{formatBytes(f.size_bytes, lang)}</Fact>
          <Fact label={t(library.uploadedAt)}>{formatDateTime(f.created_at, lang)}</Fact>
          <Fact label={t(library.source)}>
            {f.source === 'url_import' && f.import_id ? (
              <Link to={`/files/imports/${encodeURIComponent(f.import_id)}`} className="underline underline-offset-2 hover:text-text-secondary">
                {t(library.fromLink)}
              </Link>
            ) : (
              t(library.uploaded)
            )}
          </Fact>
          <Fact label={t(library.fingerprint)}>
            <bdi dir="ltr" className="break-all font-mono text-[11px] font-normal text-text-secondary">
              {f.content_sha256}
            </bdi>
          </Fact>
        </dl>
      </section>

      <Measurements file={f} />
      <PrinterFit file={f} />

      <ConfirmDialog
        open={asking}
        destructive
        title={t(library.deleteQ)}
        consequence={t(library.deleteBody)}
        confirmLabel={t(library.delete)}
        cancelLabel={t(common.close)}
        error={deleteError}
        onConfirm={remove}
        onCancel={() => {
          setAsking(false);
          setDeleteError(null);
        }}
      />
    </div>
  );
}

// ------------------------------------------------------------------ /files/imports/:id

function ImportDetail() {
  const { t, lang } = useCloudText();
  const { id = '' } = useParams();
  const q = useCloudQuery((signal) => getImport(id, { signal }), [id]);
  const outcome = q.data ? importOutcome(q.data) : null;
  usePoll(q.reload, !!q.data && !outcome?.settled, FOLLOW_MS);
  if (q.error && !q.data) return <CloudErrorState error={q.error} onRetry={q.reload} />;
  const imp = q.data;
  if (!imp || !outcome) return <CloudPageSkeleton />;
  const meta = imp.metadata as { name?: unknown; creator?: unknown };
  const name = typeof meta.name === 'string' && meta.name ? meta.name : imp.provider;
  const body =
    imp.status === 'file_imported' && outcome.fileDownloaded
      ? t(importBody.file_imported, { provider: imp.provider })
      : imp.status === 'rejected'
        ? t(importBody.rejected, { reason: rejectionText(imp.error_code, lang) })
        : imp.status === 'link_saved' || imp.status === 'failed'
          ? t(importBody[imp.status])
          : t(importBody.pending);
  return (
    <div className="space-y-4">
      <PageHeader back={{ to: '/files', label: t(print.library) }} title={<bdi>{name}</bdi>} subtitle={`${t(library.importTitle)} · ${formatRelative(imp.created_at, lang)}`} />
      <RefreshNote error={q.data && q.error ? q.error : null} onRetry={q.reload} />
      <section aria-labelledby="print-import-status" className="lv-surface space-y-3 p-4">
        <SectionHeader id="print-import-status" title={t(library.importTitle)} action={<ImportStatusPill status={imp.status} fileId={imp.file_id} />} />
        <p className={`text-[13px] leading-relaxed ${imp.status === 'link_saved' ? 'lv-alert lv-alert-warning text-text-primary' : 'text-text-secondary'}`}>{body}</p>
        <dl className="divide-y divide-border-subtle">
          <Fact label={t(library.site)}>{imp.provider}</Fact>
          {typeof meta.creator === 'string' && meta.creator ? <Fact label={t(library.designer)}>{meta.creator}</Fact> : null}
          {imp.license ? <Fact label={t(library.license)}>{imp.license}</Fact> : null}
        </dl>
        <div className="flex flex-wrap gap-2">
          {outcome.fileDownloaded && imp.file_id ? (
            <Link to={`/files/${encodeURIComponent(imp.file_id)}`} className="lv-button lv-button-primary lv-button-sm">
              <Box aria-hidden="true" className="h-4 w-4" />
              {t(library.openFile)}
            </Link>
          ) : outcome.settled ? (
            <Link to="/print" className="lv-button lv-button-primary lv-button-sm">
              <Upload aria-hidden="true" className="h-4 w-4" />
              {t(upload.choose)}
            </Link>
          ) : null}
          <a href={imp.canonical_url || imp.url} target="_blank" rel="noopener noreferrer" className="lv-button lv-button-secondary lv-button-sm">
            <ExternalLink aria-hidden="true" className="h-4 w-4" />
            {t(library.openLink)}
          </a>
        </div>
      </section>
      {imp.logs.length ? (
        <section aria-labelledby="print-import-log" className="lv-surface p-4">
          <SectionHeader id="print-import-log" title={t(library.whatHappened)} />
          <ol className="mt-2 divide-y divide-border-subtle">
            {imp.logs.map((l, i) => (
              <li key={`${l.code}-${i}`} className="flex items-start justify-between gap-3 py-2">
                <span className={`min-w-0 text-[13px] ${l.level === 'error' ? 'text-danger' : l.level === 'warning' ? 'text-warning' : 'text-text-primary'}`}>
                  {importLogText(l.code, lang)}
                </span>
                <span className="shrink-0 text-[12px] text-text-muted">{formatDateTime(l.created_at, lang)}</span>
              </li>
            ))}
          </ol>
        </section>
      ) : null}
    </div>
  );
}

export default function Library({ view }: { view: 'files' | 'file' | 'import' }) {
  if (view === 'file') return <FileDetail />;
  if (view === 'import') return <ImportDetail />;
  return <FilesPage />;
}
