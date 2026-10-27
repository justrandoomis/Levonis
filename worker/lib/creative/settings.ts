/**
 * THE OWNER'S PROVIDER SETTINGS — model, effort, budget, rates, visual review,
 * priorities and the chosen model's capabilities (spec §27, §29).
 *
 * This module reads every column of `creative_provider_settings` EXCEPT the
 * sealed key: the query below names its columns one by one and asks only
 * whether a key is stored. The ciphertext is read by
 * worker/lib/creative/anthropic.ts alone.
 *
 * DEFAULTS WHEN THE OWNER SET NOTHING. A request and a token cap always apply
 * (60 requests, 600,000 tokens a day, 2 at once, 2 automatic fix rounds); USD
 * caps apply only once the owner enters rates, because a cost without rates is
 * a number nobody measured. No model is ever defaulted: until the owner picks
 * one from the live list, AI requests answer MODEL_NOT_SELECTED.
 */
import type { BudgetSettings, Effort, Rates } from '../../../packages/creativeDoc/src/api';
import { jsonObject, stringList } from './db';

export const DEFAULT_BUDGET: Readonly<BudgetSettings> = Object.freeze({
  daily_requests: 60,
  daily_tokens: 600_000,
  daily_usd: null,
  monthly_usd: null,
  max_parallel: 2,
  auto_fix_rounds: 2,
});

/** The bounds a saved budget is clamped into (a typo cannot open an unlimited budget). */
export const BUDGET_LIMITS = Object.freeze({
  daily_requests: { min: 1, max: 2000 },
  daily_tokens: { min: 10_000, max: 50_000_000 },
  usd: { min: 0.01, max: 1000 },
  max_parallel: { min: 1, max: 8 },
  auto_fix_rounds: { min: 0, max: 5 },
});

export interface Capabilities {
  /** The model the flags were read for (they belong to one model, never carried to another). */
  model: string | null;
  structured_outputs: boolean | null;
  vision: boolean | null;
  effort: boolean | null;
  /** The effort levels the model lists as supported; empty when unknown. */
  effort_levels: Effort[];
}

export const NO_CAPABILITIES: Readonly<Capabilities> = Object.freeze({ model: null, structured_outputs: null, vision: null, effort: null, effort_levels: [] });

export interface ProviderSettings {
  migrated: boolean;
  has_stored_key: boolean;
  key_hint: string | null;
  key_set_at: string | null;
  model: string | null;
  effort: Effort | null;
  budget: BudgetSettings;
  rates: Rates | null;
  vision_review: boolean;
  priorities: string[];
  capabilities: Capabilities;
  last_test: { ok: boolean; at: string; code: string | null } | null;
}

const clampInt = (v: unknown, min: number, max: number, fallback: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, Math.round(v))) : fallback;

const usdOrNull = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.min(BUDGET_LIMITS.usd.max, Math.max(BUDGET_LIMITS.usd.min, Math.round(v * 100) / 100)) : null;

/** A stored or submitted budget → a complete, clamped one (unknown keys dropped). */
export function normalizeBudget(raw: unknown): BudgetSettings {
  const o = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const L = BUDGET_LIMITS;
  return {
    daily_requests: clampInt(o.daily_requests, L.daily_requests.min, L.daily_requests.max, DEFAULT_BUDGET.daily_requests),
    daily_tokens: clampInt(o.daily_tokens, L.daily_tokens.min, L.daily_tokens.max, DEFAULT_BUDGET.daily_tokens),
    daily_usd: usdOrNull(o.daily_usd),
    monthly_usd: usdOrNull(o.monthly_usd),
    max_parallel: clampInt(o.max_parallel, L.max_parallel.min, L.max_parallel.max, DEFAULT_BUDGET.max_parallel),
    auto_fix_rounds: clampInt(o.auto_fix_rounds, L.auto_fix_rounds.min, L.auto_fix_rounds.max, DEFAULT_BUDGET.auto_fix_rounds),
  };
}

