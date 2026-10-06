/**
 * «الشراء السريع» — the customer's standing choice and the consent behind it
 * (owner brief §5–§6, docs/GIFTS_QUICK_BUY.md D14).
 *
 * Switching Quick Buy on takes two steps the server checks, not the screen:
 *   1. consent, by VERSION, to the Terms, the Privacy Policy and the Quick
 *      Buy Policy, plus the explicit permission to hold and charge the Levo
 *      wallet automatically — recorded through the store's existing
 *      `policy_acceptances` archive (context `quick_buy`);
 *   2. a default delivery address that belongs to the customer.
 * A new version of any of the three documents switches the consent off until
 * it is given again (`needsConsent`), before the next quick purchase.
 */
import { auditStatements } from '../audit';
import { badRequest, conflict, str } from '../http';
import { isPolicyAcceptanceConflict, preparePolicyAcceptance, QUICK_BUY_POLICY_KEYS, requiredPolicies } from '../policyOps';
import type { Env } from '../types';
import { parseJson } from './model';

export interface QuickBuyProfileRow {
  user_id: string;
  enabled: number;
  address_id: string | null;
  terms_version: number | null;
  privacy_version: number | null;
  policy_version: number | null;
  consented_at: string | null;
  wallet_consent_at: string | null;
  consent_json: string;
  created_at: string;
  updated_at: string;
}

export interface QuickBuyVersions {
  terms: number;
  privacy: number;
  quick_buy: number;
}

export function loadProfile(db: D1Database, userId: string): Promise<QuickBuyProfileRow | null> {
  return db.prepare('SELECT * FROM quick_buy_profiles WHERE user_id = ?').bind(userId).first<QuickBuyProfileRow>();
}

/** The versions consent must name today, from the code registry. */
export function currentVersions(): QuickBuyVersions {
  const out: Record<string, number> = {};
  for (const r of requiredPolicies(QUICK_BUY_POLICY_KEYS)) out[r.key] = r.version;
  return { terms: out.terms ?? 0, privacy: out.privacy ?? 0, quick_buy: out.quick_buy ?? 0 };
}

export function needsConsent(p: QuickBuyProfileRow | null): boolean {
  if (!p || !p.consented_at || !p.wallet_consent_at) return true;
  const v = currentVersions();
  return p.terms_version !== v.terms || p.privacy_version !== v.privacy || p.policy_version !== v.quick_buy;
}

export function addressRow(db: D1Database, userId: string, addressId: string | null | undefined): Promise<Record<string, unknown> | null> {
  if (!addressId) return Promise.resolve(null);
  return db.prepare('SELECT * FROM addresses WHERE id = ? AND user_id = ?').bind(addressId, userId).first<Record<string, unknown>>();
}

/** What the customer sees of an address — the fields a courier needs, nothing else. */
export function addressView(row: Record<string, unknown> | null) {
  if (!row) return null;
  const s = (k: string) => (typeof row[k] === 'string' ? (row[k] as string) : '');
  return {
    id: s('id'),
    label: s('label'),
    name: s('name'),
    phone: s('phone'),
    governorate: s('governorate'),
    area: s('area'),
    address: s('address'),
    landmark: s('landmark'),
  };
}

export async function profileView(db: D1Database, userId: string) {
  const p = await loadProfile(db, userId);
  const addr = p?.address_id ? await addressRow(db, userId, p.address_id) : null;
  const needs = needsConsent(p);
  return {
    enabled: p?.enabled === 1,
    /** Enabled, consent current and the address still exists: a quick purchase may start. */
    active: p?.enabled === 1 && !needs && !!addr,
    needs_consent: needs,
    address: addressView(addr),
    /** The saved address was deleted since: Quick Buy asks for a new one. */
    address_missing: !!p?.address_id && !addr,
    consent: p?.consented_at
      ? {
          terms_version: p.terms_version,
          privacy_version: p.privacy_version,
          policy_version: p.policy_version,
          consented_at: p.consented_at,
          wallet_consent_at: p.wallet_consent_at,
        }
      : null,
    required: currentVersions(),
  };
}

const idempotencyKeyOf = (raw: unknown) => str(raw, 'idempotencyKey', { min: 8, max: 80 });

/**
 * Step 1 + step 2 in one transaction: the three acceptances, the wallet
 * consent and the address, or nothing. A replay of the same key changes
 * nothing and answers with the profile as it stands.
 */
