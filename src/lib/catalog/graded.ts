/**
 * «المستعمل» ON THE EXPLORER — its two facts, not the home page (speed audit
 * 2026-10-16). Only src/pages/CategoriesExplorer.tsx asks, so this is not in
 * src/lib/catalog/data.ts, which every category page carries.
 */
import { api, ApiError, fetchGradedStock } from '../api';
import { photoOf, type PhotoCandidate } from './explorerModel';

/** The home's graded shelf, counted: how many (≤ 12) and one photograph. */
export interface GradedSummary {
  count: number;
  photo: { src: string; product_id: string } | null;
}

/**
 * «المستعمل» on the explorer: `GET /api/home/graded` — the two facts the
 * banner draws, instead of the whole /api/home (10 KB on the wire, 47 KB of
 * JSON) it used to read them from. A Worker older than that answer (a 404)
 * is asked the old way.
 */
export async function loadGradedSummary(): Promise<GradedSummary> {
  try {
    const d = await api.get<Partial<GradedSummary>>('/api/home/graded', { mascot: 'silent' });
    const photo = d.photo && typeof d.photo.src === 'string' && d.photo.src ? { src: d.photo.src, product_id: String(d.photo.product_id ?? '') } : null;
    return { count: Number(d.count) > 0 ? Number(d.count) : 0, photo };
  } catch (e) {
    if (!(e instanceof ApiError) || e.status !== 404) throw e;
    const used = await fetchGradedStock({ mascot: 'silent' });
    const first = used.find((p) => photoOf(p as PhotoCandidate));
    return { count: used.length, photo: first ? { src: photoOf(first as PhotoCandidate), product_id: first.id } : null };
  }
}
