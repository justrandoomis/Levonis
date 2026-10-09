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
 * The membership tier PREMIUM and the legacy public fee `direct_surcharge_iqd`
 * are a different concept and keep their names (FX plan §11 "Deliberately not
 * renamed").
 *
 * THE CUSTOMER'S TEXT IS NO LONGER OUT OF SCOPE (owner decision 7,
 * 2026-10-09; DECISIONS row 190). «علاوة» could be read as LEVO PREMIUM, so
 * it left the policies too (purchase 6, faq 5, membership 5,
 * price_protection 4), and the Arabic word — in every form: «علاوة», the
 * plural «علاوات», «علاوته» with a pronoun — is now banned in EVERY source
 * file under src/, worker/, packages/ and services/ (the notification
 * service's customer templates live there) — code, labels, comments and
 * policy bodies alike. The English word stays allowed outside the engine
 * files above because LEVO PREMIUM is a real tier name; in the policy corpus a
 * lowercase "premium" is refused by tests/policyCorpus.test.ts instead.
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
import { labelRow, templateShape } from '../worker/lib/importCsv';

/**
 * «علاوة» in every form the word takes: with or without the article, the
 * plural «علاوات», and with a pronoun attached («علاوته», «علاوتها»).
 */
const ALAWA = /علاو[ةتا]/;
/** premium in any case, «علاوة» in any form, and the Sorani spellings of the loanword. */
const PREMIUM_WORD = new RegExp(`premium|${ALAWA.source}|پریمیۆم|پرێمیۆم|پریمیەم`, 'i');

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
    if (name === 'node_modules') continue;
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

/** Every .ts / .tsx file under src/, worker/, packages/ and services/ (walk() never enters a node_modules). */
function everySourceFile(): string[] {
  const files: string[] = [];
  for (const d of ['src', 'worker', 'packages', 'services']) {
    assert.ok(existsSync(join(ROOT, d)), `${d} is gone: move the guard with it`);
    walk(join(ROOT, d), files);
  }
  return files;
}

test('«علاوة» is in no source file at all — not in code, a label, a comment or a policy body (owner decision 7)', () => {
  const files = everySourceFile();
  assert.ok(files.length >= 1000, `only ${files.length} files scanned`);
  // The scan must reach the policy corpus, the one place the word lived last,
  // and the notification service's customer templates.
  for (const f of ['worker/lib/policies/purchase.ts', 'worker/lib/policies/membership.ts', 'worker/lib/policies/faq.ts', 'worker/lib/policies/price_protection.ts', 'services/notifications/src/templates.ts']) {
    assert.ok(files.includes(join(ROOT, f)), `${f} is not scanned`);
  }
  const hits: string[] = [];
  for (const file of files) {
    readFileSync(file, 'utf8')
      .split('\n')
      .forEach((line, i) => {
        if (ALAWA.test(line)) hits.push(`${relative(ROOT, file)}:${i + 1}: ${line.trim().slice(0, 160)}`);
      });
  }
  assert.deepEqual(hits, [], 'say «زيادة البيع المباشر» — the full term, never a bare «الزيادة»');
});

test('one name in three languages, the same on the contracts and on the owner screen', () => {
  const NAME = { ar: 'زيادة البيع المباشر', en: 'Direct Sale Extra', ckb: 'زیادەی فرۆشتنی ڕاستەوخۆ' } as const;
  assert.deepEqual({ ...PRICING_FIELD_LABELS.direct_sale_extra_iqd }, NAME);
  for (const lang of ['ar', 'en', 'ckb'] as const) assert.equal(PRICING_UI_STRINGS[lang].directSaleExtra, NAME[lang], lang);
  // Real Sorani: its own word with Sorani-only letters, never the Arabic pasted across (DECISIONS row 183).
  assert.match(NAME.ckb, /[ێۆڕڵەڤ]/);
  assert.notEqual(NAME.ckb, NAME.ar);
});

test('the admin screens that set a product’s direct-sale fee call it by the same name — product form, quick price, CSV import sheet', () => {
  const NAME = { ar: 'زيادة البيع المباشر', en: 'Direct Sale Extra' } as const;
  // The import sheet's human label row (the parser reads the machine row, never this one).
  const shape = templateShape('printer', ['printers'], { includeCost: true });
  const at = shape.columns.indexOf('direct_surcharge_iqd');
  assert.ok(at >= 0, 'the import sheet has no direct_surcharge_iqd column');
  assert.equal(labelRow(shape)[at], NAME.ar);
  // The two admin forms show ar + en side by side.
  for (const f of ['src/components/adminProducts/form/OptionsSection.tsx', 'src/components/adminProducts/QuickPricePanel.tsx']) {
    assert.match(readFileSync(join(ROOT, f), 'utf8'), new RegExp(`ar="${NAME.ar}" en="${NAME.en}"`), f);
  }
});
