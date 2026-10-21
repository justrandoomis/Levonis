/**
 * «ما لديك» — EVERY WAY TO DESCRIBE THE JOB, TOGETHER (plan P1-06; design
 * §4, critiques 10, 13, 14). Files, pictures, links and written references
 * sit side by side; nothing is an either-or choice.
 *
 * The pictures are a grid (ImageGrid.tsx) that opens the in-page viewer; the
 * models, documents, links and written references are rows. A row shows what
 * a merchant will see — its picture or glyph, its name cut in the middle so
 * «….stl» stays on screen, its measured size, its state while it uploads —
 * and «الرئيسي» on the main source. Everything else a row can do (make it the
 * main source, its note, the original file, a 3D look in a new tab, delete
 * it) is in ONE «⋯» menu, which is a sheet on a phone. A failed upload keeps
 * its own «أعد المحاولة» and «ألغِ» in sight, and a file the table refused
 * says why and offers only «أخفِ».
 */
import { useRef, useState } from 'react';
import { Camera, Link2, MoreVertical, Quote, RotateCcw, Star, Upload, X } from 'lucide-react';
import { Button, IconButton } from '../../../ui/Button';
import { Field, Input, Textarea } from '../../../ui/Field';
import { Menu, type MenuEntry } from '../../../ui/Menu';
import { bidiContent } from '../../../ui/BidiText';
import { SourceLinkCard } from '../../links/LinkCard';
import { formatBytes } from '../../../upload/strings';
import { REQUEST_FILE_LIMITS, requestFileAccept } from '../../../../../packages/contracts/src/requestFiles';
import { ImageGrid, type GridPicture } from './ImageGrid';
import { SourceThumb, linkLabel, middleTruncate, type ThumbKind } from './SourceThumb';
import { dimsText } from './PartCard';
import { LIMITS, fileOf, isFileSource, primaryKey, type EditorSource, type EditorState, type Key } from './state';
import type { UploadRow, UploadsApi } from './uploads';
import { uploadSummary } from './uploads';
import { fill, type EditorStrings } from './strings';

const ACCEPT = requestFileAccept();

export function thumbKindOf(s: EditorState, x: EditorSource): ThumbKind {
  if (x.kind === 'link') return 'link';
  if (x.kind === 'text_ref') return 'text';
  const f = fileOf(s, x.fileId);
  if (f?.inline) return 'image';
  return f?.kind === 'model' ? 'model' : 'document';
}

/** A source as its row names it: the file name, the link, the first words of a reference. */
export function sourceName(s: EditorState, x: EditorSource): string {
  if (x.kind === 'link') return linkLabel(x.canonical || x.url);
  if (x.kind === 'text_ref') return x.refText.split('\n')[0].slice(0, 80);
  return fileOf(s, x.fileId)?.file_name ?? '';
}

