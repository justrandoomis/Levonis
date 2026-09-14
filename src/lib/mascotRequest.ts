import { mascot } from './mascot';
export type MascotFeedback = 'auto' | 'silent';

/**
 * THE CHARACTER REACTS TO WHAT ACTUALLY HAPPENED, and to nothing else.
 *
 * Every request in the app passes through here, which is the right place for
 * this policy and also the dangerous one: a rule that is slightly wrong is
 * slightly wrong everywhere at once. The brief's §13 and §16 are the standard
 * — the face must answer the APPLICATION RESULT — and three things were
 * failing it.
 *
 * A 401 IS NOT AN ERROR. A signed-out visitor opening the cart gets one by
 * design; so does any screen that asks who is logged in. Painting a concerned
 * face at someone for not being signed in is the character being wrong about
 * the world, which is worse than the character being still.
 *
 * A BACKGROUND POLL IS NOT WORK THE USER IS WAITING FOR. Four screens re-read
 * the cart every sixty seconds. Under the old rule each of those quietly drove
 * the loading face — and a failed poll on a flaky connection painted an error
 * at a user who had asked for nothing. `silent` now covers any GET the caller
 * did not initiate, recognised by the poll interval passing `mascot: 'silent'`
 * plus the route list below.
 *
 * A 200 IS NOT ALWAYS A SUCCESS. `POST /api/cart/coupon-check` answers an
 * INVALID code with `{ ok: 200, valid: false }` — the request succeeded and
 * the thing the user wanted did not happen. Celebrating that is the exact
 * failure §13 names, so the route is excluded from the automatic success and
 * the page tells the character what really happened.
 */
export function requestFeedbackPolicy(method: string, path: string, preference: MascotFeedback = 'auto') {
  const route = path.split('?')[0];
  const silent = preference === 'silent' || /\/(typing|unread-count|availability|check-username|check-email)$/.test(route)
    || route === '/api/auth/me' || route === '/api/auth/config';
  const mutation = !['GET', 'HEAD'].includes(method);
  const success = mutation
    && !/\/(quote|calculate|preview|read|open|typing|messages)$/.test(route)
    // A route that answers "no" with a 200 must not be congratulated. The
    // screen that asked knows the answer and says so itself.
    && !/\/(coupon-check|validate|verify|check)$/.test(route)
    && !route.startsWith('/api/analytics');
  return { silent, success };
}

/**
 * Statuses that mean "you are not signed in", which is a fact about the
 * session rather than a failure of anything the user did.
 */
const NOT_A_FAILURE = new Set([401, 403]);

/**
 * WORK NOBODY ASKED FOR IS NOT WORK THE CHARACTER SHOULD PERFORM.
 *
 * A screen that re-reads itself on a timer issues exactly the same request as
 * the one the user pressed a button for, through the same client, so the
 * client cannot tell them apart — and a poll that drives the loading face
 * every sixty seconds is the repeating loop §8 rules out, arriving from the
 * one direction the animation code cannot see.
 *
 * The refresher raises this flag around the call it makes on its own
 * initiative. Requests STARTED synchronously inside that call are silent;
 * anything the caller kicks off later, from a promise, is a new decision and
 * is treated as one.
 */
let background = 0;

export function duringBackgroundRefresh<T>(run: () => T): T {
  background += 1;
  try {
    return run();
  } finally {
    background -= 1;
  }
}

export function beginRequestFeedback(method: string, path: string, preference?: MascotFeedback) {
  const policy = requestFeedbackPolicy(method, path, preference);
  if (typeof window === 'undefined' || policy.silent || background > 0) return { finish() {} };
  // Fast cache hits need no flickering loading face. This delays only feedback,
  // never the request, its result, the intro readiness, or navigation.
  let release: (() => void) | undefined;
  let done = false;
  const timer = setTimeout(() => { release = mascot.begin('loading'); }, 120);
  return {
    finish(error?: { status?: number; code?: string }) {
      if (done) return;
      done = true; clearTimeout(timer); release?.();
      if (error?.code === 'ABORTED') return;
      if (error) {
        // Not signed in is not a failure: it is the answer. The character
        // stays as it was rather than looking concerned at a visitor.
        if (NOT_A_FAILURE.has(error.status ?? 0)) return;
        // Missing fields, stock conflicts and retry limits are recoverable;
        // server/network failures are stronger alerts. No response data or
        // private message is ever copied into the animation controller.
        mascot.trigger([400, 409, 422, 429].includes(error.status ?? 0) ? 'warning' : 'error');
      } else if (policy.success) mascot.trigger('success');
    },
  };
}
