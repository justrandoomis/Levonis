import React from 'react';
import { Link } from 'react-router-dom';
import { useLanguage } from '../../LanguageContext';
import { nodeName } from '../../lib/catalog/categoryPageModel';
import { prefetchProps } from '../../lib/catalog/prefetch';
import type { CatalogTreeNode } from '../../lib/catalog/types';

/**
 * The sub-sections under an explorer banner (§5 item 4): «طابعات FDM 10»,
 * each a link straight to its listing. Drawn 30 px, hit 44 px; the row scrolls
 * sideways when it does not fit and bleeds to the screen edge so the
 * continuation is visible.
 */
export default function SubCategoryChips({ nodes, label }: { nodes: CatalogTreeNode[]; label: string }) {
  const { lang } = useLanguage();
  if (nodes.length === 0) return null;
  return (
    <nav aria-label={label} className="-mx-4 mt-1 sm:-mx-6 lg:mx-0">
      <ul className="flex gap-1.5 overflow-x-auto overscroll-x-contain px-4 hide-scrollbar sm:px-6 lg:flex-wrap lg:px-0">
        {nodes.map((n) => (
          <li key={n.id} className="shrink-0">
            <Link
              to={n.path}
              {...prefetchProps(n.path)}
              data-sub-chip={n.slug}
              className="group inline-flex min-h-11 items-center focus-visible:outline-none"
            >
              <span className="inline-flex h-[30px] items-center gap-1.5 rounded-full border border-border-subtle bg-surface px-3 text-[12px] font-bold text-text-secondary transition-colors group-hover:text-text-primary group-focus-visible:ring-2 group-focus-visible:ring-focus">
                <span>{nodeName(n, lang)}</span>
                <span className="font-semibold tabular-nums text-text-muted">{n.product_count}</span>
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
