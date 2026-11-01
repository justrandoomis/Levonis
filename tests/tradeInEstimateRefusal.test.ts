/**
 * ESTIMATE REFUSALS ON THE TRADE-IN SCREENS, ROUND 3 (docs/SMART_PRICING.md §6.9, §11; migration
 * 0218; review items r3-tradein-bundle and r3-intake-ckb).
 *
 *   BUNDLE  a /trade-in visit never loads the estimate contract (packages/contracts/src/priceEstimates.ts,
 *           a lazy chunk of its own): no static import path from the route module reaches it, read
 *           off the syntax tree of src/ and packages/. The screens carry a COPY of the three estimate
 *           refusals the doors they call can answer (in parts.tsx, which only the route loads),
 *           pinned equal to the contract:
 *             503 PRICE_ESTIMATES_READ_FAILED     the paid-net read of GET /eligible, POST /requests,
 *                                                POST /requests/:id/preview and /submit (all through
 *                                                `buildEligibility`), and the cart's estimate switch;
 *             409 PRICE_ESTIMATE_ORDERING_PAUSED  the cart door «أكمل الشراء» adds the new device through;
 *             409 PRICE_ESTIMATE_PREORDER_ONLY    the same door: a direct sale of an estimated SKU.
 *           No other door these screens call reads an estimate (the targets pass over a labelled
 *           product, and no trade-in door writes a row a 0218 trigger guards).
 *   INTAKE  the desk's intake sheet says the intake door's 503 PRICE_ESTIMATES_READ_FAILED in the
 *           reader's language, in the contract's words, never the server's «ar / en».
 *
 * Run: node --import tsx --test tests/tradeInEstimateRefusal.test.ts
 */
import { mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import ts from 'typescript';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { DatabaseSync } from 'node:sqlite';
import { asD1, ctx, post, stubApp } from './fixtures/app';
import { ROOT } from './fixtures/d1';
import { adminTradeInRoutes, tradeInRoutes } from '../worker/routes/tradeIn';
import { cartRoutes } from '../worker/routes/cart';
import { CUSTOMER, STAFF, customerApp, restoreFetch, seed, submitted } from './sv2_tradein_fixture';
import { api, ApiError, failureText } from '../src/lib/api';
import { apiRefusal } from '../src/lib/refusalStrings';
import { LanguageProvider } from '../src/LanguageContext';
import { ESTIMATE_REFUSAL_COPY, estimateRefusalCopy, useErrText } from '../src/components/tradeIn/parts';
import { intakeRefusalText } from '../src/components/adminTradeIn/IntakeSheet';
import { adminText } from '../src/components/adminTradeIn/copy';
import { ESTIMATE_REFUSALS, estimateRefusalText, type EstimateLang, type EstimateRefusalCode } from '../packages/contracts/src/priceEstimates';

test.after(restoreFetch);

const LANGS: readonly EstimateLang[] = ['ar', 'en', 'ckb'];
const CONTRACT = 'packages/contracts/src/priceEstimates.ts';
const ROUTE = 'src/pages/TradeIn.tsx';
const INTAKE_SHEET = 'src/components/adminTradeIn/IntakeSheet.tsx';
/** The estimate refusals the trade-in screens' doors can answer (the header). */
const TRADE_IN_CODES: readonly EstimateRefusalCode[] = ['PRICE_ESTIMATES_READ_FAILED', 'PRICE_ESTIMATE_ORDERING_PAUSED', 'PRICE_ESTIMATE_PREORDER_ONLY'];
const READ_FAILED = ESTIMATE_REFUSALS.PRICE_ESTIMATES_READ_FAILED;

const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');
/** A file's code without its comments: a comment may quote what it explains. */
const code = (rel: string) => read(rel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1');

// =========================================================================
//  The static import graph
// =========================================================================

/** A specifier of `from` as a repo file; null for a package of node_modules. An unresolvable one fails. */
function resolveImport(from: string, spec: string): string | null {
  let base: string;
  if (spec.startsWith('.')) base = resolve(dirname(join(ROOT, from)), spec);
  else if (spec.startsWith('@/')) base = join(ROOT, spec.slice(2));
  else if (spec.startsWith('@levonis/')) {
    // The workspaces' exports: '@levonis/<pkg>' → src/index.ts, '@levonis/<pkg>/<path>' → src/<path>.ts.
    const [, pkg, ...rest] = spec.split('/');
    base = join(ROOT, 'packages', pkg, 'src', rest.length ? rest.join('/') : 'index');
  } else return null;
  for (const ext of ['', '.ts', '.tsx', '/index.ts', '/index.tsx']) {
    const file = base + ext;
    if (existsSync(file) && statSync(file).isFile()) return relative(ROOT, file).split(sep).join('/');
  }
  assert.fail(`${from}: '${spec}' resolves to no file`);
}

const sourceOf = (rel: string) => ts.createSourceFile(rel, read(rel), ts.ScriptTarget.Latest, true, rel.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);

/** What a module imports when it loads: every import and re-export except `import type` / `export type`. */
function staticImports(rel: string): string[] {
  const out: string[] = [];
  for (const st of sourceOf(rel).statements) {
    if (ts.isImportDeclaration(st) && !st.importClause?.isTypeOnly) out.push((st.moduleSpecifier as ts.StringLiteral).text);
    else if (ts.isExportDeclaration(st) && st.moduleSpecifier && !st.isTypeOnly) out.push((st.moduleSpecifier as ts.StringLiteral).text);
  }
  return out;
}

/** Every `import('…')` a module can call later. */
function dynamicImports(rel: string): string[] {
  const out: string[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword && n.arguments[0] && ts.isStringLiteral(n.arguments[0])) out.push(n.arguments[0].text);
    ts.forEachChild(n, visit);
  };
  visit(sourceOf(rel));
  return out;
}

/** The modules `start` loads with it (static imports, transitively), each with the module that imported it. */
function closure(start: string): Map<string, string | null> {
  const by = new Map<string, string | null>([[start, null]]);
  const queue = [start];
  while (queue.length) {
    const f = queue.shift()!;
    if (!/\.(tsx?|mjs)$/.test(f)) continue;
    for (const spec of staticImports(f)) {
      const to = resolveImport(f, spec);
      if (to && !by.has(to)) {
        by.set(to, f);
        queue.push(to);
      }
    }
  }
  return by;
}

const pathTo = (graph: Map<string, string | null>, target: string) => {
  const path: string[] = [];
  for (let at: string | null = target; at; at = graph.get(at) ?? null) path.unshift(at);
  return path.join(' → ');
};

// =========================================================================
//  BUNDLE
// =========================================================================

test('BUNDLE: no static import path from the /trade-in route reaches the estimate contract, and none of its modules loads it lazily', () => {
  // The route module, as App.tsx loads it.
  assert.match(read('src/App.tsx'), /const TradeIn = React\.lazy\(\(\) => import\('\.\/pages\/TradeIn'\)\);/);
  const route = closure(ROUTE);
  // The walk is real: it reaches the screens, their words and the shop's refusal table…
  for (const f of ['src/components/tradeIn/parts.tsx', 'src/components/tradeIn/copy.ts', 'src/components/tradeIn/RequestTimeline.tsx', 'src/lib/refusalStrings.ts']) {
    assert.ok(route.has(f), `${f} is not in the route's graph`);
  }
  // …and finds the contract wherever a module imports it.
  for (const f of [INTAKE_SHEET, 'src/pages/Checkout.tsx']) assert.ok(closure(f).has(CONTRACT), `${f} should reach the contract`);
  assert.equal(route.has(CONTRACT), false, `the /trade-in route loads the contract: ${pathTo(route, CONTRACT)}`);
  // A normal visit never asks for the chunk either: no module of the route imports it on demand.
  const lazy = [...route.keys()].filter((f) => /\.(tsx?|mjs)$/.test(f)).flatMap((f) => dynamicImports(f).map((spec) => [f, resolveImport(f, spec)] as const));
  assert.deepEqual(lazy.filter(([, to]) => to === CONTRACT), []);
  // The copy rides with the route only: the product page's trade-in entry and the profile's card load copy.ts, never parts.tsx.
  for (const f of ['src/components/tradeIn/ProductTradeInEntry.tsx', 'src/components/tradeIn/MyServicesCard.tsx']) {
    const g = closure(f);
    assert.ok(g.has('src/components/tradeIn/copy.ts'), f);
    assert.equal(g.has('src/components/tradeIn/parts.tsx'), false, `${f} loads the refusal copy: ${pathTo(g, 'src/components/tradeIn/parts.tsx')}`);
  }
  assert.doesNotMatch(read('src/components/tradeIn/copy.ts'), /PRICE_ESTIMATE/);
});

test('BUNDLE: the copy is the contract’s own words, for exactly the refusals those doors answer', () => {
  assert.deepEqual(Object.keys(ESTIMATE_REFUSAL_COPY).sort(), [...TRADE_IN_CODES].sort());
  for (const c of TRADE_IN_CODES) {
    const { ar, en, ckb, audience } = ESTIMATE_REFUSALS[c];
    assert.equal(audience, 'customer', c);
    assert.deepEqual({ ...ESTIMATE_REFUSAL_COPY[c as keyof typeof ESTIMATE_REFUSAL_COPY] }, { ar, en, ckb }, `${c}: the copy drifted from the contract`);
    assert.notEqual(ckb as string, ar as string, `${c}: a Sorani slot never carries the Arabic (row 183)`);
    assert.match(ckb, /[ڕڵێۆە]/, `${c}: the Sorani is written in Sorani letters`);
    // Read the way the contract reads it: by code, or off the error carrying it.
    for (const l of LANGS) {
      assert.equal(estimateRefusalCopy(c, l), estimateRefusalText(c, l), `${c}.${l}`);
      assert.equal(estimateRefusalCopy(new ApiError(503, `${ar} / ${en}`, c), l), estimateRefusalText({ code: c }, l), `${c}.${l}`);
    }
  }
  // Any other code is not the copy's: the screens' old chain speaks for it.
  const others = Object.keys(ESTIMATE_REFUSALS).filter((c) => !(TRADE_IN_CODES as readonly string[]).includes(c));
  for (const other of [...others, 'TRADE_IN_DRAFT_LIMIT', '', 'toString', '__proto__', null, undefined, 42, {}, { code: 7 }]) {
    for (const l of LANGS) assert.equal(estimateRefusalCopy(other, l), null, `${String(other)}.${l}`);
  }
  // Small: the three sentences in three languages, not the contract.
  const bytes = Buffer.byteLength(JSON.stringify(ESTIMATE_REFUSAL_COPY), 'utf8');
  assert.ok(bytes < 1600, `the copy is ${bytes} bytes`);
});

// The language provider reads `levo_lang` from localStorage when it mounts.
let LANG: EstimateLang = 'ar';
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => (k === 'levo_lang' ? LANG : null),
  setItem: () => undefined,
  removeItem: () => undefined,
};

