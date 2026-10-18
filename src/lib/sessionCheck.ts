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
 * Pure — src/AuthContext.tsx `adoptSession` does the request.
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
