/**
 * HOW MANY THINGS ARE IN THE CART — one number, shared by every screen.
 *
 * THE DEFECT THIS CLOSES. Adding to the cart produced no visible change
 * anywhere in the app's chrome. The product page wrote a notice into a panel
 * that, on a phone, sits above the description while the button that was
 * pressed is in the fixed bar at the bottom of the screen — so the customer
 * tapped, nothing they could see moved, and the only way to find out whether
 * it had worked was to open the cart. Feedback that the user cannot see is not
 * feedback.
 *
 * WHY A MODULE STORE AND NOT A CONTEXT. A React context would put a fifth
 * provider around the whole tree and re-render every consumer of it on every
 * change; this number is read by two small components. `useSyncExternalStore`
 * subscribes exactly those components and nothing else, so a cart change costs
 * a badge repaint rather than a page repaint. It is also readable and writable
 * from a plain function — the add handler does not need a hook.
 *
 * THE COUNT IS THE SERVER'S. Every writer here passes a number that came back
 * in a cart response; nothing increments optimistically, because a cart that
 * refuses a line (one shipping type per cart, one seller per cart) must not
 * leave a badge claiming an item that was never added.
 */

let count: number | null = null;
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

/** null = not known yet (never fetched, or signed out). */
function snapshot(): number | null {
  return count;
}

/** Record the server's own count. Pass null on sign-out. */
export function setCartCount(next: number | null): void {
  if (count === next) return;
  count = next;
  emit();
}

/** Sum the quantities of a cart response's items. */
export function countCartItems(items: Array<{ qty?: number | null }>): number {
  return items.reduce((n, it) => n + (Number(it.qty) || 0), 0);
}

export const cartCountStore = { subscribe, snapshot };