/** What the trade-in screens' `useErrText()` says for `e`, rendered in `lang`. */
function screenSays(e: unknown, lang: EstimateLang): string {
  LANG = lang;
  const Probe = () => createElement('p', null, useErrText()(e));
  return renderToStaticMarkup(createElement(LanguageProvider, { children: createElement(Probe) }))
    .replace(/<[^>]+>/g, '')
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&');
}

/** A database whose reads of `table` fail; every other read is the real one. */
function refusing(raw: DatabaseSync, table: string): D1Database {
  const inner = asD1(raw);
  const fail = async () => {
    throw new Error('D1_ERROR: database is locked');
  };
  return {
    inner,
    prepare: (sql: string) =>
      sql.includes(table) ? { bind: () => ({ all: fail, first: fail, run: fail, raw: fail }), all: fail, first: fail, run: fail, raw: fail } : inner.prepare(sql),
    batch: (s: D1PreparedStatement[]) => inner.batch(s),
    exec: (q: string) => inner.exec(q),
  } as unknown as D1Database;
}

/** The error the real client (src/lib/api.ts) throws for `call`, against `app`; null when it answered. */
async function clientError(app: ReturnType<typeof stubApp>, call: () => Promise<unknown>): Promise<ApiError | null> {
  const prev = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) =>
    app.request(String(input), { ...init, headers: { ...(init?.headers as Record<string, string>), 'CF-Connecting-IP': '1.2.3.4' } }, undefined, ctx)) as typeof fetch;
  const error = mock.method(console, 'error', () => undefined);
  try {
    await call();
    return null;
  } catch (e) {
    assert.ok(e instanceof ApiError, String(e));
    return e;
  } finally {
    error.mock.restore();
    globalThis.fetch = prev;
  }
}

