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
 * THE CLEAN START (spec addendum A.6, A.12.2; DECISIONS row 222): the V1
 * routes and writers this file proved are closed — 409 PRICING_V2_MANAGED for
 * the owner (tests/pricingV2LegacyDoorsRefused.test.ts) — and their tests went
 * with them. What stays here still holds on the closed doors.
 *
 * Run: node --import tsx --test tests/usdPricingSavePrivacy.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { all, freshDb } from './fixtures/app';
import { seedLegacyCatalogue } from './fixtures/legacyCatalogue';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

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
