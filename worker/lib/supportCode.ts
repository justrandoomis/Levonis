import type { Env } from './types';

/**
 * Support-code attribution (integrated mandate §3.3) — a support code is
 * NOT a discount: it attributes an order (or specific eligible lines) to a
 * referrer for the filament-gift program, with zero monetary effect for the
 * buyer. Snapshotted at order confirmation; never mutable afterwards.
 *
 * Contract stub — the referral slice replaces the internals; the exported
 * signatures are frozen because checkout imports them.
 */

export interface SupportRef {
  userId: string;
  username: string;
  displayName: string;
}

/** Resolve a support ref (username, legacy referral code) to its owner. */
export async function resolveSupportRef(env: Env, ref: string): Promise<SupportRef | null> {
  const clean = String(ref || '').trim();
  if (!clean || clean.length > 60) return null;
  const row = await env.DB.prepare(
    `SELECT u.id, u.username, u.name FROM users u
      WHERE u.username = ?1
      UNION ALL
      SELECT u.id, u.username, u.name FROM referral_codes rc JOIN users u ON u.id = rc.user_id
      WHERE rc.code = ?1
      LIMIT 1`
  )
    .bind(clean)
    .first<{ id: string; username: string | null; name: string }>();
  if (!row) return null;
  return { userId: row.id, username: row.username || '', displayName: row.name || row.username || '' };
}

/**
 * Build the immutable support snapshot stored on the order. Self-support is
 * rejected by returning null (never attribute a buyer to themselves).
 */
export async function buildSupportSnapshot(
  env: Env,
  buyerId: string,
  ref: string | null | undefined
): Promise<{ referrer_user_id: string; referrer_username: string; ref: string } | null> {
  if (!ref) return null;
  const resolved = await resolveSupportRef(env, ref);
  if (!resolved || resolved.userId === buyerId) return null;
  return { referrer_user_id: resolved.userId, referrer_username: resolved.username, ref: String(ref).trim() };
}
