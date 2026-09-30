/**
 * THE FILES OF A PROJECT (docs/COMMUNITY_ECOSYSTEM.md §9.4) — one list, two faces.
 *
 * `FileRows` is what a reader sees on the project page: a row per attachment
 * (name, size, kind), «عرض ثلاثي الأبعاد» when the server derived a preview
 * mesh — it mints a viewer token ONCE per press (a double tap never mints
 * twice) and opens /model-viewer/<token> — and «تنزيل» only when the author
 * allowed it AND the reader is signed in; otherwise the row says why in one
 * sentence instead of showing a button that would answer 401 or 403.
 *
 * `FileComposer` (./FileComposer.tsx) is the author's side in the composer:
 * pick up to three models or PDFs, each uploaded through a resumable session
 * (purpose `post`), name it, tick «قابل للتنزيل». It is its OWN module so the
 * project reader page, which imports these rows, does not also download the
 * upload tile and the switch it never renders (perf review 2026-09-30); the
 * pure helpers it shares (`postFileKind`, `POST_FILE_ACCEPT`, `ComposerFile`,
 * the kind icon) stay here, where the tests read them.
 */
import { useMemo } from 'react';
import { Box, Download, FileText, Rotate3d } from 'lucide-react';
import { useLanguage } from '../../../LanguageContext';
import { apiRefusal } from '../../../lib/refusalStrings';
import { Button } from '../../ui/Button';
import { toast } from '../../ui/Toast';
import { formatBytes, postFilesApi, viewerHref, type PostFile, type ViewerToken } from '../files/api';
import { useProjectStrings } from './strings';

export type PostFileKind = 'model' | 'document';

/** What the composer holds for one attached file — the key is what it sends back. */
export interface ComposerFile {
  key: string;
  name: string;
  bytes: number;
  kind: PostFileKind;
  downloadable: boolean;
}

const MODEL_EXTENSIONS = new Set(['stl', '3mf', 'obj', 'amf', 'glb', 'gltf', 'step', 'stp']);
const DOCUMENT_EXTENSIONS = new Set(['pdf']);

/** The picker's accept list: the models the viewer can measure, and a PDF. */
export const POST_FILE_ACCEPT = '.stl,.3mf,.obj,.amf,.glb,.gltf,.step,.stp,.pdf';

/** A model, a document, or nothing the post API takes (a picture belongs in the media grid). */
export function postFileKind(name: string): PostFileKind | null {
  const lower = name.toLowerCase();
  const dot = lower.lastIndexOf('.');
  const ext = dot > 0 ? lower.slice(dot + 1) : '';
  if (MODEL_EXTENSIONS.has(ext)) return 'model';
  if (DOCUMENT_EXTENSIONS.has(ext)) return 'document';
  return null;
}

/**
 * One mint at a time: while a call is in flight every further press answers
 * `null` instead of starting another — a double tap on «عرض ثلاثي الأبعاد»
 * costs one token, not two. Once it settles the next press mints again.
 */
export function mintOnce<T>(mint: () => Promise<T>): () => Promise<T | null> {
  let inFlight: Promise<T> | null = null;
  return () => {
    if (inFlight) return Promise.resolve(null);
    inFlight = mint();
    return inFlight.finally(() => {
      inFlight = null;
    });
  };
}

/** The viewer page for a minted token: the server's own url, else the route from the token. */
export function viewerPage(token: ViewerToken): string {
  return token.url && token.url.startsWith('/') ? token.url : viewerHref(token.token);
}

export function KindIcon({ kind, className }: { kind: string; className?: string }) {
  return kind === 'document' ? <FileText aria-hidden="true" className={className} /> : <Box aria-hidden="true" className={className} />;
}

// ------------------------------------------------------------------ the reader

export function FileRows({ postId, files, signedIn, className = '' }: { postId: string; files: PostFile[]; signedIn: boolean; className?: string }) {
  const s = useProjectStrings();
  if (files.length === 0) return null;
  return (
    <section aria-labelledby="project-files" data-project-files className={className}>
      <h2 id="project-files" className="mb-2 text-[13px] font-semibold text-text-secondary">
        {s.files}
      </h2>
      <ul className="flex flex-col divide-y divide-border-subtle/60 overflow-hidden rounded-2xl border border-border-subtle/60 bg-surface">
        {files.map((f) => (
          <FileRow key={f.id} postId={postId} file={f} signedIn={signedIn} />
        ))}
      </ul>
    </section>
  );
}

function FileRow({ postId, file, signedIn }: { postId: string; file: PostFile; signedIn: boolean }) {
  const s = useProjectStrings();
  const { lang } = useLanguage();
  const mint = useMemo(() => mintOnce(() => postFilesApi.viewerToken(postId, file.id)), [postId, file.id]);

  const open3d = async () => {
    try {
      const token = await mint();
      if (token) window.open(viewerPage(token), '_blank', 'noopener');
    } catch (e) {
      toast.error(apiRefusal(e, lang, s.viewerFailed));
    }
  };

  const canDownload = file.downloadable && signedIn;
  const why = canDownload ? '' : file.downloadable ? s.signInToDownload : s.notDownloadable;

  return (
    <li data-project-file className="flex flex-col gap-2 px-4 py-3">
      <div className="flex min-w-0 items-center gap-3">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-surface-selected text-text-secondary">
          <KindIcon kind={file.kind} className="h-4 w-4" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-start text-[14px] font-semibold text-text-primary" title={file.name}>
            <bdi>{file.name}</bdi>
          </span>
          <span className="block text-[11.5px] text-text-muted">
            <span dir="ltr">{formatBytes(file.bytes, lang)}</span> · {s.fileKinds[file.kind]}
          </span>
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        {file.has_preview && (
          <Button type="button" size="sm" variant="secondary" icon={<Rotate3d aria-hidden="true" className="h-4 w-4" />} onClick={open3d} loadingLabel={s.opening} data-project-file-view>
            {s.view3d}
          </Button>
        )}
        {canDownload ? (
          <a href={postFilesApi.downloadUrl(postId, file.id)} download={file.name} className="lv-button lv-button-secondary lv-button-sm gap-2" data-project-file-download>
            <Download aria-hidden="true" className="h-4 w-4" />
            {s.download}
          </a>
        ) : (
          <span className="text-[11.5px] text-text-muted" data-project-file-why>
            {why}
          </span>
        )}
      </div>
    </li>
  );
}

export default FileRows;
