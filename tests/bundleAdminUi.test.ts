/**
 * THE ADMIN PANELS AND THE BUY PATH EXIST, AND ARE REACHABLE.
 *
 * These are static assertions over the source, and that is deliberate: the
 * three defects they pin were all "the server route is perfect and nothing in
 * `src/` ever calls it", which no route test can see and no type error can
 * catch.
 *
 *  1. `worker/routes/mystery.ts` registers seventeen admin routes — pool CRUD,
 *     the paginated entries list, the server-side bulk generator, the whole-set
 *     replace with `expected_updated_at`/`STALE_EDIT`, the eligible-stock
 *     preview, offer CRUD, duplicate, rotate-secret and audits — and NO file
 *     under `src/` called `/api/admin/mystery`. So an owner could not create a
 *     mystery offer at all (`worker/routes/adminBundles.ts` pins `kind` to
 *     `'bundle'` on create), could not set a spool count, a pool, a duplicate
 *     policy, a reveal milestone or family narrowing, and TWO of the three
 *     warnings the mandate quotes word for word — `POOL_ZERO_WEIGHT` and
 *     `POOL_TOO_SMALL_FOR_FORBID` — were computed and could never render to a
 *     human.
 *
 *  2. `src/pages/BundleDetail.tsx` was slice 6's deliberately unbuyable page,
 *     and a repo-wide walk found ZERO producers of §5.2's request body:
 *     `bundleChoices`, `mysteryFamilyId` and `mysteryMode` had no sender
 *     anywhere in the app, so the whole slice-7/8 cart and checkout path was
 *     reachable only by seeding `cart_items` directly — which is what the test
 *     suite does and a customer cannot.
 *
 *  3. A composition row's card linked to the ordinary product renderer, which
 *     has nothing to show for one.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './fixtures/d1';

const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

/** Every `.ts`/`.tsx` under `src/`, so "nothing in the app does X" is a
 *  measurement rather than a guess. */
function srcFiles(dir = 'src'): string[] {
  const out: string[] = [];
  for (const e of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const p = `${dir}/${e.name}`;
    if (e.isDirectory()) out.push(...srcFiles(p));
    else if (/\.(ts|tsx)$/.test(e.name)) out.push(p);
  }
  return out;
}

// ------------------------------------------------------- the mystery panels

test('§11.1: the mystery and mystery-pools panels exist and are mounted as their own tabs', () => {
  const admin = read('src/pages/Admin.tsx');
  for (const tab of ['mystery', 'mystery_pools']) {
    assert.match(admin, new RegExp(`\\|\\s*'${tab}'`), `the AdminTab union has no '${tab}' value`);
    assert.match(admin, new RegExp(`id: '${tab}'`), `there is no sidebar row for '${tab}'`);
    assert.match(admin, new RegExp(`activeTab === '${tab}'`), `'${tab}' is never rendered`);
  }
  assert.match(admin, /React\.lazy\(\(\) => import\('\.\.\/components\/adminMystery\/AdminMystery'\)\)/);
  assert.match(admin, /React\.lazy\(\(\) => import\('\.\.\/components\/adminMystery\/AdminMysteryPools'\)\)/);
});

test('§10: every mystery admin capability has a caller in the panels', () => {
  const panels = ['src/components/adminMystery/AdminMystery.tsx', 'src/components/adminMystery/AdminMysteryPools.tsx']
    .map(read)
    .join('\n');
  // The capabilities §10 and §11.1 enumerate, each identified by the path
  // fragment the panel must request.
  for (const [what, fragment] of [
    ['pool CRUD', '/api/admin/mystery/pools'],
    ['the paginated entries list', '/entries?'],
    ['the server-side bulk generator', '/entries/generate'],
    ['the whole-set replace', 'expected_updated_at'],
    ['the eligible-stock preview', '/eligible?'],
    ['offer CRUD', '/api/admin/mystery/offers'],
    ['duplicate', '/duplicate'],
    ['rotate-secret', '/rotate-secret'],
  ] as const) {
    assert.ok(panels.includes(fragment), `${what} has no caller: no panel requests "${fragment}"`);
  }
});

