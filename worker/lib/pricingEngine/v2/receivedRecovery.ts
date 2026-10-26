/** One-time recovery of the owner's saved prices captured by migration 0214.
 * No adoption of future drafts, no legacy prices, and no changed input set.
 * Each recovered channel must have a known received cost and its saved profit.
 * The ordinary writer fences the price image, inputs, rates and import decision.
 */
import { fence } from '../../operations';
import { importStockNotConfigured } from '../../importStock';
import { COMPLETENESS_LIST_VERSION, recomputeCompleteness, recomputeCost } from '../../productCompleteness';
import { receivedShelfExistsSql } from './shelf';
import { loadV2Read } from './api';
import { evaluateV2Write, storedDesired } from './evaluate';
import { v2WriteStatements, V2_PRICING_STATEMENT_CAP } from './write';

type Pending = { product_id: string; inputs_seq: number; write_seq: number };
/** The repair needs only a shared statement counter, not the automatic repricer. */
type RecoveryBudget = { canSpend(n: number): boolean; spend(n: number): boolean };
const READ_ROOM = 60; // V2 reads, installation probes and writer preparation, including a cold binding.

export async function recoverReceivedPricing(db: D1Database, budget: RecoveryBudget): Promise<{ recovered: string[]; refreshed: number; skipped: number; slugs: string[] }> {
  const report = { recovered: [] as string[], refreshed: 0, skipped: 0, slugs: [] as string[] };
  if (!budget.spend(1)) return report;
  let pending: Pending[];
  try {
    pending = (await db.prepare("SELECT product_id, inputs_seq, write_seq FROM pricing_received_recovery WHERE status = 'pending' ORDER BY product_id LIMIT 5").all<Pending>()).results ?? [];
  } catch (error) {
    if (/no such table: pricing_received_recovery/i.test(String(error))) return report;
    throw error;
  }
  for (const p of pending) {
    if (!budget.canSpend(READ_ROOM + recomputeCost(1) + 1)) break;
    budget.spend(READ_ROOM);
    const skip = async (reason: string) => {
      if (!budget.spend(1)) return;
      await db.prepare("UPDATE pricing_received_recovery SET status = 'skipped', reason = ?, completed_at = ? WHERE product_id = ? AND status = 'pending'")
        .bind(reason, new Date().toISOString(), p.product_id).run();
      report.skipped++;
    };
    const read = await loadV2Read(db, p.product_id);
    if (!read || read.loaded.doc.status !== 'active' || read.stored.state?.pricing_method !== 'cost' || read.v2?.results.length ||
      read.stored.state.inputs_seq !== p.inputs_seq || read.stored.state.write_seq !== p.write_seq) {
      await skip('CHANGED');
      continue;
    }
    // Temporary environment conditions wait; no price is guessed from a draft rate.
    if (read.control.paused || !read.rates?.usd_iqd || read.rates.derived_stale || read.rates.review_pending.USD_IQD) continue;
    if (await importStockNotConfigured(db, p.product_id)) { await skip('IMPORT_STOCK_NOT_CONFIGURED'); continue; }
    const desired = storedDesired(read.v2);
    const ev = await evaluateV2Write({ ...read, ...desired, method: 'cost', inputWrites: [], ruleWrites: [], acceptBlocked: true });
    if (!ev.complete || !ev.hash || !ev.plan.prices.length || ev.plan.prices.some((r) => r.channel !== 'direct_sale' || !r.price.v2.shelf)) {
      await skip('PRICING_INCOMPLETE');
      continue;
    }
    const now = new Date().toISOString();
    const statements = [
      ...fence(db, "EXISTS(SELECT 1 FROM pricing_received_recovery WHERE product_id = ? AND status = 'pending' AND inputs_seq = ? AND write_seq = ?)", [p.product_id, p.inputs_seq, p.write_seq]),
      ...await v2WriteStatements(db, ev, { actor: 'system:received-pricing-repair', auditActor: null, now, source: 'received_pricing_recovery', idempotencyKey: `received-recovery:${p.product_id}:${p.inputs_seq}:${p.write_seq}`, updatedAt: read.loaded.doc.updated_at }),
      db.prepare("UPDATE pricing_received_recovery SET status = 'recovered', reason = NULL, completed_at = ? WHERE product_id = ?").bind(now, p.product_id),
    ];
    if (statements.length > V2_PRICING_STATEMENT_CAP || !budget.canSpend(statements.length + recomputeCost(1))) break;
    budget.spend(statements.length);
    try {
      await db.batch(statements);
    } catch {
      // A concurrent save or worker won: the batch rolled back. Re-read next time.
      continue;
    }
    report.recovered.push(p.product_id);
    if (read.loaded.doc.slug) report.slugs.push(read.loaded.doc.slug);
    budget.spend(recomputeCost(1));
    await recomputeCompleteness(db, [p.product_id]);
  }
  // Existing published prices need their old false holds refreshed too, without
  // waiting behind the full catalog's quarter-hour completeness backlog.
  let n = 25;
  while (n > 0 && !budget.canSpend(2 + recomputeCost(n))) n--;
  if (n > 0) {
    budget.spend(1);
    const rows = (await db.prepare(`SELECT p.id FROM products p
      JOIN product_pricing_state s ON s.product_id=p.id AND s.mode='engine' AND s.pricing_method IN ('cost','usd')
      JOIN product_completeness pc ON pc.product_id=p.id AND pc.list_version < ?
      WHERE p.status='active' AND COALESCE(p.composition,'')=''
        AND ${receivedShelfExistsSql('p')}
      ORDER BY p.id LIMIT ?`).bind(COMPLETENESS_LIST_VERSION, n).all<{ id: string }>()).results ?? [];
    if (rows.length) {
      budget.spend(1 + recomputeCost(rows.length));
      const refreshed = await recomputeCompleteness(db, rows.map((r) => r.id));
      report.refreshed = refreshed.verdicts.length;
      report.slugs.push(...refreshed.flipped);
    }
  }
  return report;
}
