/**
 * Edge parity (`02-MIGRATION-PLAN.md` §1.1): the platform kit carries COPIES of
 * the core's edge libraries until Phase 3.3 turns the core's files into
 * re-exports. `hosts.ts` and `securityPolicy.ts` are byte-identical files; the
 * three `http.ts` middlewares, the rate-limit key derivation, the SSRF guard
 * and the admin-scope strippers are byte-identical DECLARATIONS (only their
 * imports differ). Any drift fails here, so the gateway can never enforce a
 * rule the core does not.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const KIT = 'packages/platform-kit/src';

/** The source text of one declaration: `[export] [async] function NAME(...) {...}` or `[export] const NAME = ...;` (balanced). */
export function extractDeclaration(src: string, name: string): string {
  const re = new RegExp(`^(?:export\\s+)?(?:async\\s+)?(?:function\\s+${name}\\b|(?:const|let)\\s+${name}\\b)`, 'm');
  const m = re.exec(src);
  if (!m) throw new Error(`declaration ${name} not found`);
  const start = m.index;
  const isFn = /function\s/.test(m[0]);
  let depth = 0;
  let inStr: string | null = null;
  let started = false; // functions: the body brace was seen; consts: the `=` was seen
  for (let i = start; i < src.length; i++) {
    const ch = src[i];
    if (inStr) {
      if (ch === '\\') i++;
      else if (ch === inStr) inStr = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      inStr = ch;
      continue;
    }
    if (ch === '/' && src[i + 1] === '/') {
      i = src.indexOf('\n', i);
      continue;
    }
    if (!isFn && !started && ch === '=') started = true;
    if (ch === '{' || ch === '[' || ch === '(') {
      depth++;
      if (isFn && ch === '{') started = true;
    } else if (ch === '}' || ch === ']' || ch === ')') {
      depth--;
      if (depth === 0 && started && isFn && ch === '}') return src.slice(start, i + 1);
    } else if (!isFn && started && depth === 0 && ch === ';') return src.slice(start, i + 1);
  }
  throw new Error(`declaration ${name} did not close`);
}

const stripExport = (s: string) => s.replace(/^export\s+/, '');

test('hosts.ts and securityPolicy.ts are byte-identical copies', () => {
  assert.equal(read(`${KIT}/edge/hosts.ts`), read('worker/lib/hosts.ts'));
  assert.equal(read(`${KIT}/edge/securityPolicy.ts`), read('worker/lib/securityPolicy.ts'));
});

const PARITY: Array<[string, string, string[]]> = [
  ['worker/lib/http.ts', `${KIT}/edge/middleware.ts`, ['originCheck', 'securityHeaders', 'requireMainHost']],
  ['worker/lib/ratelimit.ts', `${KIT}/ratelimit.ts`, ['rateLimitKey', 'identifierKey']],
  ['worker/lib/fetchGuard.ts', `${KIT}/httpx.ts`, ['normalizeHost', 'ipIsPrivate', 'validateOutboundUrl', 'BLOCKED_HOST_RE']],
  ['worker/lib/adminScope.ts', `${KIT}/scope.ts`, ['normalizeAdminScope', 'FINANCIAL_FIELDS', 'stripFinancials']],
];

for (const [coreFile, kitFile, names] of PARITY) {
  test(`${kitFile} carries byte-identical declarations of ${names.join(', ')} from ${coreFile}`, () => {
    const core = read(coreFile);
    const kit = read(kitFile);
    for (const name of names) {
      assert.equal(stripExport(extractDeclaration(kit, name)), stripExport(extractDeclaration(core, name)), `${name} drifted between ${coreFile} and ${kitFile}`);
    }
  });
}

/**
 * Smart pricing (docs/SMART_PRICING.md §8, §3.9; migration 0218): the owner-only supplier catalogue,
 * matcher, estimator and per-type defaults join BOTH copies of FINANCIAL_FIELDS — the gateway can never
 * hand a non-owner what the core strips — and the customer's own estimate facts stay out of both.
 */
const SMART_PRICING_PRIVATE = [
  'supplier_price', 'supplier_prices', 'supplier_price_amount', 'supplier_price_currency', 'supplier_item_key', 'supplier_sku_key',
  'supplier_url', 'supplier_title', 'catalogue_price', 'price_cny', 'price_eur', 'price_usd_reference', 'price_label',
  'snapshot_price_basis', 'units_per_offer', 'match_confidence', 'match_method', 'match_reasons', 'estimate_flags', 'measure_basis',
  'measure_source', 'est_cost_iqd', 'est_price_iqd', 'default_weight_g', 'default_length_mm', 'default_width_mm', 'default_height_mm',
  'default_cbm', 'min_profit_usd', 'applied_wire_json', 'type_source',
  // The per-type profit cap (migration 0222, DECISIONS row 291).
  'profit_cap_pct',
  // The owner's own supplier links (§3.10, DECISIONS row 293; migration 0223).
  'supplier_links',
];
const SMART_PRICING_PUBLIC = ['price_estimate', 'estimate_unit_iqd', 'final_unit_iqd', 'notice_version'];
/** §4.9 (DECISIONS row 292): the confirmation's live gate and the owner's statement carry the type's default measures. */
SMART_PRICING_PRIVATE.push('confirm_gate', 'real_measures');

test('both copies of FINANCIAL_FIELDS carry the smart-pricing private names and keep the public estimate facts out', () => {
  const namesIn = (file: string) => new Set([...extractDeclaration(read(file), 'FINANCIAL_FIELDS').matchAll(/'([a-z0-9_]+)'/g)].map((m) => m[1]!));
  for (const file of ['worker/lib/adminScope.ts', `${KIT}/scope.ts`]) {
    const names = namesIn(file);
    assert.deepEqual(SMART_PRICING_PRIVATE.filter((k) => !names.has(k)), [], `${file} is missing private names`);
    assert.deepEqual(SMART_PRICING_PUBLIC.filter((k) => names.has(k)), [], `${file} would strip a customer fact`);
  }
});

test('the extractor itself: balanced braces, strings with braces, trailing consts', () => {
  const src = "export function a() {\n  const s = '}';\n  if (x) { return 1; }\n}\nexport const B = ['}', '{'] as const;\nconst c = 1;";
  assert.equal(extractDeclaration(src, 'a'), "export function a() {\n  const s = '}';\n  if (x) { return 1; }\n}");
  assert.equal(extractDeclaration(src, 'B'), "export const B = ['}', '{'] as const;");
  assert.equal(extractDeclaration(src, 'c'), 'const c = 1;');
  assert.throws(() => extractDeclaration(src, 'nope'), /not found/);
});
