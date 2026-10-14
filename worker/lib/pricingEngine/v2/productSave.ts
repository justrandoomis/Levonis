/**
 * PRICING V2-3b — THE PRODUCT SAVE WITH ITS PRICES, ONE BATCH (spec §3.3 step
 * 4, §3.5 last row, §4.1, §4.3; docs/PRICING-V2.md §2.6 «نشر»).
 *
 * `POST /api/admin/products-v2` on a V2 product — or any ordinary product's
 * save with a `pricing_v2` block: a product created V2 from birth, or an
 * existing product's first V2 write (the clean start, addendum A.7) — prices
 * the document the save would
 * leave (`draftLoadedOf` over the very plan the save writes) and lays the
 * planner's statements INSIDE the V2 writer's batch, after its fences and
 * under its token: the 0181/0188 value-compared locks pass, so adding a model
 * or switching a route on never dead-ends in 409 ENGINE_MANAGED (P9), and the
 * structure and its prices land together or not at all.
 *
 *   - No price moves and no price field was sent: it saves with no sheet.
 *   - A price moves: the preview's hash, the 15% tick and a fresh sign-in
 *     (`gateV2`); without the hash 409 PRICING_PREVIEW_REQUIRED carries the
 *     V2 preview, never ENGINE_MANAGED.
 *   - Incomplete: the data saves and no price moves (an existing product keeps
 *     its last good prices; a new one is born V2 and hidden); publishing it is
 *     409 PRICING_V2_PRICE_MISSING.
 *   - Over V2_SAVE_STATEMENT_CAP: 409 PRICING_SET_TOO_LARGE {section: 5}
 *     («احفظ الخيارات على دفعتين»).
 */
import type { Context } from 'hono';
import type { AppContext } from '../../types';
import { HttpError } from '../../http';
import { serverMessage } from '@levonis/contracts/costRefusals';
import { newId } from '../../crypto';
import type { ProductDoc } from '../../productModel';
import type { ProductSavePlan } from '../../productPersistence';
import { strictBody } from '../../fx/ownerActs';
import { inputInvalid } from '../whatIf';
import { loadProducts } from '../load';
import { desiredFor, evaluateDesired, gateV2, loadV2Read, parseV2Wire, storedMethodOf, v2Answer, v2PriceKey, v2ViewerOf } from './api';
import { firstWriteStatements, foldedReviewOf } from './firstWrite';
import { belowMinProfitBell, productNameOf } from './bell';
import { draftLoadedOf } from './draft';
import { V2_SAVE_STATEMENT_CAP, v2DataStatements, v2WriteStatements } from './write';

export interface V2SaveInput {
  plan: ProductSavePlan;
  /** The stored document (row only), or null when the save creates the product. */
  prev: ProductDoc | null;
  /** `products.updated_at` as read (the stale-edit fence). */
  updatedAt: string | null;
  /** The request's `pricing_v2` block (absent on a V2 product's save with no price field). */
  block: unknown;
  /** The status the document asks for. */
  status: string;
}

export type V2SaveOutcome =
  | { kind: 'already' }
  | { kind: 'write' | 'data'; statements: D1PreparedStatement[]; priced: boolean };

/** Plan the V2 half of a product save: the gates, then the one batch the caller runs (`saveProductAtomic`). */
export async function planV2ProductSave(c: Context<AppContext>, s: V2SaveInput): Promise<V2SaveOutcome> {
  const db = c.env.DB;
  const user = c.get('user')!;
  const pid = s.plan.productId;
  const block = s.block === undefined || s.block === null ? {} : strictBody(s.block, ['pricing', 'preview_hash', 'confirm_large_change']);
  if (block.confirm_large_change !== undefined && typeof block.confirm_large_change !== 'boolean') throw inputInvalid('confirm_large_change');
  const wire = parseV2Wire(block.pricing);
  const stored = s.prev ? ((await loadProducts(db, [pid])).get(pid) ?? null) : null;
  const loaded = await draftLoadedOf(db, s.plan, stored);
  const read = (await loadV2Read(db, pid, loaded))!;
  const viewer = v2ViewerOf(c.env, user);
  const now = new Date().toISOString();
  const desired = desiredFor(read, wire, { viewer, env: c.env, user, now });
  const ev = await evaluateDesired(read, desired);
  // Publishing = the product becomes visible to customers: a draft made active, or — the clean start
  // (addendum A.4/A.7) — an active product that has never had a complete V2 write (it is hidden until
  // it has one). Either needs a complete price.
  const published = !!storedMethodOf(read) && (read.v2?.results.length ?? 0) > 0;
  const verdict = await gateV2({
    c,
    ev,
    hash: block.preview_hash,
    confirm: block.confirm_large_change,
    priceChange: ev.changes.length > 0 || wire.sent.length > 0,
    publishing: s.status === 'active' && (!s.prev || s.prev.status !== 'active' || !published),
    preview: async () => v2Answer({ viewer, read, ev, draft: !s.prev }),
  });
  if (verdict === 'already') return { kind: 'already' };
  const opts = {
    actor: user.id,
    now,
    source: 'product_form',
    idempotencyKey: ev.hash && block.preview_hash === ev.hash ? v2PriceKey(pid, ev.hash) : `v2save:${pid}:${newId()}`,
    structure: s.plan.statements,
    updatedAt: s.prev ? s.updatedAt : undefined,
    newProduct: !s.prev,
    auditDetail: { structure_statements: s.plan.statements.length },
    // The clean start: an existing product's first complete V2 write retires its Direct Sale Extra and overlay.
    ...(s.prev && ev.kind === 'v2_create' ? { firstWrite: firstWriteStatements(db, read.stored, foldedReviewOf(read, viewer, user.id, now)) } : {}),
    // Q3 (DECISIONS row 222): a price editor's publish below cost + minimum profit rings the owner in the same batch.
    ...(verdict === 'data' ? {} : { extraAudits: await belowMinProfitBell(c.env, ev, viewer, productNameOf(read.loaded.row)) }),
  };
  const statements = verdict === 'data' ? await v2DataStatements(db, ev, opts) : await v2WriteStatements(db, ev, opts);
  if (statements.length > V2_SAVE_STATEMENT_CAP) throw new HttpError(409, serverMessage('PRICING_SET_TOO_LARGE'), 'PRICING_SET_TOO_LARGE', { section: 5 });
  return { kind: verdict === 'data' ? 'data' : 'write', statements, priced: verdict !== 'data' };
}
