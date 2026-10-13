/**
 * LEAK AUDIT (client-bundles) — the owner's purchase draft outlives the
 * owner's session in the shipped client, and the next account on the same
 * browser inherits it.
 *
 * THE SHIPPED CODE UNDER TEST
 *   - src/components/adminOperations/ProcurementPanel.tsx:193 autosaves the
 *     purchase being edited to `localStorage['levonis-purchase-draft-v2']`
 *     600 ms after any change ({ header, lines, charges, funding, … }), and
 *     line 426 («Save draft») does the same at once. The header carries the
 *     purchase currency and exchange rate, the lines the supplier's own
 *     unit amounts and the landed IQD unit cost, the charges the freight /
 *     customs amounts: the owner's private cost, all of it.
 *   - src/AuthContext.tsx:61-81 is the ONLY code that removes that key on an
 *     identity change, and it does so only when `previous !== null`. Its ref
 *     starts at null on every page load.
 *
 * THE PATH
 *   The owner edits a purchase on a browser, and the session then ends
 *   WITHOUT an in-tab sign-out (cookie lifetime, revoked from another device,
 *   the owner-cost first proof that ends sessions on other devices, cleared
 *   cookie). The next page load on that browser hears `user: null` from
 *   /api/auth/me — ref null, answer null, the effect returns early. Whoever
 *   then signs in (in-app sign-in: previous is still null; or a sign-in that
 *   lands on a fresh page load: previous null again) never triggers the
 *   removal. The owner's purchase document stays in the origin's storage,
 *   readable from devtools or by any script on the apex, under a non-owner
 *   identity, indefinitely.
 *
 * HOW THIS FILE EXERCISES IT (all local: 127.0.0.1, an in-memory SQLite)
 *   - A real Chromium (Playwright) runs the REAL client modules, bundled by
 *     esbuild from src/: AuthProvider, LanguageProvider and ProcurementPanel
 *     (mounted only for `can_view_cost === true`, the gate AdminInventory.tsx
 *     uses at lines 93-97).
 *   - A local HTTP server answers /api/* with the REAL Worker routers
 *     (worker/routes/auth.ts, worker/routes/adminProcurement.ts) through the
 *     shared stubApp of tests/fixtures/app.ts, on the role-matrix database of
 *     tests/fixtures/roleMatrix.ts (the sentinel purchase `po1` of
 *     tests/fixtures/costlyProduct.ts: CNY at 203.7, supplier unit 2,999.25,
 *     charge 61,234). The cookie is modelled as `sessionUser`: what the
 *     browser's session resolves to on the server right now. Sign-in and
 *     sign-out set it; their answers are the real /api/auth/me user.
 *   - The OWNER writes the draft through the real panel UI (Open → Edit /
 *     resume draft → the real 600 ms autosave). Nothing is seeded into
 *     localStorage by hand.
 *   - Then every non-owner of ROLES (guest, customer, merchant, assistant,
 *     full, legacy_null, grantee_off, employee, investor, support_assistant)
 *     uses that browser profile, and the shared leak scanner walks every
 *     value in the origin's localStorage as that identity sees it.
 *
 * The two CONTROL cases prove the harness is live: the owner's own reload
 * keeps the draft (the reason for the `previous !== null` guard), and an
 * in-tab sign-out removes it and leaves the scanner silent (so the scanner
 * reports nothing for the rest of the storage).
 *
 * SINCE DECISIONS row 216 the panel keeps the draft in this tab's memory only
 * (src/lib/privateDrafts.ts; the harness exposes that same module instance as
 * `window.__drafts`), AuthContext clears it on every identity change, and a
 * page load removes any legacy copy at rest. So the controls now prove the
 * real panel autosaves the owner's private draft — into the tab, never into
 * the browser's storage — and that an in-tab sign-out drops it; the cases
 * after them are unchanged: nothing private at rest for anyone who comes
 * next (DECISIONS row 220).
 *
 * Run: node --import tsx --test tests/leakAudit_client-bundles_purchase_draft_survives_account_change.test.ts
 * Needs Playwright + Chromium (PLAYWRIGHT_MODULE, or `playwright` resolvable).
 */
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { asD1, ctx, stubApp, OWNER, type StubUser } from './fixtures/app';
import { ROLES, seedRoleMatrix, type RoleName } from './fixtures/roleMatrix';
import { leaks } from './fixtures/costlyProduct';
import { authRoutes } from '../worker/routes/auth';
import { adminProcurementRoutes } from '../worker/routes/adminProcurement';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DRAFT_KEY = 'levonis-purchase-draft-v2';

