/**
 * THE EMAIL VERIFICATION STAMP — ONE MEANING, AND WHAT ITS FIRST PROOF ENDS.
 *
 * `users.email_verified_at` is the proof that the account holds its mailbox.
 * The rules live here so that no reader and no writer can disagree with the
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
 *   2. THE FIRST PROOF OF THE OWNER'S ADDRESS ENDS EVERY OTHER WAY INTO THE
 *      ROW (DECISIONS row 185 amendment, review finding C1 and its review).
 *      The stamp on the INITIAL_ADMIN_EMAIL admin row is what opens cost, and
 *      the session loader reads it on every request — so whoever could get
 *      into that row BEFORE anyone proved the mailbox would see cost the
 *      moment the proof lands. That can be whoever registered the address
 *      while it was free (critique A10): the real owner proves the mailbox,
 *      and the squatter inherits cost — through a session opened earlier, or
 *      simply by signing in again with the password, the Google account, the
 *      Telegram link or the phone the squatter put on the row. Ending only
 *      the sessions did not stop that: the next sign-in with any of those saw
 *      cost (the review's probe).
 *
 *      So the first stamp of that row does, in the SAME batch, before the
 *      stamp:
 *        - deletes the row's sessions, keeping only the session doing the
 *          stamping;
 *        - clears the password, the phone (`phone_e164`: WhatsApp code sign-in
 *          and phone + password resolve through it) and the Google account;
 *        - revokes the row's Telegram link (Telegram sign-in);
 *        - spends every outstanding password-reset and verification link
 *          (a reset link mailed to the address the row held before an email
 *          change would otherwise set a new password).
 *      What is left is the proof: the mailbox (a code to this address, the
 *      forgot-password link), Google on this same address (it links again at
 *      its next sign-in, the row being proven by then) and the session the
 *      proof keeps or opens. The real owner pays for this once — their own
 *      password and Telegram link go too — and is told so on both sides of the
 *      proof: beforehand by rule 3, afterwards by `owner_first_proof` in the
 *      answer of the route that proved. The alternative, recording how each
 *      session was opened, is a migration and a cost rule that reads sign-in
 *      methods; this needs neither.
 *
 *      Every write that adds a way into a row, and every session a sign-in
 *      opens after checking a credential, re-reads in its own statement what
 *      it was allowed on — the request's session still live, the password or
 *      Google account or Telegram link still on the row
 *      (`createSession`'s `stillHolds` and `liveSessionCondition`,
 *      worker/lib/session.ts). A request that passed its check before the
 *      purge and wrote after it would otherwise hand the row back.
 *
 *   3. THAT FIRST PROOF IS MADE ONLY ONCE THE PERSON ACCEPTED WHAT IT ENDS —
 *      AND THE SERVER, NOT THE PAGE, DECIDES THAT. Two routes can make it:
 *        - the emailed link (plain, or an email change onto the owner's
 *          address), confirmed for that address only from the account's own
 *          session (VERIFY_SIGN_IN_REQUIRED);
 *        - a sign-in code sent to that address, which proves the mailbox and
 *          opens its session after the purge, in the same request — so the
 *          owner never holds a session a squatter could end before the proof.
 *      Each makes the proof only when the request carries
 *      `accept_owner_first_proof: true`. Without it, the route answers 409
 *      OWNER_FIRST_PROOF_REQUIRED (what the proof ends, in ar, en and ckb),
 *      changes nothing, and leaves the link or the code unspent; the page
 *      shows the sentence with a confirm and asks again. That covers every row
 *      that holds the address, whatever its role, and a page that has not
 *      loaded the session yet.
 *
 *      A Google sign-in and a Google link prove the mailbox too, but nothing
 *      asks before them, so they NEVER stamp the owner's address while it is
 *      unproven: they sign in or link exactly as for any account and leave the
 *      row unproven (the card is still shown, cost stays shut). Every other
 *      address, and an owner row already proven, is stamped by them (and by a
 *      code) as before, through `signInStamp`, whose own WHERE refuses the
 *      unproven owner row in the same statement; they run no purge, because on
 *      every row that statement can stamp, the purge's guard is false.
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

/**
 * The stamp a sign-in writes when it proves the mailbox — a code sent to the
 * address, a Google sign-in, a Google link (rule 3 above): `STAMP_ONCE` on
 * the row `userId` while it still holds exactly `address`, EXCEPT when the
 * row is the owner's address (the `isOwner` rule: trimmed, lower-cased
 * INITIAL_ADMIN_EMAIL, never when that is blank) with no real stamp yet. That
 * row's first proof ends every other way into it, and it is made only once the
 * person accepted that (a code with `accept_owner_first_proof`, through
 * `runStamp`), so this statement leaves it unproven and the sign-in goes on as
 * for any account. The refusal is in the statement's own WHERE, read in the
 * same write, so no change to the row between a read and this stamp can slip
 * a first proof through. No purge goes with it: every row it can stamp is
 * either not the owner's address or already proven, where the purge's guard
 * is false.
 */
export function signInStamp(db: D1Database, env: Env, userId: string, address: string): D1PreparedStatement {
  const owner = (env.INITIAL_ADMIN_EMAIL ?? '').trim().toLowerCase();
  return db
    .prepare(
      `UPDATE users SET email_verified_at = ${STAMP_ONCE}
        WHERE id = ? AND email = ?
          AND NOT (? <> '' AND lower(trim(email)) = ?
                   AND (email_verified_at IS NULL OR trim(email_verified_at) = ''))`
    )
    .bind(new Date().toISOString(), userId, address, owner, owner);
}

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
   * The session doing the stamping, which is kept. null when the proving
   * request carries no session of this account (a code sign-in opens its own
   * only after the proof): every session the row has predates the proof.
   */
  keepSessionId: string | null;
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
 * but the proof reports nothing ended.
 *
 * Every statement carries the same guard, read before the stamp:
 *   'stamp' fires only while the row still holds exactly `address`, that
 *           address is the owner's, and it carries no real stamp yet;
 *   'move'  fires unless the row already IS the owner's address, stamped —
 *           moving onto the address makes it proven for the first time.
 * None of the statements changes a column the guard reads, so all of them
 * see the same answer.
 *
 * Session ids are SHA-256 hex, never '', so a missing keep id keeps nothing.
 */
export function ownerFirstProofPurge(db: D1Database, env: Env, t: StampTarget): D1PreparedStatement[] {
  if (!isOwner(env, { email: t.address })) return [];
  const owner = (env.INITIAL_ADMIN_EMAIL ?? '').trim().toLowerCase();
  const keep = t.keepSessionId ?? '';
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
  // not match the statement); `extra` is the one value after them (the kept
  // session).
  const g = t.kind === 'stamp' ? [t.userId, owner, t.address] : [t.userId, owner];
  const extra = `?${g.length + 1}`;
  return [
    db.prepare(`DELETE FROM sessions WHERE user_id = ?1 AND id <> ${extra} AND ${guard}`).bind(...g, keep),
    db
      .prepare(
        `UPDATE users
            SET password_hash = NULL,
                phone_e164 = NULL,
                google_sub = NULL,
                updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
          WHERE id = ?1
            AND (password_hash IS NOT NULL OR phone_e164 IS NOT NULL OR google_sub IS NOT NULL)
            AND ${guard}`
      )
      .bind(...g),
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
 * a password, a phone, a Google account, a Telegram link or a reset link).
 * The caller audits it and tells the person. Called for the owner's address
 * only once the person accepted what the proof ends (rule 3 above: the link,
 * or a code); every other sign-in stamps with `signInStamp`.
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
