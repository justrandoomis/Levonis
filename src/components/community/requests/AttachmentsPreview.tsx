/**
 * THE FILES OF A REQUEST, AT A GLANCE (community UI plan C3, IMG_8472): the
 * first two files under the header card, each a thumbnail (a picture the
 * reader may see) or a kind glyph, its name kept in its own direction, and
 * «EXT · size»; beside them the count («مرفقان ‹») that opens the whole list
 * in a sheet (AttachmentList: the owner adds and removes there, and every
 * model the reader may preview has its «عرض ثلاثي الأبعاد»).
 *
 * A file the reader may not open has no address (`url` null): it shows its
 * glyph and its name, and links nowhere. A file with an address opens in a
 * new tab, and says so.
 */
import type { ReactNode } from 'react';
import { Paperclip } from 'lucide-react';
import { KindIcon, formatBytes, type RequestFile } from '../../media/RequestAttachments';
import { Sheet } from '../../ui/Sheet';
import { OnwardChevron } from '../kit/buttons';
import { useKitStrings } from '../kit/strings';
import { RequestThumb } from './RequestFileThumbs';
import { attachmentsWord, type CardLang } from './requestWords';
import { fill, type RequestStrings } from './strings';

/** «STL», «JPG»: the extension a person knows the file by, never a storage key. */
export function fileExt(name: string): string {
  const m = /\.([a-z0-9]{1,8})$/i.exec(name);
  return m ? m[1].toUpperCase() : '';
}

function FileRow({ f, newTab }: { f: RequestFile; newTab: string }) {
  const picture = !!f.inline && !!f.url && f.kind === 'image';
  const ext = fileExt(f.file_name);
  const body = (
    <>
      {picture ? (
        <RequestThumb url={f.url!} size={44} className="cm-line rounded-sm" />
      ) : (
        <span aria-hidden="true" className="cm-line flex size-11 shrink-0 items-center justify-center rounded-sm bg-surface-selected text-text-secondary">
          <KindIcon kind={f.kind} className="h-5 w-5" />
        </span>
      )}
      <span className="min-w-0 flex-1">
        <bdi className="block truncate text-[14px] font-medium text-text-primary">{f.file_name}</bdi>
        <span dir="ltr" className="block text-start text-[12px] text-text-muted">
          {[ext, formatBytes(f.size_bytes)].filter(Boolean).join(' · ')}
        </span>
      </span>
    </>
  );
  if (!f.url) {
    return (
      <li className="flex min-h-11 items-center gap-3" data-attachment-row={f.id} data-attachment-link="none">
        {body}
      </li>
    );
  }
  return (
    <li data-attachment-row={f.id}>
      <a href={f.url} target="_blank" rel="noopener noreferrer" className="flex min-h-11 items-center gap-3 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus">
        {body}
        <span className="sr-only">{newTab}</span>
      </a>
    </li>
  );
}

export interface AttachmentsPreviewProps {
  files: RequestFile[];
  lang: CardLang;
  s: RequestStrings;
  onOpenAll: () => void;
}

/** The first two files and the count that opens them all. */
export default function AttachmentsPreview({ files, lang, s, onOpenAll }: AttachmentsPreviewProps) {
  const k = useKitStrings();
  const count = attachmentsWord(files.length, lang);
  // No file yet (an owner who may add one): the door to the list alone.
  if (!files.length) {
    return (
      <button type="button" id="files" onClick={onOpenAll} aria-haspopup="dialog" className="flex min-h-11 w-full items-center gap-2 text-[13px] font-semibold text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus" data-attachments-all={0}>
        <Paperclip aria-hidden="true" className="h-4 w-4 text-text-secondary" />
        <span className="flex-1 text-start">{s.files}</span>
        <OnwardChevron className="h-4 w-4 text-text-secondary" />
      </button>
    );
  }
  return (
    <div id="files" className="flex items-stretch gap-3 scroll-mt-14" data-attachments-preview>
      <ul className="min-w-0 flex-1 divide-y divide-border-subtle" aria-label={s.files}>
        {files.slice(0, 2).map((f) => (
          <FileRow key={f.id} f={f} newTab={k.opensNewTab} />
        ))}
      </ul>
      <button
        type="button"
        onClick={onOpenAll}
        aria-label={fill(s.allFiles, { n: count })}
        aria-haspopup="dialog"
        className="flex min-h-11 shrink-0 items-center gap-1.5 border-s border-border-subtle ps-3 text-[13px] font-semibold text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
        data-attachments-all={files.length}
      >
        <Paperclip aria-hidden="true" className="h-4 w-4 text-text-secondary" />
        {count}
        <OnwardChevron className="h-4 w-4 text-text-secondary" />
      </button>
    </div>
  );
}

/** Every file of the request: the list with its add and remove, and the model doors, in a sheet. */
export function AttachmentsSheet({ open, onClose, title, children }: { open: boolean; onClose: () => void; title: string; children: ReactNode }) {
  return (
    <Sheet open={open} onClose={onClose} label={title} detents={['medium', 'large']} dragHandle testId="request-attachments" header={<h2 className="px-5 pb-2 pt-1 text-[16px] font-bold text-text-primary">{title}</h2>}>
      <div className="px-5 pb-4" data-attachments-sheet>
        {children}
      </div>
    </Sheet>
  );
}
