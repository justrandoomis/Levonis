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
 * rebase (worker/lib/walletRateRebase.ts) has rescaled every wallet and
 * written its marker in the same batch, this keeps returning the legacy rate,
 * and deploying the code moves no balance. A database that held no wallet
 * money when migration 0202 applied is born rebased.
 */
import { getSetting, SETTING_DEFAULTS } from '../settings';
import { isSchemaMissing } from '../membershipBenefits';
import { getAppliedUsdRate, wholeDinarRate } from './displayRate';

export { wholeDinarRate };

/** U as the rebase moves to it: the applied USD/IQD as a whole-dinar rate, null when none is applied. */
export async function appliedWholeDinarRate(db: D1Database): Promise<number | null> {
  return wholeDinarRate(await getAppliedUsdRate(db));
}

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

/** The marker row, once seen: it is written once and never changed, so it is kept for the isolate. */
interface RebaseMarker {
  legacyRate: number | null;
  officialRate: number | null;
  rebasedAt: string;
}
const markers = new WeakMap<object, RebaseMarker>();

const positiveInt = (v: unknown): number | null => {
  const n = Number(v);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
};

/**
 * Migration 0202's marker row, or null before the rebase. A missing table is
 * an answer — not yet. Any other failure propagates: after the rebase a
 * silent «not yet» would convert at the legacy rate and move money by 20%.
 */
async function rebaseMarker(db: D1Database, cache = true): Promise<RebaseMarker | null> {
  const seen = markers.get(db);
  if (seen) return seen;
  let row: { legacy_rate: unknown; official_rate: unknown; rebased_at: unknown } | null;
  try {
    row = await db
      .prepare('SELECT legacy_rate, official_rate, rebased_at FROM wallet_rate_rebase WHERE id = 1')
      .first<{ legacy_rate: unknown; official_rate: unknown; rebased_at: unknown }>();
  } catch (e) {
    if (isSchemaMissing(e)) return null;
    throw e;
  }
  if (!row) return null;
  const marker = {
    legacyRate: positiveInt(row.legacy_rate),
    officialRate: positiveInt(row.official_rate),
    rebasedAt: String(row.rebased_at ?? ''),
  };
  if (cache) markers.set(db, marker);
  return marker;
}

/** Has the one-time wallet rebase run (migration 0202's marker row)? */
export async function walletRateRebased(db: D1Database): Promise<boolean> {
  return (await rebaseMarker(db)) !== null;
}

/** The last applied rate this isolate read, per database: what an unreadable U falls back to after the rebase. */
const lastOfficial = new WeakMap<object, number>();

/**
 * THE official USD/IQD in whole dinars: U when it exists and the wallet has
 * been rebased onto it, else the legacy setting. Never 0.
 *
 * AFTER THE REBASE AN UNREADABLE U NEVER MEANS THE LEGACY RATE. Every balance
 * is then counted at U, so a failed read of `pricing_fx_rates` falls back to
 * the last U this isolate read, else the U the rebase moved the wallet to
 * (the marker's own figure) — never to the legacy setting, which would read
 * every balance 17% low and reserve 20% too much for a spend. Only a shop born
 * rebased with no money (its marker carries no rates) and no U ever read
 * falls back to the setting, as before.
 */
export async function getOfficialUsdRate(db: D1Database): Promise<number> {
  const official = wholeDinarRate(await getAppliedUsdRate(db));
  if (official !== null) {
    if (!(await walletRateRebased(db))) return legacyUsdRate(db);
    lastOfficial.set(db, official);
    return official;
  }
  // The failure path only (no U): the marker is read here without being kept.
  const marker = await rebaseMarker(db, false);
  if (!marker) return legacyUsdRate(db);
  return lastOfficial.get(db) ?? marker.officialRate ?? legacyUsdRate(db);
}

/**
 * WALLET MONEY TAKEN BEFORE THE REBASE AND GIVEN BACK AFTER IT.
 *
 * A refund that copies the cents (or converts the dinars at the rate) of a
 * payment made before the rebase would credit cents counted at the legacy
 * rate L into a wallet now counted at U: 50,000 د.ع paid as 3,572 cents would
 * come back reading 60,009. Such a refund is rescaled exactly as the rebase
 * rescaled every balance: by L / U. Null when no rebase moved value (none yet,
 * a shop born rebased, L = U) or when the payment came after it.
 */
type PaidAt = unknown | (() => Promise<unknown>);

