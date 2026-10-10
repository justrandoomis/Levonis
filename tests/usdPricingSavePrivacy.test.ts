/**
 * PRIVACY of the «التسعير بالدولار والشحن» save fix (owner report 2026-10-10;
 * docs/DECISIONS.md row 213; the verifiers' privacy review).
 *
 * What the fix changed that could carry cost: `data_only` on PUT …/inputs (a
 * complete manual product's data now stored without a price write), the new
 * `conversion_hash` on the preview answer (a hash over the typed dinars and
 * the rate — an oracle), the PRICING_FX_RATE_MISSING refusal's new details
 * (field, scope, scope_id), the typed-decimal reader on the server, and the
 * e2e script + seeds committed beside it. This file proves, with the owner's
 * data actually stored:
 *
 *   1. every non-owner — guest, customer, merchant, employee, investor, the
 *      assistant, full and NULL-scope admins, a grantee while delegation is
 *      off, and the owner before the address is verified — reaches none of the
 *      three changed routes: the refusal is the one generic answer (the same
 *      bytes for the real product and an invented id, with or without
 *      `data_only`), carries no value, no hash, no preview, and writes nothing;
 *   2. the owner's own refusals (no dollar rate, a bad decimal, a stale
 *      conversion hash) name a field and ids only — never the typed amount;
 *      no console line of any of these requests carries a value; audit_log
 *      carries counts only; `stripFinancials` (the second net) removes
 *      `conversion_hash`, `preview_hash` and every typed value from the
 *      preview answer;
 *   3. THE PUBLIC REPOSITORY carries no live product's legacy cost: a figure
 *      the fix's committed artifacts bind to «التكلفة القديمة» / product_cost_iqd
 *      for a product named after one of the 41 live products must be the
 *      census's synthetic figure (tests/fixtures/legacyCatalogue.ts: "no value
 *      left the live database"), never one read off the owner's screen. The
 *      figure itself is never written here (any encoding of a 7-digit
 *      multiple of 1,000 below a public price is trivially reversible).
 *
 * Run: node --import tsx --test tests/usdPricingSavePrivacy.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DatabaseSync } from 'node:sqlite';
import { all, count, freshDb, type StubUser } from './fixtures/app';
import { pricingWorld } from './fixtures/procurementPricing';
import { seedLegacyCatalogue } from './fixtures/legacyCatalogue';
import { OWNER_BASE, OWNER_RULES, SNAP, SNAP_MODEL, liveLikeWorld, persisted, storePrice } from './fixtures/usdPricingSave';
import { stripFinancials } from '../worker/lib/adminScope';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** The owner's typed dinars on the model (an IQD convenience entry) — 1,234,000 IQD → $771.25 at 1,600. */
const MODEL_IQD = 1_234_000;
const MODEL_ENTRY = { scope: 'option', scope_id: SNAP_MODEL, supplier_cost_iqd: MODEL_IQD };
/** Every value the owner stores below, as it could appear in a body, a log line or an audit row. */
const VALUES = ['899', '1234000', '1,234,000', '771.25', '15000', '15,000', '25000', '25,000'];
const HASH_KEYS = ['conversion_hash', 'preview_hash', '"preview"', 'pricing_inputs', 'supplier_cost', 'adoption'];

/** Every caller that sees no cost (tests/fixtures/roleMatrix.ts ROLES, inlined: that fixture mounts every router). */
const NON_OWNERS: Record<string, StubUser | null> = {
  guest: null,
  customer: { id: 'u1', role: 'customer', email: 's@x.co' },
  merchant: { id: 'u_m', role: 'merchant', email: 'm@x.co' },
  employee: { id: 'usr_emp', role: 'customer', email: 'emp@x.co' },
  investor: { id: 'usr_inv', role: 'customer', email: 'inv@x.co', is_investor: 1 },
  assistant: { id: 'usr_asst', role: 'admin', email: 'asst@x.co', admin_scope: 'assistant' },
  full: { id: 'usr_full', role: 'admin', email: 'full@x.co', admin_scope: 'full' },
  legacy_null: { id: 'usr_legacy', role: 'admin', email: 'legacy@x.co', admin_scope: null },
  grantee_off: { id: 'usr_grant', role: 'admin', email: 'grant@x.co', admin_scope: 'full', private_grants: ['PRICING_PRIVATE_READ', 'PRICING_PRIVATE_WRITE'] },
  owner_unverified: { id: 'usr_owner', role: 'admin', email: 'boss@x.co', email_verified_at: null },
};

