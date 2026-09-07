/**
 * Helpers over the config's catalogs: which printer can print what, what fits,
 * what the player's machines can do together, what a machine resells for.
 */

import {
  CUSTOMER_TIERS, QUALITIES,
  type CustomerTier, type CustomerTierSpec, type FarmConfig, type LocationSpec, type MaterialSpec,
  type PrinterModelSpec, type ProductSpec, type Quality,
} from './config';
import type { FarmPrinterRow } from './types';

export function printerModel(cfg: FarmConfig, key: string): PrinterModelSpec | null {
  return Object.prototype.hasOwnProperty.call(cfg.printers, key) ? cfg.printers[key] : null;
}
export function materialSpec(cfg: FarmConfig, key: string): MaterialSpec | null {
  return Object.prototype.hasOwnProperty.call(cfg.materials, key) ? cfg.materials[key] : null;
}
export function productSpec(cfg: FarmConfig, key: string): ProductSpec | null {
  return Object.prototype.hasOwnProperty.call(cfg.products, key) ? cfg.products[key] : null;
}
export function tierSpec(cfg: FarmConfig, key: string): CustomerTierSpec | null {
  return (CUSTOMER_TIERS as readonly string[]).includes(key) ? cfg.customers[key as CustomerTier] : null;
}
/** The player's location, falling back to tiny_room and then to the first configured one. */
export function locationSpec(cfg: FarmConfig, key: string): LocationSpec {
  if (Object.prototype.hasOwnProperty.call(cfg.locations, key)) return cfg.locations[key];
  if (cfg.locations.tiny_room) return cfg.locations.tiny_room;
  const first = Object.values(cfg.locations)[0];
  return first ?? { name: { ar: '', en: '', ckb: '' }, max_printers: 1, storage_grams: 1000, employees: 0, price: 0, min_level: 1 };
}

export function tierRank(tier: string): number {
  const i = (CUSTOMER_TIERS as readonly string[]).indexOf(tier);
  return i < 0 ? 0 : i;
}
export function qualityRank(q: string): number {
  const i = (QUALITIES as readonly string[]).indexOf(q);
  return i < 0 ? 1 : i;
}
export function isQuality(v: unknown): v is Quality {
  return typeof v === 'string' && (QUALITIES as readonly string[]).includes(v);
}

export function supportsMaterial(model: PrinterModelSpec, material: string): boolean {
  return model.materials.includes(material);
}

/** A part fits when its sorted dimensions fit the sorted build volume. */
export function partFits(model: PrinterModelSpec, product: ProductSpec): boolean {
  const vol = [...model.volume_mm].sort((a, b) => a - b);
  const part = [...product.size_mm].sort((a, b) => a - b);
  return part[0] <= vol[0] && part[1] <= vol[1] && part[2] <= vol[2];
}

export interface OwnedCapacity {
  /** Materials at least one owned printer can print. */
  materials: Set<string>;
  /** 1 without any AMS-capable printer, else the largest product max_colors allowed. */
  maxColors: number;
  /** Models owned (deduplicated). */
  models: PrinterModelSpec[];
  /** Whether any printer can print the product (material + volume). */
  canPrint: (product: ProductSpec, material: string) => boolean;
}

/** What the player's machines can do together — used to generate offers a player can actually take. */
export function ownedCapacity(printers: FarmPrinterRow[], cfg: FarmConfig): OwnedCapacity {
  const models: PrinterModelSpec[] = [];
  const seen = new Set<string>();
  for (const p of printers) {
    if (p.state === 'broken') continue;
    const m = printerModel(cfg, p.model_key);
    if (m && !seen.has(p.model_key)) {
      seen.add(p.model_key);
      models.push(m);
    }
  }
  const materials = new Set<string>();
  for (const m of models) for (const mat of m.materials) if (cfg.materials[mat]) materials.add(mat);
  const anyAms = models.some((m) => m.ams);
  return {
    materials,
    maxColors: anyAms ? 16 : 1,
    models,
    canPrint: (product, material) => models.some((m) => supportsMaterial(m, material) && partFits(m, product)),
  };
}

/** What the store pays for a used machine (integer coins). */
export function resaleValue(cfg: FarmConfig, modelKey: string): number {
  const m = printerModel(cfg, modelKey);
  if (!m) return 0;
  return Math.max(0, Math.round(m.price * cfg.economy.resale_factor));
}

/** The first empty slot in the room. */
export function lowestFreeSlot(printers: FarmPrinterRow[]): number {
  const taken = new Set(printers.map((p) => p.slot));
  let s = 0;
  while (taken.has(s)) s++;
  return s;
}

/** Grams a batch of `qty` parts needs (ceil — a spool cannot give half a gram). */
export function gramsFor(product: ProductSpec, qty: number): number {
  return Math.max(1, Math.ceil(product.grams_per_part * qty));
}
