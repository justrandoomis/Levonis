/**
 * LEAK AUDIT — client bundles: the gap in tests/bundlePrivateNames.test.ts
 * (candidate `bundle-private-names-guard-gap`).
 *
 * Every chunk under dist/assets is a public static file. The existing guard
 * looks at that output with 14 FX names only (NEVER_IN_CUSTOMER_CODE) and, at
 * first paint, only `/api/admin/pricing` and `/rates/fx`. It knows nothing of
 * the owner's product-cost / pricing-engine names, the data file's owner block,
 * the completeness list's PRIVATE codes or the owner's finance routes, and it
 * never looks for a VALUE.
 *
 * This test downloads nothing: it walks dist/ the way an ANONYMOUS VISITOR's
 * browser does — index.html, its preloads, every static import and every lazy
 * `import()` together with the files Vite preloads for it (`__vite__mapDeps`)
 * — stopping only at the admin shell (`Admin-*.js`), so what it reaches is what
 * the storefront, product page, cart, checkout, account, merchant and
 * community pages load. On that set it asserts:
 *
 *   1. the walk is real: it reaches the product page, cart and checkout and
 *      none of the owner's chunks the existing guard exempts;
 *   2. NO chunk at all (customer or admin — all are public) carries a baked-in
 *      private VALUE: no private key (FINANCIAL_FIELDS, the data file's
 *      PRICING_KEYS, the print buying-price / margin keys) is ever assigned a
 *      non-zero number literal, and neither the Worker's DEFAULT_PRICING margin
 *      / money figures nor DEFAULT_MATERIALS' buying prices are bundled (with a
 *      positive control proving the scan sees such a value in minified code);
 *   3. no customer-reachable chunk names the owner's private pricing / cost
 *      fields — the names the server itself calls private (`isPrivateKey`,
 *      `COMPLETENESS_ENTRIES[*].private`, FINANCIAL_FIELDS, PRICING_KEYS);
 *   4. the first paint names none of the owner-only cost routes
 *      (`/api/admin/finance*` sits behind requireCostRead exactly like
 *      `/api/admin/pricing`, which the existing guard already forbids there);
 *   5. the existing guard's heuristic exemption (`code.includes('/api/admin/pricing')`)
 *      swallows no customer chunk today.
 *
 * Allowed for customers and therefore NOT in the private lists below: the
 * final price, and the Direct Sale Extra (`direct_sale_extra_iqd`), which the
 * owner explicitly lets customers see. Also left out, each with its own reason:
 *   - `cost_iqd` — on a customer page it is the per-piece accessory price that
 *     GET /api/print-quote/accessories publishes by design (judged separately
 *     as candidate accessory-buying-cost-public) and a merchant's own workshop
 *     costing; `product_cost_iqd` and the others below still catch the owner's;
 *   - `margin_percent`, `profit_iqd` — the merchant's OWN workshop costing and
 *     a participant's own earnings, the viewer's data, not the owner's;
 *   - `amount_usd` — a wallet amount.
 *
 * RESULT (dist/ built from 85ac5e30, 384 chunks, 300 reached by the walk):
 * 2 passes — no private VALUE is in any chunk; 3 FAILS — the shared
 * productCompleteness chunk (preloaded with Requests/Product/Cart/Checkout via
 * src/lib/refusalStrings.ts → packages/contracts/src/productCompleteness.ts)
 * carries the PRIVATE completeness entries COST and ENGINE_INPUTS: TXT keys
 * `product_cost_iqd` and `pricing.rules.minimum_target_profit_usd`, flagged
 * `private:!0`, with hints that spell out the pricing chain («the minimum
 * profit and the shipping data in USD pricing»), in all three languages;
 * 4 FAILS — the first-paint entry chunk names /api/admin/finance/report/*,
 * /api/admin/finance/expenses and /expense-categories (src/lib/api.ts). The
 * existing guard passes on the same build: none of these is in its list.
 *
 * Without a build it skips; with REQUIRE_DIST=1 a missing build fails (the
 * same convention as tests/bundlePrivateNames.test.ts).
 *
 * Run: npx vite build && node --import tsx --test tests/leakAudit_client-bundles_bundle_private_names_guard_gap.test.ts
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { COMPLETENESS_ENTRIES } from '../packages/contracts/src/productCompleteness';
import { PRICING_KEYS, isPrivateKey } from '../worker/lib/productDataFile';
import { FINANCIAL_FIELDS } from '../worker/lib/adminScope';
import { DEFAULT_MATERIALS, DEFAULT_PRICING } from '../worker/lib/printPricing';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist');
const ASSETS = join(DIST, 'assets');
const built = existsSync(join(DIST, 'index.html')) && existsSync(ASSETS);
const skip = !built && process.env.REQUIRE_DIST !== '1' ? 'no dist/ — run npm run build first (REQUIRE_DIST=1 makes this a failure)' : false;

// ---------------------------------------------------------------- the build

interface Graph {
  code: Map<string, string>;
  firstPaint: string[];
  /** chunk → the chunk the walk first reached it from (null for the first paint). */
  parent: Map<string, string | null>;
  /** chunk → the lazy page it was preloaded with, when the walk reached it off a preload table. */
  via: Map<string, string>;
}

