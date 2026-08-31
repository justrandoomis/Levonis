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
import { api, ApiError } from '../../lib/api';
import { useLanguage } from '../../LanguageContext';

export interface RequestFile {
  id: string;
  file_name: string;
  content_type: string;
  size_bytes: number;
  kind: string;
  url?: string;
  inline?: boolean;
}

/** Kept in step with worker/lib/attachments.ts. */
export const ATTACHMENT_ACCEPT = '.jpg,.jpeg,.png,.webp,.gif,.pdf,.stl,.3mf,.obj';
const IMAGE_MAX = 8 * 1024 * 1024;
const MODEL_MAX = 40 * 1024 * 1024;
export const MAX_ATTACHMENTS = 6;

const isImage = (f: { type?: string; name: string }) =>
  (f.type ?? '').startsWith('image/') || /\.(jpe?g|png|webp|gif)$/i.test(f.name);

/**
 * The client-side half of the check. The server sniffs the bytes and is the
 * real gate; this exists so a merchant picking a 200 MB file is told now
 * instead of after the upload.
 */
export function attachmentProblem(file: File, loc: Loc): string {
  const ext = file.name.toLowerCase().split('.').pop() ?? '';
  if (!['jpg', 'jpeg', 'png', 'webp', 'gif', 'pdf', 'stl', '3mf', 'obj'].includes(ext)) {
    return loc(
      'نوع غير مدعوم — أرفق صورة أو PDF أو ملف STL / 3MF / OBJ.',
      'Unsupported type — attach an image, a PDF, or an STL / 3MF / OBJ model.',
      'جۆری پشتگیری نەکراو — وێنە یان PDF یان STL / 3MF / OBJ.'
    );
  }
  const max = isImage(file) ? IMAGE_MAX : MODEL_MAX;
  if (file.size > max) {
    return loc(
      `الملف أكبر من ${max / 1024 / 1024} ميغابايت.`,
      `That file is larger than ${max / 1024 / 1024} MB.`,
      `فایلەکە لە ${max / 1024 / 1024} MB گەورەترە.`
    );
  }
  return '';
}

type Loc = (ar: string, en: string, ckb?: string) => string;

export function formatBytes(n: number): string {
  return n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
}

function KindIcon({ kind, className }: { kind: string; className?: string }) {
  if (kind === 'model') return <Box className={className} />;
  if (kind === 'document') return <FileText className={className} />;
  return <ImageIcon className={className} />;
}

/** Upload every chosen file to a request that already exists. Returns how
 *  many failed, so the caller can be honest about a partial result. */
