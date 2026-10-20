/**
 * Attachments on a community request — the model, the drawing, the photo of
 * the broken part.
 *
 * This is not the merchant image picker with a different label. Three things
 * are genuinely different and each one shapes the component:
 *
 * A FILE BELONGS TO A REQUEST, so it cannot be uploaded before the request
 * exists. The new-request form therefore holds the chosen files locally and
 * uploads them once, after the request is created — and says so if that
 * second step fails, rather than pretending a request has a model it does not
 * have.
 *
 * MOST OF THESE ARE NOT PICTURES. An STL has no thumbnail, so the list is a
 * list: name, kind, size. Images get a preview; everything else gets an icon
 * and a download, because a fake preview of a model file is worse than none.
 *
 * THERE IS NO PUBLIC URL. Each file is fetched from a route that re-checks
 * who is asking, every time. That is why an attachment is an `<a href>` to
 * the API and never an R2 key.
 */

import { useRef, useState } from 'react';
import { Loader2, Paperclip, Trash2, FileText, Box, Image as ImageIcon, Download } from 'lucide-react';
import { api } from '../../lib/api';
import { useLanguage } from '../../LanguageContext';
import { pickRequestUpload, uploadLarge, type UploadProgress } from '../../lib/uploadSession';
import { REQUEST_FILE_LIMITS, requestFileAccept } from '../../../packages/contracts/src/requestFiles';
import { requestFileCheck, requestFilesCheck, requestUploadRefusal } from '../community/requests/fileRefusals';
import { RequestThumb } from '../community/requests/RequestFileThumbs';
import { UploadTile } from '../upload/UploadTile';

export interface RequestFile {
  id: string;
  file_name: string;
  content_type: string;
  size_bytes: number;
  kind: string;
  url?: string;
  inline?: boolean;
}

/**
 * What a request takes, from the one table every door reads
 * (packages/contracts/src/requestFiles.ts, R5): the same types, sizes and
 * count as the wizard, the whole-body route and the resumable session.
 */
export const ATTACHMENT_ACCEPT = requestFileAccept();
export const MAX_ATTACHMENTS = REQUEST_FILE_LIMITS.maxFiles;

type Lang = 'ar' | 'en' | 'ckb';

const isImage = (f: { type?: string; name: string }) =>
  (f.type ?? '').startsWith('image/') || /\.(jpe?g|png|webp|gif|avif)$/i.test(f.name);

/**
 * The client-side half of the check, from the same table as the server. The
 * server sniffs the bytes and is the real gate; this exists so a customer
 * picking a 400 MB file is told now instead of after the upload, in words
 * built from FORMAT_CAPABILITIES (src/components/community/requests/fileRefusals.ts).
 */
export function attachmentProblem(file: File, lang: Lang): string {
  return requestFileCheck(file, lang);
}

export function formatBytes(n: number): string {
  return n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
}

function KindIcon({ kind, className }: { kind: string; className?: string }) {
  if (kind === 'model') return <Box className={className} />;
  if (kind === 'document') return <FileText className={className} />;
  return <ImageIcon className={className} />;
}

/**
 * Upload every chosen file to a request that already exists: a picture that
 * fits one request through the whole-body route, a model or anything larger
 * through a resumable session — the door the same table picks
 * (src/lib/uploadSession.ts `pickUpload`). Returns how many failed AND why,
 * so the caller can be honest about a partial result and say what was wrong.
 */
export async function uploadRequestFiles(
  requestId: string,
  files: File[],
  onProgress?: (file: File, progress: UploadProgress) => void
): Promise<{ failed: number; reasons: unknown[] }> {
  const reasons: unknown[] = [];
  for (const file of files) {
    try {
      if (pickRequestUpload(file) === 'session') {
        await uploadLarge(file, 'request', { entityId: requestId, onProgress: onProgress && ((p) => onProgress(file, p)) });
      } else {
        const form = new FormData();
        form.append('file', file);
        await api.post(`/api/marketplace/requests/${requestId}/files`, form);
      }
    } catch (e) {
      reasons.push(e);
    }
  }
  return { failed: reasons.length, reasons };
}

/**
 * Choosing files BEFORE the request exists. Nothing is uploaded here; the
 * parent uploads the returned list once the request has an id.
 */
