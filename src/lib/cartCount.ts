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

/**
 * PUBLISH THE COUNT WHERE THE CART'S ANSWER ARRIVES, not at each call site.
 *
 * `setCartCount` had exactly THREE callers in the whole app — the store
 * itself, the bottom bar's one-shot fetch, and the product page's add. Ten
 * paths MUTATE the cart: add, quantity up and down, remove, variant change,
 * warranty change, the merchant cart's own quantity and remove, a bundle add,
 * a reorder, and the checkout that empties it. One of the ten maintained the
 * badge, and it was the one that only ever makes the number go UP.
 *
 * So deleting the last line left a 1 over an empty cart — the owner's report —
 * and it never healed, because the bottom bar's fetch is guarded on
 * `snapshot() !== null` and its effect does not depend on the route. Once the
 * store holds any number it is never fetched again for the whole session, and
 * the cart page (which owns its own `items` state and never imports this
 * module) is the screen you are standing on while you delete.
 *
 * Every one of those ten receives the server's freshly re-read cart through
 * one return in `src/lib/api.ts`. Deriving the badge there makes it a function
 * of the server's answer rather than of a caller's memory, and a new cart
 * mutation cannot forget to update it — there is nothing to remember.
 *
 * Deliberately narrow: only a `/api/cart` path, and only a response that
 * actually carries an `items` array. A DELETE that answers `{success:true}`
 * with no body leaves the count alone rather than zeroing a cart that still
 * has lines in it.
 */
export function noteCartResponse(path: string, data: unknown): void {
  if (!path.startsWith('/api/cart')) return;
  const items = (data as { items?: unknown } | null)?.items;
  if (!Array.isArray(items)) return;
  setCartCount(countCartItems(items as Array<{ qty?: number | null }>));
}

export const cartCountStore = { subscribe, snapshot };
