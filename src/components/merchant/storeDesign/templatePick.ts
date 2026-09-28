/**
 * «مقترح لمتجرك» — the template that fits what the store HAS, read from the
 * rows the gallery fetched for the templates (./TemplateGallery.tsx). No
 * React, so tests/templateGallery.test.ts reads it directly.
 *
 *   services and printers, few products   → the workshop
 *   finished work in the showcase         → the portfolio
 *   many products                         → products first
 *   products arranged in collections      → modern
 *   otherwise                             → minimal (or classic with nothing yet)
 */
import type { ThemeName } from '../../../../packages/storeLayout/src/tokens';
import type { BlockData } from '../../../../packages/storeLayout/src/data';

export type PickReason = 'workshop' | 'portfolio' | 'products' | 'collections' | 'start';

/** What the store has, read from the templates' own rows — for «مقترح لمتجرك». */
export function recommendStarter(store: { product_count?: number | null }, data: Partial<Record<ThemeName, BlockData>>): { theme: ThemeName; reason: PickReason } {
  const products = Number(store.product_count ?? 0);
  const all = Object.values(data).filter((d): d is BlockData => !!d);
  const most = <T,>(pick: (d: BlockData) => T[] | null | undefined) => Math.max(0, ...all.map((d) => pick(d)?.length ?? 0));
  const services = most((d) => d.services);
  const printers = most((d) => d.printers);
  const works = most((d) => d.showcase?.filter((s) => s.kind === 'work'));
  const collections = most((d) => d.collections);
  if (services + printers >= 2 && products < 6) return { theme: 'workshop', reason: 'workshop' };
  if (works >= 4 && products < 6) return { theme: 'portfolio', reason: 'portfolio' };
  if (products >= 12) return { theme: 'product_focused', reason: 'products' };
  if (collections >= 2) return { theme: 'modern', reason: 'collections' };
  return { theme: products ? 'minimal' : 'classic', reason: 'start' };
}