/** Rates the owner entered (USD per million tokens) with their source and date — or null (no USD estimate at all). */
export function normalizeRates(raw: unknown): Rates | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const rate = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 10_000 ? Math.round(v * 10_000) / 10_000 : null);
  const input = rate(o.input_per_mtok_usd);
  const output = rate(o.output_per_mtok_usd);
  if (input === null || output === null || (input === 0 && output === 0)) return null;
  const source = typeof o.source === 'string' ? o.source.trim().slice(0, 200) : '';
  const asOf = typeof o.as_of === 'string' && /^\d{4}-\d{2}-\d{2}/.test(o.as_of) ? o.as_of.slice(0, 10) : '';
  if (!source || !asOf) return null;
  return { input_per_mtok_usd: input, output_per_mtok_usd: output, source, as_of: asOf };
}

const EFFORTS: readonly Effort[] = ['low', 'medium', 'high'];
export const isEffort = (v: unknown): v is Effort => typeof v === 'string' && (EFFORTS as readonly string[]).includes(v);

export function normalizeCapabilities(raw: unknown): Capabilities {
  const o = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const flag = (v: unknown) => (typeof v === 'boolean' ? v : null);
  return {
    model: typeof o.model === 'string' && o.model ? o.model.slice(0, 120) : null,
    structured_outputs: flag(o.structured_outputs),
    vision: flag(o.vision),
    effort: flag(o.effort),
    effort_levels: Array.isArray(o.effort_levels) ? o.effort_levels.filter(isEffort) : [],
  };
}

/** Owner priorities: short words, at most 12. */
export function normalizePriorities(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw.filter((x): x is string => typeof x === 'string').map((x) => x.replace(/\s+/g, ' ').trim().slice(0, 120)).filter(Boolean))].slice(0, 12);
}

/** Columns read here: everything but the ciphertext. */
const COLUMNS = `key_sealed IS NOT NULL AS has_stored_key, key_hint, key_set_at, model, effort, budget_json, rates_json, vision_review,
  priorities_json, capabilities_json, last_test_at, last_test_ok, last_test_code`;

interface SettingsRow {
  has_stored_key: number;
  key_hint: string | null;
  key_set_at: string | null;
  model: string | null;
  effort: string | null;
  budget_json: string;
  rates_json: string | null;
  vision_review: number;
  priorities_json: string;
  capabilities_json: string;
  last_test_at: string | null;
  last_test_ok: number | null;
  last_test_code: string | null;
}

export function settingsFromRow(row: SettingsRow | null, migrated: boolean): ProviderSettings {
  if (!row) {
    return {
      migrated, has_stored_key: false, key_hint: null, key_set_at: null, model: null, effort: null, budget: { ...DEFAULT_BUDGET },
      rates: null, vision_review: false, priorities: [], capabilities: { ...NO_CAPABILITIES, effort_levels: [] }, last_test: null,
    };
  }
  const caps = normalizeCapabilities(jsonObject(row.capabilities_json));
  return {
    migrated,
    has_stored_key: row.has_stored_key === 1,
    key_hint: row.key_hint,
    key_set_at: row.key_set_at,
    model: row.model,
    effort: isEffort(row.effort) ? row.effort : null,
    budget: normalizeBudget(jsonObject(row.budget_json)),
    rates: normalizeRates(jsonObject(row.rates_json)),
    vision_review: row.vision_review === 1,
    priorities: stringList(row.priorities_json),
    // Capabilities belong to the model they were read for; a different chosen model has none known yet.
    capabilities: caps.model && caps.model === row.model ? caps : { ...NO_CAPABILITIES, effort_levels: [] },
    last_test: row.last_test_at ? { ok: row.last_test_ok === 1, at: row.last_test_at, code: row.last_test_code } : null,
  };
}

/** The owner's settings, or the defaults — `migrated: false` on a database without 0215 (never a throw). */
export async function readProviderSettings(db: D1Database): Promise<ProviderSettings> {
  try {
    const row = await db.prepare(`SELECT ${COLUMNS} FROM creative_provider_settings WHERE id = 'anthropic'`).first<SettingsRow>();
    return settingsFromRow(row ?? null, true);
  } catch (e) {
    if (/no such table|no such column/i.test(e instanceof Error ? e.message : String(e))) return settingsFromRow(null, false);
    throw e;
  }
}

/** The settings row exists (the key and settings writes UPDATE it). */
export function ensureSettingsRow(db: D1Database): D1PreparedStatement {
  return db.prepare(`INSERT OR IGNORE INTO creative_provider_settings (id) VALUES ('anthropic')`);
}
