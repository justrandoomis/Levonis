import React from 'react';
import { Link } from 'react-router-dom';
import { useLanguage } from '../../LanguageContext';
import { ArrowGlyph } from '../home/v2/SectionHead';
import { countNoun, type NounKind } from '../../lib/catalog/copy';
import { prefetchProps } from '../../lib/catalog/prefetch';
import type { BrandCount } from '../../lib/catalog/types';

/**
 * «حسب العلامة التجارية» (§6 item 4.3): a two-column grid of brand tiles —
 * the brand as it writes its own name, how many of this department's products
 * it makes, and a door to the listing filtered to it. The server sends the
 * brands only when there are at least two.
 */
export default function BrandShelf({ brands, basePath, kind }: { brands: BrandCount[]; basePath: string; kind: NounKind }) {
  const { lang } = useLanguage();
  return (
    <ul className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-4 lg:gap-4">
      {brands.map((b) => {
        const to = `${basePath}/all?brand=${encodeURIComponent(b.slug)}`;
        const name = b.name_en || b.name_ar;
        return (
          <li key={b.id}>
            <Link
              to={to}
              {...prefetchProps(to)}
              data-brand-tile={b.slug}
              className="group flex min-h-[72px] items-center justify-between gap-2 rounded-2xl border border-border-subtle bg-surface p-3.5 transition-colors hover:bg-surface-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus lg:min-h-[84px] lg:p-5"
            >
              <span className="min-w-0">
                <span dir="ltr" className="block truncate text-start text-[16px] font-extrabold leading-[22px] text-text-primary rtl:text-right lg:text-[18px]">
                  {name}
                </span>
                <span className="block text-[11.5px] text-text-muted lg:text-[12.5px]">{countNoun(b.count, kind, lang)}</span>
              </span>
              <span aria-hidden="true" className="grid size-[30px] shrink-0 place-items-center rounded-full bg-surface-selected text-text-primary transition-transform group-hover:translate-x-0.5 rtl:group-hover:-translate-x-0.5 motion-reduce:transition-none">
                <ArrowGlyph className="size-3.5" />
              </span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
