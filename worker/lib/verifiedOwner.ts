/**
 * THE VERIFIED OWNER'S USER ID — the one recipient of every owner-only bell
 * (exchange rates, repricing, Pricing V2's below-minimum-profit notice).
 *
 * The admin row holding INITIAL_ADMIN_EMAIL with a non-blank verification
 * stamp, the same predicate `adminScope.ts` uses for cost — never by address
 * alone, and never an admin Telegram topic (assistants read those). Moved out
 * of fx/notify.ts (which re-exports it) so a pricing module can ring the owner
 * without importing the FX layer (tests/pricingCurrencyRoles.test.ts).
 */
import type { Env } from './types';

/** The verified owner's user id, or null (no owner address, or not verified yet). */
export async function verifiedOwnerId(env: Pick<Env, 'DB' | 'INITIAL_ADMIN_EMAIL'>): Promise<string | null> {
  const owner = (env.INITIAL_ADMIN_EMAIL ?? '').trim().toLowerCase();
  if (!owner) return null;
  const row = await env.DB
    .prepare(
      `SELECT id FROM users
        WHERE lower(trim(email)) = ? AND role = 'admin' AND trim(COALESCE(email_verified_at, '')) <> ''
        ORDER BY id LIMIT 1`
    )
    .bind(owner)
    .first<{ id: string }>();
  return row?.id ?? null;
}
