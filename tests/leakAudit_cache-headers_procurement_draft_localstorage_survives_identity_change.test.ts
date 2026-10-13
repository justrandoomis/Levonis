/**
 * LEAK AUDIT — the owner's unsaved purchase draft at rest in the browser.
 *
 * src/components/adminOperations/ProcurementPanel.tsx parks the purchase being
 * typed in `localStorage['levonis-purchase-draft-v2']`: the supplier, the
 * purchase currency and exchange rate, each line's supplier unit / total
 * amount, the shipping rate, the per-shipment charges and the investor split.
 * Every one of those is the owner's private cost.
 *
 * src/AuthContext.tsx is the only thing that ever removes it on an identity
 * change, and it does so only when `previous !== null` — when a KNOWN identity
 * changes inside one page lifetime. The ref starts at `null`, so:
 *
 *   - the owner's session ends WITHOUT an in-tab sign-out (expired after its
 *     lifetime, revoked from another device, cookie cleared);
 *   - the next page load asks `/api/auth/me`, hears `null`, and the effect
 *     returns early (null === null);
 *   - anyone who now uses this browser — a visitor, a customer, a staff admin
 *     signing in — runs under an identity that is not the owner's, and the
 *     draft is still in this origin's storage, readable from devtools or by
 *     any script on the apex.
 *
 * This file drives the REAL AuthProvider (React 19, react-dom/client) against
 * the REAL `/api/auth/me` route (worker/routes/auth.ts through the shared
 * stubApp of tests/fixtures/app.ts, with the session user of each role from
 * tests/fixtures/roleMatrix.ts), with a real Map-backed localStorage, and runs
 * the shared leak scanner (tests/fixtures/costlyProduct.ts) over what the
 * non-owner's browser storage holds once that identity is settled.
 *
 * The first case is the CONTROL: the owner signs out inside the tab and the
 * draft goes. It proves this harness really runs AuthProvider's effect, so a
 * failure in the cases after it is the product's behaviour, not the harness.
 *
 * SINCE DECISIONS row 216 the panel keeps the draft in this tab's memory only
 * (src/lib/privateDrafts.ts, cleared by AuthContext on every identity change
 * and whenever cost access is gone), and AuthContext removes a legacy copy
 * an older release left at rest on every page load, signed in or not. The
 * cases below seed that legacy copy and prove no non-owner ever finds it; the
 * wiring and the control pin the mechanism that closes it (DECISIONS row 220).
 *
 * Run: node --import tsx --test tests/leakAudit_cache-headers_procurement_draft_localstorage_survives_identity_change.test.ts
 */
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import React from 'react';
// Statically imported BEFORE any window exists: src/lib/bootFetch.ts starts
// requests at module evaluation only when a window is present, and this test
// wants nothing but the auth calls.
import { AuthProvider, useAuth } from '../src/AuthContext';
import { privateDrafts } from '../src/lib/privateDrafts';
import { stubApp, OWNER, type StubUser } from './fixtures/app';
import { ROLES, type RoleName } from './fixtures/roleMatrix';
import { COST, DECIMAL_SENTINELS, leaks } from './fixtures/costlyProduct';
import { authRoutes } from '../worker/routes/auth';
import type { AppContext } from '../worker/lib/types';
import type { Hono } from 'hono';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

const DRAFT_KEY = 'levonis-purchase-draft-v2';

/**
 * THE DRAFT, IN THE SHAPE ProcurementPanel WRITES IT (line 193 autosave and
 * line 426 «save locally»): `{ header, lines, charges, funding, editId,
 * editVersion, operationId, quickReceive }`, carrying the shared sentinel
 * costs so the shared scanner recognises every private figure in it.
 */