async function rebaseBefore(db: D1Database, paidAt: PaidAt): Promise<{ legacyRate: number; officialRate: number } | null> {
  const marker = await rebaseMarker(db);
  if (!marker || marker.legacyRate === null || marker.officialRate === null) return null;
  if (marker.legacyRate === marker.officialRate) return null;
  // Read only now, when a rebase moved value: a refund pays no extra query otherwise.
  if (typeof paidAt === 'function') paidAt = await (paidAt as () => Promise<unknown>)();
  const at = (v: unknown) => {
    // D1's own clock writes ISO-8601 with a Z; an older `datetime('now')` value has a space and no zone.
    const s = String(v ?? '').trim().replace(' ', 'T');
    return Date.parse(/(?:[zZ]|[+-]\d\d:?\d\d)$/.test(s) ? s : `${s}Z`);
  };
  const paid = at(paidAt);
  const rebased = at(marker.rebasedAt);
  // Strictly later is after (the marker is stamped by the database clock inside the rebase's own
  // transaction, so a payment it saw committed is never later). An unknown time counts as before:
  // rescaling can only give back less, never create money.
  if (Number.isFinite(paid) && Number.isFinite(rebased) && paid > rebased) return null;
  return { legacyRate: marker.legacyRate, officialRate: marker.officialRate };
}

/**
 * The cents a refund of `cents` taken from a wallet at `paidAt` credits, and
 * the rate it records beside its dinars: unchanged (`rate`) for a payment made
 * after the rebase; floor(cents × L / U), at least one, recorded at U for one
 * made before it, whose dinars are then `dinarsBeforeRebase` (`legacyRate` is L).
 */
export async function refundCentsAcrossRebase(
  db: D1Database,
  cents: number,
  paidAt: PaidAt,
  rate: number | null
): Promise<{ cents: number; rate: number | null; rescaled: boolean; legacyRate: number | null }> {
  const rb = cents > 0 ? await rebaseBefore(db, paidAt) : null;
  if (!rb) return { cents, rate, rescaled: false, legacyRate: null };
  return {
    cents: Math.max(1, Math.floor((cents * rb.legacyRate) / rb.officialRate)),
    rate: rb.officialRate,
    rescaled: true,
    legacyRate: rb.legacyRate,
  };
}

/**
 * THE DINARS A RESCALED REFUND RECORDS: what the same refund showed just
 * before the rebase — its `legacyCents` read at L, plus the remainder its
 * `dinars` carried at the payment's own rate `paidRate` (0108) — never more
 * than those dinars. Equal to `dinars` when the payment was taken at L.
 *
 * Copying the payment's dinars instead overpays whenever the payment was taken
 * at a legacy rate R above today's L (the setting moved after checkout): the
 * wallet gave up floor(c × L / 100) of its reading, and a refund recording all
 * D dinars at U hands back D × (1 − L / R) more — 50,000 paid at 1,450 came
 * back as 50,001 where the same cancel a minute before the rebase gave 48,276.
 * SQL twin: `orderCancelOps` (the cancel refund's dinars).
 */
export function dinarsBeforeRebase(dinars: number, legacyCents: number, paidRate: number, legacyRate: number): number {
  const c = Math.max(0, Math.trunc(legacyCents));
  return Math.min(dinars, Math.floor((c * legacyRate) / 100) + Math.max(0, dinars - Math.floor((c * paidRate) / 100)));
}

/**
 * The rebase's marker when it moved value (L and U both known and different),
 * else null: what a reader comparing pre-rebase legacy cents with post-rebase
 * U cents converts by (`orderCancelRepair`).
 */
export async function walletRebaseMovedValue(
  db: D1Database
): Promise<{ legacyRate: number; officialRate: number; rebasedAt: string } | null> {
  const m = await rebaseMarker(db);
  if (!m || m.legacyRate === null || m.officialRate === null || m.legacyRate === m.officialRate) return null;
  return { legacyRate: m.legacyRate, officialRate: m.officialRate, rebasedAt: m.rebasedAt };
}

/**
 * The rate a refund of DINARS paid at `paidAt` at `rate` converts at: that
 * rate for a payment after the rebase, today's official rate for one before
 * it (its recorded rate counts legacy cents, which the wallet no longer holds).
 */
export async function refundRateAcrossRebase(db: D1Database, rate: number, paidAt: PaidAt): Promise<number> {
  return (await rebaseBefore(db, paidAt)) ? getOfficialUsdRate(db) : rate;
}
