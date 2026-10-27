/**
 * THE SCOPE, CARRIED INTO THE PORTALS (community UI plan B1, tokens.md §4.4).
 *
 * A window, a menu and the toast stack are portalled into <body>, outside the
 * community root, so on their own they paint in the storefront palette. The
 * house primitives (src/components/ui/Overlay.tsx, src/components/ui/Toast.tsx)
 * know nothing of the scope: they ride in every storefront visit, and a seam
 * there (a React context read by Overlay, a stamp kept in the toast store)
 * cost every store page and the first toast of every page about 4 KB, and the
 * community pages 38 KB (B1 review, round 4). So the scope does the work here,
 * in community code only, from the DOM:
 *
 *   - once this module has loaded it watches the children of <body>;
 *   - a window or a menu (`[data-overlay]`, `[data-anchored]`) that appears
 *     after a press, a key or a click inside a scope root, or inside a portal
 *     the scope already stamped (a confirmation over a community sheet), wears
 *     the pair of that root (`data-surface`, `data-theme`); one opened from the
 *     shell (the header cart, the account menu) keeps the house palette; one
 *     that opens by itself (no press since the scope arrived) belongs to the
 *     page on screen;
 *   - the toast stack (`[data-toaster]`) wears the newest scope while any
 *     scope is on screen, and loses the stamp with the last one;
 *   - the theme is read from the `data-theme` attribute of the root, so a
 *     theme switch re-stamps every portal of that root in the same frame.
 *
 * The observer reports after the commit that inserted a portal and before the
 * next paint, so a window never shows one frame in the wrong palette, and a
 * page that opens a sheet in its first render finds its root registered by
 * then. Only attributes this module wrote are ever removed: the house
 * components render neither of the two.
 */

const PORTAL = '[data-overlay], [data-anchored]';
const TOASTER = '[data-toaster]';
const PAIR = ['data-surface', 'data-theme'] as const;

/** The scope roots on screen, oldest first. */
let roots: HTMLElement[] = [];
/** Which root stamped a portal (a child of <body>). */
const owner = new WeakMap<Element, HTMLElement>();
/**
 * Where the last press, key or click landed: a scope root (inside it or inside
 * one of its portals), null (the shell), or undefined (none since the newest
 * scope arrived: the press that led to it is spent).
 */
let intent: HTMLElement | null | undefined;
let watcher: MutationObserver | null = null;

const newest = (): HTMLElement | null => roots[roots.length - 1] ?? null;

/** The scope a node belongs to: the root holding it, or the root that stamped its portal. */
function scopeOf(node: Node | null): HTMLElement | null {
  if (!node) return null;
  const inside = roots.find((root) => root.contains(node));
  if (inside) return inside;
  let top: Node | null = node;
  while (top && top.parentNode !== document.body) top = top.parentNode;
  const via = top instanceof Element ? owner.get(top) : undefined;
  return via && roots.includes(via) ? via : null;
}

function stamp(el: Element, root: HTMLElement | null): void {
  if (root) {
    owner.set(el, root);
    for (const name of PAIR) {
      const value = root.getAttribute(name);
      if (value !== null && el.getAttribute(name) !== value) el.setAttribute(name, value);
    }
  } else if (owner.has(el)) {
    owner.delete(el);
    for (const name of PAIR) el.removeAttribute(name);
  }
}

/** Re-stamp the toast stack and every portal a root owns (a theme switch, a root leaving). */
function refresh(): void {
  for (const el of Array.from(document.body.children)) {
    if (el.matches(TOASTER)) stamp(el, newest());
    else {
      const root = owner.get(el);
      if (root) stamp(el, roots.includes(root) ? root : null);
    }
  }
}

function onRecords(records: MutationRecord[]): void {
  if (roots.length === 0) return;
  let themed = false;
  for (const record of records) {
    if (record.type === 'attributes') themed = true;
    for (const node of Array.from(record.addedNodes)) {
      if (!(node instanceof Element)) continue;
      if (node.matches(TOASTER)) stamp(node, newest());
      else if (node.matches(PORTAL)) stamp(node, intent === undefined ? newest() : intent);
    }
  }
  if (themed) refresh();
}

function onIntent(e: Event): void {
  intent = scopeOf(e.target instanceof Node ? e.target : null);
}

// Armed when the community code loads, before its first page renders: a portal
// inserted in the same commit as its scope root is reported after that commit.
if (typeof document !== 'undefined' && typeof MutationObserver !== 'undefined' && document.body) {
  watcher = new MutationObserver(onRecords);
  watcher.observe(document.body, { childList: true });
  for (const type of ['pointerdown', 'keydown', 'click']) document.addEventListener(type, onIntent, true);
}

/**
 * Carry a scope root into the portals while it is mounted (CommunitySurface
 * calls this from a layout effect). The returned function lets it go.
 */
export function carryScope(root: HTMLElement): () => void {
  roots = [...roots.filter((r) => r !== root), root];
  intent = undefined;
  watcher?.observe(root, { attributes: true, attributeFilter: ['data-theme'] });
  refresh();
  return () => {
    roots = roots.filter((r) => r !== root);
    if (intent === root) intent = undefined;
    refresh();
  };
}
