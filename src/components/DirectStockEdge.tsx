import React from 'react';
import { useLanguage } from '../LanguageContext';
import type { ApiProduct } from '../lib/api';

/**
 * A stock fact laid into the card's existing bottom edge. It is absolute and
 * pointer-inert, so it neither participates in layout nor changes the card's
 * dimensions, text positions or click target. The parent's existing
 * `overflow-hidden` + rounded corners provide the only radius: this is an edge
 * highlight, not a second pill sitting on the card.
 */
export default function DirectStockEdge({ product }: { product: ApiProduct }) {
  const { loc } = useLanguage();
  const count = product.direct_stock_available;
  if (!Number.isInteger(count) || (count ?? 0) <= 0) return null;

  const amount = String(count);
  const label = loc(
    `بيع مباشر | متوفر ${amount} في المخزون`,
    `Direct sale | ${amount} in stock`,
    `فرۆشتنی ڕاستەوخۆ | ${amount} لە کۆگا بەردەستە`
  );

  return (
    <span
      data-direct-stock-edge
      aria-label={label}
      className="pointer-events-none absolute inset-x-0 bottom-0 z-20 flex h-3 items-center justify-center overflow-hidden border-t border-white/[0.035] bg-[linear-gradient(90deg,rgba(82,82,91,0.035),rgba(161,161,170,0.11),rgba(82,82,91,0.035))] px-1.5 text-[8px] font-medium leading-none shadow-[0_-4px_14px_rgba(161,161,170,0.05)] backdrop-blur-[2px] text-zinc-300/75"
    >
      <span className="max-w-full truncate [text-shadow:0_1px_5px_rgba(0,0,0,0.35)]">{label}</span>
    </span>
  );
}
