import { useEffect, useMemo, useState } from 'react';
import { loadSectionPhotos } from '../../lib/catalog/data';
import { photoOf, productBannerPhoto, rowsWithoutPhoto, type BannerPhoto, type BannerRow } from '../../lib/catalog/explorerModel';

/**
 * A banner row the page's own cards did not cover asks for its section's
 * photographs (`GET /api/products?category=<id>&limit=4`, cached), available
 * now first. The rows are drawn — words, counts and all — before any of these
 * land; each picture fades into a box whose size never changes.
 *
 * `ready` holds the reads back until the page's shared pool has settled, so a
 * row the pool will cover is not asked for twice.
 */
export function useBannerPhotos(rows: readonly BannerRow[], ready = true): BannerRow[] {
  const [own, setOwn] = useState<Record<string, BannerPhoto | null>>({});
  const missing = useMemo(() => rowsWithoutPhoto(rows).map((n) => n.id).join(','), [rows]);
  useEffect(() => {
    if (!missing || !ready) return;
    let alive = true;
    for (const id of missing.split(',')) {
      if (id in own) continue;
      loadSectionPhotos(id)
        .then((list) => {
          const pick = list.find((p) => Number(p.direct_stock_available ?? 0) > 0 && photoOf(p)) ?? list.find((p) => photoOf(p));
          if (alive) setOwn((o) => ({ ...o, [id]: pick ? productBannerPhoto(pick) : null }));
        })
        .catch(() => alive && setOwn((o) => ({ ...o, [id]: null })));
    }
    return () => {
      alive = false;
    };
    // `own` is read to skip sections already asked; re-running on it would loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [missing, ready]);
  return useMemo(() => rows.map((r) => (r.photo ? r : { ...r, photo: own[r.node.id] ?? null })), [rows, own]);
}