test('§11.3: the pool warnings the mandate quotes reach a human, verbatim and trilingual', () => {
  const pools = read('src/components/adminMystery/AdminMysteryPools.tsx');
  // They arrive as `{code, message, ar, en, ckb}` objects and are rendered
  // through `say(...)` inside a warn Banner — the same path the bundles panel
  // uses. Rendering them any other way prints "[object Object]" (§11.3).
  assert.match(pools, /Banner kind="warn"/, 'the pools panel has no warning banner at all');
  assert.match(pools, /say\(w\)/, 'warnings are not rendered through the trilingual picker');
  assert.match(pools, /warning_details/, 'the server-sent warning objects are never read');
  // And the server still produces the two the mandate names.
  const server = read('worker/lib/mystery/pools.ts');
  for (const code of ['POOL_ZERO_WEIGHT', 'POOL_TOO_SMALL_FOR_FORBID']) {
    assert.ok(server.includes(code), `${code} is no longer produced by the server`);
  }
});

test('§10: the whole-set save sends expected_updated_at and shows the 409 body verbatim', () => {
  const pools = read('src/components/adminMystery/AdminMysteryPools.tsx');
  assert.match(pools, /expected_updated_at: editing\.updated_at/, 'the whole-set save omits the staleness token');
  assert.match(pools, /STALE_EDIT/, 'the 409 has no consumer, so one admin can still destroy another’s work');
});

// ------------------------------------------------------------- the buy path

test('§5.2: the storefront produces the composition request body', () => {
  const files = srcFiles();
  const senders = (field: string) =>
    files.filter((f) => {
      const src = read(f);
      // The FIELD being sent, not merely named in a type or a comment.
      return new RegExp(`body\\.${field}|${field}:\\s`).test(src) && /api\.post|api\.put/.test(src);
    });
  for (const field of ['bundleChoices', 'mysteryFamilyId', 'mysteryMode']) {
    assert.ok(senders(field).length > 0, `no file in src/ ever sends "${field}" — §5.2's body has no producer`);
  }
  const detail = read('src/pages/BundleDetail.tsx');
  assert.match(detail, /api\.post<\{ items: CartItem\[\] \}>\('\/api\/cart\/items'/, 'the bundle page has no add-to-cart');
  assert.match(detail, /\/quote/, 'the bundle page never asks the server to price the selection');
  assert.equal(
    /deliberately UNBUYABLE/.test(detail),
    false,
    'the page still declares itself unbuyable'
  );
});

test('§10: the stepper disables at the server’s max_qty rather than silently no-opping', () => {
  const detail = read('src/pages/BundleDetail.tsx');
  // The shared QuantityInput disables + at `max` (and turns a typed figure
  // above it into it); the page must hand it the server's cap.
  assert.match(detail, /<QuantityInput[\s\S]*?max=\{maxQty\}/, 'the bundle page’s + button never disables');
  assert.match(read('src/components/ui/QuantityInput.tsx'), /disabled=\{disabled \|\| atMax\}/);
  const cart = read('src/pages/Cart.tsx');
  assert.match(cart, /lineCap\(item\)/, 'the cart’s + button ignores the composition cap');
  assert.match(cart, /lineBlocked/, 'the cart never blocks checkout on a composition availability state');
});

test('§10: a composition row is linked to where it can be bought, and the redirect is honoured', () => {
  // The grid renders the shared ProductCard, whose destination is
  // `cardHref` (src/lib/productCard.ts).
  assert.match(read('src/pages/Products.tsx'), /<ProductCard p=\{p\}/);
  assert.match(read('src/components/home/ProductCard.tsx'), /to=\{cardHref\(p\)\}/);
  assert.match(read('src/lib/productCard.ts'), /\/bundles\/\$\{p\.product_slug\}/, 'the grid still links every card to /product/');
  const product = read('src/pages/Product.tsx');
  assert.match(product, /data\.redirect/, 'the product page ignores the server’s composition redirect');
});
