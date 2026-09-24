/**
 * THE OVERLAY STACK — which open layer a key press belongs to.
 *
 * WHAT WAS WRONG. Every open `Overlay` added its own `document` keydown
 * listener and called `stopPropagation()` on Escape. Two listeners on the SAME
 * node do not stop each other, so a dialog opened over a sheet closed BOTH on
 * one Escape: the person asked to back out one step and lost two. A menu
 * (`Anchored`) opened inside a dialog did the same. And nothing kept Tab
 * inside a modal: from the last button of a dialog, Tab walked straight into
 * the page dimmed behind it.
 *
 * WHAT THIS DOES. One listener for the whole app, installed while at least one
 * layer is open. Layers register in the order they open; the LAST one is the
 * top, and only the top hears the key:
 *
 *   ESCAPE goes to the top layer alone. It is ignored when a control inside
 *   already used it (`defaultPrevented` — a combobox closing its own list, a
 *   search field clearing itself) and while an IME is composing, where Escape
 *   cancels the composition rather than the window.
 *
 *   TAB is kept inside the top layer when that layer traps (a modal). The
 *   trap only acts at the edges — Tab from the last control goes to the first,
 *   Shift+Tab from the first (or from the panel itself, which holds initial
 *   focus) goes to the last — and it never pulls focus out of something it does
 *   not own: if focus is in another window entirely (a legacy dialog that is
 *   not on this stack), the key is left alone.
 *
 *   Z-INDEX follows the stack: `layerAbove(floor)` is what a newly opened layer
 *   (or a menu opened inside one) paints at, so a confirmation opened from a
 *   sheet at z=220 does not appear UNDER that sheet.
 *
 * It is bubble-phase on `document`. That is deliberate: a trap that already
 * exists in the app (`adminUsers/useModalFocus`, capture phase) runs first and
 * marks the event handled, and this one then stands back (`defaultPrevented`).
 */

export interface OverlayLayer {
  /** The z-index this layer paints at. */
  z: number;
  /** The element Tab is kept inside, or null for a layer that does not trap. */
  trap: (() => HTMLElement | null) | null;
  /** Escape reached this layer while it was the top one. */
  onEscape: () => void;
}

type Entry = OverlayLayer & { id: number };

const stack: Entry[] = [];
let seq = 0;

/**
 * Everything that can take focus. `[tabindex]` is filtered by `tabIndex >= 0`
 * below rather than in the selector, so an element that is focusable by
 * nature but opted out (`tabIndex={-1}`, the panel itself, a roving-tabindex
 * option) is never a Tab stop.
 */
const FOCUSABLE =
  'a[href],area[href],button:not([disabled]),input:not([disabled]):not([type="hidden"]),' +
  'select:not([disabled]),textarea:not([disabled]),iframe,summary,' +
  '[contenteditable]:not([contenteditable="false"]),[tabindex]';

/** The Tab stops inside `root`, in document order. */
export function tabbables(root: HTMLElement): HTMLElement[] {
  const out: HTMLElement[] = [];
  const nodes = root.querySelectorAll<HTMLElement>(FOCUSABLE);
  const active = typeof document === 'undefined' ? null : document.activeElement;
  for (let i = 0; i < nodes.length; i++) {
    const el = nodes[i];
    if (el.tabIndex < 0) continue;
    // A native radio group is ONE Tab stop: the checked radio, when there is one.
    if (el instanceof HTMLInputElement && el.type === 'radio' && !el.checked && el.name) {
      const checked = root.querySelector(`input[type="radio"][name="${CSS.escape(el.name)}"]:checked`);
      if (checked) continue;
    }
    // Hidden controls (a collapsed section) are in the DOM but not reachable.
    if (el !== active && el.getClientRects().length === 0) continue;
    out.push(el);
  }
  return out;
}

function trapTab(e: KeyboardEvent, panel: HTMLElement): void {
  const active = document.activeElement;
  const inside = !!active && panel.contains(active);
  if (!inside && active && active !== document.body) return;
  const items = tabbables(panel);
  if (items.length === 0) {
    e.preventDefault();
    panel.focus({ preventScroll: true });
    return;
  }
  const first = items[0];
  const last = items[items.length - 1];
  const wrap = e.shiftKey ? !inside || active === first || active === panel : !inside || active === last;
  if (!wrap) return;
  e.preventDefault();
  (e.shiftKey ? last : first).focus({ preventScroll: true });
}

/** The one keydown listener. Exported for tests; the app never calls it. */
export function handleOverlayKey(e: KeyboardEvent): void {
  const top = stack[stack.length - 1];
  if (!top || e.defaultPrevented) return;
  if (e.key === 'Escape') {
    if (e.isComposing) return;
    e.preventDefault();
    e.stopPropagation();
    top.onEscape();
    return;
  }
  if (e.key === 'Tab' && top.trap) {
    const panel = top.trap();
    if (panel) trapTab(e, panel);
  }
}

/** Registers an open layer on top of the stack; call the returned function when it closes. */
export function pushLayer(layer: OverlayLayer): () => void {
  const entry: Entry = { ...layer, id: ++seq };
  stack.push(entry);
  if (stack.length === 1 && typeof document !== 'undefined') document.addEventListener('keydown', handleOverlayKey);
  return () => {
    const i = stack.indexOf(entry);
    if (i >= 0) stack.splice(i, 1);
    if (stack.length === 0 && typeof document !== 'undefined') document.removeEventListener('keydown', handleOverlayKey);
  };
}

/** How many layers are open. */
export function openLayerCount(): number {
  return stack.length;
}

/**
 * THE CONTROL A FINGER JUST PRESSED. A tap does not focus a button in iOS
 * Safari (and not in every Android browser either), so when a window opened
 * by a tap closes, `document.activeElement` was never the button — it was
 * <body> — and a window that "returns focus to its opener" returned it
 * nowhere: the next VoiceOver swipe or Tab started from the top of the page.
 * One passive capture listener remembers the last pressed control, so the
 * window can give focus back to what was actually pressed.
 */
const PRESSABLE =
  'button,a[href],summary,input,select,textarea,[role="button"],[role="tab"],[role="menuitem"],[role="option"],[tabindex]';
let lastPressed: { el: HTMLElement; at: number } | null = null;
if (typeof document !== 'undefined') {
  document.addEventListener(
    'pointerdown',
    (e) => {
      const target = e.target instanceof Element ? e.target.closest<HTMLElement>(PRESSABLE) : null;
      lastPressed = target ? { el: target, at: Date.now() } : null;
    },
    { capture: true, passive: true }
  );
}

/** The control pressed within the last `maxAgeMs`, if it is still in the document. */
export function recentlyPressed(maxAgeMs = 2000): HTMLElement | null {
  if (!lastPressed || Date.now() - lastPressed.at > maxAgeMs || !lastPressed.el.isConnected) return null;
  return lastPressed.el;
}

/**
 * The z-index for something opening NOW: at least `floor`, and above every
 * layer already open, so what opens last is always what is on top.
 */
export function layerAbove(floor: number): number {
  let z = floor;
  for (const layer of stack) z = Math.max(z, layer.z + 1);
  return z;
}