export function SourcesArea({
  state,
  uploads,
  pictures,
  touch,
  unfinished,
  measuring,
  measureLater,
  t,
  onPickFiles,
  onAddLink,
  onAddTextRef,
  onOpenPicture,
  onNote,
  onPrimary,
  onOriginal,
  onView3d,
  onRemove,
}: {
  state: EditorState;
  uploads: UploadsApi;
  pictures: GridPicture[];
  touch: boolean;
  unfinished: string[];
  measuring: ReadonlySet<string>;
  measureLater: ReadonlySet<string>;
  t: EditorStrings;
  onPickFiles: (files: File[]) => void;
  onAddLink: (url: string) => Promise<string>;
  onAddTextRef: (text: string) => string;
  onOpenPicture: (index: number) => void;
  onNote: (key: Key, note: string) => void;
  onPrimary: (key: Key) => void;
  onOriginal: (key: Key, on: boolean) => string;
  onView3d: (fileId: string) => void;
  onRemove: (key: Key) => void;
}) {
  const fileInput = useRef<HTMLInputElement | null>(null);
  const cameraInput = useRef<HTMLInputElement | null>(null);
  const [adding, setAdding] = useState<'' | 'link' | 'text'>('');
  const [link, setLink] = useState('');
  const [linkError, setLinkError] = useState('');
  const [checking, setChecking] = useState(false);
  const [text, setText] = useState('');
  const [textError, setTextError] = useState('');
  const [notes, setNotes] = useState<ReadonlySet<Key>>(() => new Set());
  const [rowError, setRowError] = useState<{ key: Key; text: string } | null>(null);

  const main = primaryKey(state);
  const filesCount = state.files.length + uploads.rows.filter((r) => r.status !== 'rejected').length;
  const full = filesCount >= REQUEST_FILE_LIMITS.maxFiles;
  const links = state.sources.filter((x) => x.kind === 'link').length;
  const textRefs = state.sources.filter((x) => x.kind === 'text_ref').length;
  const summary = uploadSummary(uploads.rows, uploads.storedThisVisit);
  const rows = state.sources.filter((x) => !(isFileSource(x) && fileOf(state, x.fileId)?.inline));
  const pendingRows = uploads.rows.filter((r) => r.status === 'rejected' || !r.preview);

  const pick = (list: FileList | null) => {
    if (list?.length) onPickFiles(Array.from(list));
    if (fileInput.current) fileInput.current.value = '';
    if (cameraInput.current) cameraInput.current.value = '';
  };

  const toggleNote = (key: Key) =>
    setNotes((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const sourceMenu = (x: EditorSource): MenuEntry[] => {
    const f = fileOf(state, x.fileId);
    const fileKind = isFileSource(x);
    const items: MenuEntry[] = [];
    if (main !== x.key) {
      items.push({
        id: 'primary',
        label: t.makePrimary,
        disabled: x.original,
        hint: x.original ? t.originalNotPrimary : undefined,
        onSelect: () => onPrimary(x.key),
      });
    }
    items.push({ id: 'note', label: x.note ? t.noteEdit : t.noteAdd, onSelect: () => toggleNote(x.key) });
    if (fileKind && f && !f.inline) {
      items.push({
        id: 'original',
        label: x.original ? t.originalOff : t.originalOn,
        hint: x.original ? undefined : t.originalHint,
        onSelect: () => {
          const err = onOriginal(x.key, !x.original);
          setRowError(err ? { key: x.key, text: err } : null);
        },
      });
    }
    if (f?.kind === 'model' && f.analysis?.measured) items.push({ id: '3d', label: t.view3d, onSelect: () => onView3d(f.id) });
    items.push({ id: 'sep', separator: true }, { id: 'remove', label: t.remove, destructive: true, onSelect: () => onRemove(x.key) });
    return items;
  };

  const uploadLine = (r: UploadRow): string => {
    if (r.status === 'rejected') return fill(t.stRejected, { reason: r.reason });
    if (r.status === 'failed') return fill(t.stFailed, { reason: r.reason });
    if (r.status === 'queued') return t.stQueued;
    if (r.status === 'checking') return fill(t.stChecking, { p: r.total > 0 ? Math.round((r.loaded / r.total) * 100) : 0 });
    if (r.status === 'finishing') return t.stFinishing;
    const line = fill(t.stUploading, { a: formatBytes(r.loaded), b: formatBytes(r.total) });
    return r.part && r.parts && r.parts > 1 ? `${line} · ${fill(t.stPart, { n: r.part, total: r.parts })}` : line;
  };

  return (
    <div className="space-y-4">
      <p className="text-[12.5px] leading-relaxed text-text-muted">{t.secSourcesHint}</p>

      <input ref={fileInput} type="file" multiple hidden accept={ACCEPT} onChange={(e) => pick(e.target.files)} data-editor="file-input" />
      <input ref={cameraInput} type="file" hidden accept="image/*" capture="environment" onChange={(e) => pick(e.target.files)} data-editor="camera-input" />

      <div className="grid grid-cols-2 gap-2">
        <Button variant="secondary" icon={<Upload aria-hidden="true" className="h-4 w-4" />} disabled={full} onClick={() => fileInput.current?.click()} data-editor="add-files">
          {t.addFiles}
        </Button>
        {touch && (
          <Button variant="secondary" icon={<Camera aria-hidden="true" className="h-4 w-4" />} disabled={full} onClick={() => cameraInput.current?.click()} data-editor="take-photo">
            {t.takePhoto}
          </Button>
        )}
        <Button
          variant="secondary"
          icon={<Link2 aria-hidden="true" className="h-4 w-4" />}
          aria-expanded={adding === 'link'}
          disabled={links >= LIMITS.maxLinks}
          onClick={() => setAdding((a) => (a === 'link' ? '' : 'link'))}
          data-editor="add-link"
        >
          {t.addLink}
        </Button>
        <Button
          variant="secondary"
          icon={<Quote aria-hidden="true" className="h-4 w-4" />}
          aria-expanded={adding === 'text'}
          disabled={textRefs >= LIMITS.maxTextRefs}
          onClick={() => setAdding((a) => (a === 'text' ? '' : 'text'))}
          data-editor="add-text"
        >
          {t.addTextRef}
        </Button>
      </div>
      <p className="text-[12px] text-text-muted">
        {full ? fill(t.full, { n: REQUEST_FILE_LIMITS.maxFiles }) : fill(t.addFilesHint, { n: REQUEST_FILE_LIMITS.maxFiles })}
        <span className="ms-1 tabular-nums">
          {bidiContent(fill(t.limitsLine, { f: Math.min(filesCount, REQUEST_FILE_LIMITS.maxFiles), fm: REQUEST_FILE_LIMITS.maxFiles, l: links, lm: LIMITS.maxLinks }))}
        </span>
      </p>

      {adding === 'link' && (
        <div className="space-y-2 rounded-md border border-border-subtle p-3" data-editor="link-form">
          <Field label={t.linkLabel} hint={t.linkHint} error={linkError || undefined}>
            <Input
              ltr
              type="url"
              inputMode="url"
              autoComplete="off"
              placeholder="https://"
              value={link}
              onChange={(e) => {
                setLink(e.target.value);
                setLinkError('');
              }}
            />
          </Field>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="primary"
              size="sm"
              loading={checking}
              onClick={async () => {
                if (!/^https:\/\//i.test(link.trim())) {
                  setLinkError(t.linkInvalid);
                  return;
                }
                setChecking(true);
                const err = await onAddLink(link.trim());
                setChecking(false);
                if (err) setLinkError(err);
                else {
                  setLink('');
                  setAdding('');
                }
              }}
            >
              {t.linkAddButton}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setAdding('')}>
              {t.cancelAdd}
            </Button>
          </div>
        </div>
      )}

      {adding === 'text' && (
        <div className="space-y-2 rounded-md border border-border-subtle p-3" data-editor="text-form">
          <Field label={t.textRefLabel} error={textError || undefined}>
            <Textarea dir="auto" rows={3} maxLength={LIMITS.textRefMax} value={text} placeholder={t.textRefPlaceholder} onChange={(e) => setText(e.target.value)} />
          </Field>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="primary"
              size="sm"
              disabled={!text.trim()}
              onClick={() => {
                const err = onAddTextRef(text);
                if (err) setTextError(err);
                else {
                  setText('');
                  setTextError('');
                  setAdding('');
                }
              }}
            >
              {t.textRefAddButton}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setAdding('')}>
              {t.cancelAdd}
            </Button>
          </div>
        </div>
      )}

      {unfinished.length > 0 && (
        <p className="text-[12px] text-warning" data-editor="resume-hint">
          {unfinished.map((name) => fill(t.resumeHint, { name })).join(' ')}
        </p>
      )}

      {pictures.length > 0 && (
        <div>
          <h3 className="mb-2 text-[13px] font-semibold text-text-secondary">{t.picturesLabel}</h3>
          <ImageGrid pictures={pictures} onOpen={onOpenPicture} onRetry={uploads.retry} onCancel={uploads.cancel} t={t} />
        </div>
      )}

      {(rows.length > 0 || pendingRows.length > 0) && (
        <div>
          <h3 className="mb-2 text-[13px] font-semibold text-text-secondary">{t.filesLinksLabel}</h3>
          <ul className="space-y-2" aria-label={t.filesLinksLabel}>
            {rows.map((x) => {
              const f = fileOf(state, x.fileId);
              const name = sourceName(state, x);
              const kind = thumbKindOf(state, x);
              const dims = f?.analysis?.measured ? fill(t.measured, { dims: dimsText(f.analysis.dimensions_mm) }) : '';
              const kindWord =
                x.kind === 'link' ? t.kindLink : x.kind === 'text_ref' ? t.kindText : x.kind === 'project_post' ? t.kindProjectCopy : x.kind === 'studio_revision' ? t.kindStudio : kind === 'model' ? t.kindModel : t.kindDocument;
              const state1 = f?.kind === 'model' && !f.analysis?.measured ? (measureLater.has(f.id) ? t.stMeasureLater : measuring.has(f.id) ? t.stMeasuring : '') : '';
              return (
                <li key={x.key} className="rounded-md bg-surface px-3 py-2" data-editor-source={x.kind} data-editor-source-kind={kind}>
                  <div className="flex items-center gap-3">
                    <SourceThumb kind={kind} url={f?.url} />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[13px] font-semibold text-text-primary" title={name}>
                        {x.kind === 'text_ref' ? <bdi>{name}</bdi> : <bdi dir="ltr">{middleTruncate(name, 34)}</bdi>}
                      </p>
                      <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11.5px] text-text-muted">
                        <span>{kindWord}</span>
                        {dims && <span className="tabular-nums">{bidiContent(dims)}</span>}
                        {state1 && <span>{state1}</span>}
                        {main === x.key && (
                          <span className="inline-flex items-center gap-1 font-semibold text-text-primary" data-editor-primary>
                            <Star aria-hidden="true" className="h-3 w-3 text-gold" />
                            {t.primaryBadge}
                          </span>
                        )}
                        {x.original && <span className="font-semibold text-warning" data-editor-original>{t.originalBadge}</span>}
                      </p>
                    </div>
                    <Menu
                      label={fill(t.moreActions, { name: middleTruncate(name, 30) })}
                      items={sourceMenu(x)}
                      trigger={(props) => <IconButton {...props} label={fill(t.moreActions, { name: middleTruncate(name, 30) })} icon={<MoreVertical className="h-5 w-5" />} />}
                    />
                  </div>
                  {x.kind === 'link' && <SourceLinkCard url={x.canonical || x.url} className="mt-2" />}
                  {rowError?.key === x.key && (
                    <p className="lv-field-error mt-2" role="alert">
                      {rowError.text}
                    </p>
                  )}
                  {(notes.has(x.key) || x.note) && (
                    <div className="mt-2">
                      <Field label={t.noteLabel} hint={t.noteHint}>
                        <Textarea dir="auto" rows={2} maxLength={LIMITS.sourceNoteMax} value={x.note} onChange={(e) => onNote(x.key, e.target.value)} />
                      </Field>
                    </div>
                  )}
                </li>
              );
            })}
            {pendingRows.map((r) => (
              <li key={r.key} className="rounded-md bg-surface px-3 py-2" data-editor-upload={r.status}>
                <div className="flex items-center gap-3">
                  <SourceThumb kind={r.kind === 'model' ? 'model' : r.kind === 'image' ? 'image' : 'document'} preview={r.preview} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[13px] font-semibold text-text-primary" title={r.name}>
                      <bdi dir="ltr">{middleTruncate(r.name, 34)}</bdi>
                    </p>
                    <p
                      className={`mt-0.5 text-[11.5px] tabular-nums ${r.status === 'failed' || r.status === 'rejected' ? 'text-danger' : 'text-text-muted'}`}
                      role={r.status === 'failed' || r.status === 'rejected' ? 'alert' : undefined}
                    >
                      {uploadLine(r)}
                    </p>
                  </div>
                  {r.status === 'rejected' ? (
                    <Button size="sm" variant="ghost" onClick={() => uploads.dismiss(r.key)}>
                      {t.dismiss}
                    </Button>
                  ) : r.status === 'failed' ? (
                    <div className="flex shrink-0 items-center">
                      <IconButton label={`${t.retry}: ${r.name}`} icon={<RotateCcw className="h-4 w-4" />} onClick={() => uploads.retry(r.key)} data-editor-retry />
                      <IconButton label={`${t.cancelUpload}: ${r.name}`} icon={<X className="h-4 w-4" />} onClick={() => uploads.cancel(r.key)} />
                    </div>
                  ) : (
                    <IconButton label={`${t.cancelUpload}: ${r.name}`} icon={<X className="h-4 w-4" />} onClick={() => uploads.cancel(r.key)} />
                  )}
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      {summary && (
        <p className="text-[12.5px] font-semibold text-warning" role="status" data-editor="upload-summary">
          {bidiContent(fill(t.summaryPartial, summary))}
        </p>
      )}
    </div>
  );
}
