import { getPolicyDocument, POLICY_KEYS, type PolicyKey } from './policies';
import { POLICY_LANGS, policyDocHash, type PolicyLang } from './policies/types';
import { ensurePolicyCorpus } from './policySync';
import type { Env } from './types';
import { badRequest } from './http';
import { newId } from './crypto';

/**
 * Policy acceptance recording (tables in migration 0003: policy_documents,
 * policy_acceptances; immutability triggers in 0070).
 *
 * The TEXT of every policy now lives in code — worker/lib/policies/ — and
 * `policy_documents` is the archive that worker/lib/policySync.ts mirrors it
 * into. This file is what binds a customer's consent to one exact archived
 * row, so it is the one place that still has to talk to the table.
 *
 * Contract consumed by checkout (worker/routes/orders.ts): the required set is
 * whatever the code registry says, so consent is enforced on every deployment
 * — including one whose database was reset — instead of turning on only once
 * someone remembered to press "publish".
 */

export interface PolicyRef {
  key: string;
  version: number;
}

/** Policy keys whose acceptance is required to place an order. */
export const CHECKOUT_POLICY_KEYS = ['terms', 'privacy'] as const satisfies readonly PolicyKey[];

// The registry is the single list of documents and languages; re-exported here
// so the existing importers (policyPublication.ts, the route, the tests) keep
// one import site while the authorship moved.
export { POLICY_KEYS, POLICY_LANGS, policyDocHash };
export type { PolicyKey, PolicyLang };

/**
 * The checkout consent gate, answered from the code registry.
 *
 * `env` is kept in the signature because every caller holds one and because
 * the archived counterpart of this answer is still asserted inside the order
 * transaction below — see preparePolicyAcceptance.
 */
export async function getRequiredCheckoutPolicies(_env: Env): Promise<PolicyRef[]> {
  return CHECKOUT_POLICY_KEYS.flatMap((key) => {
    const doc = getPolicyDocument(key);
    return doc ? [{ key: doc.key, version: doc.version }] : [];
  });
}

/** Prepare consent in the SAME transaction as the order, never ahead of it.
 * The read-time comparison produces a friendly refusal. The first statement
 * asserts the archived set still matches the registry inside D1's atomic
 * batch, so a row that vanished or drifted between the read and the write
 * aborts the order rather than recording an unverifiable acceptance.
 */
export async function preparePolicyAcceptance(
  env: Env,
  userId: string,
  context: string,
  accepted: Array<{ key: string; version: number }> | undefined,
  options: { locale?: unknown; orderId?: string | null } = {}
): Promise<{ required: PolicyRef[]; statements: D1PreparedStatement[] }> {
  const required = await getRequiredCheckoutPolicies(env);
  const list = Array.isArray(accepted) ? accepted : [];
  const locale: PolicyLang = options.locale === 'en' || options.locale === 'ckb' ? options.locale : 'ar';
  if (required.some((r) => !list.some((a) => a && a.key === r.key && Number(a.version) === r.version))) {
    throw badRequest('Please review and accept the current policies', 'POLICY_ACCEPTANCE_REQUIRED');
  }
  // An acceptance is a foreign key into the archive, so the archive has to
  // hold this version before consent can be recorded against it. On a warm
  // isolate this is free; on a cold or reset database it writes the corpus
  // once. A failure here must NOT be swallowed: recording consent against a
  // row that does not exist is worse than refusing the order.
  await ensurePolicyCorpus(env.DB);
  const docs: Array<PolicyRef & { id: string; hash: string; lang: PolicyLang }> = [];
  for (const r of required) {
    const doc = await env.DB.prepare(
      `SELECT id, hash, lang FROM policy_documents
       WHERE key = ? AND version = ? AND status = 'published' AND lang IN (?, 'ar')
       ORDER BY CASE WHEN lang = ? THEN 0 ELSE 1 END LIMIT 1`
    ).bind(r.key, r.version, locale, locale).first<{ id: string; hash: string; lang: PolicyLang }>();
    if (!doc) throw badRequest('Policies changed; reload and review them again', 'POLICY_ACCEPTANCE_REQUIRED');
    docs.push({ ...r, ...doc });
  }
  const now = new Date().toISOString();
  const changedDocument = docs.map(() => `NOT EXISTS (
    SELECT 1 FROM policy_documents WHERE id = ? AND hash = ? AND status = 'published'
      AND version = (SELECT MAX(version) FROM policy_documents WHERE key = ? AND status = 'published')
  )`).join(' OR ');
  // An invalid NULL user_id deliberately aborts the whole transaction. On a
  // matching snapshot this SELECT inserts zero rows; no sentinel is persisted.
  const statements: D1PreparedStatement[] = [env.DB.prepare(
    `INSERT INTO policy_acceptances (id, user_id, policy_key, version, hash, context, accepted_at)
     SELECT ?, NULL, 'terms', 1, '', '', ?
     WHERE (SELECT COUNT(DISTINCT key) FROM policy_documents
            WHERE status = 'published' AND key IN (${CHECKOUT_POLICY_KEYS.map(() => '?').join(',')})) != ?
       ${changedDocument ? `OR (${changedDocument})` : ''}`
  ).bind(newId('pacguard'), now, ...CHECKOUT_POLICY_KEYS, required.length,
    ...docs.flatMap((d) => [d.id, d.hash, d.key]))];
  for (const d of docs) {
    statements.push(env.DB.prepare(
      `INSERT OR IGNORE INTO policy_acceptances
       (id, user_id, policy_key, version, hash, context, accepted_at, document_id, order_id, locale, requested_locale, event)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(newId('pac'), userId, d.key, d.version, d.hash, context, now, d.id,
      options.orderId ?? null, d.lang, locale, options.orderId ? 'checkout.policy.accepted' : 'policy.accepted'));
  }
  return { required, statements };
}

export function isPolicyAcceptanceConflict(error: unknown): boolean {
  const message = error instanceof Error ? `${error.message} ${String(error.cause ?? '')}` : String(error);
  return /NOT NULL constraint failed:\s*policy_acceptances\.user_id/i.test(message);
}

/** Backward-compatible entry point for non-order acceptance callers. */
export async function verifyAndRecordAcceptance(
  env: Env, userId: string, context: string,
  accepted: Array<{ key: string; version: number }> | undefined,
  options: { locale?: unknown } = {}
): Promise<PolicyRef[]> {
  const prepared = await preparePolicyAcceptance(env, userId, context, accepted, options);
  try { await env.DB.batch(prepared.statements); }
  catch (error) {
    if (isPolicyAcceptanceConflict(error)) throw badRequest('Policies changed; reload and review them again', 'POLICY_ACCEPTANCE_REQUIRED');
    throw error;
  }
  return prepared.required;
}
