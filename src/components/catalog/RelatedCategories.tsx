import React, { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useLanguage } from '../../LanguageContext';
import CropPhoto from './CropPhoto';
import { nodeName } from '../../lib/catalog/categoryPageModel';
import { authoredPhoto, representativePhoto, treePhoto, type BannerPhoto } from '../../lib/catalog/explorerModel';
import { cachedTree, loadPhotoPool, loadTree } from '../../lib/catalog/data';
import { prefetchProps } from '../../lib/catalog/prefetch';
import { whenNear } from '../../lib/nearViewport';
import type { CatalogTreeNode, CatalogTreeResponse } from '../../lib/catalog/types';

/** A tile is a third of the row; the cropped studio photograph is drawn ~1.4× its tile (index.css `.lv-promo-photo[data-crop]`). */
const RELATED_TILE_SIZES = '(min-width: 1024px) 320px, (min-width: 640px) 220px, 160px';

/** Each section's picture: the admin's, else the one the map picked for that root (it is one), else none yet. */
export function relatedPhotos(nodes: readonly CatalogTreeNode[], tree: CatalogTreeResponse | null): Record<string, BannerPhoto | null> {
  const onMap = new Map((tree?.roots ?? []).map((r) => [r.id, r]));
  const out: Record<string, BannerPhoto | null> = {};
  for (const n of nodes) out[n.id] = authoredPhoto(n) ?? treePhoto(onMap.get(n.id) ?? {});
  return out;
}

/**
 * «يكمّل طابعتك» (§6 item 6): the other departments, as three small dark tiles
 * with a photograph each — links to their pages, not products. The sections
 * come from the department's own answer; the photographs are the admin's,
 * else the ones the map picked for those roots (`GET /api/catalog/tree`, one
 * per root, never the same product twice), arriving after the words.
 *
 * AT THE BOTTOM OF THE PAGE, SO LAST (speed audit 2026-10-16: this row read
 * the 50-product pool — 27 KB on the wire, 160 KB of JSON — on mount, beside
 * the page's first screen). The map is usually already here (the visitor came
 * through «كل الفئات»); when it is not, it is asked for — 3 KB, not the pool —
 * only once the row nears the screen. A map without photographs (an answer
 * cached before them) still borrows from the pool, then.
 */
export default function RelatedCategories({ nodes }: { nodes: CatalogTreeNode[] }) {
  const { lang } = useLanguage();
  const [photos, setPhotos] = useState<Record<string, BannerPhoto | null>>(() => relatedPhotos(nodes, cachedTree()));
  const list = useRef<HTMLUListElement | null>(null);

  useEffect(() => {
    const now = relatedPhotos(nodes, cachedTree());
    setPhotos(now);
    if (nodes.every((n) => now[n.id])) return;
    const el = list.current;
    if (!el) return;
    let alive = true;
    const fill = async () => {
      const tree = await loadTree({ mascot: 'silent' }).catch(() => null);
      let next = relatedPhotos(nodes, tree);
      if (!nodes.every((n) => next[n.id])) {
        const pool = await loadPhotoPool();
        const used = new Set(Object.values(next).map((p) => p?.productId).filter((id): id is string => !!id));
        next = { ...next };
        for (const n of nodes) {
          if (next[n.id]) continue;
          const pick = representativePhoto(n, pool, used);
          if (pick?.productId) used.add(pick.productId);
          next[n.id] = pick;
        }
      }
      if (alive) setPhotos(next);
    };
    const cancel = whenNear(el, () => void fill().catch(() => undefined));
    return () => {
      alive = false;
      cancel();
    };
  }, [nodes]);

  return (
    <ul ref={list} className="-mx-4 -my-2 flex snap-x gap-2 overflow-x-auto overscroll-x-contain px-4 py-2 hide-scrollbar sm:-mx-6 sm:grid sm:grid-cols-3 sm:px-6 lg:mx-0 lg:grid-cols-4 lg:gap-4 lg:px-0">
      {nodes.map((n) => {
        const photo = photos[n.id];
        return (
          <li key={n.id} className="w-[31%] min-w-[108px] shrink-0 snap-start sm:w-auto">
            <Link
              to={n.path}
              {...prefetchProps(n.path)}
              data-feature=""
              data-related={n.slug}
              className="group relative isolate block h-[118px] overflow-hidden rounded-2xl shadow-sm bg-charcoal text-ivory focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus lg:h-[168px]"
            >
              {photo ? <CropPhoto src={photo.src} lightSrc={photo.lightSrc} mobileSrc={photo.mobileSrc} lightMobileSrc={photo.lightMobileSrc} crop={photo.productPhoto} size={240} sizes={RELATED_TILE_SIZES} className="lv-fade-top inset-x-0 bottom-0 top-[30%]" /> : null}
              <span className="relative block p-2.5 text-[12px] font-extrabold leading-[17px] lg:p-4 lg:text-[15px] lg:leading-6">{nodeName(n, lang)}</span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
