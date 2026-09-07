/**
 * Customer jobs: what is offered, what it pays, when it is due.
 *
 * Offers are generated deterministically from a seed the route derives from
 * (userId, refresh index): two reads racing for the same refresh produce the
 * same rows with the same ids, so `INSERT OR IGNORE` makes the race harmless.
 * Reward, penalties and deadline are computed HERE, at offer time, from the
 * config of that moment and snapshot on the row (docs §5 snapshot-at-use).
 */

import { CUSTOMER_TIERS, type CustomerTier, type FarmConfig, type ProductSpec, type Quality } from './config';
import { gramsFor, materialSpec, productSpec, tierRank, tierSpec, type OwnedCapacity } from './catalog';
import { roll, sequence, weightedIndex } from './rng';
import { addMs, gameMinutesToRealMs, gameSecondsToRealMs, realMinutesToMs, referenceSeconds } from './time';
import type { FarmJobRow } from './types';

/** A farm_jobs row about to be inserted. */
export interface JobInsert {
  id: string;
  user_id: string;
  state: 'offered';
  customer_tier: CustomerTier;
  customer_name: string;
  product_key: string;
  qty: number;
  material: string;
  colors_json: string;
  grams: number;
  print_seconds: number;
  quality: Quality;
  reward_coins: number;
  reputation_gain_bp: number;
  late_penalty_bp: number;
  cancel_penalty_coins: number;
  cancel_penalty_bp: number;
  offered_at: string;
  offer_expires_at: string;
  deadline_at: string;
  seed: string;
}

/**
 * reward = (material cost × per_gram_factor + reference hours × per_hour_coins
 *           + qty × per_part_coins) × tier margin × quality multiplier, rounded.
 */
export function rewardFor(cfg: FarmConfig, product: ProductSpec, qty: number, materialKey: string, tier: CustomerTier, quality: Quality): number {
  const mat = materialSpec(cfg, materialKey);
  const t = cfg.customers[tier];
  const f = cfg.jobs.reward_formula;
  const grams = gramsFor(product, qty);
  const materialCost = grams * (mat?.price_per_gram ?? 0);
  const hours = referenceSeconds(product, qty) / 3600;
  const base = materialCost * f.per_gram_factor + hours * f.per_hour_coins + qty * f.per_part_coins;
  const q = f.quality_multipliers[quality] ?? 1;
  return Math.max(0, Math.round(base * (t?.reward_margin ?? 1) * q));
}

/** The customer's deadline is fixed when the offer appears: lifetime + print time × factor + buffer. */
export function deadlineFor(cfg: FarmConfig, product: ProductSpec, qty: number, tier: CustomerTier, offeredAt: string): string {
  const t = cfg.customers[tier];
  const printMs = gameSecondsToRealMs(referenceSeconds(product, qty) * (t?.deadline_factor ?? 2), cfg);
  const bufferMs = gameMinutesToRealMs(cfg.jobs.deadline_buffer_minutes, cfg);
  return addMs(offeredAt, realMinutesToMs(cfg.jobs.offer_lifetime_minutes) + printMs + bufferMs);
}

export interface OfferSpec {
  id: string;
  userId: string;
  tier: CustomerTier;
  productKey: string;
  qty: number;
  material: string;
  colors: string[];
  quality: Quality;
  customerName: { ar: string; en: string; ckb: string };
  offeredAt: string;
  seed: string;
}

/** Turns a chosen offer into the row to insert, computing every snapshot value. */
export function buildOffer(cfg: FarmConfig, spec: OfferSpec): JobInsert | null {
  const product = productSpec(cfg, spec.productKey);
  const tier = tierSpec(cfg, spec.tier);
  if (!product || !tier) return null;
  return {
    id: spec.id,
    user_id: spec.userId,
    state: 'offered',
    customer_tier: spec.tier,
    customer_name: JSON.stringify(spec.customerName),
    product_key: spec.productKey,
    qty: spec.qty,
    material: spec.material,
    colors_json: JSON.stringify(spec.colors),
    grams: gramsFor(product, spec.qty),
    print_seconds: referenceSeconds(product, spec.qty),
    quality: spec.quality,
    reward_coins: rewardFor(cfg, product, spec.qty, spec.material, spec.tier, spec.quality),
    reputation_gain_bp: tier.reputation_gain_bp,
    late_penalty_bp: tier.late_penalty_bp,
    cancel_penalty_coins: tier.cancel_penalty_coins,
    cancel_penalty_bp: tier.cancel_penalty_bp,
    offered_at: spec.offeredAt,
    offer_expires_at: addMs(spec.offeredAt, realMinutesToMs(cfg.jobs.offer_lifetime_minutes)),
    deadline_at: deadlineFor(cfg, product, spec.qty, spec.tier, spec.offeredAt),
    seed: spec.seed,
  };
}

