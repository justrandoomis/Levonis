/**
 * The fingerprint of the migrated values the owner is shown (P1's answer B
 * placement): «قبول القيم المرحّلة» is fenced on it, so a price edited between
 * the look and the tap is a fresh look (FX plan §10 step 2, MVP P3). Private:
 * a hash over amounts is a cost oracle (FINANCIAL_FIELDS `legacy_hash`).
 */
import type { PricingRuleRow } from '@levonis/pricing/ruleResolution';
import { sha256Hex } from '../crypto';

export async function legacyHashOf(rules: readonly PricingRuleRow[]): Promise<string> {
  const image = [...rules]
    .map((r) => [r.kind, r.scope, r.scope_id, r.state, r.amount_iqd ?? null])
    .sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1));
  return sha256Hex(JSON.stringify(image));
}