export function AttachmentDraft({
  files,
  onChange,
}: {
  files: File[];
  onChange: (files: File[]) => void;
}) {
  const { loc, lang } = useLanguage();
  const L: Lang = lang === 'en' || lang === 'ckb' ? lang : 'ar';
  const input = useRef<HTMLInputElement | null>(null);
  const [error, setError] = useState('');

  function add(list: FileList | null) {
    if (!list?.length) return;
    // Every picked file is asked the table in turn: none is dropped without
    // its reason (a file past the sixth is named, not sliced away).
    const { accepted, refusal } = requestFilesCheck(Array.from(list), L, files.length);
    if (accepted.length) onChange([...files, ...accepted]);
    setError(refusal);
    if (input.current) input.current.value = '';
  }

  return (
    <div>
      <div className="lv-well rounded-lg divide-y divide-border-subtle empty:hidden">
        {files.map((f, i) => (
          <div key={`${f.name}-${i}`} className="flex items-center gap-3 px-3 py-2.5">
            <KindIcon kind={isImage(f) ? 'reference' : 'model'} className="w-4 h-4 text-text-muted shrink-0" />
            <div className="min-w-0 flex-1">
              <p className="text-text-primary text-[12.5px] truncate">{f.name}</p>
              <p className="text-text-muted text-[11px]" dir="ltr">{formatBytes(f.size)}</p>
            </div>
            <button
              type="button"
              onClick={() => onChange(files.filter((_, j) => j !== i))}
              className="text-red-300/80 shrink-0"
              aria-label={loc('إزالة', 'Remove', 'لابردن')}
            >
              <Trash2 className="w-4 h-4" />
            </button>
          </div>
        ))}
      </div>

      {files.length < MAX_ATTACHMENTS && (
        <button
          type="button"
          onClick={() => input.current?.click()}
          className="w-full min-h-[46px] mt-2 rounded-lg border border-dashed border-border-subtle text-text-secondary text-[12.5px] font-semibold flex items-center justify-center gap-2 transition-colors hover:text-text-primary"
        >
          <Paperclip className="w-4 h-4" />
          {loc('أرفق صورة أو ملف ثلاثي الأبعاد', 'Attach a photo or a 3D file', 'وێنە یان فایلی سێ ڕەهەندی هاوپێچ بکە')}
        </button>
      )}

      <p className="text-text-muted text-[11px] mt-2">
        {loc(
          `صور، PDF، أو مجسمات ثلاثية الأبعاد. حتى ${MAX_ATTACHMENTS} ملفات. الملفات تُرفع بعد نشر الطلب.`,
          `Images, PDF, or 3D models. Up to ${MAX_ATTACHMENTS} files. They upload once the request is posted.`,
          `وێنە، PDF، یان مۆدێلی سێ ڕەهەندی. تا ${MAX_ATTACHMENTS} فایل. فایلەکان دوای بڵاوکردنەوەی داواکارییەکە باردەکرێن.`
        )}
      </p>
      {error && <p className="text-red-400 text-[11.5px] mt-1">{error}</p>}

      <input
        ref={input}
        type="file"
        accept={ATTACHMENT_ACCEPT}
        multiple
        className="hidden"
        onChange={(e) => add(e.target.files)}
      />
    </div>
  );
}

/**
 * The saved attachments on an existing request. `canEdit` is the OWNER's
 * answer from the server, and adding or removing is refused by the API once
 * the request stops taking offers — because a merchant priced against these.
 */