/** The admin shell. Everything reachable only through it is the admin's. */
const BARRIER = /^Admin-[A-Za-z0-9_-]+\.js$/;

function load(): Graph {
  const code = new Map<string, string>();
  for (const f of readdirSync(ASSETS)) if (f.endsWith('.js')) code.set(f, readFileSync(join(ASSETS, f), 'utf8'));
  const html = readFileSync(join(DIST, 'index.html'), 'utf8');
  const firstPaint = [...new Set([...html.matchAll(/(?:src|href)="\/?assets\/([^"]+\.js)"/g)].map((m) => m[1]!))];

  /** Each edge: the chunk it leads to, and the lazy page it is preloaded with (when it comes off `__vite__mapDeps`). */
  const edges = (f: string): Array<[string, string | null]> => {
    const c = code.get(f) ?? '';
    // Vite's preload table: `m.f=["assets/A.js","assets/B.js",…]`, indexed by __vite__mapDeps([i,…]).
    const table = c.match(/m\.f=\[([^\]]*)\]/);
    const files = table ? [...table[1]!.matchAll(/"assets\/([^"]+)"/g)].map((m) => m[1]!) : [];
    const out: Array<[string, string | null]> = [];
    for (const m of c.matchAll(/(?:from|import)\s*"\.\/([^"]+\.js)"/g)) out.push([m[1]!, null]);
    for (const m of c.matchAll(/import\("\.\/([^"]+\.js)"\)/g)) {
      const target = m[1]!;
      if (BARRIER.test(target)) continue; // the admin shell and the files preloaded only for it
      const tail = c.slice(m.index!, m.index! + 600);
      const next = tail.indexOf('import(', 8);
      const deps = (next < 0 ? tail : tail.slice(0, next)).match(/__vite__mapDeps\(\[([\d,]*)\]\)/);
      out.push([target, null]);
      if (deps) for (const i of deps[1]!.split(',').filter(Boolean)) if (files[Number(i)]) out.push([files[Number(i)]!, target]);
    }
    return out.filter(([x]) => x.endsWith('.js'));
  };

  const parent = new Map<string, string | null>();
  const via = new Map<string, string>();
  const queue: string[] = [];
  for (const f of firstPaint) if (code.has(f)) { parent.set(f, null); queue.push(f); }
  while (queue.length) {
    const f = queue.shift()!;
    for (const [to, with_] of edges(f)) {
      if (!code.has(to) || parent.has(to)) continue;
      parent.set(to, f);
      if (with_) via.set(to, with_);
      queue.push(to);
    }
  }
  return { code, firstPaint, parent, via };
}

const esc = (s: string): string => s.replace(/[.*+?^$|()[\]{}\\]/g, '\\$&');

const chain = (g: Graph, f: string): string => {
  const out: string[] = [];
  for (let at: string | null | undefined = f; at; at = g.parent.get(at)) out.unshift(g.via.has(at) ? `${at} (preloaded with ${g.via.get(at)})` : at);
  return out.join(' → ');
};

/** What the existing guard knows (read from its source, so this test cannot drift from it). */
function guardList(): string[] {
  const src = readFileSync(join(ROOT, 'tests', 'bundlePrivateNames.test.ts'), 'utf8');
  const block = src.match(/const NEVER_IN_CUSTOMER_CODE = \[([\s\S]*?)\];/);
  return block ? [...block[1]!.matchAll(/'([^']+)'/g)].map((m) => m[1]!) : [];
}

// ------------------------------------------------------- what is private

/** Allowed for customers (owner): the Direct Sale Extra line. */
const ALLOWED = new Set(['direct_sale_extra_iqd']);
/**
 * Names whose customer-page use is the viewer's own or deliberately public data (see the header).
 * The four printer-economics names joined FINANCIAL_FIELDS with DECISIONS row 220 (so the Worker
 * strips the OWNER's model-card economics from every non-owner answer); on a customer page they are
 * the fields a store owner types for THEIR OWN machines (the merchant dashboard's printers and
 * costing tabs), never the owner's.
 */
const NOT_OWNER_ON_CUSTOMER_PAGES = new Set([
  'cost_iqd',
  'margin_percent',
  'profit_iqd',
  'amount_usd',
  'machine_iqd_per_hour',
  'purchase_iqd',
  'residual_iqd',
  'maintenance_iqd_per_hour',
]);

/** The completeness list's PRIVATE codes: their TXT key and their hint (which describes the pricing chain). */
const PRIVATE_COMPLETENESS = Object.values(COMPLETENESS_ENTRIES).filter((e) => e.private);

/** The print settings the owner alone reads (COST_SETTING_KEYS in worker/routes/admin.ts) and their private fields. */
const PRINT_OWNER_NAMES = ['printPricingConfig', 'printMaterials', 'minMarginPercent', 'price_iqd_per_kg', 'min_margin_percent'];

/** The pricing engine's private tables and fields, by the names the Worker and the TXT owner block use. */
const ENGINE_NAMES = [
  'pricing_inputs',
  'pricing_sku_costs',
  'final_price_usd',
  'pricing_private',
  'pricing_token',
  'minimum_target_profit',
  'target_profit_usd',
  'pricing.base.',
  'pricing.rules.',
  'pricing.options.',
  'pricing.colors.',
  'pricing.skus.',
];

function privateNames(): string[] {
  const names = new Set<string>([
    ...(FINANCIAL_FIELDS as readonly string[]),
    ...PRICING_KEYS,
    ...PRINT_OWNER_NAMES,
    ...ENGINE_NAMES,
    ...PRIVATE_COMPLETENESS.flatMap((e) => [e.txt_key, e.hint.en, e.hint.ar, e.hint.ckb]),
  ]);
  for (const n of [...names]) if (ALLOWED.has(n) || NOT_OWNER_ON_CUSTOMER_PAGES.has(n) || n.length < 6) names.delete(n);
  return [...names];
}

/** Owner-only cost routes (requireCostRead): never at first paint, like /api/admin/pricing. */
const OWNER_COST_ROUTES = ['/api/admin/pricing', '/api/admin/finance'];

// ------------------------------------------------------------------ tests

test('the walk is real: it reaches the customer pages and none of the owner chunks', { skip }, () => {
  const g = load();
  const reached = [...g.parent.keys()];
  assert.ok(g.firstPaint.length > 0, 'index.html references no script');
  for (const page of ['Product-', 'Cart-', 'Checkout-', 'Storefront-']) {
    assert.ok(reached.some((f) => f.startsWith(page)), `the walk never reaches the ${page}*.js customer page`);
  }
  for (const owner of [/^Admin-/, /^AdminPricing-/, /^OwnerRatesCard-/, /^dataFileStrings-/, /^ProductForm-/, /^ReviewSheetV2-/]) {
    assert.ok(!reached.some((f) => owner.test(f)), `the walk reaches an owner chunk (${owner}) — the barrier is wrong`);
  }
  assert.ok(reached.length > 50 && reached.length < g.code.size, `reached ${reached.length} of ${g.code.size}`);
});

/**
 * Every private VALUE a chunk could carry at build time: a private key given a
 * non-zero number literal, the Worker's DEFAULT_PRICING money / margin figures
 * (nested ones member by member), DEFAULT_MATERIALS' buying prices next to
 * their material id. Minified literals (`6e3`, `.45`) are read as numbers.
 */
function valueFindings(chunks: ReadonlyMap<string, string>): string[] {
  // The Worker's own print-pricing defaults: its money and margin keys (the owner-only printPricingConfig).
  const moneyKeys = Object.keys(DEFAULT_PRICING).filter((k) => /iqd|margin|percent/.test(k));
  const keys = [...new Set([...(FINANCIAL_FIELDS as readonly string[]), ...PRICING_KEYS, ...PRINT_OWNER_NAMES, ...moneyKeys])].filter(
    (k) => !ALLOWED.has(k),
  );
  const NUM = '-?(?:\\d+\\.?\\d*|\\.\\d+)(?:e\\d+)?';
  const keyRe = new RegExp(`(?:^|[^A-Za-z0-9_$])"?(${keys.join('|')})"?:(${NUM})(?![A-Za-z0-9_$.])`, 'g');
  /** Nested defaults ({fdm, resin} per process): the whole object, member by member. */
  const nested = Object.entries(DEFAULT_PRICING).filter(
    (e): e is [string, Record<string, number>] => moneyKeys.includes(e[0]) && typeof e[1] === 'object' && e[1] !== null,
  );
  const found = new Set<string>();
  for (const [f, c] of chunks) {
    for (const m of c.matchAll(keyRe)) if (Number(m[2]) !== 0) found.add(`${f}: ${m[1]} = ${m[2]}`);
    for (const [k, obj] of nested) {
      for (const m of c.matchAll(new RegExp(`(?:^|[^A-Za-z0-9_$])"?${k}"?:\\{([^{}]{0,200})\\}`, 'g'))) {
        const pairs = new Map([...m[1]!.matchAll(new RegExp(`"?([A-Za-z_$][\\w$]*)"?:(${NUM})`, 'g'))].map((p) => [p[1]!, Number(p[2])]));
        if (Object.entries(obj).every(([sub, v]) => pairs.get(sub) === v)) found.add(`${f}: DEFAULT_PRICING.${k} = ${JSON.stringify(obj)}`);
      }
    }
    for (const mat of DEFAULT_MATERIALS) {
      if (!mat.price_iqd_per_kg) continue;
      for (const m of c.matchAll(new RegExp(`"${esc(mat.id)}"([^;]{0,160})`, 'g'))) {
        const nums = (m[1]!.match(/-?(?:\d+\.?\d*|\.\d+)(?:e\d+)?/g) ?? []).map(Number);
        if (nums.includes(mat.price_iqd_per_kg)) found.add(`${f}: DEFAULT_MATERIALS ${mat.id} buying price ${mat.price_iqd_per_kg}/kg`);
      }
    }
  }
  return [...found];
}

test('the value scan sees a private value in minified code (positive control)', () => {
  const pla = DEFAULT_MATERIALS.find((m) => m.id === 'pla')!;
  const synthetic = new Map([
    ['a.js', `const x={labor_iqd_per_hour:6e3,target_margin_percent:35};`],
    ['b.js', `const y={machine_hour_iqd:{fdm:${DEFAULT_PRICING.machine_hour_iqd.fdm},resin:${DEFAULT_PRICING.machine_hour_iqd.resin}}};`],
    ['c.js', `fdm("pla","PLA","PLA",1.24,${pla.price_iqd_per_kg / 1000}e3,.05,1,0,.1,!1,!1);`],
    ['d.js', `const z={unit_cost_iqd:611111,supplier_cost_amount:12.5,direct_sale_extra_iqd:5e3,product_cost_iqd:0};`],
  ]);
  const found = valueFindings(synthetic);
  for (const want of ['a.js: labor_iqd_per_hour', 'a.js: target_margin_percent', 'b.js: DEFAULT_PRICING.machine_hour_iqd', 'c.js: DEFAULT_MATERIALS pla', 'd.js: unit_cost_iqd', 'd.js: supplier_cost_amount']) {
    assert.ok(found.some((x) => x.startsWith(want)), `the scan missed «${want}»: ${found.join(' | ')}`);
  }
  // The Direct Sale Extra is allowed, and a zero (a blank form) is not a value.
  assert.ok(!found.some((x) => x.includes('direct_sale_extra_iqd') || x.includes('product_cost_iqd')), found.join(' | '));
});

test('no chunk any visitor can download carries a baked-in private VALUE', { skip }, () => {
  const found = valueFindings(load().code);
  assert.deepEqual(found, [], `private values baked into public chunks:\n${found.join('\n')}`);
});

test('no customer-reachable chunk names the owner\'s private pricing / cost fields', { skip }, () => {
  const g = load();
  const guard = new Set(guardList());
  assert.ok(guard.size >= 10, 'could not read the existing guard\'s list');
  // Sanity: the names below are the ones the server itself treats as private.
  for (const e of PRIVATE_COMPLETENESS) assert.ok(isPrivateKey(e.txt_key), `${e.code}'s TXT key ${e.txt_key} is not private by isPrivateKey`);
  const names = privateNames();
  const found: string[] = [];
  for (const f of g.parent.keys()) {
    const c = g.code.get(f)!;
    for (const n of names) {
      if (!c.includes(n)) continue;
      found.push(`${f} carries «${n}»${guard.has(n) ? '' : ' (not in bundlePrivateNames\' list)'} — reached by ${chain(g, f)}`);
    }
  }
  assert.deepEqual(found, [], `owner-private names in chunks an anonymous visitor's customer pages load:\n${found.join('\n')}`);
});

test('the first paint names none of the owner-only cost routes', { skip }, () => {
  const g = load();
  const found: string[] = [];
  for (const f of g.firstPaint) {
    const c = g.code.get(f) ?? '';
    for (const r of OWNER_COST_ROUTES) {
      const hits = [...new Set(c.match(new RegExp(`${esc(r)}[A-Za-z0-9_/-]*`, 'g')) ?? [])];
      for (const h of hits) found.push(`${f} carries «${h}»`);
    }
  }
  assert.deepEqual(found, [], `owner cost routes in the first paint:\n${found.join('\n')}`);
});

test('the existing guard\'s owner-chunk exemption swallows no customer chunk', { skip }, () => {
  const g = load();
  const swallowed = [...g.parent.keys()].filter(
    (f) => /^(AdminPricing|OwnerRatesCard|dataFileStrings|ProductForm|ReviewSheetV2)-/.test(f) || g.code.get(f)!.includes('/api/admin/pricing'),
  );
  assert.deepEqual(swallowed, [], `customer chunks the existing guard would silently exempt: ${swallowed.join(', ')}`);
});
