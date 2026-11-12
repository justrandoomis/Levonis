/**
 * A BROWSER JUST BIG ENOUGH FOR REACT-DOM TO DRAW A PAGE INTO, AND FOR A TEST TO USE IT AS THE OWNER DOES.
 *
 * tests/freshOnReturnHold.test.ts mounts a hook in a browser that draws nothing. The costs pages' interactions (step 5 of
 * the «المال والأرباح» redesign, DECISIONS row 317) need more: elements with children, text, attributes and styles; fields
 * that hold what was typed, and a single select whose options are exclusive; the focus, which a removed element loses as in
 * a browser, a disabled control never takes and a control held while it has it gives up to the page;
 * and events that travel from their target up to the root react-dom listens on. A click on a submit button submits its
 * form; Enter in a field submits through the form's default button, unless that button is disabled (HTML's implicit
 * submission); Enter on a button presses it. No layout, no CSS, no selection.
 *
 * installDom() before react-dom/client is imported: react-dom reads the document once, when it loads.
 */

const ELEMENT_NODE = 1, TEXT_NODE = 3, COMMENT_NODE = 8, DOCUMENT_NODE = 9;
const HTML_NS = 'http://www.w3.org/1999/xhtml';

type Handler = ((event: FakeEvent) => void) | { handleEvent(event: FakeEvent): void };
type ListenerOptions = boolean | { capture?: boolean; once?: boolean; passive?: boolean };
interface Listener { handler: Handler; capture: boolean; once: boolean }

export class FakeEvent {
  [key: string]: unknown;
  readonly type: string;
  readonly bubbles: boolean;
  readonly cancelable: boolean;
  readonly timeStamp = Date.now();
  readonly isTrusted = true;
  target: unknown = null;
  currentTarget: unknown = null;
  eventPhase = 0;
  defaultPrevented = false;
  cancelBubble = false;
  stopImmediate = false;
  constructor(type: string, init: Record<string, unknown> = {}) {
    const { bubbles = false, cancelable = false, ...rest } = init;
    this.type = type;
    this.bubbles = !!bubbles;
    this.cancelable = !!cancelable;
    Object.assign(this, rest);
  }
  preventDefault() { if (this.cancelable) this.defaultPrevented = true; }
  stopPropagation() { this.cancelBubble = true; }
  stopImmediatePropagation() { this.cancelBubble = true; this.stopImmediate = true; }
}

/** What both a node and the window are: something listened to. */
class Listened {
  private readonly listening = new Map<string, Listener[]>();
  addEventListener(type: string, handler: Handler | null, options?: ListenerOptions) {
    if (!handler) return;
    const capture = typeof options === 'boolean' ? options : !!options?.capture, once = typeof options === 'object' && !!options?.once;
    const list = this.listening.get(type) ?? [];
    if (!list.some((l) => l.handler === handler && l.capture === capture)) list.push({ handler, capture, once });
    this.listening.set(type, list);
  }
  removeEventListener(type: string, handler: Handler | null, options?: ListenerOptions) {
    const capture = typeof options === 'boolean' ? options : !!options?.capture;
    this.listening.set(type, (this.listening.get(type) ?? []).filter((l) => !(l.handler === handler && l.capture === capture)));
  }
  /** The listeners of one phase: `capture` true for the capturing ones, false for the bubbling ones. */
  invoke(event: FakeEvent, capture: boolean) {
    event.currentTarget = this;
    for (const l of [...(this.listening.get(event.type) ?? [])]) {
      if (l.capture !== capture) continue;
      if (l.once) this.removeEventListener(event.type, l.handler, capture);
      if (typeof l.handler === 'function') l.handler.call(this, event); else l.handler.handleEvent(event);
      if (event.stopImmediate) return;
    }
  }
}

/** A node and every node above it, nearest first. */
function lineage(node: FakeNode): FakeNode[] {
  const out: FakeNode[] = [];
  for (let n: FakeNode | null = node; n; n = n.parentNode) out.push(n);
  return out;
}