function ownersDraft() {
  return {
    header: {
      supplier_id: 'sup_private_supplier',
      warehouse_id: 'wh_main',
      invoice_no: 'INV-1',
      currency: 'CNY',
      exchange_rate: DECIMAL_SENTINELS.fxRate,
      cost_profile_id: 'cp_air',
      // A version number, not a cost: left null so the scanner's "cost key with a
      // number" rule lists only real figures below.
      cost_profile_version: null,
      shipping_basis: 'weight',
      shipping_rate_iqd: COST.incomingShipping,
      purchase_day: '2026-10-01',
      expected_day: '',
      tracking: '',
      note: '',
      attachment_url: '',
      invoice_total_iqd: String(COST.purchaseUnit * 2),
      cost_state: 'final',
    },
    lines: [
      {
        // The Selection the picker handed over (src/components/adminOperations/
        // shared.tsx), spread into the line by selectionCostDraft — its cost
        // references and the saved supplier defaults come with it.
        product_id: 'p_a1',
        scope: 'base',
        scope_id: 'p_a1',
        label: 'Bambu Lab A1',
        sku: 'A1',
        stock: 5,
        reserved: 0,
        selling_price_iqd: 900000,
        unit_cost_iqd: COST.lotUnit,
        purchase_unit_iqd: COST.purchaseUnit,
        cost_source: 'procurement_default',
        cost_date: '2026-09-30T00:00:00.000Z',
        weight_g: 1200,
        volume_mm3: 0,
        packed_weight_g: 1200,
        packed_volume_mm3: null,
        procurement_defaults: [
          { profile_id: 'cp_air', currency: 'CNY', source_unit_amount: DECIMAL_SENTINELS.sourceUnit, weight_g: 1200, volume_mm3: 0, updated_at: '2026-09-30T00:00:00.000Z' },
        ],
        // The draft line's own fields (procurementCostDraft.ts).
        qty_ordered: 2,
        invoiced_qty: 2,
        purchase_cost_mode: 'unit',
        source_unit_amount: DECIMAL_SENTINELS.sourceUnit,
        source_total_amount: DECIMAL_SENTINELS.sourceUnit * 2,
        unit_conversion_inexact: false,
      },
    ],
    charges: [
      { title: 'Customs', scope: 'shipment', amount_iqd: COST.purchaseCharge, unit_amount_iqd: null, basis: 'quantity', applies_to: null },
    ],
    funding: {
      mode: 'investor',
      user_id: 'usr_inv',
      agreed_iqd: String(COST.purchaseUnit),
      received_iqd: String(COST.purchaseUnit),
      received_day: '2026-10-01',
      reference: '',
      profit_share_bps: 3500,
      loss_share_bps: 0,
      save_default: false,
    },
    editId: '',
    editVersion: undefined,
    operationId: '00000000-0000-4000-8000-000000000001',
    quickReceive: false,
  };
}

// ------------------------------------------------------------ the browser

/** A real Storage: what the browser keeps for this origin across page loads. */
class MemoryStorage {
  private readonly map = new Map<string, string>();
  get length() {
    return this.map.size;
  }
  key(i: number) {
    return [...this.map.keys()][i] ?? null;
  }
  getItem(k: string) {
    return this.map.has(k) ? this.map.get(k)! : null;
  }
  setItem(k: string, v: string) {
    this.map.set(k, String(v));
  }
  removeItem(k: string) {
    this.map.delete(k);
  }
  clear() {
    this.map.clear();
  }
  /** Everything this origin's storage holds, parsed where it is JSON — what devtools shows. */
  dump(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [k, v] of this.map) {
      try {
        out[k] = JSON.parse(v);
      } catch {
        out[k] = v;
      }
    }
    return out;
  }
}

/** One browser profile: its storage survives every page load in it. */
const storage = new MemoryStorage();

/**
 * The smallest document react-dom/client needs to mount a tree that renders
 * no host element (AuthProvider + a probe that returns null): a container
 * element with an owner document, event listeners, and an active element.
 */
function installBrowser() {
  const g = globalThis as Record<string, unknown>;
  const win = new EventTarget() as EventTarget & Record<string, unknown>;
  const doc = new EventTarget() as EventTarget & Record<string, unknown>;
  const element = (tag: string) => {
    const el = new EventTarget() as EventTarget & Record<string, unknown>;
    Object.assign(el, {
      nodeType: 1,
      nodeName: tag.toUpperCase(),
      tagName: tag.toUpperCase(),
      ownerDocument: doc,
      parentNode: null,
      childNodes: [],
      firstChild: null,
      style: {},
      setAttribute() {},
      removeAttribute() {},
      getAttribute: () => null,
      appendChild: (c: unknown) => c,
      removeChild: (c: unknown) => c,
      insertBefore: (c: unknown) => c,
      contains: () => false,
    });
    return el;
  };
  const html = element('html');
  const body = element('body');
  Object.assign(doc, {
    nodeType: 9,
    nodeName: '#document',
    defaultView: win,
    documentElement: html,
    body,
    head: element('head'),
    activeElement: body,
    createElement: element,
    createTextNode: (t: string) => ({ nodeType: 3, nodeValue: t }),
    querySelector: () => null,
    querySelectorAll: () => [],
    getElementById: () => null,
  });
  class HTMLIFrameElement {}
  Object.assign(win, {
    document: doc,
    localStorage: storage,
    sessionStorage: new MemoryStorage(),
    location: new URL('https://levonis-iq.com/admin/inventory'),
    navigator: globalThis.navigator,
    HTMLIFrameElement,
    setTimeout,
    clearTimeout,
  });
  (win as Record<string, unknown>).window = win;
  const saved: Record<string, PropertyDescriptor | undefined> = {};
  const set = (name: string, value: unknown) => {
    saved[name] = Object.getOwnPropertyDescriptor(g, name);
    Object.defineProperty(g, name, { value, configurable: true, writable: true });
  };
  set('window', win);
  set('document', doc);
  set('localStorage', storage);
  set('HTMLIFrameElement', HTMLIFrameElement);
  return {
    container: element('div'),
    restore() {
      for (const [name, d] of Object.entries(saved)) {
        if (d) Object.defineProperty(g, name, d);
        else delete g[name];
      }
    },
  };
}

