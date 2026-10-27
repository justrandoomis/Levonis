/**
 * CLAIM EVIDENCE, READ FROM THE STORE WHEN THE REQUEST IS MADE (spec §9, §10,
 * §25; acceptance 12).
 *
 * The copy an AI request may write depends on what is true NOW, not on what a
 * stored marketing snapshot said when the design was made: an offer that has
 * ended is no evidence for discount wording, however recent the snapshot
 * looks. So, for the products the copy is about:
 *
 *   offer          the store's own public card, rebuilt now (`buildSnapshotData`),
 *                  carries a live public offer for that product and variant;
 *   arrival        the catalogue watch recorded an arrival for the product in
 *   backInStock    the last 14 days (back in stock: an unavailable → available
 *                  transition), the product is still listed, and — for back in
 *                  stock — still available. This is the rule «شنو أنشر اليوم؟»
 *                  uses (collectOpportunities in ./opportunities.ts), so an idea
 *                  and the copy written from it agree on what is proven.
 *
 * Only a product named by a LIVE snapshot counts: a manual or test snapshot is
 * never evidence (spec §9), and its product id is not trusted to name a real
 * product. Read-only: nothing here writes, and a database without the studio
 * tables simply proves nothing (deploy-ahead).
 */
import type { ClaimEvidence } from '../../../packages/creativeDoc/src/text';
import type { ProductSnapshot } from '../../../packages/creativeDoc/src/snapshot';
import { nowIso } from './db';
import { buildSnapshotData, cardStates } from './store';

/** The window an arrival or a back-in-stock event stays evidence (the same as collectOpportunities). */
export const EVENT_WINDOW_MS = 14 * 86_400_000;

export interface ProductRef {
  product_id: string;
  variant_key: string | null;
}

export type StoreEvidence = Required<Pick<ClaimEvidence, 'offer' | 'arrival' | 'backInStock'>>;

/** The arrival / back-in-stock flags the catalogue watch's recorded events prove for these products right now. */
export async function watchEvidence(db: D1Database, productIds: readonly string[], nowMs = Date.now()): Promise<{ arrival: boolean; backInStock: boolean }> {
  const ids = [...new Set(productIds.filter(Boolean))].slice(0, 12);
  if (!ids.length) return { arrival: false, backInStock: false };
  const { results } = await db
    .prepare(`SELECT product_id, kind FROM creative_events WHERE detected_at >= ? AND product_id IN (SELECT value FROM json_each(?))`)
    .bind(nowIso(nowMs - EVENT_WINDOW_MS), JSON.stringify(ids))
    .all<{ product_id: string; kind: 'arrival' | 'back_in_stock' }>()
    .catch(() => ({ results: [] as Array<{ product_id: string; kind: 'arrival' | 'back_in_stock' }> }));
  const events = results ?? [];
  if (!events.length) return { arrival: false, backInStock: false };
  const cards = await cardStates(db, [...new Set(events.map((e) => e.product_id))]);
  let arrival = false;
  let backInStock = false;
  for (const e of events) {
    const card = cards.get(e.product_id);
    // Still listed, and (for back in stock) still available: an event that no longer holds is not evidence today.
    if (!card) continue;
    if (e.kind === 'arrival') arrival = true;
    if (e.kind === 'back_in_stock' && card.availability === 'available') backInStock = true;
  }
  return { arrival, backInStock };
}

/** Offer, arrival and back-in-stock evidence for the products these snapshots name (live snapshots only). */
export async function storeEvidence(db: D1Database, snapshots: ReadonlyArray<ProductSnapshot | null | undefined>, nowMs = Date.now()): Promise<StoreEvidence> {
  const refs: ProductRef[] = [];
  for (const s of snapshots) if (s && s.source === 'live' && s.data.product_id) refs.push({ product_id: s.data.product_id, variant_key: s.data.variant_key ?? null });
  if (!refs.length) return { offer: false, arrival: false, backInStock: false };
  const fresh = await Promise.all(refs.slice(0, 6).map((r) => buildSnapshotData(db, r.product_id, r.variant_key).catch(() => null)));
  const watch = await watchEvidence(db, refs.map((r) => r.product_id), nowMs);
  return { offer: fresh.some((d) => !!d && d.price.offer !== null), ...watch };
}
