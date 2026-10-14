/**
 * A V1 ENGINE PRODUCT AS THE CUT-OVER FOUND IT (spec addendum A.6, A.12.2).
 *
 * Since the clean start every V1 pricing door answers 409 PRICING_V2_MANAGED,
 * so no request can make a product V1-engine-priced any more. Products that
 * were adopted before the release still are (`mode = 'engine'`, no
 * `pricing_method`): hidden from customers until their first V2 write, never
 * repriced by the automatic run, untouched by every V2 write beside them.
 * A test that needs such a product stages it here through the V1 library the
 * door used to call — parse, evaluate, the one engine batch — exactly as the
 * pre-release owner save wrote it. Test-only: no worker/ or src/ path calls it.
 */
import { loadPreviewContext, loadProducts } from '../../worker/lib/pricingEngine/load';
import { loadProductPricing } from '../../worker/lib/pricingEngine/store';
import { loadPricingRates } from '../../worker/lib/pricingEngine/rates';
import { effectiveWrites, loadEngineReads, parseProductInputs, productEngineEvaluation } from '../../worker/lib/pricingEngine/productInputs';
import { engineWriteStatements } from '../../worker/lib/pricingEngine/engineWrite';

export interface V1Draft {
  inputs: Array<Record<string, unknown>>;
  rules: Array<Record<string, unknown>>;
}

/** Adopt `pid` into the V1 engine with `draft`, as the owner's pre-release save did (one batch). */
export async function stageV1Engine(db: D1Database, pid: string, draft: V1Draft, actor = 'usr_owner'): Promise<void> {
  const rates = await loadPricingRates(db);
  if (!rates) throw new Error('stageV1Engine: no central rates (seed the pricing world first)');
  const loaded = (await loadProducts(db, [pid])).get(pid);
  if (!loaded) throw new Error(`stageV1Engine: no product ${pid}`);
  const [stored, ctx, reads] = await Promise.all([loadProductPricing(db, pid), loadPreviewContext(db), loadEngineReads(db, pid)]);
  const now = new Date().toISOString();
  const parsed = parseProductInputs({ inputs_seq: stored.state?.inputs_seq ?? 0, ...draft }, loaded, stored, { rates, now });
  const writes = effectiveWrites(parsed);
  const ev = await productEngineEvaluation(loaded, stored, ctx, rates, parsed, reads, { adopt: true, writes });
  if (!ev.complete || !ev.hash) throw new Error(`stageV1Engine: the draft leaves ${pid} incomplete (${ev.codes.join(', ')})`);
  const statements = await engineWriteStatements(db, ev, writes.inputWrites, writes.ruleWrites, {
    actor,
    now,
    source: 'product_form',
    idempotencyKey: `pe:${pid}:${ev.hash}`,
  });
  await db.batch(statements);
}