// ------------------------------------------------------------ the server

/**
 * What the cookie in this browser currently resolves to on the server: the
 * session user the real `/api/auth/me` route sees. `null` is an expired,
 * revoked or cleared session — the Worker's own answer to it is `user: null`.
 */
let sessionUser: StubUser | null = null;
const authApp = (user: StubUser | null): Hono<AppContext> =>
  stubApp(null, user, (a) => a.route('/api/auth', authRoutes));

/** The real `/api/auth/me` answer for a session user. */
async function meFor(user: StubUser | null): Promise<Record<string, unknown>> {
  const res = await authApp(user).request('/api/auth/me', { headers: { 'CF-Connecting-IP': '1.2.3.4' } });
  return (await res.json()) as Record<string, unknown>;
}

/**
 * The browser's fetch: `/api/auth/me` goes to the real route for whatever the
 * cookie is now. A sign-in (`/api/auth/login`) sets the cookie to the account
 * that signed in and answers `{ user }` exactly as /me then describes it —
 * the client reads nothing else from it. Anything else is a dead network.
 */
const calls: string[] = [];
let pendingLogin: StubUser | null = null;
async function browserFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
  const path = url.startsWith('/') ? url : new URL(url).pathname;
  calls.push(`${init?.method ?? 'GET'} ${path}`);
  if (path === '/api/auth/me') {
    return authApp(sessionUser).request('/api/auth/me', { headers: { 'CF-Connecting-IP': '1.2.3.4' } });
  }
  if (path === '/api/auth/login') {
    sessionUser = pendingLogin;
    const me = await meFor(sessionUser);
    return new Response(JSON.stringify({ success: true, user: me.user }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }
  if (path === '/api/auth/logout') {
    sessionUser = null;
    return new Response(JSON.stringify({ success: true }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  throw new TypeError('fetch failed');
}

// ------------------------------------------------------------ the page

type Auth = ReturnType<typeof useAuth>;
let browser: ReturnType<typeof installBrowser>;
let realFetch: typeof fetch;
let createRoot: (c: unknown) => { render(n: React.ReactNode): void; unmount(): void };

before(async () => {
  realFetch = globalThis.fetch;
  globalThis.fetch = browserFetch as typeof fetch;
  browser = installBrowser();
  createRoot = ((await import('react-dom/client')) as unknown as { createRoot: typeof createRoot }).createRoot;
});
after(async () => {
  // Let React's scheduler finish the last unmount before the window goes.
  await new Promise((r) => setTimeout(r, 200));
  globalThis.fetch = realFetch;
  browser.restore();
});

const tick = () => new Promise((r) => setTimeout(r, 5));
async function until(what: string, ok: () => boolean) {
  for (let i = 0; i < 400; i += 1) {
    if (ok()) return;
    await tick();
  }
  assert.fail(`timed out waiting for: ${what}`);
}

/**
 * ONE PAGE LOAD: a fresh AuthProvider (its identity ref starts at null, as on
 * every load), mounted on this browser profile's storage. Resolves once the
 * first `/api/auth/me` answer has been applied.
 */
async function loadPage() {
  let auth: Auth | null = null;
  function Probe() {
    auth = useAuth();
    return null;
  }
  const root = createRoot(browser.container);
  root.render(React.createElement(AuthProvider, null, React.createElement(Probe)));
  await until('the first /api/auth/me answer', () => auth?.isLoaded === true);
  // Let the identity effect that follows the answer run.
  for (let i = 0; i < 5; i += 1) await tick();
  return {
    get auth(): Auth {
      return auth!;
    },
    async settle() {
      for (let i = 0; i < 10; i += 1) await tick();
    },
    async unmount() {
      root.unmount();
      for (let i = 0; i < 10; i += 1) await tick();
    },
  };
}

/** The owner typed a purchase on this browser in an earlier page lifetime. */
function ownerLeftADraft() {
  storage.clear();
  storage.setItem(DRAFT_KEY, JSON.stringify(ownersDraft()));
}

/** What the non-owner can read from this browser: every value at rest in the origin's storage. */
function privateAtRest(): string[] {
  return leaks(storage.dump(), { decimals: [String(DECIMAL_SENTINELS.sourceUnit * 2)] });
}

// ------------------------------------------------------------ wiring

test('wiring: the panel keeps the private draft under this key in tab memory only, and every page load removes a legacy copy at rest', () => {
  const panel = read('src/components/adminOperations/ProcurementPanel.tsx');
  assert.match(panel, /privateDrafts\.setItem\('levonis-purchase-draft-v2', JSON\.stringify\(\{ header, lines, charges, funding,/);
  assert.doesNotMatch(panel, /localStorage\.setItem\('levonis-purchase-draft-v2'/, 'the draft is never written at rest');
  // The draft fields really are the private ones this test seeds.
  const header = read('src/components/adminOperations/ProcurementPanel.tsx');
  for (const f of ['supplier_id', 'exchange_rate', 'shipping_rate_iqd', 'cost_profile_id']) assert.match(header, new RegExp(`\\b${f}:`));
  const draftLine = read('src/components/adminOperations/procurementCostDraft.ts');
  for (const f of ['source_unit_amount', 'source_total_amount']) assert.match(draftLine, new RegExp(`\\b${f}\\b`));
  assert.match(read('src/lib/privateDrafts.ts'), /localStorage\.removeItem\('levonis-purchase-draft-v2'\)/);
  const auth = read('src/AuthContext.tsx');
  assert.match(auth, /useEffect\(purgeLegacyPrivateDrafts, \[\]\)/, 'every page load purges the legacy copy');
  assert.match(auth, /privateDrafts\.clear\(\)/, 'an identity change clears the in-tab draft');
  // The fixture's draft carries the sentinels the scanner looks for.
  assert.ok(leaks(ownersDraft()).length > 0, 'the seeded draft must be visible to the leak scanner');
});

// ------------------------------------------------------------ control

test('CONTROL: the real AuthProvider runs — a legacy copy at rest goes on load, and the in-tab draft goes at sign-out', async () => {
  ownerLeftADraft();
  sessionUser = OWNER;
  const page = await loadPage();
  assert.equal(page.auth.user?.id, OWNER.id);
  assert.equal(page.auth.user?.is_owner, true, 'the real /api/auth/me names this session the owner');
  // Even the owner's own load removes what an older release left at rest.
  assert.equal(storage.getItem(DRAFT_KEY), null, 'the page load removed the legacy copy at rest');
  // What the panel writes now: the owner's draft, in this tab's memory.
  privateDrafts.setItem(DRAFT_KEY, JSON.stringify(ownersDraft()));
  await page.auth.logout();
  await page.settle();
  assert.equal(page.auth.user, null);
  assert.equal(privateDrafts.getItem(DRAFT_KEY), null, 'an in-tab sign-out clears the in-tab draft');
  assert.deepEqual(privateAtRest(), []);
  await page.unmount();
});

// ------------------------------------------------------------ the candidate

const NON_OWNERS = (Object.keys(ROLES) as RoleName[]).filter((r) => ROLES[r] !== null);

test('the owner session EXPIRED: an anonymous visitor on this browser holds no private cost at rest', async () => {
  ownerLeftADraft();
  sessionUser = null; // the cookie expired / was revoked: /api/auth/me answers null
  const page = await loadPage();
  assert.equal(page.auth.user, null, 'the real /api/auth/me answers a dead session with user: null');
  const found = privateAtRest();
  await page.unmount();
  assert.deepEqual(
    found,
    [],
    `an anonymous visitor's browser still holds the owner's purchase draft (${DRAFT_KEY}): ${found.join('; ')}`,
  );
});

for (const role of NON_OWNERS) {
  test(`the owner session EXPIRED, then «${role}» signs in on this browser: no private cost at rest for them`, async () => {
    ownerLeftADraft();
    sessionUser = null;
    const page = await loadPage();
    assert.equal(page.auth.user, null);
    pendingLogin = ROLES[role];
    await page.auth.login('someone@x.co', 'pw');
    await page.settle();
    // Read afresh: the assertion above narrowed the getter's type to null.
    const signedIn = page.auth.user as Auth['user'];
    assert.equal(signedIn?.id, ROLES[role]!.id, `${role} is signed in`);
    assert.notEqual(signedIn?.is_owner, true, `${role} is not the owner`);
    const found = privateAtRest();
    await page.unmount();
    assert.deepEqual(
      found,
      [],
      `«${role}» signed in after the owner's session expired and this browser still holds the owner's purchase draft (${DRAFT_KEY}): ${found.join('; ')}`,
    );
  });
}

test('a non-owner whose session is already live on the first page load (sign-in by link / another tab) holds no private cost at rest', async () => {
  ownerLeftADraft();
  sessionUser = ROLES.full; // the owner's cookie was replaced by a staff admin's before this load
  const page = await loadPage();
  assert.equal(page.auth.user?.id, ROLES.full!.id);
  const found = privateAtRest();
  await page.unmount();
  assert.deepEqual(
    found,
    [],
    `a full-scope staff admin's first page load still holds the owner's purchase draft (${DRAFT_KEY}): ${found.join('; ')}`,
  );
});