/** The screens' words for `e` before round 2: the shop's table, then the server's sentence, then the fallback. */
const before = (e: unknown, lang: EstimateLang) => apiRefusal(e, lang) || failureText(e, 'x');

function saysInEveryLanguage(e: ApiError | null, status: number, c: EstimateRefusalCode) {
  assert.ok(e, `${c}: the door answered`);
  assert.deepEqual([e.status, e.code], [status, c]);
  const words = ESTIMATE_REFUSALS[c];
  // The server sends "ar / en": what the screens printed to every reader before round 2.
  assert.equal(e.message, `${words.ar} / ${words.en}`);
  for (const l of LANGS) {
    assert.equal(before(e, l), e.message, `${c}.${l}: the shop's table has no entry for it`);
    assert.equal(screenSays(e, l), words[l], `${c}.${l}`);
  }
}

test('BUNDLE: the draft door answers PRICE_ESTIMATES_READ_FAILED when the estimate records cannot be read, and the screen says it in ar, en and ckb', async () => {
  const raw = seed();
  const app = stubApp(refusing(raw, 'order_price_estimates'), CUSTOMER, (a) => a.route('/api/trade-in', tradeInRoutes));
  const e = await clientError(app, () => api.post('/api/trade-in/requests', { order_item_id: 'oi_a1', unit_index: 1, scope: 'whole' }));
  saysInEveryLanguage(e, 503, 'PRICE_ESTIMATES_READ_FAILED');
  // Fail closed: no draft was opened.
  assert.equal((raw.prepare('SELECT COUNT(*) AS n FROM trade_in_requests').get() as { n: number }).n, 0);
});

test('BUNDLE: the cart door «أكمل الشراء» adds the new device through answers the other two, for a device whose price became an estimate', async () => {
  const raw = seed();
  const app = customerApp(raw);
  // The body RequestTimeline's «أكمل الشراء» sends for the credit's device (P1S).
  const body = { productId: 'p_p1s', qty: 1, fulfillmentType: 'direct_sale' };
  assert.equal((await post(app, '/api/cart/items', body)).status, 200, 'an ordinary device is added');
  raw.exec("DELETE FROM cart_items WHERE user_id = 'cust'");
  // What an applied estimate leaves (trigger T1: only under the product's price token).
  raw.exec(`INSERT INTO ops_guards (id, ok) VALUES ('engine-price:p_p1s', 1);
    UPDATE products SET price_estimate = 1 WHERE id = 'p_p1s';
    DELETE FROM ops_guards WHERE id = 'engine-price:p_p1s';`);
  saysInEveryLanguage(await clientError(app, () => api.post('/api/cart/items', body)), 409, 'PRICE_ESTIMATE_PREORDER_ONLY');
  raw.exec('UPDATE price_estimate_control SET ordering_enabled = 0 WHERE id = 1');
  saysInEveryLanguage(await clientError(app, () => api.post('/api/cart/items', body)), 409, 'PRICE_ESTIMATE_ORDERING_PAUSED');
  raw.exec('UPDATE price_estimate_control SET ordering_enabled = 1 WHERE id = 1');
  const unread = stubApp(refusing(raw, 'price_estimate_control'), CUSTOMER, (a) => a.route('/api/cart', cartRoutes));
  saysInEveryLanguage(await clientError(unread, () => api.post('/api/cart/items', body)), 503, 'PRICE_ESTIMATES_READ_FAILED');
  assert.equal((raw.prepare("SELECT COUNT(*) AS n FROM cart_items WHERE user_id = 'cust'").get() as { n: number }).n, 0, 'nothing was added');
});

