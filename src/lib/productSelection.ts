/**
 * WHICH ANSWER THE PRODUCT PAGE SENDS — the two rules, as functions.
 *
 * «عند اختيار طلب مسبق وتحديد شحن بحري ثم اختيار النسخة عند الضغط على النسخة
 *  يذهب خيار طريق الشحن … وعند تغيير الخيار يرجع يختفي.»
 *
 * The page asks the buyer two questions — how it is fulfilled, and by which
 * route — and used to throw BOTH answers away every time a version button was
 * tapped. The clearing was standing in for a validity check that did not
 * exist: a new version may genuinely not offer sea freight, and a remembered
 * route the server has closed must never reach the cart door. But «forget
 * everything» is a blunt instrument for «check it is still true», and it
 * charged every correct selection the price of the rare invalid one.
 *
 * Both rules are the same shape: THE PRESS IS REMEMBERED AND FILTERED. The
 * buyer's answer survives a change that still offers it, disappears the moment
 * one does not, and returns by itself when a later selection offers it again.
 *
 * THEY LIVE HERE, OUTSIDE THE COMPONENT, SO THEY CAN BE PROVEN. Pinning the
 * shape of a ternary inside a 3,000-line page only ever confirms that the code
 * is the code — this repository has already shipped a feature that was dead
 * under a green suite for exactly that reason. These are total functions of
 * (press, server facts), so the owner's scenario is a test that runs.
 */

/** One row of the server's per-type verdict. Computed before it reads any
 *  preference, which is what makes it safe to fall back on. */
export type ModeFact = { type: string; usable: boolean };

/** What the server says about the pre-order routes for this combination. */
export type RouteFacts = {
  /** Every route the product declares; `configured` means someone priced it. */
  transports: ReadonlyArray<{ method: string; configured: boolean }>;
  /** Per-route quota, when the product tracks one. Absent = no quota. */
  routes?: ReadonlyArray<{ method: string; usable: boolean }> | null;
};

export type OrderType = '' | 'direct_sale' | 'pre_order';

/**
 * THE ORDER TYPE EVERY REQUEST CARRIES.
 *
 * The buyer's press wins while it still leads somewhere — a press the server
 * has since closed must not keep being SENT, because nothing raises a pricing
 * error for it and the buy button would stay live for an add the door refuses.
 *
 * WITH NO PRESS, THE FALLBACK READS `modes`, NOT `availability.mode`.
 * `saleAvailability` computes `mode` as «the preferredType I was handed, if it
 * is usable, otherwise the default» — and the preferredType the page hands it
 * is derived from this very function. Reading it back was a loop: an untouched
 * answer fed the next request and re-latched itself, and dropping the press on
 * every option tap was the only way to break it. `modes` is computed before
 * the server looks at any preference, so there is no loop to break.
 *
 * The fallback order — direct, then pre-order — is `lineOrderType`'s own, so
 * the page and the cart door resolve an untouched selection to the same type
 * by construction rather than by coincidence.
 */
export function resolveOrderType(press: OrderType, modes: ReadonlyArray<ModeFact>): OrderType {
  const directUsable = modes.some((m) => m.type === 'direct_sale' && m.usable);
  const preUsable = modes.some((m) => m.type === 'pre_order' && m.usable);
  if (press === 'pre_order' && preUsable) return 'pre_order';
  if (press === 'direct_sale' && directUsable) return 'direct_sale';
  if (directUsable) return 'direct_sale';
  if (preUsable) return 'pre_order';
  return '';
}

/**
 * Is this route one the buyer can actually take? Two facts, both the server's:
 * somebody priced it, and its own quota — where it has one — is not full. A
 * route with no quota row is unlimited, which is why `null` is not `false`.
 */
export function routeIsUsable(facts: RouteFacts | null | undefined, method: string): boolean {
  const t = facts?.transports.find((x) => x.method === method);
  if (!t?.configured) return false;
  const cap = facts?.routes?.find((r) => r.method === method) ?? null;
  return cap === null || cap.usable;
}

/**
 * THE TRANSPORT EVERY REQUEST CARRIES — the buyer's route, kept across a
 * version change and honoured only while this combination still offers it.
 *
 * Empty for anything that is not a pre-order, which is why the fulfilment
 * cards no longer need to forget the route to stay correct: a buyer who looks
 * at the direct price and goes back to «طلب مسبق» finds their sea freight
 * still chosen, and nothing direct could ever have carried a transport.
 */
export function resolveTransport(
  press: string,
  orderType: OrderType,
  facts: RouteFacts | null | undefined
): string {
  if (orderType !== 'pre_order' || !press) return '';
  return routeIsUsable(facts, press) ? press : '';
}