/** Collects every console line a block prints (the Worker's only log sink). */
async function captureConsole<T>(fn: () => Promise<T>): Promise<{ out: T; lines: string[] }> {
  const lines: string[] = [];
  const methods = ['log', 'info', 'warn', 'error', 'debug'] as const;
  const saved = methods.map((m) => console[m]);
  for (const m of methods) console[m] = (...args: unknown[]) => void lines.push(args.map((a) => (a instanceof Error ? `${a.message} ${a.stack}` : typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
  try {
    return { out: await fn(), lines };
  } finally {
    methods.forEach((m, i) => (console[m] = saved[i]!));
  }
}

const noValue = (where: string, text: string) => {
  for (const v of VALUES) assert.ok(!text.includes(v), `${where} carries «${v}»: ${text.slice(0, 400)}`);
};

/** The owner stores a complete entry plus typed dinars on the model, data only, at the conversion shown. */
async function ownerStores(raw?: DatabaseSync) {
  const w = raw ? pricingWorld({ raw }) : pricingWorld();
  const pv = await w.previewInputs(SNAP, { inputs: [OWNER_BASE, MODEL_ENTRY], rules: OWNER_RULES });
  assert.equal(pv.status, 200, JSON.stringify(pv.body));
  assert.match(pv.body.conversion_hash, /^[0-9a-f]{64}$/);
  const r = await w.putInputs(SNAP, { inputs_seq: 0, inputs: [OWNER_BASE, MODEL_ENTRY], rules: OWNER_RULES, data_only: true, preview_hash: pv.body.conversion_hash });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.mode, 'manual');
  return { w, pv, saved: r };
}

/** Everything a request could have written: the owner rows, the audit trails, the store price. */
const snapshot = (raw: DatabaseSync) =>
  JSON.stringify({
    p: persisted(raw),
    audit: count(raw, 'SELECT COUNT(*) AS n FROM audit_log'),
    paudit: count(raw, 'SELECT COUNT(*) AS n FROM pricing_audit'),
    price: storePrice(raw),
  });

test('1. no non-owner reaches the changed routes: one generic refusal, the same bytes for a real and an invented id, with or without data_only — no value, no hash, nothing written', async () => {
  const { w, pv, saved } = await ownerStores();
  const before = snapshot(w.raw);
  const seq = saved.body.inputs_seq as number;
  for (const [name, user] of Object.entries(NON_OWNERS)) {
    const as = pricingWorld({ raw: w.raw, user });
    const { out: answers, lines } = await captureConsole(async () => [
      ['GET inputs', await as.getInputs(SNAP)],
      ['GET inputs (invented id)', await as.getInputs('zz-no-such-product')],
      ['POST preview (dinars)', await as.previewInputs(SNAP, { inputs: [OWNER_BASE, MODEL_ENTRY], rules: OWNER_RULES })],
      ['PUT data_only', await as.putInputs(SNAP, { inputs_seq: seq, inputs: [OWNER_BASE], rules: OWNER_RULES, data_only: true })],
      ['PUT data_only + the owner’s conversion hash', await as.putInputs(SNAP, { inputs_seq: seq, inputs: [OWNER_BASE, MODEL_ENTRY], data_only: true, preview_hash: pv.body.conversion_hash })],
      ['PUT data_only + adopt (contradiction)', await as.putInputs(SNAP, { inputs_seq: seq, inputs: [OWNER_BASE], data_only: true, adopt: true })],
      ['PUT data_only of a wrong type', await as.putInputs(SNAP, { inputs_seq: seq, inputs: [OWNER_BASE], data_only: 'yes' })],
      ['PUT without data_only (invented id)', await as.putInputs('zz-no-such-product', { inputs_seq: 0, inputs: [OWNER_BASE] })],
    ] as Array<[string, { status: number; body: Record<string, unknown> }]>);
    // The guest is asked to sign in, a non-admin is turned away at the admin door, an admin at the cost door.
    const expected =
      name === 'guest' ? ['UNAUTHORIZED'] : name === 'owner_unverified' ? ['OWNER_EMAIL_UNVERIFIED'] : user?.role === 'admin' ? ['COST_ACCESS_DENIED'] : ['FORBIDDEN', 'COST_ACCESS_DENIED'];
    for (const [what, r] of answers) {
      assert.equal(r.status, name === 'guest' ? 401 : 403, `${name} · ${what}: ${JSON.stringify(r.body)}`);
      assert.ok(expected.includes(String(r.body.code)), `${name} · ${what}: ${String(r.body.code)}`);
      const text = JSON.stringify(r.body);
      noValue(`${name} · ${what}`, text);
      for (const k of HASH_KEYS) assert.ok(!text.includes(k), `${name} · ${what} carries ${k}`);
      assert.equal(r.body.details, undefined, `${name} · ${what}: a read or write refusal names nothing`);
    }
    // No oracle: the refusal is the same bytes whatever the target, whatever the body.
    const bodies = new Set(answers.map(([, r]) => JSON.stringify(r.body)));
    assert.equal(bodies.size, 1, `${name}: ${[...bodies].join(' | ')}`);
    for (const l of lines) noValue(`${name} · console`, l);
  }
  assert.equal(snapshot(w.raw), before, 'no non-owner request wrote anything');
});

test('2a. the owner’s refusals name a field and ids only — never the typed amount; no console line carries a value', async () => {
  const live = liveLikeWorld();
  const { out, lines } = await captureConsole(async () => [
    // No approved dollar rate: the dinars cannot convert (the new details: field, scope, scope_id).
    ['FX missing (model)', await live.putInputs(SNAP, { inputs_seq: 0, inputs: [OWNER_BASE, MODEL_ENTRY], rules: OWNER_RULES, data_only: true })],
    ['FX missing (preview)', await live.previewInputs(SNAP, { inputs: [MODEL_ENTRY] })],
    // A thousands separator and a trailing point, refused by field.
    ['separator', await live.putInputs(SNAP, { inputs_seq: 0, inputs: [{ ...OWNER_BASE, supplier_cost_amount: '1,234,000' }], data_only: true })],
    ['trailing point', await live.putInputs(SNAP, { inputs_seq: 0, inputs: [{ ...OWNER_BASE, supplier_cost_amount: '771.25.' }], data_only: true })],
  ] as Array<[string, { status: number; body: Record<string, unknown> }]>);
  const [fx, fxPreview, sep, point] = out;
  assert.equal(fx![1].status, 409);
  assert.equal(fx![1].body.code, 'PRICING_FX_RATE_MISSING');
  assert.deepEqual(fx![1].body.details, { field: 'supplier_cost_iqd', scope: 'option', scope_id: SNAP_MODEL });
  assert.equal(fxPreview![1].status, 409);
  assert.deepEqual(fxPreview![1].body.details, { field: 'supplier_cost_iqd', scope: 'option', scope_id: SNAP_MODEL });
  for (const r of [sep, point]) {
    assert.equal(r![1].status, 400, JSON.stringify(r![1].body));
    assert.deepEqual(r![1].body.details, { field: 'supplier_cost_amount' });
  }
  for (const [what, r] of out) noValue(`owner · ${what}`, JSON.stringify(r.body));
  for (const l of lines) noValue('owner refusals · console', l);
  assert.deepEqual(persisted(live.raw), { inputs: [], rules: [], state: null });

  // A stale conversion hash (the rate the owner was shown moved): a code, never the conversion.
  const normal = pricingWorld();
  const stale = await captureConsole(() =>
    normal.putInputs(SNAP, { inputs_seq: 0, inputs: [MODEL_ENTRY], data_only: true, preview_hash: 'a'.repeat(64) })
  );
  assert.equal(stale.out.status, 409);
  assert.equal(stale.out.body.code, 'PRICING_PREVIEW_STALE');
  noValue('owner · stale hash', JSON.stringify(stale.out.body));
  for (const l of stale.lines) noValue('owner stale · console', l);
});

test('2b. the owner’s data-only save: audit_log carries counts only, no console line carries a value; the second net strips conversion_hash and every value', async () => {
  const { out, lines } = await captureConsole(() => ownerStores());
  const { w, pv } = out;
  for (const l of lines) noValue('owner save · console', l);
  // What a staff reader of the audit trail sees (created_at left out: its milliseconds are any three digits).
  const audits = all<Record<string, unknown>>(w.raw, 'SELECT action, target, detail FROM audit_log');
  assert.ok(audits.length >= 1, 'the save is audited');
  for (const a of audits) noValue(`audit_log ${String(a.action)}`, JSON.stringify(a));
  // conversion_hash is an oracle over (product, dinars, rate) — the rate is public in the top bar.
  const stripped = JSON.stringify(stripFinancials(pv.body));
  for (const k of ['conversion_hash', 'preview_hash']) assert.ok(!stripped.includes(k), k);
  assert.ok(!stripped.includes(String(pv.body.conversion_hash)), 'the hash value itself');
  noValue('stripFinancials(preview)', stripped);
});

// ------------------------------------------------------------------ 3. the public repository

/** The 41 live products' slugs (the census, tests/fixtures/legacyCatalogue.ts). */
function censusSlugs(): string[] {
  const text = readFileSync(join(ROOT, 'tests/fixtures/legacyCatalogue.ts'), 'utf8');
  const start = text.indexOf('const CENSUS = `') + 'const CENSUS = `'.length;
  return text
    .slice(start, text.indexOf('`', start))
    .split('\n')
    .slice(2)
    .map((l) => l.trim().split(/\s+/)[0]!)
    .filter(Boolean);
}

/** A product named after a census slug ('snapmaker-u1' → «Snapmaker U1 …», 'snapmaker-u1', 'snapmaker_u1'). */
const namedAfter = (slug: string) => new RegExp(`(?<![a-z0-9])${slug.split('-').join('[\\s_-]+')}(?![a-z0-9-])`, 'i');

/** A figure bound to the legacy cost: the constant, the English phrase, the Arabic label, the column. */
const LEGACY_BINDINGS = [
  /\bLEGACY_COST\s*=\s*([0-9][0-9_,]*)/g,
  /\blegacy cost\s+([0-9][0-9,]*)/gi,
  /التكلفة القديمة»?\s*[:=]?\s*([0-9٠-٩][0-9٠-٩,٬]*)/g,
  /\bproduct_cost_iqd\s*:\s*([0-9][0-9_]*)\b/g,
];
const digits = (s: string) => Number(s.replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660)).replace(/[^0-9]/g, ''));

