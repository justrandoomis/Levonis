/**
 * "DIRECT SALE EXTRA", NEVER "PREMIUM", IN THE PRICING ENGINE (FX programme
 * plan §11, brief §24; push FX-0).
 *
 * The owner's word for what a direct sale adds on top of the pre-order price is
 * «زيادة البيع المباشر» / "Direct Sale Extra" / «زیادەی فرۆشتنی ڕاستەوخۆ». The
 * engine used to call it a premium (`direct_premium`, «علاوة»). This file holds
 * the rename:
 *   - no engine source file says premium (or «علاوة», or a Sorani spelling of
 *     the loanword), in code, in a label or in a comment;
 *   - the private-name net (FINANCIAL_FIELDS, both copies) keeps the old names
 *     beside the new ones, and no OTHER premium name joins it;
 *   - one name in three languages, the same on the contracts and the screen.
 *
 * The membership tier PREMIUM, the legacy public fee `direct_surcharge_iqd`
 * and the customer policy texts are a different concept or owner text and
 * are deliberately out of scope (FX plan §11 "Deliberately not renamed").
 *
 * Run: node --import tsx --test tests/noPremiumWord.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { ROOT } from './fixtures/d1';
import { FINANCIAL_FIELDS } from '../worker/lib/adminScope';
import { FINANCIAL_FIELDS as KIT_FIELDS } from '../packages/platform-kit/src/scope';
import { PRICING_FIELD_LABELS } from '../packages/contracts/src/pricingFieldLabels';
import { PRICING_UI_STRINGS } from '../src/components/adminPricing/strings';

/** premium in any case, «علاوة» (with or without the article), and the Sorani spellings of the loanword. */
const PREMIUM_WORD = /premium|علاوة|پریمیۆم|پرێمیۆم|پریمیەم/i;

/** Files that MUST exist (a missing one would make the scan vacuous). */
const REQUIRED_FILES = [
  'packages/pricing/src/costToPrice.ts',
  'packages/pricing/src/ruleResolution.ts',
  'packages/pricing/src/legacyTargets.ts',
  'packages/contracts/src/costRefusals.ts',
  'worker/routes/adminPricing.ts',
];
/** Files a later push adds (FX plan §11): scanned once they exist. */
const LATER_FILES = ['packages/pricing/src/fxChain.ts'];
/** Directories scanned whole, every .ts / .tsx file at any depth. */
const REQUIRED_DIRS = ['worker/lib/pricingEngine', 'src/components/adminPricing'];
const LATER_DIRS = ['worker/lib/fx'];

function walk(dir: string, out: string[]): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

function scannedFiles(): string[] {
  const files: string[] = [];
  for (const f of REQUIRED_FILES) {
    assert.ok(existsSync(join(ROOT, f)), `${f} is gone: move the guard with it`);
    files.push(join(ROOT, f));
  }
  for (const f of LATER_FILES) if (existsSync(join(ROOT, f))) files.push(join(ROOT, f));
  for (const d of REQUIRED_DIRS) {
    assert.ok(existsSync(join(ROOT, d)), `${d} is gone: move the guard with it`);
    walk(join(ROOT, d), files);
  }
  for (const d of LATER_DIRS) if (existsSync(join(ROOT, d))) walk(join(ROOT, d), files);
  const contracts = join(ROOT, 'packages/contracts/src');
  for (const name of readdirSync(contracts)) if (/^pricing.*\.ts$/.test(name)) files.push(join(contracts, name));
  return files;
}

test('no pricing-engine file says premium, «علاوة» or the Sorani loanword — in code, labels or comments', () => {
  const files = scannedFiles();
  assert.ok(files.length >= 20, `only ${files.length} files scanned`);
  const hits: string[] = [];
  for (const file of files) {
    readFileSync(file, 'utf8')
      .split('\n')
      .forEach((line, i) => {
        if (PREMIUM_WORD.test(line)) hits.push(`${relative(ROOT, file)}:${i + 1}: ${line.trim()}`);
      });
  }
  assert.deepEqual(hits, [], 'say "Direct Sale Extra" / «زيادة البيع المباشر» / «زیادەی فرۆشتنی ڕاستەوخۆ»');
});

/** The old private names: they STAY in the net beside the new ones (exact tokens). */
const OLD_TO_NEW: Readonly<Record<string, string | null>> = {
  direct_premium_iqd: 'direct_sale_extra_iqd',
  direct_sale_premium_iqd: 'direct_sale_extra_iqd',
  premium_rule_id: 'extra_rule_id',
  direct_premium_unit_iqd: 'direct_sale_extra_unit_iqd',
  direct_premium_snapshot: 'direct_sale_extra_snapshot',
  // Reserved for the legacy migration's columns; no code uses them under
  // either name yet, so they have no renamed twin.
  premium_iqd: null,
  inherited_premium_iqd: null,
  premium_plan_json: null,
};

test('FINANCIAL_FIELDS keeps every old premium name beside its Direct Sale Extra twin, and admits no other premium name', () => {
  for (const [label, list] of [['adminScope', FINANCIAL_FIELDS], ['platform-kit', KIT_FIELDS]] as const) {
    const names = new Set<string>(list as readonly string[]);
    const premiumNames = [...names].filter((k) => PREMIUM_WORD.test(k)).sort();
    assert.deepEqual(premiumNames, Object.keys(OLD_TO_NEW).sort(), `${label}: the old names, exactly`);
    for (const [old, twin] of Object.entries(OLD_TO_NEW)) if (twin) assert.ok(names.has(twin), `${label}: ${old} has no twin ${twin}`);
    assert.ok(names.has('extra_rule_version'), `${label}: extra_rule_version`);
  }
});

test('one name in three languages, the same on the contracts and on the owner screen', () => {
  const NAME = { ar: 'زيادة البيع المباشر', en: 'Direct Sale Extra', ckb: 'زیادەی فرۆشتنی ڕاستەوخۆ' } as const;
  assert.deepEqual({ ...PRICING_FIELD_LABELS.direct_sale_extra_iqd }, NAME);
  for (const lang of ['ar', 'en', 'ckb'] as const) assert.equal(PRICING_UI_STRINGS[lang].directSaleExtra, NAME[lang], lang);
  // Real Sorani: its own word with Sorani-only letters, never the Arabic pasted across (DECISIONS row 183).
  assert.match(NAME.ckb, /[ێۆڕڵەڤ]/);
  assert.notEqual(NAME.ckb, NAME.ar);
});
