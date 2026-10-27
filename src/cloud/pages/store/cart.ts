/**
 * THE CART — in this tab's memory, and only ever its owner's.
 *
 * WHY MEMORY. A cart is a purchase being drafted, and a draft left at rest in
 * the browser is read by whoever uses the browser next: the owner's purchase
 * draft did exactly that until DECISIONS row 216 moved it into the tab
 * (tests/leakAudit_client-bundles_purchase_draft_survives_account_change.test.ts).
 * So nothing here touches localStorage or sessionStorage
 * (tests/printCloudUiShell.test.ts refuses either in src/cloud): a reload
 * starts an empty cart, and a placed order is the server's.
 *
 * WHY OWNED. The lines belong to the account that added them. Every read goes
 * through `cartFor(state, user id)` (rules.ts), so a different account — or
 * nobody, after a sign-out — sees an empty cart, and the first write under
 * the new identity drops the old lines for good. StoreRoutes also adopts the
 * identity whenever it changes, so the old lines do not wait for that write.
 *
 * Nobody signed in has no cart: the catalogue's «Add to cart» asks for an
 * account first (src/cloud/auth.tsx `useSignIn`), and the cart's own screen
 * sits behind <RequireSignIn>.
 */
import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react';
import { useCloud } from '../../CloudContext';
import { addToCart, cartFor, removeFromCart, restoreCartLine, setCartQuantity, type AddOutcome, type CartLine, type CartState, type NewCartLine } from './rules';

let state: CartState = { owner: null, lines: [] };
const listeners = new Set<() => void>();

function publish(next: CartState) {
  if (next === state) return;
  state = next;
  for (const l of listeners) l();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const read = () => state;

/** Make `owner` the cart's owner; another identity's lines are dropped. */
export function adoptCartOwner(owner: string | null): void {
  publish(cartFor(state, owner));
}

export interface CartApi {
  lines: readonly CartLine[];
  /** Lines, not units: what the badge counts. */
  count: number;
  add: (line: NewCartLine) => AddOutcome;
  setQuantity: (key: string, quantity: number) => void;
  remove: (keys: readonly string[]) => void;
  restore: (line: CartLine, index: number) => void;
}

const NONE: readonly CartLine[] = [];

export function useCart(): CartApi {
  const { user } = useCloud();
  const owner = user?.id ?? null;
  const snapshot = useSyncExternalStore(subscribe, read, read);
  // Never another identity's lines — not even for the render before the effect below adopts this one.
  const lines = snapshot.owner === owner ? snapshot.lines : NONE;

  useEffect(() => adoptCartOwner(owner), [owner]);

  const add = useCallback(
    (line: NewCartLine) => {
      const result = addToCart(state, owner, line);
      publish(result.state);
      return result.outcome;
    },
    [owner]
  );
  // A change made from a screen of one identity and run after another took over — an «undo» toast
  // pressed after a sign-out, say — finds a cart that is not its own, and changes nothing.
  const setQuantity = useCallback((key: string, quantity: number) => {
    if (state.owner === owner) publish(setCartQuantity(state, owner, key, quantity));
  }, [owner]);
  const remove = useCallback((keys: readonly string[]) => {
    if (state.owner === owner) publish(removeFromCart(state, owner, keys));
  }, [owner]);
  const restore = useCallback((line: CartLine, index: number) => {
    if (state.owner === owner) publish(restoreCartLine(state, owner, line, index));
  }, [owner]);

  return useMemo(() => ({ lines, count: lines.length, add, setQuantity, remove, restore }), [lines, add, setQuantity, remove, restore]);
}
