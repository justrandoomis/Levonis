/**
 * THE EMAIL VERIFICATION STAMP — ONE MEANING, AND WHAT ITS FIRST PROOF ENDS.
 *
 * `users.email_verified_at` is the proof that the account holds its mailbox.
 * Two rules live here so that no reader and no writer can disagree with the
 * cost rule (`hasVerifiedAddress`, worker/lib/adminScope.ts):
 *
 *   1. ONE MEANING OF "VERIFIED". Only a non-blank string is a stamp: NULL, ''
 *      and '   ' are none. A truthiness test (`!!row.email_verified_at`) reads
 *      '   ' as verified, so a blank left by a manual or imported edit would
 *      be "verified" to the invoice mailer and "unverified" to the cost rule —
 *      two answers to one question. Every reader calls `isStamped`; every
 *      writer stamps with `STAMP_ONCE`, which replaces a blank like a NULL.
 *      tests/emailStamp.test.ts walks worker/ and fails on a truthiness read.
 *
 *   2. THE FIRST PROOF OF THE OWNER'S ADDRESS ENDS EVERY WAY INTO THE ROW
 *      OTHER THAN THE PROOF ITSELF (DECISIONS row 185 amendment, review finding
 *      C1 and its review). The stamp on the INITIAL_ADMIN_EMAIL admin row is
 *      what opens cost, and the session loader reads it on every request — so
 *      whoever could get into that row BEFORE anyone proved the mailbox would
 *      see cost the moment the proof lands. That can be whoever registered the
 *      address while it was free (critique A10): the real owner signs in by
 *      code, the code proves the mailbox and stamps the row, and the squatter
 *      inherits cost — through a session opened earlier, or simply by signing
 *      in again with the password, the Google account, the Telegram link or the
 *      phone the squatter put on the row. Ending only the sessions did not stop
 *      that: the next sign-in with any of those saw cost (the review's probe).
 *
 *      So whichever path FIRST stamps that row — a code sign-in, the emailed
 *      link (plain or an email change), a Google sign-in or a Google link —
 *      does, in the SAME batch, before the stamp:
 *        - deletes the row's sessions, keeping only the session doing the
 *          stamping (none, when that request opens its session afterwards);
 *        - clears the password, the phone (`phone_e164`: WhatsApp code sign-in
 *          and phone + password resolve through it) and the Google account,
 *          unless that Google account IS the proof;
 *        - revokes the row's Telegram link (Telegram sign-in);
 *        - spends every outstanding password-reset and verification link
 *          (a reset link mailed to the address the row held before an email
 *          change would otherwise set a new password).
 *      What is left is the proof: the mailbox (a code to this address, the
 *      forgot-password link) and, when Google proved it, that Google account.
 *      The real owner pays for this once — their own password and Telegram
 *      link go too — and is told so on both sides of the proof: the card that
 *      sends the link says it beforehand (OWNER_EMAIL_UNVERIFIED), and every
 *      route that proves returns `owner_first_proof` for the page to say it
 *      afterwards. The alternative, recording how each session was opened, is a
 *      migration and a cost rule that reads sign-in methods; this needs neither.
 *
 * The purge is a set of statements, not a function call after the fact: each
 * one's own WHERE reads the row's state INSIDE the batch, before the stamp
 * beside them, so they fire exactly when this batch is the first proof and
 * never on a row that was already proven (a second sign-in by code is not a
 * reason to sign the owner out everywhere or take a password away). D1 runs a
 * batch as one transaction, so a stamp that fails (UNIQUE on an email change)
 * takes the purge back with it.
 */
import type { Env } from './types';
import { isOwner } from './adminScope';

/** A real verification stamp: a non-blank string. NULL, '' and '   ' are none. */
export function isStamped(v: unknown): v is string {
  return typeof v === 'string' && v.trim() !== '';
}

/** First real stamp wins; a blank one is replaced like a NULL. Binds one `?` (the stamp). */
export const STAMP_ONCE = "COALESCE(NULLIF(trim(email_verified_at), ''), ?)";

/** What a stamping statement is about to do to one account. */
export interface StampTarget {
  userId: string;
  /**
   * 'stamp': the row keeps its address and gains a stamp; `address` is the
   * address the stamp is guarded by (the row's own). 'move': the row is moved
   * onto `address` and stamped in one statement (an email change).
   */
  kind: 'stamp' | 'move';
  address: string;
  /**
   * The session doing the stamping, which is kept. null when the stamping
   * request opens its session only afterwards (a code or Google sign-in): every
   * session that exists at the moment of the proof predates it.
   */
  keepSessionId: string | null;
  /**
   * The Google account doing the stamping (a Google sign-in or link), which
   * keeps its place on the row. null for every other proof: a Google account
   * already on the row is one more way in that predates the proof.
   */
  keepGoogleSub?: string | null;
}