export class FakeNode extends Listened {
  parentNode: FakeNode | null = null;
  readonly childNodes: FakeNode[] = [];
  constructor(readonly nodeType: number, readonly nodeName: string, public ownerDocument: FakeDocument | null) { super(); }
  get parentElement(): FakeElement | null { return this.parentNode instanceof FakeElement ? this.parentNode : null; }
  get firstChild(): FakeNode | null { return this.childNodes[0] ?? null; }
  get lastChild(): FakeNode | null { return this.childNodes[this.childNodes.length - 1] ?? null; }
  get nextSibling(): FakeNode | null { const s = this.parentNode?.childNodes; return s ? s[s.indexOf(this) + 1] ?? null : null; }
  get previousSibling(): FakeNode | null { const s = this.parentNode?.childNodes; return s ? s[s.indexOf(this) - 1] ?? null : null; }
  getRootNode(): FakeNode { const all = lineage(this); return all[all.length - 1]; }
  get isConnected(): boolean { return this.getRootNode().nodeType === DOCUMENT_NODE; }
  hasChildNodes() { return this.childNodes.length > 0; }
  contains(other: FakeNode | null): boolean { for (let n = other; n; n = n.parentNode) if (n === this) return true; return false; }
  appendChild<T extends FakeNode>(child: T): T { return this.insertBefore(child, null); }
  insertBefore<T extends FakeNode>(child: T, before: FakeNode | null): T {
    if (child.parentNode) child.parentNode.removeChild(child);
    const at = before ? this.childNodes.indexOf(before) : -1;
    if (at < 0) this.childNodes.push(child); else this.childNodes.splice(at, 0, child);
    child.parentNode = this;
    return child;
  }
  removeChild<T extends FakeNode>(child: T): T {
    const at = this.childNodes.indexOf(child);
    if (at < 0) throw new Error(`${child.nodeName} is not a child of ${this.nodeName}`);
    this.childNodes.splice(at, 1);
    child.parentNode = null;
    // An element taken out of the page takes the focus with it, as in a browser.
    const doc = child.ownerDocument;
    if (doc?.focused && child.contains(doc.focused)) doc.focused = null;
    return child;
  }
  get textContent(): string { return this.childNodes.map((c) => c.textContent).join(''); }
  set textContent(text: string) {
    for (const c of [...this.childNodes]) this.removeChild(c);
    if (text !== '' && text != null && this.ownerDocument) this.appendChild(this.ownerDocument.createTextNode(String(text)));
  }
  /** Capture from the top down, the target, then bubbling back up to the window; false when a listener prevented the default. */
  dispatchEvent(event: FakeEvent): boolean {
    const path: Listened[] = lineage(this);
    const top = path[path.length - 1];
    if (top instanceof FakeDocument && top.defaultView) path.push(top.defaultView);
    event.target = this;
    event.eventPhase = 1;
    for (let i = path.length - 1; i > 0 && !event.cancelBubble; i--) path[i].invoke(event, true);
    event.eventPhase = 2;
    if (!event.cancelBubble) this.invoke(event, true);
    if (!event.cancelBubble) this.invoke(event, false);
    event.eventPhase = 3;
    if (event.bubbles) for (let i = 1; i < path.length && !event.cancelBubble; i++) path[i].invoke(event, false);
    event.eventPhase = 0;
    event.currentTarget = null;
    return !event.defaultPrevented;
  }
}

class FakeText extends FakeNode {
  constructor(public data: string, doc: FakeDocument, type = TEXT_NODE) { super(type, type === TEXT_NODE ? '#text' : '#comment', doc); }
  get nodeValue() { return this.data; }
  set nodeValue(v: string) { this.data = String(v); }
  get textContent() { return this.nodeType === TEXT_NODE ? this.data : ''; }
  set textContent(v: string) { this.data = String(v); }
}

/** The controls a `disabled` attribute takes out of the page's reach. */
const DISABLEABLE = new Set(['button', 'input', 'select', 'textarea', 'option', 'fieldset']);
const FOCUSABLE = new Set(['button', 'input', 'select', 'textarea', 'summary']);