export function AttachmentList({
  requestId,
  files,
  canEdit,
  onChanged,
}: {
  requestId: string;
  files: RequestFile[];
  canEdit: boolean;
  onChanged: () => void;
}) {
  const { loc, lang } = useLanguage();
  const L: Lang = lang === 'en' || lang === 'ckb' ? lang : 'ar';
  const input = useRef<HTMLInputElement | null>(null);
  const tileSeq = useRef(0);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  // Files on their way up through a resumable session (a model, or anything
  // above 8 MiB, up to 300 MB): each draws the shared tile with its progress,
  // checksum step, cancel and retry, as in the wizard, never a bare spinner.
  const [tiles, setTiles] = useState<Array<{ id: string; file: File }>>([]);
  const dropTile = (id: string) => setTiles((list) => list.filter((t) => t.id !== id));
  const kindWord = (kind: string) =>
    kind === 'model' ? loc('مجسم', 'Model', 'مۆدێل') : kind === 'document' ? loc('مستند', 'Document', 'بەڵگەنامە') : loc('صورة', 'Picture', 'وێنە');

  async function add(list: FileList | null) {
    if (!list?.length) return;
    setError('');
    // Every picked file is asked the table in turn, counting the saved files
    // and the ones still uploading: none is dropped without its reason.
    const { accepted, refusal } = requestFilesCheck(Array.from(list), L, files.length + tiles.length);
    if (input.current) input.current.value = '';
    const viaSession = accepted.filter((f) => pickRequestUpload(f) === 'session');
    const whole = accepted.filter((f) => pickRequestUpload(f) !== 'session');
    if (viaSession.length) {
      setTiles((list) => [...list, ...viaSession.map((file) => ({ id: `t${(tileSeq.current += 1)}`, file }))]);
    }
    let said = refusal;
    if (whole.length) {
      setBusy('add');
      const { failed, reasons } = await uploadRequestFiles(requestId, whole);
      setBusy('');
      if (failed) {
        // The reason, not only the count: the server refusal in words (R5).
        const why = requestUploadRefusal(reasons[0], L, loc(
          `تعذّر رفع ${failed} من الملفات.`,
          `${failed} file(s) could not be uploaded.`,
          `${failed} فایل بار نەکرا.`
        ));
        said = said ? `${said} ${why}` : why;
      }
      onChanged();
    }
    setError(said);
  }

  async function remove(f: RequestFile) {
    setBusy(f.id);
    setError('');
    try {
      await api.delete(`/api/marketplace/requests/${requestId}/files/${f.id}`);
      onChanged();
    } catch (e) {
      setError(requestUploadRefusal(e, L, loc('تعذّر الحذف', 'Could not remove it', 'نەتوانرا بسڕدرێتەوە')));
    } finally {
      setBusy('');
    }
  }

  if (!files.length && !canEdit) return null;

  return (
    <div>
      <h3 className="text-gold font-bold text-[12.5px] mb-2">
        {loc('المرفقات', 'Attachments', 'هاوپێچەکان')}
      </h3>

      <div className="lv-well rounded-lg divide-y divide-border-subtle empty:hidden">
        {files.map((f) => (
          <div key={f.id} className="flex items-center gap-3 px-3 py-2.5">
            {f.inline && f.url ? (
              <RequestThumb url={f.url} size={40} />
            ) : (
              <div className="w-10 h-10 rounded-sm bg-surface-raised flex items-center justify-center shrink-0">
                <KindIcon kind={f.kind} className="w-4 h-4 text-text-muted" />
              </div>
            )}
            <div className="min-w-0 flex-1">
              <p className="text-text-primary text-[12.5px] truncate">{f.file_name}</p>
              <p className="text-text-muted text-[11px]">
                {kindWord(f.kind)} · <span dir="ltr">{formatBytes(f.size_bytes)}</span>
              </p>
            </div>
            {f.url && (
              <a
                href={f.url}
                target="_blank"
                rel="noreferrer"
                className="text-text-secondary shrink-0"
                aria-label={loc('فتح', 'Open', 'کردنەوە')}
              >
                <Download className="w-4 h-4" />
              </a>
            )}
            {canEdit && (
              <button
                type="button"
                onClick={() => remove(f)}
                disabled={busy === f.id}
                className="text-red-300/80 shrink-0 disabled:opacity-40"
                aria-label={loc('حذف', 'Remove', 'سڕینەوە')}
              >
                {busy === f.id ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
              </button>
            )}
          </div>
        ))}
      </div>

      {tiles.length > 0 && (
        <ul className="mt-2 space-y-1.5" aria-label={loc('ملفات قيد الرفع', 'Files uploading', 'فایلەکانی خەریکی بارکردنن')}>
          {tiles.map((t) => (
            <li key={t.id} data-attachments="upload-tile">
              <UploadTile
                file={t.file}
                purpose="request"
                entityId={requestId}
                onDone={() => {
                  dropTile(t.id);
                  onChanged();
                }}
                onCancel={() => dropTile(t.id)}
              />
            </li>
          ))}
        </ul>
      )}

      {canEdit && files.length + tiles.length < MAX_ATTACHMENTS && (
        <button
          type="button"
          onClick={() => input.current?.click()}
          disabled={busy === 'add'}
          className="w-full min-h-[42px] mt-2 rounded-lg border border-dashed border-border-subtle text-text-secondary text-[12.5px] font-semibold flex items-center justify-center gap-2 transition-colors hover:text-text-primary disabled:opacity-40"
        >
          {busy === 'add' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Paperclip className="w-4 h-4" />}
          {loc('أضف ملفًا', 'Add a file', 'فایلێک زیاد بکە')}
        </button>
      )}

      {error && <p className="text-red-400 text-[11.5px] mt-2">{error}</p>}

      <input
        ref={input}
        type="file"
        accept={ATTACHMENT_ACCEPT}
        multiple
        className="hidden"
        onChange={(e) => add(e.target.files)}
      />
    </div>
  );
}
