/**
 * STEP 1, «الملفات والفكرة» — EVERY WAY TO DESCRIBE THE JOB, TOGETHER
 * (community UI plan C4, §4; IMG_8474, IMG_8481; P1-06 design §4, critiques
 * 10, 13, 14).
 *
 *   «طريقة الطلب»     four tiles that are NOT a choice of one: «ملف مجسّم»,
 *                     «رابط مجسّم», «وصف فقط», «صور مرجعية». A tile is ticked
 *                     when the request already carries that kind, and a tap
 *                     opens its adder (the file picker, the link field, the
 *                     written reference, the picture picker). They are
 *                     checkboxes whose state is what the request holds.
 *   «الملفات المرفقة» one list of every kind: the picture or the glyph, the
 *                     name cut in the middle so «….stl» stays on screen,
 *                     «STL · 2.4 MB», the eye (a picture opens the in-page
 *                     viewer, a measured model the 3D viewer in a new tab)
 *                     and the bin (asked first). The rest a row can do (the
 *                     main source, a note, the original file) is in its «⋯»
 *                     menu, a sheet on a phone. A file on its way shows its
 *                     ring; a failed one keeps «أعد المحاولة» and «ألغِ» in
 *                     sight; one the table refused says why and only hides.
 *   the drop zone     click, keyboard, drag and drop, and the camera on a
 *                     touch screen; the formats line is read from the
 *                     contract (REQUEST_FILE_EXTENSIONS), never typed here.
 *
 * The title and the description follow in the step (RequestEditor.tsx).
 */
import { useRef, useState } from 'react';
import { Box, Eye, FileText, Image as ImageIcon, Link2, Ellipsis, RotateCcw, Star, Trash2, X } from 'lucide-react';
import { Menu, type MenuEntry } from '../../../ui/Menu';
import { SourceLinkCard } from '../../links/LinkCard';
import { formatBytes } from '../../../media/RequestAttachments';
import { REQUEST_FILE_EXTENSIONS, REQUEST_FILE_LIMITS, requestFileAccept, requestFileExtension } from '../../../../../packages/contracts/src/requestFiles';
import { ChoiceTiles } from '../../kit/controls';
import { CountedField, DropZone } from '../../kit/fields';
import { KitButton, KitIconButton } from '../../kit/buttons';
import { KitCard } from '../../kit/display';
import type { GridPicture } from './ImageGrid';
import { SourceThumb, linkLabel, middleTruncate, type ThumbKind } from './SourceThumb';
import { dimsText } from './PartCard';
import { LIMITS, fileOf, isFileSource, primaryKey, type EditorSource, type EditorState, type Key } from './state';
import type { UploadRow, UploadsApi } from './uploads';
import { uploadSummary } from './uploads';
import { isolateLtr } from './estimate';
import { fill, type EditorStrings } from './strings';

const ACCEPT = requestFileAccept();
const ACCEPT_MODELS = requestFileAccept(['model', 'document']);
const ACCEPT_PICTURES = requestFileAccept(['image']);

/** «STL · 3MF · … · PDF · JPG · …»: every extension a request takes, from the contract. */
export const FORMATS_LINE = [...REQUEST_FILE_EXTENSIONS.model, ...REQUEST_FILE_EXTENSIONS.document, ...REQUEST_FILE_EXTENSIONS.image].map((e) => e.toUpperCase()).join(' · ');

export type WayId = 'model' | 'link' | 'text' | 'pictures';
const WAYS: readonly WayId[] = ['model', 'link', 'text', 'pictures'];

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

/** The kinds the request carries now: the ticks of «طريقة الطلب». Files on their way count. */
export function waysCarried(s: EditorState, rows: readonly UploadRow[]): WayId[] {
  const out = new Set<WayId>();
  for (const x of s.sources) {
    if (x.kind === 'link') out.add('link');
    else if (x.kind === 'text_ref') out.add('text');
    else if (isFileSource(x)) out.add(fileOf(s, x.fileId)?.inline ? 'pictures' : 'model');
  }
  for (const r of rows) {
    if (r.status === 'rejected') continue;
    out.add(r.kind === 'image' ? 'pictures' : 'model');
  }
  return WAYS.filter((w) => out.has(w));
}

/** The meta line of a file: «STL · 2.4 MB». */
export function fileMeta(name: string, bytes: number | null | undefined): string {
  const ext = requestFileExtension(name).toUpperCase();
  return [ext, bytes ? formatBytes(bytes) : ''].filter(Boolean).join(' · ');
}

