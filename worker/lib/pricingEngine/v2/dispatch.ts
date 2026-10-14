/**
 * PRICING V2 — WHICH WRITER PRICES A PRODUCT (spec §3.1, C-1).
 *
 * A product is V2 when its state is `mode = 'engine'` AND it carries a
 * `pricing_method` ('cost' «من التكلفة» or 'usd' «سعر بالدولار»). Every 0181
 * lock, 0183 SKU guard and 0188 variant already keys on `mode = 'engine'`, so a
 * V2 product is locked exactly like an engine product; only the code AFTER the
 * selection branches here: V1's `evaluateEngineWrite` or V2's `evaluateV2Write`.
 */
import type { PricingContext } from '../../../routes/cart';
import { evaluateEngineWrite, isV2Product, type EngineControl, type EngineEvaluation, type StoredSkuCost } from '../engineWrite';
import type { LoadedProduct } from '../load';
import type { PricingRates } from '../rates';
import type { ProductPricingData } from '../store';
import { evaluateV2Write, storedDesired, type V2Evaluation } from './evaluate';
import type { V2Store } from './store';

/** Spec C-1: `mode = 'engine'` with a method. */
export const isV2 = (stored: Pick<ProductPricingData, 'state'>): boolean => isV2Product(stored);

export type AnyEvaluation = { engine: 'v1'; ev: EngineEvaluation } | { engine: 'v2'; ev: V2Evaluation };

export interface AnyEvaluationInput {
  loaded: LoadedProduct;
  stored: ProductPricingData;
  /** The product's V2 store (`loadV2Store`); read only for a V2 product. */
  v2: V2Store | null;
  ctx: PricingContext;
  rates: PricingRates | null;
  control: EngineControl;
  image: string;
  /** V1's stored figures (the stale list's rows). */
  storedCosts: readonly StoredSkuCost[];
  /** FX-5: an automatic repricing. */
  auto?: true;
}

/**
 * The product's own writer, evaluated with no draft (FX-5's automatic repricing
 * and the owner's rate-act preview): V1's for every V1 engine product exactly as
 * before, V2's for a V2 product with its stored method, points and discounts.
 */
export async function evaluateAny(a: AnyEvaluationInput): Promise<AnyEvaluation> {
  if (!isV2(a.stored)) {
    return {
      engine: 'v1',
      ev: await evaluateEngineWrite({
        loaded: a.loaded,
        stored: a.stored,
        ctx: a.ctx,
        rates: a.rates,
        control: a.control,
        inputs: a.stored.inputs,
        inputWrites: [],
        ruleWrites: [],
        image: a.image,
        storedCosts: a.storedCosts,
      }),
    };
  }
  const desired = storedDesired(a.v2);
  return {
    engine: 'v2',
    ev: await evaluateV2Write({
      loaded: a.loaded,
      stored: a.stored,
      v2: a.v2,
      ctx: a.ctx,
      rates: a.rates,
      control: a.control,
      method: a.stored.state!.pricing_method!,
      points: desired.points,
      discounts: desired.discounts,
      inputWrites: [],
      ruleWrites: [],
      image: a.image,
      ...(a.auto ? { auto: true as const } : {}),
    }),
  };
}
