/**
 * THE COMPARE TRAY — the list of products a shopper is collecting to compare
 * (docs/ux/CATALOG_DISCOVERY.md §10.4). Before it, nothing on a card or a
 * listing could add to a comparison: /compare opened on an empty picker.
 *
 * A tiny external store (`useSyncExternalStore`), in the ENTRY chunk because
 * every card toggle and the tray gate read it — so it holds no React, no
 * strings and no UI. Persisted in localStorage under `lv_compare_v1`:
 *
 *   {v:1, type:'printer', items:[{id, slug, name, image}], at}
 *
 * THE RULES
 *  - At most 4 (the compare route's own MAX_COMPARE_IDS). The fifth add is
 *    refused and says so (`full`) — never a silent drop of the oldest.
 *  - One product type. The first item sets `type`; an item of another type is
 *    refused with `type` so the UI can ASK before replacing anything.
 *  - Expires 30 days after the last change. A shopper back after a month is
 *    not greeted by a tray from another purchase.
 *  - Every storage touch is try/caught. Private mode, a full quota or a
 *    blocked site keep the tray in memory for the visit — it still works.
 *  - Another tab's write arrives through the `storage` event; both tabs
 *    converge on what storage holds.
 *  - Guests use everything. Nothing is sent to the server.
 *
 * NOTICES. A card toggle is in a lazy chunk and the dialog and the toasts live
 * in the tray's own lazy chunk (src/components/compare/CompareTray.tsx), so a
 * refused add is published as a notice that the tray answers: the «full»
 * toast, or the «start a new comparison?» dialog.
 */

export const COMPARE_TRAY_KEY = 'lv_compare_v1';
export const COMPARE_TRAY_VERSION = 1;
/** worker/routes/compare.ts MAX_COMPARE_IDS. */
export const COMPARE_TRAY_MAX = 4;
export const COMPARE_TRAY_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export interface TrayItem {
  id: string;
  slug: string;
  name: string;
  image: string;
}

export interface TrayState {
  v: 1;
  type: string | null;
  items: TrayItem[];
  /** Epoch ms of the last change. */
  at: number;
}

export type AddResult =
  | { ok: true; added: boolean }
  | { ok: false; reason: 'full' }
  | { ok: false; reason: 'type'; current: string };

export type TrayNotice =
  | { kind: 'full'; seq: number }
  | { kind: 'conflict'; seq: number; item: TrayItem; type: string; current: string };

/** The part of `Storage` the tray touches, so a test can hand it a fake. */
export interface TrayStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface CompareTrayStore {
  getSnapshot(): TrayState;
  subscribe(listener: () => void): () => void;
  has(id: string): boolean;
  add(item: TrayItem, type: string): AddResult;
  /** `add`, and on refusal publish the notice the tray UI answers. */
  request(item: TrayItem, type: string): AddResult;
  remove(id: string): void;
  toggle(item: TrayItem, type: string): AddResult | { ok: true; added: false; removed: true };
  clear(): TrayState;
  /** Replace the whole list (the compare page writes its URL's ids back). */
  replaceAll(items: Array<TrayItem | string>, type?: string | null): void;
  /** Put a previous state back (the clear toast's «تراجع»). */
  restore(state: TrayState): void;
  /** Re-read storage; the `storage` event calls it. */
  sync(): void;
  getNotice(): TrayNotice | null;
  subscribeNotice(listener: () => void): () => void;
  consumeNotice(seq: number): void;
  /** Bumped when something asks the tray to show itself expanded. */
  getExpandSeq(): number;
}

const EMPTY: TrayState = Object.freeze({ v: 1, type: null, items: [], at: 0 }) as TrayState;

function clean(s: unknown, max = 300): string {
  return typeof s === 'string' ? s.slice(0, max) : '';
}

/** Parse what storage holds. Anything malformed, old or expired is EMPTY. */
export function parseTray(raw: string | null, now: number): TrayState {
  if (!raw) return EMPTY;
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return EMPTY;
  }
  if (!data || typeof data !== 'object') return EMPTY;
  const d = data as Record<string, unknown>;
  if (d.v !== COMPARE_TRAY_VERSION) return EMPTY;
  const at = typeof d.at === 'number' && Number.isFinite(d.at) ? d.at : 0;
  if (!at || now - at > COMPARE_TRAY_TTL_MS) return EMPTY;
  const seen = new Set<string>();
  const items: TrayItem[] = [];
  for (const it of Array.isArray(d.items) ? d.items : []) {
    if (!it || typeof it !== 'object') continue;
    const o = it as Record<string, unknown>;
    const id = clean(o.id, 120);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    items.push({ id, slug: clean(o.slug, 200) || id, name: clean(o.name), image: clean(o.image, 600) });
    if (items.length === COMPARE_TRAY_MAX) break;
  }
  if (!items.length) return EMPTY;
  const type = typeof d.type === 'string' && d.type ? d.type : null;
  return { v: 1, type, items, at };
}

function browserStorage(): TrayStorage | null {
  try {
    return typeof window !== 'undefined' && window.localStorage ? window.localStorage : null;
  } catch {
    return null;
  }
}

