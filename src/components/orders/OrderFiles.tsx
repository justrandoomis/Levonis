/**
 * «ملفاتك» — THE FILES THE BUYER PAID FOR, ON THEIR OWN ORDER.
 *
 * The shopfront's product page (src/components/storefront/ProductFiles.tsx) is
 * not the buyer's only way back to a purchased download: a store the public
 * may not see yet (push 1.4 — its merchant not approved) answers its product
 * page STORE_UNAVAILABLE, and «StoreUnavailable» sends its buyers to «طلباتي».
 * This block is what they find there: GET /api/orders/:id/files
 * (worker/lib/orderFiles.ts), which lists only what the download door — or,
 * on a `preview`, the viewer door — would serve to THIS buyer, and nothing
 * for a sanctioned store or a cancelled order.
 *
 * The links are the shopfront's own doors (community/files/api.ts
 * `storefrontFilesApi`): the download is a navigation to the attachment, and
 * «View in 3D» mints a viewer token on the tap (never on load — minting is
 * rate-limited and writes a row). Its own chunk, loaded by the order page
 * only for a store order; it draws nothing while loading, when the list is
 * empty, or when the read fails — the order page never waits on it.
 *
 * NOTHING FROM THE SHOPFRONT'S OWN FILES (tests/bundleBudget.test.ts, the
 * storefront app payload): importing storefront/strings.ts or
 * storefront/ProductFiles.tsx from this chunk split the strings table out of
 * the store pages' chunk and grew what every store visit downloads. So the
 * per-file words below are this block's own copy of the shopfront's
 * (`STOREFRONT_STRINGS[lang].files`, pinned equal by
 * tests/orderFilesDoor.test.ts), the size is community/files/api.ts
 * `formatBytes` (the same units), and the row rules are the few lines of
 * ProductFiles' `rowAction` / `ROLE_ORDER` they need.
 */
import { useEffect, useId, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Box, Download, FileArchive, FileText, FolderDown, Image as ImageIcon, Loader2 } from 'lucide-react';
import { useLanguage } from '../../LanguageContext';
import { formatBytes, storefrontFilesApi, type ProductFileRole } from '../community/files/api';
import { orderFilesApi, type OrderFile } from './orderFilesApi';
import { asLang } from './format';

/** This block's words, the per-file ones (roles, Download, View in 3D …) worded exactly as the shopfront's. */
export const ORDER_FILES_STRINGS = {
  ar: {
    title: 'ملفاتك',
    intro: 'الملفات التي اشتريتها في هذا الطلب.',
    view3d: 'عرض ثلاثي الأبعاد',
    download: 'تنزيل',
    opening: 'جارٍ الفتح…',
    noPreview: 'لا معاينة ثلاثية الأبعاد لهذا الملف.',
    viewerFailed: 'تعذّر فتح المعاينة الآن. حاول مجددًا.',
    roles: {
      preview: 'معاينة',
      download_after_purchase: 'تنزيل بعد الشراء',
      reference: 'مرجع',
      instruction: 'تعليمات',
      source_model: 'ملف المصدر',
    },
  },
  en: {
    title: 'Your files',
    intro: 'The files you bought with this order.',
    view3d: 'View in 3D',
    download: 'Download',
    opening: 'Opening…',
    noPreview: 'This file has no 3D preview.',
    viewerFailed: 'The preview could not be opened right now. Try again.',
    roles: {
      preview: 'Preview',
      download_after_purchase: 'Download after purchase',
      reference: 'Reference',
      instruction: 'Instructions',
      source_model: 'Source file',
    },
  },
  ckb: {
    title: 'فایلەکانت',
    intro: 'ئەو فایلانەی لەم داواکارییەدا کڕیوتن.',
    view3d: 'بینینی سێ ڕەهەندی',
    download: 'داگرتن',
    opening: 'دەکرێتەوە…',
    noPreview: 'ئەم فایلە پێشبینینی سێ ڕەهەندی نییە.',
    viewerFailed: 'ئێستا پێشبینینەکە ناکرێتەوە. دووبارە هەوڵبدەوە.',
    roles: {
      preview: 'پێشبینین',
      download_after_purchase: 'داگرتن دوای کڕین',
      reference: 'سەرچاوە',
      instruction: 'ڕێنمایی',
      source_model: 'فایلی سەرچاوە',
    },
  },
} as const;

/** The two shopfront doors the block needs (community/files/api.ts `storefrontFilesApi`), injected so it renders without a network. */
export interface OrderFilesDoor {
  viewerToken: (slug: string, productId: string, fileId: string) => Promise<{ url: string }>;
  downloadUrl: (slug: string, productId: string, fileId: string) => string;
}

/** The shopfront's role order (storefront/ProductFiles.tsx `ROLE_ORDER`): what can be done first, what was bought next. */
export const ORDER_FILE_ROLE_ORDER: readonly ProductFileRole[] = ['preview', 'download_after_purchase', 'source_model', 'reference', 'instruction'];

/** What a row offers — storefront/ProductFiles.tsx `rowAction`, the same answers: a preview with a mesh is viewed, never downloaded. */
export function orderFileAction(f: Pick<OrderFile, 'role' | 'has_preview' | 'downloadable' | 'granted'>): 'view' | 'download' | 'after_purchase' | 'name_only' {
  if (f.role === 'preview') return f.has_preview ? 'view' : 'name_only';
  return f.downloadable || f.granted ? 'download' : 'after_purchase';
}