// ------------------------------------------------------------ Playwright

/** The slice of Playwright this file drives. */
interface PwPage {
  goto(url: string): Promise<unknown>;
  close(): Promise<void>;
  evaluate<R, A = undefined>(fn: (arg: A) => R | Promise<R>, arg?: A): Promise<R>;
  waitForFunction<A>(fn: (arg: A) => unknown, arg?: A, opts?: { timeout?: number }): Promise<unknown>;
  on(event: 'pageerror', cb: (e: Error) => void): void;
}
interface PwRoute {
  request(): { url(): string };
  continue(): Promise<void>;
  abort(): Promise<void>;
}
interface PwContext {
  newPage(): Promise<PwPage>;
  addInitScript(fn: () => void): Promise<void>;
  route(glob: string, cb: (r: PwRoute) => void): Promise<void>;
  close(): Promise<void>;
}
interface PwBrowser {
  newContext(): Promise<PwContext>;
  close(): Promise<void>;
}

function loadChromium(): { launch(o: { args: string[] }): Promise<PwBrowser> } | null {
  const req = createRequire(import.meta.url);
  const ids = [process.env.PLAYWRIGHT_MODULE, 'playwright', '/opt/node22/lib/node_modules/playwright'].filter(Boolean) as string[];
  for (const id of ids) {
    try {
      const chromium = (req(id) as { chromium: { launch(o: { args: string[] }): Promise<PwBrowser>; executablePath(): string } }).chromium;
      // The module without its browser (a CI runner that never ran
      // `playwright install`) is a skip, not a failure of the product.
      if (!existsSync(chromium.executablePath())) continue;
      return chromium;
    } catch {
      /* next */
    }
  }
  return null;
}

// ------------------------------------------------------------ the client

/**
 * The page: the real providers in App.tsx's order, and the procurement panel
 * behind the very gate AdminInventory.tsx puts it behind. `window.__auth` is
 * the real useAuth() value, so the test signs in and out through the real
 * AuthContext functions.
 */
const ENTRY = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { AuthProvider, useAuth } from '../src/AuthContext';
import { LanguageProvider } from '../src/LanguageContext';
import ProcurementPanel from '../src/components/adminOperations/ProcurementPanel';
import { privateDrafts } from '../src/lib/privateDrafts';

(window as unknown as { __drafts: unknown }).__drafts = privateDrafts;

