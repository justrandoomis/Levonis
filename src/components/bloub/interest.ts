/**
 * WHICH CONTROLS THE CHARACTER CONSIDERS WORTH NOTICING.
 *
 * The brief asks the mascot to look towards a meaningful button when the
 * pointer arrives on it — and, in the same breath, not to react dramatically
 * to every tiny element. Those two requirements are a definition problem, not
 * an animation problem: the whole difference between a character that seems
 * perceptive and one that seems twitchy is what it decides to ignore.
 *
 * Text matching is not available. The app runs in Arabic, English and Kurdish,
 * so "Add to Cart" is three strings and neither of the other two is in the
 * bundle when the first is. A blanket `button` selector is worse still: this
 * codebase has hundreds, most of them chips, toggles and icon affordances, and
 * a character that turns its head for each one is the annoyance the brief's
 * §27 ends on.
 *
 * So importance is DECLARED. The registry below is the whole policy, and it is
 * short by design:
 *
 *  1. `data-mascot="…"` — the explicit opt-in, and the way new controls join.
 *  2. A handful of `data-testid`s that already exist on this app's three
 *     genuine commerce CTAs. Reusing them means the behaviour works today, on
 *     the buttons that actually matter, without editing three pages to say
 *     something those pages already say.
 *
 * Everything else is invisible to the character. That is not a limitation to
 * be fixed later; it is the feature.
 */

export type InterestKind =
  /** A primary commercial action: add to cart, check out, place the order,
   *  apply a coupon, sign in, upload, submit. Worth turning towards. */
  | 'cta'
  /** A quantity stepper. Noticed, and separately escalated by the controller
   *  as presses accumulate (§11). */
  | 'quantity'
  /** Seen, but never reacted to. An explicit way to silence a control that
   *  would otherwise match. */
  | 'ignore';

/** `data-testid` values that are, in this application, primary CTAs. Kept to
 *  the ones that are unambiguously a commercial decision; a page's own filter
 *  chips and toggles are not in it and must not be added to it. */
const KNOWN_CTA_TESTIDS = new Set([
  'product-cta',
  'cart-checkout',
  'checkout-place-order',
]);

/** The selector the delegated listener climbs to. Interest is a property of a
 *  CONTROL, so a hover on the label inside a button resolves to the button. */
const CONTROL = 'button, a[href], [role="button"], summary, input[type="submit"], [data-mascot]';

export interface InterestTarget {
  kind: Exclude<InterestKind, 'ignore'>;
  element: Element;
  /** The control's centre in viewport CSS pixels, measured when the pointer
   *  arrived. Re-measured on the layout pass, never per frame. */
  x: number;
  y: number;
}

/** What, if anything, this element is to the character. */
export function classify(element: Element | null): InterestKind | null {
  if (!element) return null;
  const declared = element.getAttribute('data-mascot');
  if (declared !== null) {
    if (declared === 'ignore' || declared === 'false') return 'ignore';
    if (declared === 'quantity' || declared === 'qty-inc' || declared === 'qty-dec') return 'quantity';
    // Any other value is an opt-in. Treating an unknown value as a CTA rather
    // than as nothing means a typo makes the character MORE attentive, which
    // is a far better failure than one that silently does nothing.
    return 'cta';
  }
  const testid = element.getAttribute('data-testid');
  if (testid && KNOWN_CTA_TESTIDS.has(testid)) return 'cta';
  return null;
}

/** The nearest control at or above `node`, and what it is. */
export function resolve(node: EventTarget | null): { element: Element; kind: InterestKind } | null {
  if (!node || !(node instanceof Element)) return null;
  const element = node.closest(CONTROL);
  if (!element) return null;
  const kind = classify(element);
  return kind ? { element, kind } : null;
}

/** Centre of an element in viewport pixels. One layout read, at the moment the
 *  pointer arrives — never in a frame loop. */
export function centreOf(element: Element): { x: number; y: number } | null {
  const rect = element.getBoundingClientRect();
  if (rect.width <= 0 && rect.height <= 0) return null;
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}

export interface InterestEvents {
  /** A meaningful control is under the pointer, or has taken keyboard focus. */
  enter(target: InterestTarget): void;
  /** It is no longer. */
  leave(): void;
  /** A meaningful control was ACTIVATED — the click, not the hover. */
  activate(kind: Exclude<InterestKind, 'ignore'>, element: Element): void;
}

/**
 * Watch the document for controls worth noticing.
 *
 * Capture phase and passive throughout, for the same two reasons as the
 * pointer tracker: a component that stops propagation on its own container
 * must not be able to blind the character, and nothing here may ever be in a
 * position to delay a gesture.
 *
 * `focusin` is included deliberately. A keyboard user tabbing to the checkout
 * button has done exactly what §10 describes — arrived at a control, without
 * committing — and there is no reason the character should only be able to
 * notice a mouse.
 */
export function watchInterest(events: InterestEvents): () => void {
  if (typeof document === 'undefined') return () => {};
  let current: Element | null = null;

  const claim = (element: Element, kind: InterestKind) => {
    if (kind === 'ignore') {
      if (current) { current = null; events.leave(); }
      return;
    }
    if (current === element) return;
    const centre = centreOf(element);
    if (!centre) return;
    current = element;
    events.enter({ kind, element, x: centre.x, y: centre.y });
  };

  const release = (element: Element | null) => {
    if (!current || (element && element !== current)) return;
    current = null;
    events.leave();
  };

  const over = (event: Event) => {
    const hit = resolve(event.target);
    if (hit) claim(hit.element, hit.kind);
    // A pointer that moved onto something uninteresting has LEFT the thing it
    // was on. Without this the character keeps staring at a button the user
    // walked away from, which reads as vacancy rather than attention.
    else release(current);
  };

  const out = (event: Event) => {
    const hit = resolve(event.target);
    if (hit) release(hit.element);
  };

  const click = (event: Event) => {
    const hit = resolve(event.target);
    if (hit && hit.kind !== 'ignore') events.activate(hit.kind, hit.element);
  };

  const passive = { passive: true, capture: true } as const;
  document.addEventListener('pointerover', over, passive);
  document.addEventListener('pointerout', out, passive);
  document.addEventListener('focusin', over, passive);
  document.addEventListener('focusout', out, passive);
  document.addEventListener('click', click, passive);

  return () => {
    const opts = { capture: true } as const;
    document.removeEventListener('pointerover', over, opts);
    document.removeEventListener('pointerout', out, opts);
    document.removeEventListener('focusin', over, opts);
    document.removeEventListener('focusout', out, opts);
    document.removeEventListener('click', click, opts);
    current = null;
  };
}
