/**
 * FX SENTINELS (FX programme plan §14.2 S1): every private field of the 0179
 * tables seeded with a value no public number can equal — the market sell
 * 1666.6666, the owner's adjustment 37.2501 (and the 29.8642 it replaced, in a
 * settings_change row's old → new), held and rejected candidates, the drift
 * anchor, the ECB figures, the derived EUR/CNY dinar rates, a shipping rate
 * and the history. The ONE public figure is the effective USD/IQD
 * (1703.9167 = 1666.6666 + 37.2501): the top bar's `displayUsdRate`.
 */
import type { DatabaseSync } from 'node:sqlite';

export const FX_PUBLIC_RATE = '1703.9167';

export const FX_SENTINELS = [
  '1666.6666', // USD/IQD market sell
  '1650.165', // market buy
  '1310.1313', // CBI official
  '37.2501', // the owner's adjustment (market_adjustment_iqd)
  '29.8642', // the adjustment before the owner's last change (a settings_change row's settings_diff)
  '1696.5308', // the effective rate under that older adjustment (the settings_change row's effective_before)
  '1680.4321', // the drift anchor (last owner-confirmed)
  '1777.7777', // a held market figure
  '1815.0278', // a held effective candidate
  '1999.9999', // a rejected candidate
  '1.0987', // EUR/USD
  '1.0911', // EUR/USD anchor
  '7.7777', // CNY per EUR
  '0.1412698', // CNY/USD
  '1872.09327829', // EUR in IQD
  '240.71197142566', // CNY in IQD
  '12345.678', // a central shipping rate
] as const;

export function seedFxSentinels(raw: DatabaseSync): void {
  const at = '2026-10-08T12:00:00.000Z';
  raw.exec(`
    UPDATE fx_rate_pairs SET market_rate='1666.6666', market_buy='1650.165', official_rate='1310.1313', market_adjustment_iqd='37.2501',
           effective_rate='${FX_PUBLIC_RATE}', effective_version=1, effective_source='provider', effective_applied_at='${at}',
           last_known_good_rate='${FX_PUBLIC_RATE}', last_known_good_at='${at}', drift_anchor_rate='1680.4321', drift_anchor_at='${at}',
           published_at='${at}', fetch_status='OK', pending_market_rate='1777.7777', pending_effective_rate='1815.0278',
           pending_reason='ANOMALY', pending_observed_at='${at}', pending_published_at='${at}', rejected_rate='1999.9999', rejected_at='${at}',
           status='REVIEW_REQUIRED'
     WHERE pair='USD_IQD';
    UPDATE fx_rate_pairs SET market_rate='1.0987', source_usd_per_eur='1.0987', source_cny_per_eur='7.7777', effective_rate='1.0987',
           effective_version=1, effective_source='provider', last_known_good_rate='1.0987', drift_anchor_rate='1.0911', drift_anchor_at='${at}',
           published_at='2026-10-08T00:00:00.000Z', fetch_status='OK', status='OK'
     WHERE pair='EUR_USD';
    UPDATE fx_rate_pairs SET market_rate='0.1412698', source_usd_per_eur='1.0987', source_cny_per_eur='7.7777', effective_rate='0.1412698',
           effective_version=1, effective_source='provider', last_known_good_rate='0.1412698', drift_anchor_rate='0.1412698', drift_anchor_at='${at}',
           published_at='2026-10-08T00:00:00.000Z', fetch_status='OK', status='OK'
     WHERE pair='CNY_USD';
    UPDATE pricing_fx_rates SET rate_iqd='${FX_PUBLIC_RATE}', usd_iqd_rate='${FX_PUBLIC_RATE}', usd_version=1, version=2, updated_at='${at}' WHERE currency='USD';
    UPDATE pricing_fx_rates SET rate_iqd='1872.09327829', usd_iqd_rate='${FX_PUBLIC_RATE}', cross_rate='1.0987', usd_version=1, cross_version=1, version=2, updated_at='${at}' WHERE currency='EUR';
    UPDATE pricing_fx_rates SET rate_iqd='240.71197142566', usd_iqd_rate='${FX_PUBLIC_RATE}', cross_rate='0.1412698', usd_version=1, cross_version=1, version=2, updated_at='${at}' WHERE currency='CNY';
    UPDATE pricing_shipping_rates SET rate_iqd='12345.678', version=2, updated_at='${at}' WHERE profile='GERMANY_LAND';
    INSERT INTO fx_rate_log (id, pair, event, trigger_kind, provider, market_rate, effective_before, effective_after, pending_rate, change_ppm, published_at, result, created_at, market_adjustment_iqd)
      VALUES ('fxl_s1', 'USD_IQD', 'review_held', 'cron', 'iqwealth', '1777.7777', '${FX_PUBLIC_RATE}', '${FX_PUBLIC_RATE}', '1815.0278', 65432, '${at}', 'REVIEW_HELD', '${at}', '37.2501'),
             ('fxl_s2', 'USD_IQD', 'apply', 'cron', 'iqwealth', '1666.6666', '1680.4321', '${FX_PUBLIC_RATE}', NULL, 13955, '${at}', 'APPLIED', '2026-10-08T06:00:00.000Z', '37.2501'),
             ('fxl_s3', 'EUR_USD', 'apply', 'cron', 'ecb', '1.0987', '1.0911', '1.0987', NULL, 6965, '2026-10-08T00:00:00.000Z', 'APPLIED', '2026-10-08T06:00:00.000Z', NULL);
    INSERT INTO fx_rate_log (id, pair, event, trigger_kind, provider, effective_before, effective_after, result, actor_id, created_at, market_adjustment_iqd, settings_diff)
      VALUES ('fxl_sdiff', 'USD_IQD', 'settings_change', 'owner', 'owner', '1696.5308', '${FX_PUBLIC_RATE}', 'APPLIED', 'usr_owner', '2026-10-08T05:00:00.000Z', '37.2501',
              '[{"field":"market_adjustment_iqd","before":"29.8642","after":"37.2501"}]');
  `);
}