/** The rows grouped by product (in the order the server sent them), each product's rows in the shopfront's role order. */
export function groupByProduct(files: readonly OrderFile[]): Array<{ productId: string; name: string; files: OrderFile[] }> {
  const groups = new Map<string, { productId: string; name: string; files: OrderFile[] }>();
  for (const f of files) {
    const g = groups.get(f.product_id) ?? { productId: f.product_id, name: f.product_name, files: [] };
    g.files.push(f);
    groups.set(f.product_id, g);
  }
  const rank = (f: OrderFile) => ORDER_FILE_ROLE_ORDER.indexOf(f.role);
  return [...groups.values()].map((g) => ({ ...g, files: [...g.files].sort((a, b) => rank(a) - rank(b)) }));
}

function KindIcon({ kind }: { kind: string }) {
  const cls = 'h-5 w-5 shrink-0 text-text-muted';
  if (kind === 'model') return <Box className={cls} strokeWidth={1.75} aria-hidden="true" />;
  if (kind === 'archive') return <FileArchive className={cls} strokeWidth={1.75} aria-hidden="true" />;
  if (kind === 'image') return <ImageIcon className={cls} strokeWidth={1.75} aria-hidden="true" />;
  return <FileText className={cls} strokeWidth={1.75} aria-hidden="true" />;
}

const ACTION = 'lv-button lv-button-secondary lv-button-sm shrink-0 inline-flex items-center gap-1.5';

/** The list itself, given the rows — exported so it renders without a network. */
export function OrderFilesList({ files, door }: { files: readonly OrderFile[]; door: OrderFilesDoor }) {
  const { lang } = useLanguage();
  const l = asLang(lang);
  const s = ORDER_FILES_STRINGS[l];
  const navigate = useNavigate();
  const headingId = useId();
  const [opening, setOpening] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ id: string; text: string } | null>(null);
  const groups = groupByProduct(files);
  if (!groups.length) return null;

  async function view(f: OrderFile) {
    if (opening) return;
    setNotice(null);
    setOpening(f.id);
    try {
      navigate((await door.viewerToken(f.store_slug, f.product_id, f.id)).url);
    } catch (e) {
      const code = (e as { code?: unknown } | null)?.code;
      setNotice({ id: f.id, text: code === 'NO_PREVIEW' ? s.noPreview : s.viewerFailed });
    } finally {
      setOpening(null);
    }
  }

  return (
    <section className="lv-surface p-4" aria-labelledby={headingId} data-order-files>
      <h3 id={headingId} className="text-text-primary font-bold text-[14px] inline-flex items-center gap-1.5">
        <FolderDown className="w-4 h-4 text-gold" aria-hidden="true" />
        {s.title}
      </h3>
      <p className="text-text-muted text-[12px] mt-1 leading-relaxed">{s.intro}</p>
      <div className="mt-3 flex flex-col gap-3">
        {groups.map((g) => (
          <div key={g.productId} data-order-files-product={g.productId}>
            {g.name && (
              <p className="text-text-secondary text-[12px] font-semibold mb-1.5 truncate" dir="auto">
                {g.name}
              </p>
            )}
            <ul className="flex flex-col gap-2">
              {g.files.map((f) => {
                const action = orderFileAction(f);
                const busy = opening === f.id;
                return (
                  <li key={f.id} className="rounded-lg bg-surface-raised px-3 py-2" data-order-file={f.id} data-file-action={action}>
                    <div className="flex items-center gap-2.5">
                      <KindIcon kind={f.kind} />
                      <div className="min-w-0 flex-1">
                        <p className="text-text-primary text-[12.5px] truncate" dir="auto">
                          {f.name}
                        </p>
                        <p className="text-text-muted text-[11.5px] tabular-nums" dir="auto">
                          {s.roles[f.role]} · {formatBytes(f.bytes, l)}
                        </p>
                      </div>
                      {action === 'view' && (
                        <button
                          type="button"
                          className={ACTION}
                          onClick={() => view(f)}
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
                          href={door.downloadUrl(f.store_slug, f.product_id, f.id)}
                          download
                          className={ACTION}
                          aria-label={`${s.download}: ${f.name}`}
                          data-download={f.id}
                        >
                          <Download className="h-4 w-4" aria-hidden="true" />
                          <span>{s.download}</span>
                        </a>
                      )}
                    </div>
                    {notice?.id === f.id && (
                      <p role="status" className="mt-1.5 text-text-secondary text-[12px]">
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

export default function OrderFiles({ orderId }: { orderId: string }) {
  const [files, setFiles] = useState<OrderFile[] | null>(null);
  useEffect(() => {
    let alive = true;
    setFiles(null);
    orderFilesApi
      .list(orderId)
      .then((rows) => alive && setFiles(rows))
      // Quiet: a failed read draws nothing; the order page is whole without it.
      .catch(() => alive && setFiles(null));
    return () => {
      alive = false;
    };
  }, [orderId]);
  if (!files || !files.length) return null;
  return <OrderFilesList files={files} door={storefrontFilesApi} />;
}
