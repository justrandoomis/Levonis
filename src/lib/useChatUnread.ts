import { useSyncExternalStore } from 'react';

/**
 * THE UNREAD MESSAGES, ONE READ A PAGE (community UI plan C1). The chats list
 * carries an authoritative unread count per conversation (GET /api/chats);
 * the bottom bar sums it for its badge, once per page, and publishes the sum
 * on the root element (`data-chat-unread`, src/components/BottomNav.tsx).
 * The community top bar shows the same number from here, so the page asks
 * the server once, never twice. Before the bottom bar has answered (or for a
 * guest) the count is 0, and the badge is simply absent.
 *
 * The read stays in the bottom bar, which is in the entry: a module of its
 * own there renamed the minified entry and cost 84 B gzip, against the 28 B
 * the storefront budget had left (tests/bundleBudget.test.ts). This hook is
 * in the community chunk only.
 */
const ATTR = 'data-chat-unread';

function subscribe(onChange: () => void): () => void {
  const watch = new MutationObserver(onChange);
  watch.observe(document.documentElement, { attributes: true, attributeFilter: [ATTR] });
  return () => watch.disconnect();
}

const snapshot = () => Math.max(0, Math.trunc(Number(document.documentElement.getAttribute(ATTR)) || 0));

export function useChatUnread(): number {
  return useSyncExternalStore(subscribe, snapshot, () => 0);
}
