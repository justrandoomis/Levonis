/**
 * WHICH PART OF THE STORE AN ADDRESS ASKS FOR, on a page with no tab strip to
 * show it in (review of the store builder, 2026-09-28): a collection
 * (`?section=`) is its products; otherwise the tab the address names
 * (`/products`, `/about`, `?tab=services`). A layout WITH a Tabs block
 * answers both itself, inside the strip. Null: the page's own blocks.
 *
 * Its own module, without React, so tests/storefrontViews.test.ts reads it
 * directly; the renderer (./StoreRenderer.tsx) draws the answer.
 */
import type { StoreBlock } from '../../../packages/storeLayout/src/schema';
import type { TabKind } from './runtime';

export function addressedView(
  blocks: ReadonlyArray<Pick<StoreBlock, 'type'>>,
  rt: { section: string; initialTab: TabKind | null }
): TabKind | null {
  if (blocks.some((b) => b.type === 'tabs')) return null;
  if (rt.section) return 'products';
  return rt.initialTab;
}
