/**
 * THE ONE OFFICIAL USD/IQD (owner 2026-10-18, DECISIONS row 252).
 *
 * «سعر الصرف يكون رسمي وسائد للموقع حتى في المحفظة»: the shop has one dollar
 * rate, the APPLIED rate U every product is priced at
 * (`pricing_fx_rates.rate_iqd` for USD — market + the owner's adjustment on
 * AUTO, the rate he typed on MANUAL). The wallet (balances, top-ups,
 * withdrawals, holds, membership charges), merchant finance, the admin and
 * the notices all read it here; the storefront reads the same U as its
 * public display rate (worker/lib/fx/displayRate.ts).
 *
 * WHOLE DINARS. The wallet's ledger, every `exchange_rate_snapshot` and the
 * orders' `exchange_rate` count whole dinars per dollar (INTEGER columns,
 * `corroboratedDeclaredIqd` refuses a fraction), so a U with decimals is
 * rounded to the nearest dinar for money — identical to U whenever U is
 * whole, as the provider's sell and a typed rate are in practice.
 *
 * FALLBACK, NEVER A SILENT 0. With no applied rate (a fresh shop, a database
 * without the FX tables) it is the legacy `exchangeRate` setting, as before;
 * with that unusable too, the setting's default. Rows already stored keep the
 * rate they recorded — this is read for NEW operations only, and no
 * snapshot is ever rewritten.
 */
import { getSetting, SETTING_DEFAULTS } from '../settings';
import { getAppliedUsdRate, wholeDinarRate } from './displayRate';

export { wholeDinarRate };

/** The legacy admin setting, used only while no applied rate exists. */
async function legacyRate(db: D1Database): Promise<number> {
  try {
    const n = Math.trunc(Number(await getSetting(db, 'exchangeRate')));
    if (Number.isSafeInteger(n) && n > 0) return n;
  } catch {
    // unreadable: the default below
  }
  return SETTING_DEFAULTS.exchangeRate;
}

/** THE official USD/IQD in whole dinars: U when it exists, else the legacy setting. Never 0, never throws. */
export async function getOfficialUsdRate(db: D1Database): Promise<number> {
  const official = wholeDinarRate(await getAppliedUsdRate(db));
  return official ?? legacyRate(db);
}
