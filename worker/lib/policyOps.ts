import type { Env } from './types';
import { badRequest } from './http';
import { newId } from './crypto';

/**
 * Versioned policy documents + acceptance recording (tables in migration
 * 0003: policy_documents, policy_acceptances).
 *
 * Contract consumed by checkout (worker/routes/orders.ts): a policy key
 * gates checkout only once a PUBLISHED version of it exists — drafts never
 * block orders, so consent enforcement turns on exactly when the owner
 * publishes the documents.
 */

export interface PolicyRef {
  key: string;
  version: number;
}

/** Policy keys whose acceptance is required to place an order. */
export const CHECKOUT_POLICY_KEYS = ['terms', 'privacy'] as const;

export async function getRequiredCheckoutPolicies(env: Env): Promise<PolicyRef[]> {
  const rows = await env.DB.prepare(
    `SELECT key, MAX(version) AS version FROM policy_documents
     WHERE status = 'published' AND key IN ('terms','privacy')
     GROUP BY key`
  ).all<{ key: string; version: number }>();
  return (rows.results || []).map((r) => ({ key: r.key, version: Number(r.version) }));
}

/**
 * Verify that the client-supplied acceptance list covers every required
 * checkout policy at its current published version, then persist the
 * acceptance rows (idempotent via the table's UNIQUE constraint).
 * Throws 400 POLICY_ACCEPTANCE_REQUIRED when anything is missing/stale.
 */
export async function verifyAndRecordAcceptance(
  env: Env,
  userId: string,
  context: string,
  accepted: Array<{ key: string; version: number }> | undefined
): Promise<PolicyRef[]> {
  const required = await getRequiredCheckoutPolicies(env);
  if (required.length === 0) return [];
  const list = Array.isArray(accepted) ? accepted : [];
  const missing = required.filter(
    (r) => !list.some((a) => a && a.key === r.key && Number(a.version) === r.version)
  );
  if (missing.length > 0) {
    throw badRequest(
      'Please review and accept the current policies',
      'POLICY_ACCEPTANCE_REQUIRED'
    );
  }
  const now = new Date().toISOString();
  for (const r of required) {
    const doc = await env.DB.prepare(
      `SELECT hash FROM policy_documents WHERE key = ? AND version = ? AND status = 'published'
       ORDER BY CASE lang WHEN 'ar' THEN 0 ELSE 1 END LIMIT 1`
    )
      .bind(r.key, r.version)
      .first<{ hash: string }>();
    await env.DB.prepare(
      `INSERT OR IGNORE INTO policy_acceptances (id, user_id, policy_key, version, hash, context, accepted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(newId('pac'), userId, r.key, r.version, doc?.hash || '', context, now)
      .run();
  }
  return required;
}
