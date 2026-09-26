/**
 * FETCH WHERE THE FINGER IS GOING (docs/ux/CATALOG_DISCOVERY.md §3.1, §12).
 *
 * On `pointerdown` or `focus` of a door into a category — an explorer banner,
 * a «عرض الكل», a related tile — the page's chunk and its data are requested
 * before the tap completes. A press lasts ~100 ms and a route chunk on a warm
 * connection about as long, so the navigation is usually a synchronous render
 * over a snapshot rather than a skeleton.
 *
 * Idempotent and silent: the chunk import is memoised by the module system,
 * the data read is skipped while a fresh snapshot exists, and a failure is
 * swallowed — the page will simply fetch (and report) on its own.
 */
import { cachedCategory, cachedTree, loadCategory, loadTree } from './data';

const started = new Set<string>();

function once(key: string, run: () => Promise<unknown>) {
  if (started.has(key)) return;
  started.add(key);
  run()
    .catch(() => undefined)
    .finally(() => {
      // Allow a later intent to try again once this one has settled.
      setTimeout(() => started.delete(key), 30_000);
    });
}

/** `/categories/<slug>` — the page chunk and `GET /api/catalog/<slug>`. */
export function prefetchCategory(slug: string): void {
  once(`chunk:category`, () => import('../../pages/CategoryPage'));
  if (!cachedCategory(slug)) once(`data:category:${slug}`, () => loadCategory(slug, { mascot: 'silent' }));
}

/** `/categories/<cat>/<sub>` — the listing chunk and the tree it resolves against. */
export function prefetchListing(): void {
  once(`chunk:listing`, () => import('../../pages/CategoryListing'));
  if (!cachedTree()) once('data:tree', () => loadTree({ mascot: 'silent' }));
}

/** `/categories` — the explorer chunk and the tree. */
export function prefetchExplorer(): void {
  once(`chunk:explorer`, () => import('../../pages/CategoriesExplorer'));
  if (!cachedTree()) once('data:tree', () => loadTree({ mascot: 'silent' }));
}

/**
 * The handlers a door into `path` spreads on its link. The path decides the
 * page: `/categories`, `/categories/<cat>` or `/categories/<cat>/<sub>`.
 */
export function prefetchProps(path: string): { onPointerDown: () => void; onFocus: () => void } {
  const run = () => {
    const [clean] = path.split('?');
    const parts = clean.split('/').filter(Boolean);
    if (parts[0] !== 'categories') return;
    if (parts.length === 1) prefetchExplorer();
    else if (parts.length === 2) prefetchCategory(decodeURIComponent(parts[1]));
    else prefetchListing();
  };
  return { onPointerDown: run, onFocus: run };
}