function Gate() {
  const auth = useAuth();
  (window as unknown as { __auth: unknown }).__auth = auth;
  if (!auth.isLoaded) return <p data-who="loading">loading</p>;
  return (
    <div data-who={auth.user?.id ?? 'anonymous'}>
      {auth.user?.can_view_cost === true ? <ProcurementPanel onChanged={() => {}} /> : <p>no procurement for this account</p>}
    </div>
  );
}
createRoot(document.getElementById('root')!).render(
  <AuthProvider><LanguageProvider><Gate /></LanguageProvider></AuthProvider>,
);
`;

const HTML = '<!doctype html><html lang="en"><head><meta charset="utf-8"></head><body><div id="root"></div><script type="module" src="/harness.js"></script></body></html>';

async function bundle(): Promise<string> {
  const out = await build({
    stdin: { contents: ENTRY, resolveDir: join(ROOT, 'tests'), sourcefile: 'purchase-draft-harness.tsx', loader: 'tsx' },
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    jsx: 'automatic',
    logLevel: 'silent',
    loader: { '.css': 'empty', '.svg': 'empty', '.png': 'empty', '.jpg': 'empty', '.webp': 'empty', '.woff': 'empty', '.woff2': 'empty', '.mp4': 'empty', '.glb': 'empty' },
    define: {
      'process.env.NODE_ENV': '"production"',
      'import.meta.env': JSON.stringify({ DEV: false, PROD: true, MODE: 'production', BASE_URL: '/', SSR: false }),
    },
    plugins: [
      {
        // vite.config.ts aliases '@' to the repository root.
        name: 'at-alias',
        setup(b) {
          b.onResolve({ filter: /^@\// }, (args) => b.resolve(`./${args.path.slice(2)}`, { resolveDir: ROOT, kind: args.kind }));
        },
      },
    ],
  });
  return out.outputFiles[0].text;
}

// ------------------------------------------------------------ the server

const db = seedRoleMatrix();
/** What the browser's session cookie resolves to on the server right now. */
let sessionUser: StubUser | null = null;
const ACCOUNTS: StubUser[] = [OWNER, ...(Object.values(ROLES).filter(Boolean) as StubUser[])];
const workerFor = (user: StubUser | null) =>
  stubApp(asD1(db), user, (a) => {
    a.route('/api/auth', authRoutes);
    a.route('/api/admin/procurement', adminProcurementRoutes);
  });

async function meFor(user: StubUser | null): Promise<unknown> {
  const res = await workerFor(user).request('/api/auth/me', { headers: { 'CF-Connecting-IP': '127.0.0.1' } }, undefined, ctx);
  return ((await res.json()) as { user: unknown }).user;
}

const readBody = (req: IncomingMessage) =>
  new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

let js = '';
async function handle(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const method = req.method ?? 'GET';
  if (url.pathname === '/' || url.pathname === '/index.html') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(HTML);
  }
  if (url.pathname === '/harness.js') {
    res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' });
    return res.end(js);
  }
  if (!url.pathname.startsWith('/api/')) {
    res.writeHead(404);
    return res.end();
  }
  const body = await readBody(req);
  // Sign-in: the session cookie now belongs to the account named; the client
  // reads only `user` from the answer, and gets the real /me description.
  if (url.pathname === '/api/auth/login' && method === 'POST') {
    const { email } = JSON.parse(body.toString() || '{}') as { email?: string };
    const account = ACCOUNTS.find((u) => u.email === email);
    if (!account) return sendJson(res, 401, { success: false, error: 'bad credentials' });
    sessionUser = account;
    return sendJson(res, 200, { success: true, user: await meFor(account) });
  }
  if (url.pathname === '/api/auth/logout' && method === 'POST') {
    sessionUser = null;
    return sendJson(res, 200, { success: true });
  }
  const headers = new Headers({ 'CF-Connecting-IP': '127.0.0.1' });
  if (req.headers['content-type']) headers.set('content-type', String(req.headers['content-type']));
  const r = await workerFor(sessionUser).request(
    url.pathname + url.search,
    { method, headers, body: method === 'GET' || method === 'HEAD' ? undefined : body },
    undefined,
    ctx,
  );
  const outHeaders: Record<string, string> = {};
  r.headers.forEach((v, k) => {
    outHeaders[k] = v;
  });
  res.writeHead(r.status, outHeaders);
  res.end(Buffer.from(await r.arrayBuffer()));
}

// ------------------------------------------------------------ lifecycle

const chromium = loadChromium();
let server: Server;
let base = '';
let browser: PwBrowser;
const offHost: string[] = [];
const pageErrors: string[] = [];

before(async () => {
  if (!chromium) return;
  js = await bundle();
  server = createServer((req, res) => {
    handle(req, res).catch((e) => {
      res.writeHead(500);
      res.end(String(e));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}/`;
  browser = await chromium.launch({ args: ['--no-sandbox'] });
});

after(async () => {
  if (browser) await browser.close();
  if (server) await new Promise<void>((r) => server.close(() => r()));
  db.close();
  // LOCAL ONLY: nothing in this file may leave 127.0.0.1.
  assert.deepEqual(offHost, [], 'the harness reached a host other than 127.0.0.1');
});

const skip = chromium ? false : 'Playwright/Chromium not resolvable (set PLAYWRIGHT_MODULE)';