/** What a first proof of the owner's address ended, or null when this stamp was not one. */
export interface OwnerFirstProof {
  sessionsEnded: number;
}

/**
 * The statements that end every other way into the row when this stamp is the
 * FIRST proof of the owner's address — [] whenever it cannot be: the address
 * is not INITIAL_ADMIN_EMAIL (or that is blank). Put them in the same batch
 * as, and BEFORE, the stamping statement, in this order: the sessions, the
 * row's credentials, the Telegram link, the reset links, the verification
 * links. Each one's `changes` counts what it ended — the credentials statement
 * matches the row only when it holds one to clear, so a row that had nothing
 * but the proof (an account Google just created) reports nothing ended.
 *
 * Every statement carries the same guard, read before the stamp:
 *   'stamp' fires only while the row still holds exactly `address`, that
 *           address is the owner's, and it carries no real stamp yet;
 *   'move'  fires unless the row already IS the owner's address, stamped —
 *           moving onto the address makes it proven for the first time.
 * None of the statements changes a column the guard reads, so all of them
 * see the same answer.
 *
 * Session ids are SHA-256 hex, never '', so a missing keep id keeps nothing; a
 * missing Google keep is NULL, and `google_sub = NULL` is never true.
 */
export function ownerFirstProofPurge(db: D1Database, env: Env, t: StampTarget): D1PreparedStatement[] {
  if (!isOwner(env, { email: t.address })) return [];
  const owner = (env.INITIAL_ADMIN_EMAIL ?? '').trim().toLowerCase();
  const keep = t.keepSessionId ?? '';
  const keepSub = t.keepGoogleSub ?? null;
  // ?1 the row, ?2 the owner address (lower-cased), ?3 the row's address ('stamp' only).
  const guard =
    t.kind === 'stamp'
      ? `EXISTS (SELECT 1 FROM users u
                  WHERE u.id = ?1 AND u.email = ?3 AND lower(trim(u.email)) = ?2
                    AND (u.email_verified_at IS NULL OR trim(u.email_verified_at) = ''))`
      : `EXISTS (SELECT 1 FROM users u
                  WHERE u.id = ?1
                    AND NOT (lower(trim(u.email)) = ?2
                             AND u.email_verified_at IS NOT NULL AND trim(u.email_verified_at) <> ''))`;
  // Every statement binds the guard's parameters first, in the same order, and
  // exactly as many values as it names (D1 refuses a binding count that does
  // not match the statement); `extra` is the one value after them.
  const g = t.kind === 'stamp' ? [t.userId, owner, t.address] : [t.userId, owner];
  const extra = `?${g.length + 1}`;
  return [
    db.prepare(`DELETE FROM sessions WHERE user_id = ?1 AND id <> ${extra} AND ${guard}`).bind(...g, keep),
    db
      .prepare(
        `UPDATE users
            SET password_hash = NULL,
                phone_e164 = NULL,
                google_sub = CASE WHEN google_sub = ${extra} THEN google_sub ELSE NULL END,
                updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
          WHERE id = ?1
            AND (password_hash IS NOT NULL OR phone_e164 IS NOT NULL
                 OR (google_sub IS NOT NULL AND google_sub IS NOT ${extra}))
            AND ${guard}`
      )
      .bind(...g, keepSub),
    db
      .prepare(
        `UPDATE telegram_links SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
          WHERE user_id = ?1 AND revoked_at IS NULL AND ${guard}`
      )
      .bind(...g),
    db.prepare(`UPDATE password_reset_tokens SET used = 1 WHERE user_id = ?1 AND used = 0 AND ${guard}`).bind(...g),
    db.prepare(`UPDATE email_verification_tokens SET used = 1 WHERE user_id = ?1 AND used = 0 AND ${guard}`).bind(...g),
  ];
}

/**
 * Runs `stamp` — with the owner purge before it, in one batch, when this can
 * be the owner's first proof — and says what a first proof ended: null when no
 * purge fired, or when it fired on a row that had no other way in (a session,
 * a password, a phone, another Google account, a Telegram link or a reset
 * link). The caller audits it and tells the person.
 */
export async function runStamp(
  db: D1Database,
  env: Env,
  target: StampTarget,
  stamp: D1PreparedStatement
): Promise<OwnerFirstProof | null> {
  const purge = ownerFirstProofPurge(db, env, target);
  if (purge.length === 0) {
    await stamp.run();
    return null;
  }
  const results = await db.batch([...purge, stamp]);
  const changed = (i: number) => Number(results[i]?.meta?.changes ?? 0);
  const sessionsEnded = changed(0);
  // Sessions, credentials, Telegram link, reset links. Spent verification links
  // are housekeeping, not a way in, and do not by themselves make a report.
  if (sessionsEnded + changed(1) + changed(2) + changed(3) === 0) return null;
  return { sessionsEnded };
}