/** A thin ring for a file on its way (no stylesheet: an inline drawing). */
function Ring({ loaded, total }: { loaded: number; total: number }) {
  const p = total > 0 ? Math.max(0.04, Math.min(1, loaded / total)) : 0.04;
  const c = 2 * Math.PI * 9;
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" className="absolute inset-0 m-auto h-7 w-7 text-gold" data-editor-ring>
      <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeOpacity="0.25" strokeWidth="2.5" />
      <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="2.5" strokeDasharray={`${c * p} ${c}`} transform="rotate(-90 12 12)" strokeLinecap="round" />
    </svg>
  );
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
  const modelInput = useRef<HTMLInputElement | null>(null);
  const pictureInput = useRef<HTMLInputElement | null>(null);
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
  const carried = waysCarried(state, uploads.rows);
  const pending = uploads.rows;

  const pick = (list: FileList | null) => {
    if (list?.length) onPickFiles(Array.from(list));
    if (modelInput.current) modelInput.current.value = '';
    if (pictureInput.current) pictureInput.current.value = '';
  };

  /** A tile pressed: its adder opens (the tick stays what the request carries). */
  const openWay = (way: WayId) => {
    if (way === 'model') modelInput.current?.click();
    else if (way === 'pictures') pictureInput.current?.click();
    else {
      setAdding(way);
      requestAnimationFrame(() => document.getElementById(way === 'link' ? 'editor-link' : 'editor-text-ref')?.focus());
    }
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
    const items: MenuEntry[] = [];
    if (main !== x.key) {
      items.push({ id: 'primary', label: t.makePrimary, disabled: x.original, hint: x.original ? t.originalNotPrimary : undefined, onSelect: () => onPrimary(x.key) });
    }
    items.push({ id: 'note', label: x.note ? t.noteEdit : t.noteAdd, onSelect: () => toggleNote(x.key) });
    if (isFileSource(x) && f && !f.inline) {
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

  const ways = [
    { id: 'model', title: t.tileModel, subtitle: t.tileModelSub, icon: <Box className="h-6 w-6" strokeWidth={1.75} />, disabled: full && !carried.includes('model') },
    { id: 'link', title: t.tileLink, subtitle: t.tileLinkSub, icon: <Link2 className="h-6 w-6" strokeWidth={1.75} />, disabled: links >= LIMITS.maxLinks && !carried.includes('link') },
    { id: 'text', title: t.tileText, subtitle: t.tileTextSub, icon: <FileText className="h-6 w-6" strokeWidth={1.75} />, disabled: textRefs >= LIMITS.maxTextRefs && !carried.includes('text') },
    { id: 'pictures', title: t.tilePictures, subtitle: t.tilePicturesSub, icon: <ImageIcon className="h-6 w-6" strokeWidth={1.75} />, disabled: full && !carried.includes('pictures') },
  ];

  const hasRows = state.sources.length > 0 || pending.length > 0;

  return (
    <div className="space-y-5" data-editor-section="sources">
      <input ref={modelInput} type="file" multiple hidden accept={ACCEPT_MODELS} onChange={(e) => pick(e.target.files)} data-editor="file-input" />
      <input ref={pictureInput} type="file" multiple hidden accept={ACCEPT_PICTURES} onChange={(e) => pick(e.target.files)} data-editor="picture-input" />

      <section aria-labelledby="editor-ways">
        <h2 id="editor-ways" className="mb-2.5 text-ui-lg font-bold text-text-primary">
          {t.waysTitle}
        </h2>
        <KitCard className="p-3">
          <ChoiceTiles
            multiple
            label={t.waysTitle}
            columns={2}
            items={ways}
            value={carried}
            onChange={(ids) => {
              const toggled = WAYS.find((w) => ids.includes(w) !== carried.includes(w));
              if (toggled) openWay(toggled);
            }}
          />
        </KitCard>
        <p className="mt-2 text-ui-xs text-text-muted">{t.waysHint}</p>
      </section>

      {adding === 'link' && (
        <KitCard className="space-y-3" data-editor="link-form">
          <CountedField
            label={t.linkLabel}
            hint={t.linkHint}
            error={linkError || undefined}
            value={link}
            ltr
            placeholder="https://"
            onValueChange={(v) => {
              setLink(v);
              setLinkError('');
            }}
            id="editor-link"
          />
          <div className="flex flex-wrap gap-2">
            <KitButton
              size="sm"
              variant="secondary"
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
            </KitButton>
            <KitButton size="sm" variant="ghost" onClick={() => setAdding('')}>
              {t.cancelAdd}
            </KitButton>
          </div>
        </KitCard>
      )}

      {adding === 'text' && (
        <KitCard className="space-y-3" data-editor="text-form">
          <CountedField
            id="editor-text-ref"
            label={t.textRefLabel}
            multiline
            rows={3}
            max={LIMITS.textRefMax}
            value={text}
            placeholder={t.textRefPlaceholder}
            error={textError || undefined}
            onValueChange={setText}
          />
          <div className="flex flex-wrap gap-2">
            <KitButton
              size="sm"
              variant="secondary"
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
            </KitButton>
            <KitButton size="sm" variant="ghost" onClick={() => setAdding('')}>
              {t.cancelAdd}
            </KitButton>
          </div>
        </KitCard>
      )}

      {hasRows && (
        <section aria-labelledby="editor-attached" data-editor-section="attached">
          <h2 id="editor-attached" className="mb-2.5 text-ui-lg font-bold text-text-primary" tabIndex={-1}>
            {t.attachedTitle}
          </h2>
          <ul className="space-y-2.5" aria-labelledby="editor-attached">
            {state.sources.map((x) => {
              const f = fileOf(state, x.fileId);
              const name = sourceName(state, x);
              const kind = thumbKindOf(state, x);
              const pictureAt = f?.inline ? pictures.findIndex((p) => p.key === x.key) : -1;
              const dims = f?.analysis?.measured ? fill(t.measured, { dims: dimsText(f.analysis.dimensions_mm) }) : '';
              const kindWord =
                x.kind === 'link'
                  ? t.kindLink
                  : x.kind === 'text_ref'
                    ? t.kindText
                    : x.kind === 'project_post'
                      ? t.kindProjectCopy
                      : x.kind === 'studio_revision'
                        ? t.kindStudio
                        : kind === 'model'
                          ? t.kindModel
                          : kind === 'image'
                            ? t.kindPicture
                            : t.kindDocument;
              const working = f?.kind === 'model' && !f.analysis?.measured ? (measureLater.has(f.id) ? t.stMeasureLater : measuring.has(f.id) ? t.stMeasuring : '') : '';
              const view = pictureAt >= 0 ? () => onOpenPicture(pictureAt) : f?.kind === 'model' && f.analysis?.measured ? () => onView3d(f.id) : null;
              const short = middleTruncate(name, 30);
              const menu = sourceMenu(x);
              return (
                <li key={x.key} className="cm-card rounded-xl p-2.5 shadow-sm" data-editor-source={x.kind} data-editor-source-kind={kind}>
                  <div className="flex items-center gap-3">
                    <SourceThumb kind={kind} url={f?.url} size={56} />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[15px] font-semibold text-text-primary" title={name}>
                        {x.kind === 'text_ref' ? <bdi>{name}</bdi> : <bdi dir="ltr">{middleTruncate(name, 34)}</bdi>}
                      </p>
                      <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[13px] text-text-muted">
                        {f && <bdi dir="ltr">{fileMeta(f.file_name, f.size_bytes)}</bdi>}
                        <span>{kindWord}</span>
                        {dims && <span className="tabular-nums">{isolateLtr(dims)}</span>}
                        {working && <span>{working}</span>}
                        {main === x.key && (
                          <span className="inline-flex items-center gap-1 font-semibold text-text-primary" data-editor-primary>
                            <Star aria-hidden="true" className="h-3 w-3 text-gold" />
                            {t.primaryBadge}
                          </span>
                        )}
                        {x.original && (
                          <span className="font-semibold text-warning" data-editor-original>
                            {t.originalBadge}
                          </span>
                        )}
                        {x.origin && (
                          <span data-editor-origin={x.origin.kind}>
                            <bdi>{fill(x.origin.kind === 'project' ? t.fromProject : t.fromProduct, { title: x.origin.title })}</bdi>
                          </span>
                        )}
                      </p>
                    </div>
                    {view && (
                      <KitIconButton
                        shape="square"
                        label={kind === 'model' ? `${t.view3d}: ${short}` : fill(t.viewNamed, { name: short })}
                        icon={<Eye className="h-5 w-5" />}
                        onClick={view}
                        data-editor-view
                      />
                    )}
                    <KitIconButton shape="square" tone="danger" label={fill(t.removeNamed, { name: short })} icon={<Trash2 className="h-5 w-5" />} onClick={() => onRemove(x.key)} data-editor-remove />
                    {/* A picture keeps its note and the main mark in the viewer; every other source has them here. */}
                    {pictureAt < 0 && (
                      <Menu
                        label={fill(t.moreActions, { name: short })}
                        items={menu}
                        trigger={(props) => <KitIconButton {...props} tone="ghost" label={fill(t.moreActions, { name: short })} icon={<Ellipsis className="h-5 w-5" />} />}
                      />
                    )}
                  </div>
                  {x.kind === 'link' && <SourceLinkCard url={x.canonical || x.url} className="mt-2" />}
                  {rowError?.key === x.key && (
                    <p className="lv-field-error mt-2" role="alert">
                      {rowError.text}
                    </p>
                  )}
                  {(notes.has(x.key) || x.note) && (
                    <CountedField className="mt-2" label={t.noteLabel} hint={t.noteHint} multiline rows={2} max={LIMITS.sourceNoteMax} value={x.note} onValueChange={(v) => onNote(x.key, v)} />
                  )}
                </li>
              );
            })}
            {pending.map((r) => {
              const bad = r.status === 'failed' || r.status === 'rejected';
              const moving = !bad && r.status !== 'queued';
              return (
                <li key={r.key} className="cm-card rounded-xl p-2.5 shadow-sm" data-editor-upload={r.status}>
                  <div className="flex items-center gap-3">
                    <span className="relative shrink-0">
                      <SourceThumb kind={r.kind === 'model' ? 'model' : r.kind === 'image' ? 'image' : 'document'} preview={r.preview} size={56} />
                      {moving && <Ring loaded={r.loaded} total={r.total} />}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[15px] font-semibold text-text-primary" title={r.name}>
                        <bdi dir="ltr">{middleTruncate(r.name, 34)}</bdi>
                      </p>
                      <p className={`mt-0.5 text-[13px] tabular-nums ${bad ? 'text-danger' : 'text-text-muted'}`} role={bad ? 'alert' : undefined}>
                        {uploadLine(r)}
                      </p>
                    </div>
                    {r.status === 'rejected' ? (
                      <KitButton size="sm" variant="ghost" onClick={() => uploads.dismiss(r.key)}>
                        {t.dismiss}
                      </KitButton>
                    ) : (
                      <>
                        {r.status === 'failed' && (
                          <KitIconButton shape="square" label={`${t.retry}: ${r.name}`} icon={<RotateCcw className="h-5 w-5" />} onClick={() => uploads.retry(r.key)} data-editor-retry />
                        )}
                        <KitIconButton shape="square" tone="ghost" label={`${t.cancelUpload}: ${r.name}`} icon={<X className="h-5 w-5" />} onClick={() => uploads.cancel(r.key)} />
                      </>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      <DropZone
        title={t.dropTitle}
        subtitle={t.dropSub}
        accept={ACCEPT}
        disabled={full}
        cameraLabel={touch ? t.takePhoto : undefined}
        onFiles={onPickFiles}
        formats={
          <>
            {t.formatsLabel} <bdi dir="ltr">{FORMATS_LINE}</bdi>
          </>
        }
      />
      <p className="text-ui-xs text-text-muted" data-editor="limits">
        <span className="tabular-nums">
          {full
            ? fill(t.full, { n: REQUEST_FILE_LIMITS.maxFiles })
            : isolateLtr(fill(t.limitsLine, { f: Math.min(filesCount, REQUEST_FILE_LIMITS.maxFiles), fm: REQUEST_FILE_LIMITS.maxFiles, l: links, lm: LIMITS.maxLinks }))}
        </span>
        <span className="mt-1 block">{t.stMeasureLaterHint}</span>
      </p>

      {unfinished.length > 0 && (
        <p className="text-ui-xs text-warning" data-editor="resume-hint">
          {unfinished.map((name) => fill(t.resumeHint, { name })).join(' ')}
        </p>
      )}
      {summary && (
        <p className="text-[13px] font-semibold text-warning" role="status" data-editor="upload-summary">
          {isolateLtr(fill(t.summaryPartial, summary))}
        </p>
      )}
    </div>
  );
}
