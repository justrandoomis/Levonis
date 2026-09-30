/**
 * FILES ON A PRODUCT, AS A SHOPPER SEES THEM (docs/COMMUNITY_ECOSYSTEM.md
 * §9.4 «Files on products»). The block under the description on the product
 * page: the files BY ROLE, names and sizes only — never a key, never a URL to
 * the bytes.
 *
 *   preview                       «عرض ثلاثي الأبعاد»: a viewer token is
 *                                 minted on the tap (never on page load —
 *                                 minting is rate-limited and writes a row)
 *                                 and the viewer page opens with it;
 *   reference / instruction       the name is visible to everyone; the
 *                                 download appears once the server says the
 *                                 viewer holds a grant, else «يتاح بعد الشراء»;
 *   download_after_purchase /
 *   source_model                  the same rule, and nothing else.
 *
 * WHO DECIDES: the server. `downloadable` / `granted` on each row is the
 * server's answer for THIS viewer (owner, buyer with a grant, guest); this
 * file only draws it. The download is a navigation to the attachment door,
 * not a fetch — the browser saves what the server streams.
 *
 * THE DOOR IS INJECTED. A store visit downloads this directory's files and a
 * short allow-list of modules (tests/storefrontBlocks.test.ts), so the typed
 * fetchers (src/components/community/files/api.ts) are passed in by the page
 * as `door`, and the shapes below are structural copies of theirs.
 *
 * Presentation is the store's own: sf-* classes and the theme's tokens, the
 * shopper's language from the language context. No inline style, no spring —
 * nothing here moves.
 */
import { useId, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Box, Download, FileArchive, FileText, Image as ImageIcon, Loader2 } from 'lucide-react';
import { useLanguage } from '../../LanguageContext';
import { storefrontStrings } from './strings';

export type ProductFileRole = 'preview' | 'download_after_purchase' | 'reference' | 'instruction' | 'source_model';

/** One row of GET /api/product-files/:slug/:productId — the server's public shape. */
export interface StorefrontFile {
  id: string;
  role: ProductFileRole;
  name: string;
  bytes: number;
  kind: string;
  /** A `preview` file with a derived mesh: the viewer is offered. */
  has_preview: boolean;
  /** The server's answer for THIS viewer: may they take the bytes now. */
  downloadable: boolean;
  /** The server's answer for THIS viewer: do they hold the file (owner or buyer). */
  granted?: boolean;
}

/** The two doors the block needs, injected by the page (community/files/api.ts `storefrontFilesApi`). */
export interface FilesDoor {
  viewerToken: (slug: string, productId: string, fileId: string) => Promise<{ url: string }>;
  downloadUrl: (slug: string, productId: string, fileId: string) => string;
}

/** The order the roles read in: what a shopper can do first, what they get after buying next. */
export const ROLE_ORDER: readonly ProductFileRole[] = ['preview', 'download_after_purchase', 'source_model', 'reference', 'instruction'];

export type RowAction = 'view' | 'download' | 'after_purchase' | 'name_only';

/**
 * What the row offers. A preview is viewed (when it has a mesh) and never
 * downloaded; every other role downloads when the server says this viewer
 * holds it, and says «يتاح بعد الشراء» otherwise.
 */
export function rowAction(f: Pick<StorefrontFile, 'role' | 'has_preview' | 'downloadable' | 'granted'>): RowAction {
  if (f.role === 'preview') return f.has_preview ? 'view' : 'name_only';
  return f.downloadable || f.granted ? 'download' : 'after_purchase';
}

/** The files grouped by role, in ROLE_ORDER, empty roles dropped, each group in the merchant's order. */
export function groupByRole<T extends { role: ProductFileRole }>(files: readonly T[]): Array<{ role: ProductFileRole; files: T[] }> {
  return ROLE_ORDER.map((role) => ({ role, files: files.filter((f) => f.role === role) })).filter((g) => g.files.length > 0);
}

/** «2.4 م.ب» — the size beside a name, with the language's own units. */
export function bytesLabel(bytes: number, units: readonly string[]): string {
  let v = Math.max(0, Number(bytes) || 0);
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  const num = i === 0 ? String(Math.round(v)) : v.toFixed(v >= 100 ? 0 : 1);
  return `${num} ${units[i]}`;
}