// =========================================================================
//  INTAKE
// =========================================================================

test('INTAKE: the desk reads the intake door’s 503 PRICE_ESTIMATES_READ_FAILED in its own language, never the server’s «ar / en»', async () => {
  const raw = seed();
  raw.prepare("INSERT INTO device_serials (serial_norm, serial_raw, unit_id, assigned_by) VALUES ('A1SERIAL0001', 'A1SERIAL0001', 'unit_a1', 'staff')").run();
  const id = await submitted(raw);
  const desk = stubApp(refusing(raw, 'order_price_estimates'), STAFF, (a) => a.route('/api/admin/trade-in', adminTradeInRoutes));
  // What the sheet's «submit» posts.
  const e = await clientError(desk, () =>
    api.post(`/api/admin/trade-in/requests/${encodeURIComponent(id)}/intake`, {
      serial: 'A1SERIAL0001',
      hours: 40,
      components: { device: { cleanliness: 4, exterior: 4, scratches: 4, faults: [], original_accessories: 'all' } },
      findings: '',
      handover: 'store',
    })
  );
  assert.ok(e);
  assert.deepEqual([e.status, e.code], [503, 'PRICE_ESTIMATES_READ_FAILED']);
  assert.equal(e.message, `${READ_FAILED.ar} / ${READ_FAILED.en}`);
  // Fail closed: the device is not received.
  assert.deepEqual({ ...(raw.prepare('SELECT intake_at, status FROM trade_in_requests WHERE id = ?').get(id) as object) }, { intake_at: null, status: 'submitted' });
  for (const l of LANGS) {
    const fallback = adminText('failed', l);
    // The sheet before: the server's sentence, both languages at once, to every reader.
    assert.equal(apiRefusal(e, l, fallback), e.message, l);
    assert.equal(intakeRefusalText(e, l, fallback), READ_FAILED[l], l);
  }
  // Every other refusal reads exactly as before.
  const others: unknown[] = [
    new ApiError(409, 'server words', 'TRADE_IN_SERIAL_MISMATCH'),
    new ApiError(409, 'server words', 'TRADE_IN_ALREADY_RECEIVED'),
    new ApiError(400, 'Unsupported file type — please upload a JPEG, PNG or WebP photo'),
    new ApiError(500, '', 'SOME_OTHER_CODE'),
    new ApiError(0, 'network', 'NETWORK'),
    new Error('plain'),
    null,
  ];
  for (const other of others) {
    for (const l of LANGS) assert.equal(intakeRefusalText(other, l, adminText('failed', l)), apiRefusal(other, l, adminText('failed', l)), `${String((other as { code?: unknown })?.code ?? other)}.${l}`);
  }
  // Both of the sheet's catches say it so: the photo upload and the submit.
  const sheet = code(INTAKE_SHEET);
  assert.equal((sheet.match(/setError\(intakeRefusalText\(e, refusalLang\(lang\), a\('failed'\)\)\)/g) ?? []).length, 2);
  assert.equal((sheet.match(/\bapiRefusal\(/g) ?? []).length, 1, 'apiRefusal only inside intakeRefusalText');
  assert.match(sheet, /export const intakeRefusalText = \(e: unknown, lang: Lang, fallback: string\): string => estimateRefusalText\(e, lang\) \?\? apiRefusal\(e, lang, fallback\);/);
});
