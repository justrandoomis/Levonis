import type { Env } from './types';

/**
 * Support-code attribution (integrated mandate §3.3) — a support code is
 * NOT a discount: it attributes an order (or specific eligible lines) to a
 * referrer for the filament-gift program, with zero monetary effect for the
 * buyer. Snapshotted at order confirmation; never mutable afterwards.
 *
 * The exported signatures below are FROZEN — checkout (worker/routes/
 * orders.ts) and the auth referral resolver (worker/routes/auth.ts) import
 * them. Only the internals evolve.
 */

export interface SupportRef {
  userId: string;
  username: string;
  displayName: string;
}

/** Longest ref accepted anywhere (username ≤30, legacy code 8, plus slack). */
export const SUPPORT_REF_MAX = 60;

/**
 * Canonical form of a user-typed / URL-carried ref.
 *
 * Pure and unit-tested (tests/supportCode.test.ts). It exists because the
 * same handle reaches us as `@Ammar`, `ammar `, a pasted profile URL or a
 * pasted invite link, and all of those must mean one thing before anything
 * is looked up, stored or compared. Returns '' for anything unusable — an
 * empty ref is simply "no support code", never an error the buyer has to
 * solve (§3.3: using a support code is never mandatory).
 */
export function normalizeSupportRef(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  let s = raw.trim();
  if (!s) return '';
  // A pasted link: take its ?ref= value when present, else its last path
  // segment. Never follows or fetches anything — pure string work.
  if (/^https?:\/\//i.test(s)) {
    try {
      const url = new URL(s);
      const q = url.searchParams.get('ref');
      const seg = url.pathname.split('/').filter(Boolean).pop() ?? '';
      s = (q || seg || '').trim();
    } catch {
      return '';
    }
  }
  s = s.replace(/^@+/, '').trim();
  if (!s || s.length > SUPPORT_REF_MAX) return '';
  // Usernames are [a-z0-9._-] (worker/lib/http.ts username()) and legacy
  // referral codes are 8 hex uppercase; anything with other characters can
  // never match a row, so it is rejected here instead of hitting the DB.
  if (!/^[A-Za-z0-9._-]+$/.test(s)) return '';
  return s;
}

/**
 * Ordered lookup forms for a normalized ref. Usernames are stored lowercase
 * and legacy referral codes uppercase, so trying the lowercase form first
 * makes precedence deterministic: a username always resolves to its CURRENT
 * holder and can never be shadowed by a same-spelling legacy code. This
 * mirrors (and is mirrored by) referrerLookupCandidates in routes/auth.ts.
 */
function refCandidates(clean: string): { username: string; legacyCode: string } {
  return { username: clean.toLowerCase(), legacyCode: clean.toUpperCase() };
}

/**
 * Resolve a support ref (username, legacy referral code) to its owner.
 *
 * Two separate statements rather than one UNION ALL + LIMIT: a compound
 * SELECT has no guaranteed row order without ORDER BY, so the previous form
 * could — on a different query plan — return the legacy-code branch for a
 * ref that is also somebody's username. Precedence must be a property of
 * the code, not of the planner.
 */
export async function resolveSupportRef(env: Env, ref: string): Promise<SupportRef | null> {
  const clean = normalizeSupportRef(ref);
  if (!clean) return null;
  const { username, legacyCode } = refCandidates(clean);

  const byUsername = await env.DB.prepare(
    'SELECT id, username, name FROM users WHERE username = ? LIMIT 1'
  )
    .bind(username)
    .first<{ id: string; username: string | null; name: string }>();
  if (byUsername) {
    return {
      userId: byUsername.id,
      username: byUsername.username || '',
      displayName: byUsername.name || byUsername.username || '',
    };
  }

  const byCode = await env.DB.prepare(
    `SELECT u.id AS id, u.username AS username, u.name AS name
       FROM referral_codes rc JOIN users u ON u.id = rc.user_id
      WHERE rc.code = ? LIMIT 1`
  )
    .bind(legacyCode)
    .first<{ id: string; username: string | null; name: string }>();
  if (!byCode) return null;
  return {
    userId: byCode.id,
    username: byCode.username || '',
    displayName: byCode.name || byCode.username || '',
  };
}

/** The immutable shape stored in orders.support_snapshot (migration 0014). */
export interface SupportSnapshot {
  referrer_user_id: string;
  referrer_username: string;
  ref: string;
}

/**
 * Build the immutable support snapshot stored on the order. Self-support is
 * rejected by returning null (never attribute a buyer to themselves) — and
 * so is an unresolvable ref: an order is never annotated with an
 * attribution that points at nobody.
 */
export async function buildSupportSnapshot(
  env: Env,
  buyerId: string,
  ref: string | null | undefined
): Promise<SupportSnapshot | null> {
  const clean = normalizeSupportRef(ref);
  if (!clean) return null;
  const resolved = await resolveSupportRef(env, clean);
  if (!resolved || resolved.userId === buyerId) return null; // self-support never binds
  return {
    referrer_user_id: resolved.userId,
    referrer_username: resolved.username,
    ref: clean,
  };
}

/**
 * Read back a stored snapshot. Defensive on purpose: rows written before
 * this shape existed, hand-edited JSON or a NULL column must degrade to
 * "no attribution", never to a half-built object that a gift engine could
 * mistake for a real referrer.
 */
export function parseSupportSnapshot(raw: unknown): SupportSnapshot | null {
  if (raw === null || raw === undefined || raw === '') return null;
  let value: unknown = raw;
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!value || typeof value !== 'object') return null;
  const o = value as Record<string, unknown>;
  const referrerId = typeof o.referrer_user_id === 'string' ? o.referrer_user_id.trim() : '';
  if (!referrerId) return null;
  return {
    referrer_user_id: referrerId,
    referrer_username: typeof o.referrer_username === 'string' ? o.referrer_username : '',
    ref: typeof o.ref === 'string' ? o.ref : '',
  };
}

/**
 * The public invite path for a signup invitation (§3.1). Path only — the
 * origin is supplied by whoever renders it (the browser uses
 * window.location.origin; a server-side sender uses the configured
 * production origin), so no environment ever hardcodes the wrong host.
 */
export function inviteRefPath(username: string): string {
  const clean = normalizeSupportRef(username);
  return clean ? `/auth?ref=${encodeURIComponent(clean.toLowerCase())}` : '';
}

/**
 * A product share link carrying the sharer's support ref (§3.3). Takes the
 * REAL product path from the caller — this helper never guesses the app's
 * routing — and preserves any query string already on it.
 */
export function productSupportPath(productPath: string, username: string): string {
  const path = String(productPath || '').trim();
  if (!path.startsWith('/')) return '';
  const clean = normalizeSupportRef(username);
  if (!clean) return path;
  const [base, hash = ''] = path.split('#');
  const sep = base.includes('?') ? '&' : '?';
  return `${base}${sep}ref=${encodeURIComponent(clean.toLowerCase())}${hash ? `#${hash}` : ''}`;
}
