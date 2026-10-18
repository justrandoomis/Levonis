/**
 * DID THIS BROWSER KEEP THE SESSION? — asked after every sign-in.
 *
 * A sign-in answered 2xx used to be the end of the question: the page
 * published the POST's user, said «signed in» and moved on. But the session
 * lives in a `Secure; HttpOnly` cookie the page cannot see, and a browser that
 * did not store it (plain http, cookies blocked, a private tab, a mail app's
 * viewer) showed the person as signed in for exactly one page — then a guest
 * again, with nothing on screen to say why (sign-in fix, 2026-10-18).
 *
 * So the caller asks `/api/auth/me` once more, fresh, and this decides:
 *
 *   /me answered with a user, the same one the POST named
 *   (or the POST named none)                 → ok, publish /me's user
 *   /me answered with no user, or a
 *   different one                            → not_kept: the cookie did not
 *                                              stick. Publish nothing, say so.
 *   /me did not answer (network, timeout,
 *   5xx, cancelled)                          → ok, publish the POST's user (or
 *                                              keep the current state when the
 *                                              POST named none). A check that
 *                                              FAILED proves nothing, and must
 *                                              never fail a sign-in.
 *
 * `decideSession` is pure; `createSessionAdopter` below runs the request
 * (src/AuthContext.tsx wires it to the API client and the published user).
 */
export type MeCheck<U> = { ok: true; user: U | null } | { ok: false };

export type SessionDecision<U> = { status: 'ok'; publish: U | 'keep' } | { status: 'not_kept' };

export function decideSession<U extends { id: string }>(
  postUser: U | null | undefined,
  me: MeCheck<U>
): SessionDecision<U> {
  if (!me.ok) return { status: 'ok', publish: postUser ?? 'keep' };
  if (!me.user) return { status: 'not_kept' };
  if (postUser && postUser.id !== me.user.id) return { status: 'not_kept' };
  return { status: 'ok', publish: me.user };
}

/** What a sign-in caller learns: 'not_kept' means the server signed the
 *  person in and THIS browser did not keep the session. */
export type SessionAdoption = 'ok' | 'not_kept';

export interface SessionAdopterDeps<U> {
  /** Cancel what the leaving guest still has in flight (bumps the API's
   *  session epoch, which turns those results into cancellations). */
  clear: () => void;
  /** One fresh /me: the signed-in user, or null for a guest. Throws on failure. */
  readMe: () => Promise<U | null>;
  /** Was this failure a cancellation by a session-epoch bump — i.e. the
   *  request was SUPERSEDED, not answered? */
  isSuperseded: (err: unknown) => boolean;
  /** Publish the account the check confirmed. */
  publish: (user: U) => void;
}

/** A /me cancelled this many times in a row by other session changes is
 *  given up on, and only then counts as unanswered. */
export const MAX_SUPERSEDED_READS = 3;

/**
 * ONE ADOPTION AT A TIME (review of the sign-in fix, 2026-10-18).
 *
 * Every adoption cancels the leaving guest's requests first, and that
 * cancellation is an epoch bump that turns EVERY pending GET into ABORTED —
 * including another adoption's own /me. Telegram's wake handler (focus,
 * visibilitychange and pageshow fire together) ran two status polls, two
 * «completed», two adoptions: the second cancelled the first one's /me, the
 * first read that as an unanswered check, said 'ok' with nobody published, and
 * navigated a guest into ProtectedRoute's bounce back to /auth.
 *
 * So: a caller arriving while an adoption is in flight gets THAT adoption's
 * promise (the same sign-in moment, one clear, one /me); and a /me cancelled
 * by an epoch bump is SUPERSEDED — asked again — never read as a check that
 * failed. Only an answer, or a real failure, decides.
 */
export function createSessionAdopter<U extends { id: string }>(
  deps: SessionAdopterDeps<U>
): (postUser?: U | null) => Promise<SessionAdoption> {
  let inFlight: Promise<SessionAdoption> | null = null;
  const run = async (postUser: U | null): Promise<SessionAdoption> => {
    deps.clear();
    let me: MeCheck<U> = { ok: false };
    for (let attempt = 0; attempt < MAX_SUPERSEDED_READS; attempt++) {
      try {
        me = { ok: true, user: await deps.readMe() };
        break;
      } catch (err) {
        if (deps.isSuperseded(err)) continue;
        me = { ok: false };
        break;
      }
    }
    const decision = decideSession(postUser, me);
    if (decision.status === 'not_kept') return 'not_kept';
    if (decision.publish !== 'keep') deps.publish(decision.publish);
    return 'ok';
  };
  return (postUser) => {
    if (inFlight) return inFlight;
    const current = run(postUser ?? null);
    inFlight = current;
    const release = () => {
      if (inFlight === current) inFlight = null;
    };
    current.then(release, release);
    return current;
  };
}

/**
 * WHAT THE PERSON IS TOLD WHEN THE SESSION WAS NOT KEPT — and whether trying
 * again can work.
 *
 * A sign-in into an account that already existed can simply be tried again.
 * A sign-in that CREATED the account (the e-mailed finish link, a code or
 * Telegram sign-up, a password sign-up) spent its token or ticket doing so:
 * a retry meets TOKEN_USED, TICKET_INVALID or «already registered». That case
 * says the account exists, offers no retry, and offers signing in to it —
 * with the address or number already filled in where it is known.
 */
export type NotKeptNext =
  | { message: 'SESSION_NOT_KEPT'; retry: true }
  | { message: 'ACCOUNT_CREATED_NOT_KEPT'; retry: false; signInAs: string };

export function notKeptNext(accountCreated: boolean, identifier?: string | null): NotKeptNext {
  if (!accountCreated) return { message: 'SESSION_NOT_KEPT', retry: true };
  return { message: 'ACCOUNT_CREATED_NOT_KEPT', retry: false, signInAs: (identifier ?? '').trim() };
}