/** The fix's committed artifacts: its e2e script and seeds, its tests and their fixture. */
function fixArtifacts(): string[] {
  const out = ['scripts/e2e-usd-pricing-save.mjs', 'tests/fixtures/usdPricingSave.ts'];
  const seeds = join(ROOT, 'scripts/e2e-usd-pricing-save');
  if (existsSync(seeds)) out.push(...readdirSync(seeds).map((f) => `scripts/e2e-usd-pricing-save/${f}`));
  out.push(...readdirSync(join(ROOT, 'tests')).filter((f) => /^usdPricing.*\.test\.ts$/.test(f)).map((f) => `tests/${f}`));
  return out.filter((f) => existsSync(join(ROOT, f)));
}

test('3. the public repository carries no live product’s legacy cost: a figure the fix’s artifacts bind to «التكلفة القديمة» for a live product is the census’s synthetic one', () => {
  const slugs = censusSlugs();
  assert.equal(slugs.length, 41);
  // The census's own synthetic legacy cost per live product (what a twin may carry).
  const raw = freshDb();
  seedLegacyCatalogue(raw);
  const synthetic = new Map(all<{ slug: string; c: number | null }>(raw, 'SELECT slug, product_cost_iqd AS c FROM products').map((r) => [r.slug, r.c]));
  const offenders: string[] = [];
  for (const file of fixArtifacts()) {
    const text = readFileSync(join(ROOT, file), 'utf8');
    const named = slugs.filter((s) => namedAfter(s).test(text));
    if (!named.length) continue;
    for (const re of LEGACY_BINDINGS) {
      for (const m of text.matchAll(re)) {
        const figure = digits(m[1]!);
        if (!Number.isFinite(figure) || figure < 1000) continue;
        // A figure equal to a named product's census figure is synthetic; anything else came from somewhere else.
        if (named.some((s) => synthetic.get(s) === figure)) continue;
        const line = text.slice(0, m.index).split('\n').length;
        // The figure itself is never printed: this message would land in CI logs of a public repository.
        offenders.push(`${file}:${line} binds a non-census legacy cost to the live product ${named.join('/')}`);
      }
    }
  }
  assert.deepEqual(offenders, [], 'replace it with the census figure (tests/fixtures/legacyCatalogue.ts) or a value under an invented product name');
});
