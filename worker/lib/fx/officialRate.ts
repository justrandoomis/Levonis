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
 *
 * NOT BEFORE THE WALLET IS REBASED (owner 2026-10-18, «keep the existing
 * balances' value in dinars»). Wallet cents were credited at the legacy rate;
 * read at U they would be worth U / legacy more dinars. So until the one-time
 * rebase (worker/lib/fx/walletRateRebase.ts) has rescaled every wallet and
 * written its marker in the same batch, this keeps returning the legacy rate,
 * and deploying the code moves no balance. A database that held no wallet
 * money when migration 0202 applied is born rebased.
 */
import { getSetting, SETTING_DEFAULTS } from '../settings';
import { isSchemaMissing } from '../membershipBenefits';
import { getAppliedUsdRate, wholeDinarRate } from './displayRate';

export { wholeDinarRate };

/** The legacy admin setting: the wallet's rate until the rebase, and the fallback while no applied rate exists. */
export async function legacyUsdRate(db: D1Database): Promise<number> {
  try {
    const n = Math.trunc(Number(await getSetting(db, 'exchangeRate')));
    if (Number.isSafeInteger(n) && n > 0) return n;
  } catch {
    // unreadable: the default below
  }
  return SETTING_DEFAULTS.exchangeRate;
}

/** Databases whose marker has been seen: it is never removed, so a `true` is kept for the isolate. */
const rebased = new WeakSet<object>();

/**
 * Has the one-time wallet rebase run (migration 0202's marker row)? A missing
 * table is an answer — not yet. Any other failure propagates: after the rebase
 * a silent `false` would convert at the legacy rate and move money by 20%.
 */
export async function walletRateRebased(db: D1Database): Promise<boolean> {
  if (rebased.has(db)) return true;
  try {
    const row = await db.prepare('SELECT 1 AS ok FROM wallet_rate_rebase WHERE id = 1').first<{ ok: number }>();
    if (!row) return false;
  } catch (e) {
    if (isSchemaMissing(e)) return false;
    throw e;
  }
  rebased.add(db);
  return true;
}

/**
 * THE official USD/IQD in whole dinars: U when it exists and the wallet has
 * been rebased onto it, else the legacy setting. Never 0.
 */
export async function getOfficialUsdRate(db: D1Database): Promise<number> {
  const official = wholeDinarRate(await getAppliedUsdRate(db));
  if (official === null || !(await walletRateRebased(db))) return legacyUsdRate(db);
  return official;
}