export function createCompareTray(opts: { storage?: TrayStorage | null; now?: () => number } = {}): CompareTrayStore {
  const storage = opts.storage === undefined ? browserStorage() : opts.storage;
  const now = opts.now ?? (() => Date.now());
  const listeners = new Set<() => void>();
  const noticeListeners = new Set<() => void>();
  let lastRaw: string | null = null;
  let state: TrayState = EMPTY;
  let notice: TrayNotice | null = null;
  let noticeSeq = 0;
  let expandSeq = 0;

  const read = (): string | null => {
    try {
      return storage ? storage.getItem(COMPARE_TRAY_KEY) : null;
    } catch {
      return lastRaw;
    }
  };

  const load = () => {
    const raw = read();
    lastRaw = raw;
    state = parseTray(raw, now());
  };
  load();

  const emit = () => {
    for (const l of [...listeners]) l();
  };

  const commit = (next: TrayState) => {
    state = next.items.length ? next : EMPTY;
    const raw = state.items.length ? JSON.stringify(state) : null;
    lastRaw = raw;
    try {
      if (storage) {
        if (raw) storage.setItem(COMPARE_TRAY_KEY, raw);
        else storage.removeItem(COMPARE_TRAY_KEY);
      }
    } catch {
      /* private mode or a full quota: the tray lives in memory for this visit */
    }
    emit();
  };

  const publish = (n: { kind: 'full' } | { kind: 'conflict'; item: TrayItem; type: string; current: string }) => {
    notice = { ...n, seq: ++noticeSeq } as TrayNotice;
    for (const l of [...noticeListeners]) l();
  };

  const store: CompareTrayStore = {
    getSnapshot: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    has: (id) => state.items.some((i) => i.id === id),
    add(item, type) {
      if (!item.id || !type) return { ok: true, added: false };
      if (store.has(item.id)) return { ok: true, added: false };
      if (state.items.length && state.type && state.type !== type) return { ok: false, reason: 'type', current: state.type };
      if (state.items.length >= COMPARE_TRAY_MAX) return { ok: false, reason: 'full' };
      commit({ v: 1, type, items: [...state.items, { ...item }], at: now() });
      return { ok: true, added: true };
    },
    request(item, type) {
      const r = store.add(item, type);
      if (r.ok === true) return r;
      if (r.reason === 'full') {
        expandSeq++;
        publish({ kind: 'full' });
      } else {
        publish({ kind: 'conflict', item: { ...item }, type, current: r.current });
      }
      return r;
    },
    remove(id) {
      if (!store.has(id)) return;
      commit({ ...state, items: state.items.filter((i) => i.id !== id), at: now() });
    },
    toggle(item, type) {
      if (store.has(item.id)) {
        store.remove(item.id);
        return { ok: true, added: false, removed: true };
      }
      return store.request(item, type);
    },
    clear() {
      const before = state;
      if (before.items.length) commit(EMPTY);
      return before;
    },
    replaceAll(items, type) {
      const known = new Map(state.items.map((i) => [i.id, i]));
      const seen = new Set<string>();
      const next: TrayItem[] = [];
      for (const it of items) {
        const id = typeof it === 'string' ? it : it.id;
        if (!id || seen.has(id)) continue;
        seen.add(id);
        next.push(typeof it === 'string' ? known.get(id) ?? { id, slug: id, name: '', image: '' } : { ...it });
        if (next.length === COMPARE_TRAY_MAX) break;
      }
      commit({ v: 1, type: type === undefined ? state.type : type, items: next, at: now() });
    },
    restore(saved) {
      commit({ ...saved, items: saved.items.slice(0, COMPARE_TRAY_MAX), at: now() });
    },
    sync() {
      const raw = read();
      if (raw === lastRaw) return;
      load();
      emit();
    },
    getNotice: () => notice,
    subscribeNotice(listener) {
      noticeListeners.add(listener);
      return () => noticeListeners.delete(listener);
    },
    consumeNotice(seq) {
      if (notice && notice.seq === seq) {
        notice = null;
        for (const l of [...noticeListeners]) l();
      }
    },
    getExpandSeq: () => expandSeq,
  };
  return store;
}

/** The app's one tray. */
export const compareTray: CompareTrayStore = createCompareTray();

if (typeof window !== 'undefined') {
  try {
    window.addEventListener('storage', (e) => {
      if (e.key === null || e.key === COMPARE_TRAY_KEY) compareTray.sync();
    });
  } catch {
    /* no window events (a test, a worker) */
  }
}

/**
 * WHERE THE FLOATING TRAY IS DRAWN. Hidden where it would cover the page's
 * own job: the comparison itself, the cart and checkout, the finder (its own
 * full-screen flow), the admin and the merchant workspace, and every page
 * with its own sticky purchase bar — the product page, where it becomes the
 * top-bar badge instead, and a bundle's page.
 */
export function trayVisibleOn(pathname: string): boolean {
  const p = (pathname || '/').toLowerCase().replace(/\/+$/, '') || '/';
  const hiddenExact = ['/compare', '/cart', '/printer-finder', '/auth'];
  if (hiddenExact.includes(p)) return false;
  const hiddenPrefix = ['/checkout', '/admin', '/merchant', '/product/', '/bundles/', '/chat/', '/store-checkout'];
  // A trailing slash means "a page under it": `/bundles` (the list) keeps the
  // tray, `/bundles/<slug>` (its own purchase bar) does not.
  return !hiddenPrefix.some((prefix) => p.startsWith(prefix));
}

/** `/compare?ids=a,b,c` for what the tray holds. */
export function compareHref(state: Pick<TrayState, 'items'>): string {
  return state.items.length ? `/compare?ids=${state.items.map((i) => encodeURIComponent(i.id)).join(',')}` : '/compare';
}
