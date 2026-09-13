import { mascot } from './mascot';
export type MascotFeedback = 'auto' | 'silent';

/** Background polling/availability probes are not user-visible operations.
 * Keep this policy in one place rather than sprinkling visual calls in pages.
 */
export function requestFeedbackPolicy(method: string, path: string, preference: MascotFeedback = 'auto') {
  const route = path.split('?')[0];
  const silent = preference === 'silent' || /\/(typing|unread-count|availability|check-username|check-email)$/.test(route)
    || route === '/api/auth/me' || route === '/api/auth/config';
  const mutation = !['GET', 'HEAD'].includes(method);
  const success = mutation && !/\/(quote|calculate|preview|read|open|typing|messages)$/.test(route)
    && !route.startsWith('/api/analytics');
  return { silent, success };
}

export function beginRequestFeedback(method: string, path: string, preference?: MascotFeedback) {
  const policy = requestFeedbackPolicy(method, path, preference);
  if (typeof window === 'undefined' || policy.silent) return { finish() {} };
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
        // Missing fields, stock conflicts and retry limits are recoverable;
        // server/network/auth failures are stronger alerts. No response data
        // or private message is ever copied into the animation controller.
        mascot.trigger([400, 409, 422, 429].includes(error.status ?? 0) ? 'warning' : 'error');
      } else if (policy.success) mascot.trigger('success');
    },
  };
}