/** One browser profile: its localStorage survives every page load in it. */
async function profile(): Promise<PwContext> {
  const context = await browser.newContext();
  await context.route('**/*', (route) => {
    const u = new URL(route.request().url());
    if (u.hostname === '127.0.0.1') void route.continue();
    else {
      offHost.push(u.href);
      void route.abort();
    }
  });
  // English labels for the panel's buttons (LanguageContext reads this key).
  await context.addInitScript(() => {
    try {
      if (!localStorage.getItem('levo_lang')) localStorage.setItem('levo_lang', 'en');
    } catch {
      /* ignore */
    }
  });
  return context;
}

async function open(context: PwContext, expectWho: string): Promise<PwPage> {
  const page = await context.newPage();
  page.on('pageerror', (e) => pageErrors.push(e.message));
  await page.goto(base);
  await page.waitForFunction((who: string) => document.querySelector('[data-who]')?.getAttribute('data-who') === who, expectWho, { timeout: 20_000 });
  await settle(page);
  return page;
}

/** Let React commit and run the effects that follow (AuthContext's identity effect). */
const settle = (page: PwPage) => page.evaluate(() => new Promise<void>((r) => setTimeout(r, 150)));

/** Everything this origin's localStorage holds, parsed where it is JSON — what devtools shows. */
async function storage(page: PwPage): Promise<Record<string, unknown>> {
  const rawStore = await page.evaluate(() => {
    const o: Record<string, string> = {};
    for (let i = 0; i < localStorage.length; i += 1) {
      const k = localStorage.key(i)!;
      o[k] = localStorage.getItem(k) ?? '';
    }
    return o;
  });
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(rawStore)) {
    try {
      out[k] = JSON.parse(v);
    } catch {
      out[k] = v;
    }
  }
  return out;
}

/** Leak-scanner findings, reduced to path + key (never the value: no cost in logs). */
const findings = (store: Record<string, unknown>) => leaks(store).map((f) => f.replace(/\s*(=|∈|⊃).*$/, ''));

/** The in-tab draft the real panel keeps (src/lib/privateDrafts.ts), parsed, or null. */
const tabDraft = (page: PwPage) =>
  page.evaluate((key: string) => {
    const raw = (window as unknown as { __drafts: { getItem(k: string): string | null } }).__drafts.getItem(key);
    return raw ? (JSON.parse(raw) as unknown) : null;
  }, DRAFT_KEY);

/**
 * THE OWNER, THROUGH THE REAL PANEL: open the sentinel purchase po1, press
 * «Edit / resume draft» (or «Clone purchase»), and let the panel's own
 * 600 ms autosave write the draft — into this tab's memory. Returns the
 * owner's still-open page.
 */
async function ownerEditsAPurchase(context: PwContext): Promise<PwPage> {
  sessionUser = OWNER;
  const page = await open(context, OWNER.id);
  await press(page, ['Open']);
  await press(page, ['Edit / resume draft', 'Clone purchase']);
  await page.waitForFunction(
    (key: string) => !!(window as unknown as { __drafts: { getItem(k: string): string | null } }).__drafts.getItem(key),
    DRAFT_KEY,
    { timeout: 20_000 },
  );
  const draft = await tabDraft(page);
  assert.ok(draft, "the real panel autosaved the owner's draft");
  assert.ok(findings({ [DRAFT_KEY]: draft }).length > 0, "the owner's autosaved draft carries the purchase's private cost (the scanner sees it)");
  // …and none of it is at rest, even while the owner is still editing.
  assert.deepEqual(findings(await storage(page)), [], "the owner's draft never reaches the browser's storage");
  return page;
}

/**
 * Press the first enabled button whose text is one of `labels` (in that
 * order of preference), the way a tap does: a DOM click React handles. The
 * harness ships no stylesheet, so pointer hit-testing on the unstyled layout
 * is meaningless; the click event is what the panel reacts to.
 */
async function press(page: PwPage, labels: string[]) {
  await page.waitForFunction(
    (ls: string[]) => Array.from(document.querySelectorAll('button')).some((b) => ls.includes(b.textContent?.trim() ?? '') && !b.disabled),
    labels,
    { timeout: 20_000 },
  );
  await page.evaluate((ls: string[]) => {
    const buttons = Array.from(document.querySelectorAll('button')).filter((b) => !b.disabled);
    for (const l of ls) {
      const b = buttons.find((x) => x.textContent?.trim() === l);
      if (b) return b.click();
    }
  }, labels);
}