export class FakeElement extends FakeNode {
  [key: string]: unknown;
  declare value: string;
  declare checked: boolean;
  declare type: string;
  declare selected: boolean;
  declare selectionStart: number;
  declare selectionEnd: number;
  readonly tagName: string;
  readonly attributes = new Map<string, string>();
  readonly style: Record<string, unknown> & { setProperty(k: string, v: string): void; removeProperty(k: string): void; getPropertyValue(k: string): string };
  constructor(readonly localName: string, readonly namespaceURI: string, doc: FakeDocument) {
    super(ELEMENT_NODE, namespaceURI === HTML_NS ? localName.toUpperCase() : localName, doc);
    this.tagName = this.nodeName;
    const props: Record<string, string> = {};
    this.style = Object.assign(props, {
      setProperty: (k: string, v: string) => { props[k] = v; }, removeProperty: (k: string) => { delete props[k]; }, getPropertyValue: (k: string) => props[k] ?? '',
    }) as never;
    // A field keeps what was typed apart from its attributes, as a browser does: own data properties, so react-dom
    // tracks no value on them and every input event is a change.
    if (localName === 'input' || localName === 'textarea')
      Object.assign(this, { value: '', defaultValue: '', checked: false, defaultChecked: false, type: localName === 'input' ? 'text' : 'textarea', name: '', selectionStart: 0, selectionEnd: 0 });
    if (localName === 'select') {
      Object.assign(this, { multiple: false, name: '' });
      Object.defineProperties(this, {
        options: { get: () => this.querySelectorAll('option') },
        selectedIndex: { get: () => this.querySelectorAll('option').findIndex((o) => o.selected) },
        value: {
          get: () => this.querySelectorAll('option').find((o) => o.selected)?.value ?? this.querySelectorAll('option')[0]?.value ?? '',
          set: (v: string) => { for (const o of this.querySelectorAll('option')) o.selected = o.value === String(v); },
        },
      });
    }
    if (localName === 'option') {
      // A single select's options are exclusive, as in a browser: react-dom marks only the chosen option selected and relies on
      // the browser to clear the one chosen before — without this, select.value read the first option ever chosen (the checker
      // of step 5's second review).
      let selected = false;
      Object.defineProperty(this, 'selected', {
        get: () => selected,
        set: (v: unknown) => {
          selected = !!v;
          const select = selected ? this.closest('select') : null;
          if (select && !select.multiple) for (const o of select.querySelectorAll('option')) if (o !== this) o.selected = false;
        },
      });
      Object.assign(this, { defaultSelected: false });
      Object.defineProperty(this, 'value', { get: () => this.getAttribute('value') ?? this.textContent, set: (v: string) => this.setAttribute('value', String(v)) });
    }
  }
  private key(name: string) { return this.namespaceURI === HTML_NS ? name.toLowerCase() : name; }
  setAttribute(name: string, value: unknown) {
    this.attributes.set(this.key(name), String(value));
    // A control held while it has the focus loses it to the page, as in a browser (HTML's focus fixup): a press that holds the
    // very button it was made on leaves the focus on <body> (the checker of step 5's second review).
    const doc = this.ownerDocument, at = doc?.focused;
    if (this.key(name) === 'disabled' && at && (!at.focusable || at.closest('fieldset[disabled]'))) doc.focused = null;
  }
  getAttribute(name: string) { return this.attributes.get(this.key(name)) ?? null; }
  removeAttribute(name: string) { this.attributes.delete(this.key(name)); }
  hasAttribute(name: string) { return this.attributes.has(this.key(name)); }
  setAttributeNS(_ns: string | null, name: string, value: unknown) { this.setAttribute(name, value); }
  removeAttributeNS(_ns: string | null, name: string) { this.removeAttribute(name); }
  get id() { return this.getAttribute('id') ?? ''; }
  get className() { return this.getAttribute('class') ?? ''; }
  set className(v: string) { this.setAttribute('class', v); }
  get disabled() { return DISABLEABLE.has(this.localName) && this.hasAttribute('disabled'); }
  set disabled(v: boolean) { if (v) this.setAttribute('disabled', ''); else this.removeAttribute('disabled'); }
  get tabIndex() { return Number(this.getAttribute('tabindex') ?? (FOCUSABLE.has(this.localName) ? 0 : -1)); }
  /** What can take the focus: a live control, a link, anything with a tabindex — in the page. */
  get focusable() {
    if (!this.isConnected || this.disabled) return false;
    return this.hasAttribute('tabindex') || FOCUSABLE.has(this.localName) || (this.localName === 'a' && this.hasAttribute('href'));
  }
  focus() { if (this.focusable && this.ownerDocument) this.ownerDocument.focused = this; }
  blur() { if (this.ownerDocument?.focused === this) this.ownerDocument.focused = null; }
  closest(selector: string): FakeElement | null {
    return lineage(this).find((n): n is FakeElement => n instanceof FakeElement && n.matches(selector)) ?? null;
  }
  matches(selector: string): boolean { return selector.split(',').some((s) => matchChain(this, chain(s))); }
  querySelectorAll(selector: string): FakeElement[] {
    const found: FakeElement[] = [];
    const walk = (n: FakeNode) => { for (const c of n.childNodes) if (c instanceof FakeElement) { if (c.matches(selector)) found.push(c); walk(c); } };
    walk(this);
    return found;
  }
  querySelector(selector: string): FakeElement | null { return this.querySelectorAll(selector)[0] ?? null; }
}