export async function uploadRequestFiles(requestId: string, files: File[]): Promise<number> {
  let failed = 0;
  for (const file of files) {
    const form = new FormData();
    form.append('file', file);
    try {
      await api.post(`/api/marketplace/requests/${requestId}/files`, form);
    } catch {
      failed += 1;
    }
  }
  return failed;
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
  const { loc } = useLanguage();
  const input = useRef<HTMLInputElement | null>(null);
  const [error, setError] = useState('');

  function add(list: FileList | null) {
    if (!list?.length) return;
    setError('');
    const room = MAX_ATTACHMENTS - files.length;
    if (room <= 0) {
      setError(loc(`الحد الأقصى ${MAX_ATTACHMENTS} ملفات.`, `At most ${MAX_ATTACHMENTS} files.`, `زۆرترین ${MAX_ATTACHMENTS} فایل.`));
      return;
    }
    const accepted: File[] = [];
    let rejected = '';
    for (const f of Array.from(list).slice(0, room)) {
      const problem = attachmentProblem(f, loc);
      if (problem) { rejected = problem; continue; }
      accepted.push(f);
    }
    if (accepted.length) onChange([...files, ...accepted]);
    if (rejected) setError(rejected);
    if (input.current) input.current.value = '';
  }

  return (
    <div>
      <div className="space-y-2">
        {files.map((f, i) => (
          <div
            key={`${f.name}-${i}`}
            className="flex items-center gap-3 rounded-2xl border border-white/10 bg-black/30 px-3 py-2.5"
          >
            <KindIcon kind={isImage(f) ? 'reference' : 'model'} className="w-4 h-4 text-zinc-500 shrink-0" />
            <div className="min-w-0 flex-1">
              <p className="text-zinc-200 text-[12.5px] truncate">{f.name}</p>
              <p className="text-zinc-600 text-[11px]" dir="ltr">{formatBytes(f.size)}</p>
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
          className="w-full min-h-[46px] mt-2 rounded-2xl border border-dashed border-white/15 bg-white/[0.02] text-zinc-400 text-[12.5px] font-semibold flex items-center justify-center gap-2"
        >
          <Paperclip className="w-4 h-4" />
          {loc('أرفق صورة أو ملف ثلاثي الأبعاد', 'Attach a photo or a 3D file', 'وێنە یان فایلی سێ ڕەهەندی هاوپێچ بکە')}
        </button>
      )}

      <p className="text-zinc-600 text-[11px] mt-2">
        {loc(
          'صور، PDF، أو ملفات STL / 3MF / OBJ. حتى 6 ملفات. الملفات تُرفع بعد نشر الطلب.',
          'Images, PDF, or STL / 3MF / OBJ models. Up to 6 files. They upload once the request is posted.',
          'وێنە، PDF، یان STL / 3MF / OBJ. تا ٦ فایل.'
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
  const { loc } = useLanguage();
  const input = useRef<HTMLInputElement | null>(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');

  async function add(list: FileList | null) {
    if (!list?.length) return;
    setError('');
    const room = MAX_ATTACHMENTS - files.length;
    if (room <= 0) {
      setError(loc(`الحد الأقصى ${MAX_ATTACHMENTS} ملفات.`, `At most ${MAX_ATTACHMENTS} files.`, `زۆرترین ${MAX_ATTACHMENTS} فایل.`));
      return;
    }
    const chosen = Array.from(list).slice(0, room);
    for (const f of chosen) {
      const problem = attachmentProblem(f, loc);
      if (problem) { setError(problem); return; }
    }

    setBusy('add');
    const failed = await uploadRequestFiles(requestId, chosen);
    setBusy('');
    if (input.current) input.current.value = '';
    if (failed) {
      setError(loc(
        `تعذّر رفع ${failed} من الملفات.`,
        `${failed} file(s) could not be uploaded.`,
        `${failed} فایل بار نەکرا.`
      ));
    }
    onChanged();
  }

  async function remove(f: RequestFile) {
    setBusy(f.id);
    setError('');
    try {
      await api.delete(`/api/marketplace/requests/${requestId}/files/${f.id}`);
      onChanged();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : loc('تعذّر الحذف', 'Could not remove it', 'نەتوانرا بسڕدرێتەوە'));
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

      <div className="space-y-2">
        {files.map((f) => (
          <div
            key={f.id}
            className="flex items-center gap-3 rounded-2xl border border-white/10 bg-black/30 px-3 py-2.5"
          >
            {f.inline && f.url ? (
              <img src={f.url} alt="" className="w-10 h-10 rounded-lg object-cover shrink-0 bg-black/40" />
            ) : (
              <div className="w-10 h-10 rounded-lg bg-black/40 flex items-center justify-center shrink-0">
                <KindIcon kind={f.kind} className="w-4 h-4 text-zinc-500" />
              </div>
            )}
            <div className="min-w-0 flex-1">
              <p className="text-zinc-200 text-[12.5px] truncate">{f.file_name}</p>
              <p className="text-zinc-600 text-[11px]" dir="ltr">
                {f.kind} · {formatBytes(f.size_bytes)}
              </p>
            </div>
            {f.url && (
              <a
                href={f.url}
                target="_blank"
                rel="noreferrer"
                className="text-zinc-400 shrink-0"
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

      {canEdit && files.length < MAX_ATTACHMENTS && (
        <button
          type="button"
          onClick={() => input.current?.click()}
          disabled={busy === 'add'}
          className="w-full min-h-[42px] mt-2 rounded-2xl border border-dashed border-white/15 bg-white/[0.02] text-zinc-400 text-[12.5px] font-semibold flex items-center justify-center gap-2 disabled:opacity-40"
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
