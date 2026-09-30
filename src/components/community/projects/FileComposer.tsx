/**
 * THE AUTHOR'S FILES IN THE COMPOSER (docs/COMMUNITY_ECOSYSTEM.md §9.4): pick
 * up to three models or PDFs, each uploaded through a resumable session
 * (purpose `post`: the server files a model or a document PRIVATE under
 * post-files/, the only shape the post API accepts in `files[]`), name it,
 * tick «قابل للتنزيل». The keys travel back with the post; the server
 * re-checks every one against the author's own ledger. A file on its way up
 * is an UploadTile — progress, the checksum step named, cancel, retry — never
 * a ghost row.
 *
 * Split from ./FileRows.tsx (the reader's rows) so the project page does not
 * carry the tile, the switch and the input it never shows.
 */
import { useEffect, useRef, useState } from 'react';
import { Paperclip, Trash2 } from 'lucide-react';
import { useLanguage } from '../../../LanguageContext';
import type { UploadLargeResult } from '../../../lib/uploadSession';
import { Button, IconButton } from '../../ui/Button';
import { Input } from '../../ui/Field';
import { Switch } from '../../ui/Switch';
import { UploadTile } from '../../upload/UploadTile';
import { POST_FILES_MAX, formatBytes } from '../files/api';
import { KindIcon, POST_FILE_ACCEPT, postFileKind, type ComposerFile, type PostFileKind } from './FileRows';
import { useProjectStrings } from './strings';

export type { ComposerFile } from './FileRows';

interface Upload {
  id: string;
  file: File;
  kind: PostFileKind;
}

let uploadSeq = 0;

export function FileComposer({
  value,
  onChange,
  disabled,
  error: saveError,
  max = POST_FILES_MAX,
}: {
  value: ComposerFile[];
  onChange: (next: ComposerFile[]) => void;
  disabled?: boolean;
  /** A refusal about the files from the form's save (POST_FILE_*). */
  error?: string;
  max?: number;
}) {
  const s = useProjectStrings();
  const { lang } = useLanguage();
  const input = useRef<HTMLInputElement | null>(null);
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [problem, setProblem] = useState('');
  // A tile finishes later than the render that made it: append to what the form holds THEN.
  const latest = useRef(value);
  useEffect(() => {
    latest.current = value;
  }, [value]);

  function pick(list: FileList | null) {
    if (!list || list.length === 0) return;
    setProblem('');
    const room = Math.max(0, max - value.length - uploads.length);
    const chosen = Array.from(list);
    if (chosen.length > room) setProblem(s.filesLimit);
    const next: Upload[] = [];
    for (const file of chosen.slice(0, room)) {
      const kind = postFileKind(file.name);
      if (!kind) {
        setProblem(s.fileKindRefused);
        continue;
      }
      next.push({ id: `pf${++uploadSeq}`, file, kind });
    }
    if (next.length) setUploads((u) => [...u, ...next]);
    if (input.current) input.current.value = '';
  }

  const done = (u: Upload, result: UploadLargeResult) => {
    setUploads((list) => list.filter((x) => x.id !== u.id));
    if (!result.key) return;
    const name = u.file.name.replace(/\.[^.]+$/, '').slice(0, 120) || u.file.name.slice(0, 120);
    onChange([...latest.current, { key: result.key, name, bytes: result.bytes, kind: u.kind, downloadable: false }]);
  };
  const cancel = (u: Upload) => setUploads((list) => list.filter((x) => x.id !== u.id));
  const patch = (key: string, p: Partial<ComposerFile>) => onChange(value.map((f) => (f.key === key ? { ...f, ...p } : f)));
  const remove = (key: string) => onChange(value.filter((f) => f.key !== key));

  const full = value.length + uploads.length >= max;

  return (
    <div data-composer-files>
      {(value.length > 0 || uploads.length > 0) && (
        <ul className="flex flex-col gap-2" aria-label={s.files}>
          {value.map((f) => (
            <li key={f.key} data-composer-file className="flex flex-col gap-2 rounded-2xl border border-border-subtle bg-surface p-3">
              <div className="flex items-center gap-2">
                <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-surface-selected text-text-secondary">
                  <KindIcon kind={f.kind} className="h-4 w-4" />
                </span>
                <Input value={f.name} maxLength={120} aria-label={s.fileName} placeholder={s.fileName} disabled={disabled} onChange={(e) => patch(f.key, { name: e.target.value })} data-composer-file-name />
                <IconButton type="button" label={s.removeFile} icon={<Trash2 className="h-4 w-4" />} disabled={disabled} onClick={() => remove(f.key)} />
              </div>
              <div className="flex items-center justify-between gap-3 ps-12">
                <span className="text-[11.5px] text-text-muted">
                  <span dir="ltr">{formatBytes(f.bytes, lang)}</span> · {s.fileKinds[f.kind]}
                </span>
                <Switch checked={f.downloadable} disabled={disabled} onChange={(on) => patch(f.key, { downloadable: on })} label={<span className="text-[12.5px]">{s.downloadable}</span>} className="min-w-0" />
              </div>
            </li>
          ))}
          {uploads.map((u) => (
            <li key={u.id} data-composer-upload>
              <UploadTile file={u.file} purpose="post" onDone={(r) => done(u, r)} onCancel={() => cancel(u)} />
            </li>
          ))}
        </ul>
      )}
      {!full && (
        <Button type="button" variant="secondary" size="sm" icon={<Paperclip aria-hidden="true" className="h-4 w-4" />} disabled={disabled} onClick={() => input.current?.click()} className={value.length > 0 || uploads.length > 0 ? 'mt-2' : ''} data-composer-file-add>
          {s.addFile}
        </Button>
      )}
      <p className="mt-2 text-[11.5px] text-text-muted">{s.modelFileHint}</p>
      {(problem || saveError) && (
        <p className="mt-1.5 text-[11.5px] text-danger" role="alert">
          {problem || saveError}
        </p>
      )}
      <input ref={input} type="file" multiple accept={POST_FILE_ACCEPT} className="hidden" onChange={(e) => pick(e.target.files)} data-project-file-input />
    </div>
  );
}

export default FileComposer;