/** One compound selector of the few forms the tests and the pages use: tag, #id, .class, [attr] and [attr="value"]. */
interface Compound { tag: string | null; id: string | null; classes: string[]; attrs: Array<[string, string | null]> }
function compound(text: string): Compound {
  const c: Compound = { tag: null, id: null, classes: [], attrs: [] };
  const re = /([a-zA-Z][\w-]*)|#([\w-]+)|\.([\w-]+)|\[([\w-]+)(?:="([^"]*)")?\]/g;
  for (const m of text.matchAll(re)) {
    if (m[1]) c.tag = m[1].toLowerCase(); else if (m[2]) c.id = m[2]; else if (m[3]) c.classes.push(m[3]); else c.attrs.push([m[4], m[5] ?? null]);
  }
  return c;
}
const chain = (selector: string) => selector.trim().split(/\s+/).map(compound);
function matchOne(el: FakeElement, c: Compound) {
  if (c.tag && el.localName.toLowerCase() !== c.tag) return false;
  if (c.id && el.id !== c.id) return false;
  const classes = el.className.split(/\s+/);
  if (c.classes.some((k) => !classes.includes(k))) return false;
  return c.attrs.every(([k, v]) => (v === null ? el.hasAttribute(k) : el.getAttribute(k) === v));
}
/** A descendant chain, right to left. */
function matchChain(el: FakeElement, parts: Compound[]): boolean {
  if (!matchOne(el, parts[parts.length - 1])) return false;
  let i = parts.length - 2;
  for (let n = el.parentElement; n && i >= 0; n = n.parentElement) if (matchOne(n, parts[i])) i--;
  return i < 0;
}

export class FakeDocument extends FakeNode {
  readonly documentElement: FakeElement;
  readonly head: FakeElement;
  readonly body: FakeElement;
  defaultView: FakeWindow | null = null;
  /** The element with the focus; null is the body, as `document.activeElement` reads it. */
  focused: FakeElement | null = null;
  /** react-dom asks `'oninput' in document` before it listens to input events. */
  oninput = null;
  constructor() {
    super(DOCUMENT_NODE, '#document', null);
    this.documentElement = this.appendChild(this.createElement('html'));
    this.head = this.documentElement.appendChild(this.createElement('head'));
    this.body = this.documentElement.appendChild(this.createElement('body'));
  }
  get activeElement(): FakeElement { return this.focused && this.focused.isConnected ? this.focused : this.body; }
  createElement(tag: string) { return new FakeElement(tag.toLowerCase(), HTML_NS, this); }
  createElementNS(ns: string | null, tag: string) { return new FakeElement(tag, ns ?? HTML_NS, this); }
  createTextNode(text: string) { return new FakeText(String(text), this); }
  createComment(text: string) { return new FakeText(String(text), this, COMMENT_NODE); }
  querySelector(selector: string) { return this.documentElement.matches(selector) ? this.documentElement : this.documentElement.querySelector(selector); }
  querySelectorAll(selector: string) { return this.documentElement.querySelectorAll(selector); }
  getElementById(id: string) { return this.querySelector(`#${id}`); }
}

export class FakeWindow extends Listened {
  [key: string]: unknown;
  readonly window = this;
  readonly self = this;
  readonly top = this;
  readonly HTMLIFrameElement = class {};
  readonly navigator = { userAgent: 'node' };
  readonly history = { state: null, replaceState() {}, pushState() {} };
  readonly location: { href: string; search: string; pathname: string; origin: string; protocol: string };
  constructor(readonly document: FakeDocument, href: string) {
    super();
    const url = new URL(href);
    this.location = { href, search: url.search, pathname: url.pathname, origin: url.origin, protocol: url.protocol };
  }
  getSelection() { return { anchorNode: null, anchorOffset: 0, focusNode: null, focusOffset: 0, rangeCount: 0, removeAllRanges() {}, addRange() {}, toString: () => '' }; }
  getComputedStyle() { return { getPropertyValue: () => '' }; }
  dispatchEvent(event: FakeEvent) {
    try { event.target = this; } catch { /* a platform event keeps its own target */ }
    this.invoke(event, true); this.invoke(event, false);
    return !event.defaultPrevented;
  }
  setTimeout = (fn: () => void, ms?: number) => globalThis.setTimeout(fn, ms);
  clearTimeout = (id: ReturnType<typeof setTimeout>) => globalThis.clearTimeout(id);
  setInterval = (fn: () => void, ms?: number) => globalThis.setInterval(fn, ms);
  clearInterval = (id: ReturnType<typeof setInterval>) => globalThis.clearInterval(id);
}