/** Tiers whose reputation and level gates this player passes. */
export function eligibleTiers(cfg: FarmConfig, profile: { level: number; reputation_bp: number }): CustomerTier[] {
  return CUSTOMER_TIERS.filter((t) => {
    const s = cfg.customers[t];
    return s.weight > 0 && profile.level >= s.min_level && profile.reputation_bp >= s.min_reputation_bp;
  });
}

/** Products a tier may ask for that the player's machines can print in some material they may buy. */
export function eligibleProducts(
  cfg: FarmConfig, tier: CustomerTier, capacity: OwnedCapacity, level: number
): Array<{ key: string; product: ProductSpec; materials: string[] }> {
  const rank = tierRank(tier);
  const out: Array<{ key: string; product: ProductSpec; materials: string[] }> = [];
  for (const [key, product] of Object.entries(cfg.products)) {
    if (tierRank(product.min_tier) > rank) continue;
    const materials = product.materials.filter((m) => {
      const spec = materialSpec(cfg, m);
      return !!spec && spec.min_level <= level && capacity.materials.has(m) && capacity.canPrint(product, m);
    });
    if (materials.length) out.push({ key, product, materials });
  }
  return out.sort((a, b) => a.key.localeCompare(b.key));
}

export interface GenerateOffersInput {
  userId: string;
  profile: { level: number; reputation_bp: number };
  capacity: OwnedCapacity;
  now: string;
  cfg: FarmConfig;
  /** From seedFrom(userId, 'offers', refreshIndex). */
  seed: string;
  count: number;
}

/** Deterministic offers for one refresh. Same input → same rows, same ids. */
export function generateOffers(input: GenerateOffersInput): JobInsert[] {
  const { cfg, capacity, profile } = input;
  const tiers = eligibleTiers(cfg, profile);
  if (tiers.length === 0 || input.count <= 0) return [];
  const next = sequence(input.seed, 'offers');
  const out: JobInsert[] = [];
  for (let i = 0; i < input.count; i++) {
    const tier = tiers[weightedIndex(tiers.map((t) => cfg.customers[t].weight), next())];
    const t = cfg.customers[tier];
    const products = eligibleProducts(cfg, tier, capacity, profile.level);
    if (products.length === 0) continue;
    const pick = products[Math.floor(next() * products.length)];
    const material = pick.materials[Math.floor(next() * pick.materials.length)];
    const mat = materialSpec(cfg, material)!;
    const [lo, hi] = t.qty_range;
    const qty = lo + Math.floor(next() * (hi - lo + 1));
    const maxColors = Math.max(1, Math.min(pick.product.max_colors, capacity.maxColors, mat.colors.length));
    const nColors = 1 + Math.floor(next() * maxColors);
    const palette = [...mat.colors];
    const colors: string[] = [];
    for (let c = 0; c < nColors && palette.length; c++) colors.push(palette.splice(Math.floor(next() * palette.length), 1)[0]);
    // Finer work appears more often for higher tiers; individuals mostly want standard.
    const qRoll = next();
    const quality: Quality = qRoll < 0.08 ? 'draft' : qRoll < 0.8 - tierRank(tier) * 0.08 ? 'standard' : qRoll < 0.96 ? 'fine' : 'ultra';
    const name = t.names.length ? t.names[Math.floor(next() * t.names.length)] : { ar: '', en: '', ckb: '' };
    const row = buildOffer(cfg, {
      id: `fjob_${input.seed.slice(0, 16)}${i.toString(36)}`,
      userId: input.userId,
      tier,
      productKey: pick.key,
      qty,
      material,
      colors,
      quality,
      customerName: name,
      offeredAt: input.now,
      seed: `${input.seed}:${i}`,
    });
    if (row) out.push(row);
  }
  return out;
}

/** The starter's first job — the template from config, built like any other offer. */
export function starterFirstJob(cfg: FarmConfig, userId: string, now: string): JobInsert | null {
  const s = cfg.starter.first_job;
  const t = cfg.customers[s.customer_tier];
  const name = t?.names[0] ?? { ar: '', en: '', ckb: '' };
  return buildOffer(cfg, {
    id: `fjob_first_${userId}`.slice(0, 80),
    userId,
    tier: s.customer_tier,
    productKey: s.product,
    qty: s.qty,
    material: cfg.starter.spool.material,
    colors: s.colors.length ? s.colors : [cfg.starter.spool.color],
    quality: s.quality,
    customerName: name,
    offeredAt: now,
    seed: `first:${userId}`,
  });
}

/** Ids of offers whose lifetime has passed. */
export function expireOffers(jobs: FarmJobRow[], now: string): string[] {
  const t = Date.parse(now);
  return jobs.filter((j) => j.state === 'offered' && Date.parse(j.offer_expires_at) <= t).map((j) => j.id);
}

/** A stable per-job roll, for anything a job decides later. */
export function jobRoll(job: Pick<FarmJobRow, 'seed'>, salt: string): number {
  return roll(job.seed, salt);
}