/** Mint the viewer link for one file and answer where it opens. Exported so the decision is testable without a DOM. */
export async function openViewer(door: FilesDoor, slug: string, productId: string, fileId: string): Promise<string> {
  const minted = await door.viewerToken(slug, productId, fileId);
  return minted.url;
}

function KindIcon({ kind }: { kind: string }) {
  const cls = 'h-5 w-5 shrink-0 text-zinc-500';
  if (kind === 'model') return <Box className={cls} strokeWidth={1.75} aria-hidden="true" />;
  if (kind === 'archive') return <FileArchive className={cls} strokeWidth={1.75} aria-hidden="true" />;
  if (kind === 'image') return <ImageIcon className={cls} strokeWidth={1.75} aria-hidden="true" />;
  return <FileText className={cls} strokeWidth={1.75} aria-hidden="true" />;
}

const PILL =
  'inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-full border border-white/10 px-3 text-[12.5px] font-semibold text-white press-scale focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus disabled:opacity-40';

export default function ProductFiles({
  slug,
  productId,
  files,
  door,
}: {
  slug: string;
  productId: string;
  files: StorefrontFile[];
  door: FilesDoor;
}) {
  const { lang } = useLanguage();
  const s = storefrontStrings(lang).files;
  const navigate = useNavigate();
  const headingId = useId();
  const [opening, setOpening] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ id: string; text: string } | null>(null);
  const groups = groupByRole(files);
  if (!groups.length) return null;

  async function view(fileId: string) {
    if (opening) return;
    setNotice(null);
    setOpening(fileId);
    try {
      navigate(await openViewer(door, slug, productId, fileId));
    } catch (e) {
      // NO_PREVIEW is the one code with its own sentence; anything else reads as «try again».
      const code = (e as { code?: unknown } | null)?.code;
      setNotice({ id: fileId, text: code === 'NO_PREVIEW' ? s.noPreview : s.viewerFailed });
    } finally {
      setOpening(null);
    }
  }

  return (
    <section className="sf-card sf-card-pad mb-6" aria-labelledby={headingId} data-product-files>
      <h2 id={headingId} className="sf-title text-white mb-3">
        {s.title}
      </h2>
      <div className="space-y-3">
        {groups.map((g) => (
          <div key={g.role} data-file-role={g.role}>
            <p className="text-zinc-400 text-[11.5px] font-semibold mb-1.5">{s.roles[g.role]}</p>
            <ul className="space-y-2">
              {g.files.map((f) => {
                const action = rowAction(f);
                const busy = opening === f.id;
                return (
                  <li key={f.id} className="sf-row px-3 py-2" data-product-file={f.id} data-file-action={action}>
                    <div className="flex items-center gap-2.5">
                      <KindIcon kind={f.kind} />
                      <div className="min-w-0 flex-1">
                        <p className="text-zinc-300 text-[12.5px] truncate" dir="auto">
                          {f.name}
                        </p>
                        <p className="text-zinc-400 text-[11.5px] tabular-nums" dir="auto">
                          {bytesLabel(f.bytes, s.units)}
                        </p>
                      </div>
                      {action === 'view' && (
                        <button
                          type="button"
                          className={PILL}
                          onClick={() => view(f.id)}
                          disabled={!!opening}
                          aria-busy={busy || undefined}
                          aria-label={`${s.view3d}: ${f.name}`}
                          data-view-3d={f.id}
                        >
                          {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Box className="h-4 w-4" aria-hidden="true" />}
                          <span>{busy ? s.opening : s.view3d}</span>
                        </button>
                      )}
                      {action === 'download' && (
                        <a
                          href={door.downloadUrl(slug, productId, f.id)}
                          download
                          className={PILL}
                          aria-label={`${s.download}: ${f.name}`}
                          data-download={f.id}
                        >
                          <Download className="h-4 w-4" aria-hidden="true" />
                          <span>{s.download}</span>
                        </a>
                      )}
                      {action === 'after_purchase' && (
                        <span className="text-zinc-400 text-[11.5px] shrink-0" data-after-purchase={f.id}>
                          {s.afterPurchase}
                        </span>
                      )}
                    </div>
                    {notice?.id === f.id && (
                      <p role="status" className="mt-1.5 text-zinc-200 text-[12px]">
                        {notice.text}
                      </p>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </div>
    </section>
  );
}
