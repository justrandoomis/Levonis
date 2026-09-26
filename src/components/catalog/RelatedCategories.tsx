import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useLanguage } from '../../LanguageContext';
import CropPhoto from './CropPhoto';
import { nodeName } from '../../lib/catalog/categoryPageModel';
import { authoredPhoto, representativePhoto, type BannerPhoto } from '../../lib/catalog/explorerModel';
import { loadPhotoPool } from '../../lib/catalog/data';
import { prefetchProps } from '../../lib/catalog/prefetch';
import type { CatalogTreeNode } from '../../lib/catalog/types';

/**
 * «يكمّل طابعتك» (§6 item 6): the other departments, as three small dark tiles
 * with a photograph each — links to their pages, not products. The sections
 * come from the tree the page already has; the photographs are the admin's,
 * else borrowed from one shared read of the catalogue (never the same product
 * twice), arriving after the words.
 */
export default function RelatedCategories({ nodes }: { nodes: CatalogTreeNode[] }) {
  const { lang } = useLanguage();
  const [photos, setPhotos] = useState<Record<string, BannerPhoto | null>>(() => {
    const out: Record<string, BannerPhoto | null> = {};
    for (const n of nodes) out[n.id] = authoredPhoto(n);
    return out;
  });

  useEffect(() => {
    if (nodes.every((n) => authoredPhoto(n))) return;
    let alive = true;
    loadPhotoPool()
      .then((pool) => {
        if (!alive) return;
        const used = new Set<string>();
        const next: Record<string, BannerPhoto | null> = {};
        for (const n of nodes) {
          const own = authoredPhoto(n);
          const pick = own ?? representativePhoto(n, pool, used);
          if (pick?.productId) used.add(pick.productId);
          next[n.id] = pick;
        }
        setPhotos(next);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [nodes]);

  return (
    <ul className="-mx-4 flex snap-x gap-2 overflow-x-auto overscroll-x-contain px-4 hide-scrollbar sm:-mx-6 sm:grid sm:grid-cols-3 sm:px-6 lg:mx-0 lg:grid-cols-4 lg:gap-4 lg:px-0">
      {nodes.map((n) => {
        const photo = photos[n.id];
        return (
          <li key={n.id} className="w-[31%] min-w-[108px] shrink-0 snap-start sm:w-auto">
            <Link
              to={n.path}
              {...prefetchProps(n.path)}
              data-feature=""
              data-related={n.slug}
              className="group relative isolate block h-[118px] overflow-hidden rounded-[14px] bg-charcoal text-ivory ring-1 ring-inset ring-white/[0.06] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold-muted lg:h-[168px] lg:rounded-[18px]"
            >
              {photo ? <CropPhoto src={photo.src} lightSrc={photo.lightSrc} crop={photo.productPhoto} size={240} className="lv-fade-top inset-x-0 bottom-0 top-[30%]" /> : null}
              <span className="relative block p-2.5 text-[12px] font-extrabold leading-[17px] lg:p-4 lg:text-[15px] lg:leading-6">{nodeName(n, lang)}</span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