/** The browser, as globals; a container for a React root in its body. */
export function installDom(href = 'https://levonis-iq.com/admin?tab=finance') {
  const document = new FakeDocument(), window = new FakeWindow(document, href);
  document.defaultView = window;
  Object.assign(globalThis, { window, document, IS_REACT_ACT_ENVIRONMENT: true });
  return { window, document, container: () => document.body.appendChild(document.createElement('div')) };
}

// ------------------------------------------------------------------ the owner's hands

const disabledControl = (el: FakeElement) => el.disabled || !!el.closest('fieldset[disabled]');
const isSubmit = (el: FakeElement) => el.localName === 'button' && (el.getAttribute('type') ?? 'submit') === 'submit';
/** The fields Enter submits a form from (HTML's "fields that block implicit submission"). */
const IMPLICIT = new Set(['text', 'search', 'url', 'tel', 'email', 'password', 'date', 'month', 'week', 'time', 'datetime-local', 'number']);

function submit(form: FakeElement, submitter: FakeElement | null) {
  form.dispatchEvent(new FakeEvent('submit', { bubbles: true, cancelable: true, submitter }));
}
/** A click as the page receives it, and what a browser does after it: a submit button submits its form. */
function press(el: FakeElement): boolean {
  if (disabledControl(el)) return false;
  const go = el.dispatchEvent(new FakeEvent('click', { bubbles: true, cancelable: true, button: 0, detail: 1 }));
  if (go) {
    const button = el.closest('button');
    const form = button && isSubmit(button) && !disabledControl(button) ? button.closest('form') : null;
    if (form) submit(form, button);
  }
  return go;
}
/** The owner clicks `el`: a disabled control takes neither the focus nor the click; anything else takes both (Chromium on Windows focuses a button it clicks). */
export function click(el: FakeElement): boolean {
  if (disabledControl(el)) return false;
  el.focus();
  if (el.localName === 'input' && (el.type === 'checkbox' || el.type === 'radio')) {
    el.checked = el.type === 'radio' ? true : !el.checked;
    const go = press(el);
    if (!go && el.type === 'checkbox') el.checked = !el.checked;
    return go;
  }
  return press(el);
}
/** The owner puts the caret in `el` and types until it reads `value` (one input event). */
export function type(el: FakeElement, value: string) {
  el.focus();
  el.value = value;
  el.selectionStart = el.selectionEnd = value.length;
  el.dispatchEvent(new FakeEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
}
/** The owner picks `value` in a select. */
export function choose(select: FakeElement, value: string) {
  select.focus();
  select.value = value;
  select.dispatchEvent(new FakeEvent('input', { bubbles: true }));
  select.dispatchEvent(new FakeEvent('change', { bubbles: true }));
}
/**
 * The owner presses `key` where the focus is. Enter in a field submits its form through the form's default button — unless
 * that button is disabled, when nothing happens — or, with no submit button, the form itself; Enter or Space on a button
 * presses it.
 */
export function pressKey(key: string, at?: FakeElement): boolean {
  const doc = (globalThis as unknown as { document: FakeDocument }).document;
  const el = at ?? doc.activeElement;
  const go = el.dispatchEvent(new FakeEvent('keydown', { bubbles: true, cancelable: true, key }));
  if (!go) return false;
  if (key === 'Enter' && el.localName === 'input' && IMPLICIT.has(el.type)) {
    const form = el.closest('form');
    if (form) {
      const button = form.querySelectorAll('button').find(isSubmit);
      if (!button) submit(form, null);
      else if (!disabledControl(button)) press(button);
    }
  } else if ((key === 'Enter' || key === ' ') && el.localName === 'button') press(el);
  el.dispatchEvent(new FakeEvent('keyup', { bubbles: true, cancelable: true, key }));
  return true;
}

/** An element's words, as the owner reads them. */
export const words = (n: FakeNode) => n.textContent.replace(/\s+/g, ' ').trim();
/** The first element under `root` matching `selector` whose words include `text`. */
export function named(root: FakeElement | FakeDocument, selector: string, text: string | RegExp): FakeElement {
  const found = root.querySelectorAll(selector).find((el) => (typeof text === 'string' ? words(el).includes(text) : text.test(words(el))));
  if (!found) throw new Error(`no ${selector} reading «${text}»`);
  return found;
}
