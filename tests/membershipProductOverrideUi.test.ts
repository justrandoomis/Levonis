/**
 * §18 — THE PRODUCT-SCOPED MEMBERSHIP OVERRIDE IS REACHABLE FROM THE PRODUCT
 * EDITOR, AND IT WRITES THROUGH THE AUDITED DOOR.
 *
 * `tests/membershipBenefitsWired.test.ts` runs the rules through the real
 * routers; this file asserts the things no route test can see, and each one is
 * a defect that has happened before in this repo:
 *
 *   1. a panel that exists as a file and is rendered by nothing;
 *   2. a second persistence path — a screen that writes a benefit rule some
 *      other way, so the write lands with no version row and no audit row and
 *      an order can no longer name the configuration it was priced under;
 *   3. a commercial number typed into React, which is the one thing
 *      docs/MEMBERSHIP_BENEFITS.md exists to prevent;
 *   4. a PLUS rule offered by a screen and refused by the door, because PLUS
 *      holds no shopping entitlement;
 *   5. a unit («%» / «د.ع») decided by the browser instead of read from the
 *      server's `schema.units`.
 *
 * Run: npm run test:unit
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './fixtures/d1';

const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

const PANEL = 'src/components/adminProducts/form/MembershipDiscountSection.tsx';
const panel = read(PANEL);
const form = read('src/components/adminProducts/ProductForm.tsx');

test('§18.1: the product editor renders the membership override panel', () => {
  assert.match(form, /from '\.\/form\/MembershipDiscountSection'/, 'ProductForm does not import the panel');
  assert.match(form, /<MembershipDiscountSection/, 'ProductForm imports the panel and never renders it');
  // The panel must be told which product it is scoped to, and which member
  // prices are TYPED on it — a typed price beats every rule (§2), and a panel
  // that cannot see one would invite an override that is never reached.
  assert.match(form, /productId=\{doc\.id \|\| null\}/, 'the panel is not given the saved product id');
  assert.match(form, /typedMemberPrice=\{/, 'the panel is not told about the typed member prices');
});

test('§18.2: it writes through /api/admin/membership-benefits and nowhere else', () => {
  // Create, edit and remove — every one of them through the admin door, which
  // appends a version row and an audit row in the same batch as the rule.
  assert.match(panel, /api\.post\(\s*'\/api\/admin\/membership-benefits'/, 'no create through the admin door');
  assert.match(panel, /api\.put\(`\/api\/admin\/membership-benefits\//, 'no edit through the admin door');
  assert.match(panel, /api\.delete\(`\/api\/admin\/membership-benefits\//, 'no clear through the admin door');
  assert.doesNotMatch(panel, /\bfetch\(/, 'the panel calls fetch directly instead of the API client');
  // One product, one benefit type. A panel that could write a section or a
  // global rule from inside a product is how a whole catalogue gets discounted.
  assert.match(panel, /scope: 'product'/, "the rule it writes is not scoped to 'product'");
  assert.doesNotMatch(panel, /scope: '(global|category|sub_category)'/, 'the panel can write a wider scope');
  assert.match(panel, /benefit_type: 'product_discount'/, 'the rule it writes is not a product discount');
});

test('§18.3: not one commercial value is written into the panel', () => {
  for (const field of ['percent', 'fixed_iqd', 'max_discount_iqd', 'max_quantity', 'min_subtotal_iqd']) {
    assert.doesNotMatch(
      panel,
      new RegExp(`${field}\\s*:\\s*\\d`),
      `${field} is given a number in React — every one of them is the owner's, typed at runtime`
    );
  }
});

test('§18.4: PLUS is never offered, and the tiers come from the server', () => {
  assert.match(panel, /schema\?\.tiers|schema\.tiers/, 'the tier rows are not read from the schema');
  assert.match(panel, /!== 'plus'/, 'PLUS is not filtered out of the tier rows');
  assert.doesNotMatch(panel, /tier: 'plus'|value="plus"/, 'the panel can produce a PLUS rule');
  // And no tier-name branch decides what a membership is worth (§4): the
  // typed-price lookup is by tier id, not by an `if (tier === 'pro')`.
  assert.doesNotMatch(panel, /tier === '(pro|prime)'/, 'the panel branches on a tier name');
});

test('§18.5: the units are the server\'s, and a refusal is the server\'s sentence', () => {
  assert.match(panel, /unitOf\(schema,/, 'the panel does not read the unit from schema.units');
  assert.match(panel, /unitWord\(unit,/, 'the panel does not print the unit the server named');
  // Every refusal reaches the owner exactly as the door wrote it — "Say
  // whether the ceiling is per unit or per order" is worth more than "failed".
  assert.match(panel, /e instanceof ApiError \? e\.message/, 'the API refusal is not surfaced verbatim');
});

test('§18.6: a product that was never saved cannot be scoped to', () => {
  assert.match(panel, /const locked = !productId/, 'the panel has no locked state for an unsaved product');
  assert.match(panel, /disabled=\{locked/, 'the controls are not disabled while the product is unsaved');
});

test('§18.7: the fields the panel does not show survive its save', () => {
  // A PUT replaces the whole row. Anything this compact editor omits would be
  // cleared — a window, a priority, a minimum order or a note somebody set on
  // the benefits screen.
  for (const carried of ['min_subtotal_iqd', 'priority', 'valid_from', 'valid_until', 'label', 'enabled']) {
    assert.match(
      panel,
      new RegExp(`${carried}: rule`),
      `${carried} is not carried through the panel's save and would be cleared`
    );
  }
  assert.match(panel, /notesFromVersions/, 'the note is not recovered before a save that would replace it');
});