export async function activateQuickBuy(env: Env, userId: string, body: Record<string, unknown>, locale: string) {
  const key = idempotencyKeyOf(body.idempotencyKey);
  const replay = await env.DB.prepare('SELECT 1 AS x FROM quick_buy_actions WHERE user_id = ? AND key = ?').bind(userId, key).first();
  if (replay) return profileView(env.DB, userId);

  if (body.walletConsent !== true) {
    throw badRequest(
      'وافق على حجز المبلغ وخصمه من محفظة Levo لتفعيل الشراء السريع / Allow the Levo wallet hold and charge to switch Quick Buy on',
      'QUICK_BUY_WALLET_CONSENT_REQUIRED'
    );
  }
  const addressId = str(body.addressId, 'addressId', { min: 1, max: 60 });
  const addr = await addressRow(env.DB, userId, addressId);
  if (!addr) throw badRequest('اختر عنواناً صحيحاً للشراء السريع / Choose a valid Quick Buy address', 'QUICK_BUY_ADDRESS_INVALID');

  const list = Array.isArray(body.policyAcceptance)
    ? (body.policyAcceptance as Array<{ key?: unknown; version?: unknown }>).slice(0, 10).map((a) => ({
        key: String(a?.key ?? ''),
        version: Number(a?.version),
      }))
    : undefined;
  const prepared = await preparePolicyAcceptance(env, userId, 'quick_buy', list, { locale, keys: QUICK_BUY_POLICY_KEYS });
  const version = (k: string) => prepared.required.find((r) => r.key === k)?.version ?? null;
  const now = new Date().toISOString();
  const audit = await auditStatements(env.DB, userId, 'quick_buy.activate', userId, {
    address_id: addressId,
    terms_version: version('terms'),
    privacy_version: version('privacy'),
    quick_buy_version: version('quick_buy'),
  });
  const stmts: D1PreparedStatement[] = [
    env.DB.prepare(
      `INSERT INTO quick_buy_actions (user_id, key, session_id, kind, request_hash, response_json)
       VALUES (?, ?, NULL, 'activate', '', '{}')`
    ).bind(userId, key),
    ...prepared.statements,
    env.DB.prepare(
      `INSERT INTO quick_buy_profiles
         (user_id, enabled, address_id, terms_version, privacy_version, policy_version, consented_at, wallet_consent_at, consent_json, updated_at)
       VALUES (?1, 1, ?2, ?3, ?4, ?5, ?6, ?6, ?7, ?6)
       ON CONFLICT(user_id) DO UPDATE SET
         enabled = 1, address_id = excluded.address_id, terms_version = excluded.terms_version,
         privacy_version = excluded.privacy_version, policy_version = excluded.policy_version,
         consented_at = excluded.consented_at, wallet_consent_at = excluded.wallet_consent_at,
         consent_json = excluded.consent_json, updated_at = excluded.updated_at`
    ).bind(userId, addressId, version('terms'), version('privacy'), version('quick_buy'), now, JSON.stringify(prepared.acceptanceIds)),
    ...audit.statements,
  ];
  try {
    await env.DB.batch(stmts);
  } catch (e) {
    if (isPolicyAcceptanceConflict(e)) {
      throw badRequest('Policies changed; reload and review them again', 'POLICY_ACCEPTANCE_REQUIRED');
    }
    const msg = e instanceof Error ? e.message : String(e);
    if (/UNIQUE/i.test(msg) && /quick_buy_actions/.test(msg)) return profileView(env.DB, userId);
    throw e;
  }
  return profileView(env.DB, userId);
}

/** «تغيير العنوان الافتراضي» and the switch. A new address applies to the NEXT
 *  session only (§15): an open session keeps the snapshot it started with. */
export async function updateQuickBuyProfile(env: Env, userId: string, body: Record<string, unknown>) {
  idempotencyKeyOf(body.idempotencyKey);
  const p = await loadProfile(env.DB, userId);
  if (!p) throw conflict('فعّل الشراء السريع أولاً / Switch Quick Buy on first', 'QUICK_BUY_NOT_ACTIVE');
  const enabled = typeof body.enabled === 'boolean' ? body.enabled : null;
  const addressId = body.addressId === undefined || body.addressId === null ? null : str(body.addressId, 'addressId', { min: 1, max: 60 });
  if (addressId && !(await addressRow(env.DB, userId, addressId))) {
    throw badRequest('اختر عنواناً صحيحاً للشراء السريع / Choose a valid Quick Buy address', 'QUICK_BUY_ADDRESS_INVALID');
  }
  if (enabled === true && needsConsent(p)) {
    throw conflict('وافق على السياسات المحدّثة لإعادة تفعيل الشراء السريع / Accept the updated policies to switch Quick Buy back on', 'QUICK_BUY_RECONSENT_REQUIRED');
  }
  const audit = await auditStatements(env.DB, userId, 'quick_buy.profile', userId, { enabled, address_id: addressId });
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE quick_buy_profiles
          SET enabled = COALESCE(?2, enabled), address_id = COALESCE(?3, address_id),
              updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE user_id = ?1`
    ).bind(userId, enabled === null ? null : enabled ? 1 : 0, addressId),
    ...audit.statements,
  ]);
  return profileView(env.DB, userId);
}

/** The acceptance rows an activation recorded, keyed by document. */
export function consentIdsOf(p: Pick<QuickBuyProfileRow, 'consent_json'> | null): Record<string, string> {
  return parseJson<Record<string, string>>(p?.consent_json, {});
}
