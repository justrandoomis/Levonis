/**
 * Consent — the rule that decides whether an identifier may exist here at all
 * (`01-TARGET.md` §9.1, `03-EVENTS.md` §5 rules 2 and 3).
 *
 * Three things this file is careful about:
 *
 *  1. **Hashing is consent-gated, not send-gated.** `hashIdentifiers` returns
 *     nulls for every consent value other than `'ads'`, so an unconsented
 *     contact never becomes a hash, never reaches a delivery payload and never
 *     reaches `ads_consent_snapshots`. The drop happens BEFORE persistence,
 *     which is what "dropped before persistence, not merely recorded
 *     `no_consent`" means.
 *
 *  2. **Ads does not hold contacts.** In production the hashes arrive already
 *     computed, on `UserUpdated`, from Identity — the owner of the contacts —
 *     and this service never sees a raw address. The normalisation and hashing
 *     below are the SAME functions, kept here so the rule is executable and
 *     testable in one place (`test/consent.test.ts`) and so the local rig can
 *     produce a realistic snapshot without inventing a second definition.
 *
 *  3. **Normalisation is part of the hash.** A hash of `" Ali@Example.COM "`
 *     and one of `ali@example.com` are different numbers and would match
 *     nothing on the provider's side, so the normalisation is fixed here and
 *     pinned by a test rather than left to each call site.
 */
import { sha256Hex } from '@levonis/contracts/canonical';
import type { ConsentState } from './types';

export type MarketingConsent = 'none' | 'analytics' | 'ads';

/** Lowercase, trimmed. Nothing else: an address is not ours to rewrite. */
export function normaliseEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

/**
 * E.164 without the `+`: digits only, leading zeros of a national trunk prefix
 * left to the caller (this service never sees a national number — Identity
 * normalises with `libphonenumber-js` before it hashes).
 */
export function normalisePhone(raw: string): string {
  return raw.replace(/[^\d]/g, '').replace(/^0+/, '');
}

export interface RawIdentifiers {
  email?: string | null;
  phone?: string | null;
}

export interface HashedIdentifiers {
  email_hash: string | null;
  phone_hash: string | null;
}

/**
 * SHA-256 of the normalised email / phone — **only** when the consent flag says
 * `'ads'`. Every other value returns nulls without computing anything, so
 * there is no branch in which an unconsented identifier exists even in memory
 * as a hash.
 */
export async function hashIdentifiers(consent: MarketingConsent, raw: RawIdentifiers): Promise<HashedIdentifiers> {
  if (consent !== 'ads') return { email_hash: null, phone_hash: null };
  const email = raw.email ? normaliseEmail(raw.email) : '';
  const phone = raw.phone ? normalisePhone(raw.phone) : '';
  return {
    email_hash: email ? await sha256Hex(email) : null,
    phone_hash: phone ? await sha256Hex(phone) : null,
  };
}

/**
 * The stable (NOT daily-salted) user hash Ads joins its snapshots on.
 *
 * `PurchaseCompleted`, `UserUpdated`, `AddToCart`, `CheckoutStarted` and
 * `ProductViewed` all carry a hash and Ads uses it verbatim.
 * `SubscriptionChanged` (`03-EVENTS.md` §3.16) carries only `user_id`, which is
 * annotated `pii`, so Ads derives the join key from it and NEVER stores the id
 * itself. The definition is fixed here, pinned by `test/consent.test.ts`, and
 * named in `CONTRACT.md` as the value Identity must use for the stable hash —
 * if the two ever disagree the consequence is a `no_consent` delivery, never a
 * leak.
 */
export function stableUserHash(userId: string): Promise<string> {
  return sha256Hex(userId);
}

/**
 * The identifiers a provider payload may carry for this snapshot. Returns
 * nulls for anything but `'ads'` consent — a second, independent gate on top of
 * the one in `hashIdentifiers`, because a snapshot written before a consent
 * withdrawal must not survive it.
 */
export function consentedIdentifiers(snapshot: ConsentState | null | undefined): HashedIdentifiers {
  if (!snapshot || snapshot.consent !== 'ads') return { email_hash: null, phone_hash: null };
  return { email_hash: snapshot.email_hash ?? null, phone_hash: snapshot.phone_hash ?? null };
}