/** The owner's session ends without an in-tab sign-out, and the owner's tab is gone. */
async function ownerSessionEndsElsewhere(ownerPage: PwPage) {
  sessionUser = null;
  await ownerPage.close();
}

// ------------------------------------------------------------ controls

test('CONTROL: the real panel autosaves the owner’s draft into the tab — a reload starts clean, nothing at rest', { skip, timeout: 120_000 }, async () => {
  const context = await profile();
  try {
    const ownerPage = await ownerEditsAPurchase(context);
    await ownerPage.close();
    const again = await open(context, OWNER.id);
    assert.equal(await tabDraft(again), null, 'a new page load holds no in-tab draft');
    assert.equal((await storage(again))[DRAFT_KEY], undefined, 'and no copy at rest');
  } finally {
    await context.close();
  }
});

test('CONTROL: the owner signs out inside the tab — the draft goes and the scanner is silent', { skip, timeout: 120_000 }, async () => {
  const context = await profile();
  try {
    const page = await ownerEditsAPurchase(context);
    await page.evaluate(() => (window as unknown as { __auth: { logout(): Promise<void> } }).__auth.logout());
    await page.waitForFunction(() => document.querySelector('[data-who]')?.getAttribute('data-who') === 'anonymous', undefined, { timeout: 20_000 });
    await settle(page);
    const store = await storage(page);
    assert.equal(await tabDraft(page), null, 'an in-tab sign-out clears the in-tab draft (the real AuthContext ran)');
    assert.equal(store[DRAFT_KEY], undefined, 'and nothing of it is at rest');
    assert.deepEqual(findings(store), [], 'nothing else in storage trips the scanner');
  } finally {
    await context.close();
  }
});

// ------------------------------------------------------------ the candidate

const NON_OWNERS = Object.keys(ROLES) as RoleName[];

for (const role of NON_OWNERS) {
  const account = ROLES[role];
  test(`owner's session ends elsewhere, then «${role}» uses this browser: no private cost in its storage`, { skip, timeout: 120_000 }, async () => {
    const context = await profile();
    try {
      await ownerSessionEndsElsewhere(await ownerEditsAPurchase(context));
      // The next page load on this browser: /api/auth/me answers null.
      const page = await open(context, 'anonymous');
      if (account) {
        // In-app sign-in through the real AuthContext.login.
        await page.evaluate((email: string) => (window as unknown as { __auth: { login(e: string, p: string): Promise<void> } }).__auth.login(email, 'pw'), account.email);
        await page.waitForFunction((id: string) => document.querySelector('[data-who]')?.getAttribute('data-who') === id, account.id, { timeout: 20_000 });
        await settle(page);
        const me = (await page.evaluate(() => (window as unknown as { __auth: { user: { is_owner?: boolean; can_view_cost?: boolean } | null } }).__auth.user)) ?? null;
        assert.notEqual(me?.is_owner, true, `${role} is not the owner`);
        assert.notEqual(me?.can_view_cost, true, `${role} may not see cost`);
      }
      const found = findings(await storage(page));
      assert.deepEqual(
        found,
        [],
        `«${role}» on this browser after the owner's session ended elsewhere still holds the owner's purchase draft (${DRAFT_KEY}): ${found.join('; ')}`,
      );
    } finally {
      await context.close();
    }
  });
}

test("owner's session ends elsewhere, then a staff admin's sign-in lands on a fresh page load: no private cost in its storage", { skip, timeout: 120_000 }, async () => {
  const context = await profile();
  try {
    await ownerSessionEndsElsewhere(await ownerEditsAPurchase(context));
    // A sign-in that completes on a new page load (Google redirect, emailed
    // link, Telegram): the first /api/auth/me answer is already the staff admin.
    sessionUser = ROLES.full;
    const page = await open(context, ROLES.full!.id);
    const found = findings(await storage(page));
    assert.deepEqual(
      found,
      [],
      `a full-scope staff admin's first page load after the owner's session ended still holds the owner's purchase draft (${DRAFT_KEY}): ${found.join('; ')}`,
    );
  } finally {
    await context.close();
  }
});

test('no uncaught page error while the real client ran', { skip }, () => {
  assert.deepEqual(pageErrors, []);
});
