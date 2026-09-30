/**
 * THE PERSONALIZE DOORS, TYPED (worker/routes/personalize.ts, lane L5):
 *
 *   GET  /api/personalize/status              what this viewer may do
 *   GET  /api/personalize/blueprints/:id      the product's public blueprint (?rev=)
 *   POST /api/personalize/configs             {product_id, configuration} → minted
 *   GET  /api/personalize/configs/:id         the owner's configuration, priced now
 *
 * Used from C3 on (the storefront door, the cart). In C1 the studio is mounted
 * only by the merchant's builder preview, which hands it the preview
 * projection itself, and by the test fixture. Every figure here is the
 * server's: the client sends ids and choices, never a price (P1); a refusal
 * code reaches the screen through src/lib/refusalStrings.ts.
 */
import { api, type RequestOptions } from '../../lib/api';
import type { CheckFinding } from '../../../packages/catalog/src/personalize/check';
import type { DesignConfig, PublicBlueprint, Verdict } from '../../../packages/catalog/src/personalize/types';

export interface PersonalizeStatus {
  on: boolean;
  may_use: boolean;
  may_build: boolean;
  cart: boolean;
  create: boolean;
  social: boolean;
}

export interface ConfigWordsOut {
  ar: string;
  en: string;
  ckb: string;
}

export interface MintedConfig {
  config_id: string;
  twin_code: string;
  unit_iqd: number;
  adds: Array<{ key: string; iqd: number; qty?: number }>;
  words: ConfigWordsOut;
  check: { verdict: Verdict; issues: CheckFinding[] };
  config: DesignConfig;
}

export interface OwnConfig {
  config_id: string;
  twin_code: string;
  product_id: string;
  rev: number;
  live_rev: number | null;
  /** The shop published a new revision since (the studio carries the choices over). */
  changed: boolean;
  config: DesignConfig;
  unit_iqd: number | null;
  adds: Array<{ key: string; iqd: number; qty?: number }>;
  check: { verdict: Verdict; issues: CheckFinding[] } | null;
  words: ConfigWordsOut | null;
  created_at: string;
}

const id = (s: string) => encodeURIComponent(s);

export const personalizeApi = {
  status: (opts?: RequestOptions) => api.get<{ success: true } & PersonalizeStatus>('/api/personalize/status', opts),
  blueprint: (productId: string, rev?: number | null, opts?: RequestOptions) =>
    api.get<{ success: true; preview: boolean; blueprint: PublicBlueprint }>(`/api/personalize/blueprints/${id(productId)}${rev ? `?rev=${rev}` : ''}`, opts),
  /** The choices only — the server prices, checks and words them. */
  mint: (productId: string, configuration: DesignConfig, opts?: RequestOptions) =>
    api.post<{ success: true } & MintedConfig>('/api/personalize/configs', { product_id: productId, configuration }, opts),
  config: (configId: string, opts?: RequestOptions) => api.get<{ success: true } & OwnConfig>(`/api/personalize/configs/${id(configId)}`, opts),
};
