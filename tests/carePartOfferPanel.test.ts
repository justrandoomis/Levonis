/**
 * PRINTER PHASE 5 — the staff side of the Levo Care part offer (DECISIONS row 358): «خصم على قطعة — ليفو كير»
 * inside the claim's Care panel.
 *
 *  - The offers of a claim are listed with their state in words (live / used / revoked / expired); only a
 *    live one can be taken back, and only by the financial scope.
 *  - The form says WHY it cannot send (closed claim, Care not active, no claim left, five live offers) beside
 *    the button — never a silent grey.
 *  - The before / after preview is the server's own arithmetic, ceiling included.
 *  - An older server (no part_rules, no part_grants) does not crash the Care panel.
 *
 * Run: TZ=UTC node --import tsx --test tests/carePartOfferPanel.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import PartOfferPanel, { partDiscountPreview, type PartGrantAdmin, type PartRules } from '../src/components/adminWarranty/PartOfferPanel';
import { partDiscountOf } from '../worker/lib/carePartGrantViews';

const ROOT = join(import.meta.dirname, '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const rules: PartRules = { default_pct: 30, max_pct: 50, valid_days: 14, max_live: 5 };
const product = { id: 'prd_nozzle', slug: 'nozzle', name: 'Hardened nozzle', name_ar: 'فوهة مقسّاة', name_ku: 'نۆزڵی ڕەقکراو', image: '', needs_choices: false, available: true };
const grant = (id: string, state: PartGrantAdmin['state'], extra: Partial<PartGrantAdmin> = {}): PartGrantAdmin => ({
  id, claim_id: 'cl_1', product, discount_pct: 30, max_discount_iqd: null, price_iqd: 20_000, discount_iqd: 6_000, after_iqd: 14_000,
  state, expires_at: '2026-12-02T10:00:00.000Z', created_at: '2026-11-18T10:00:00.000Z', used_order_id: null, discount_given_iqd: null, ...extra,
});
const run = async () => true;
const render = (props: Record<string, unknown> = {}, lang = 'ar') => renderToStaticMarkup(createElement(PartOfferPanel, {
  claimId: 'cl_1', lang, grants: [], rules, canDecide: true, careActive: true, claimOpen: true, claimsLeft: 2, warrantyActive: false, benefitLeftIqd: null, busy: false, run, ...props,
} as Parameters<typeof PartOfferPanel>[0]));

test('the list: every offer by its product and its state in words; only a live one can be taken back', () => {
  const grants = [
    grant('cpg_live', 'live'),
    grant('cpg_used', 'used', { used_order_id: 'ORD-77', discount_given_iqd: 5_500 }),
    grant('cpg_gone', 'revoked', { revoke_reason: 'أُرسلت بالخطأ' }),
    grant('cpg_old', 'expired'),
    grant('cpg_deleted', 'live', { product: null, price_iqd: null, discount_iqd: null, after_iqd: null }),
  ];
  const html = render({ grants });
  for (const [id, state] of [['cpg_live', 'live'], ['cpg_used', 'used'], ['cpg_gone', 'revoked'], ['cpg_old', 'expired']]) {
    assert.match(html, new RegExp(`data-care-part-grant="${id}" data-care-part-state="${state}"`), id);
  }
  for (const word of ['ساري', 'استُخدم', 'مسحوب', 'انتهى', 'فوهة مقسّاة', 'ORD-77', 'أُرسلت بالخطأ', 'منتج محذوف']) assert.ok(html.includes(word), word);
  assert.equal((html.match(/data-care-part-revoke="/g) ?? []).length, 2, 'the two live offers, and no other, can be taken back');
  // Without the financial scope: the list is read, nothing is sent or taken back, and it says why.
  const staff = render({ grants, canDecide: false });
  assert.match(staff, /data-care-part-finance-only/);
  assert.doesNotMatch(staff, /data-care-part-revoke="|data-care-part-send|data-care-part-search/);
  // Each language has its own words (Sorani is not a copy of the Arabic).
  const ckb = render({ grants }, 'ckb');
  assert.ok(ckb.includes('کشێنرایەوە') && ckb.includes('نۆزڵی ڕەقکراو') && !ckb.includes('مسحوب'));
  assert.ok(render({ grants }, 'en').includes('Taken back'));
});

test('the form says why it cannot send — beside the button, or instead of the form when nothing can change it', () => {
  const fresh = render();
  assert.match(fresh, /data-care-part-search/);
  assert.match(fresh, /<button[^>]*disabled=""[^>]*data-care-part-send/);
  assert.match(fresh, /data-care-part-why[^>]*>.*اختر القطعة أولاً/);
  // Five live offers: the limit is said with the count.
  const full = render({ grants: ['a', 'b', 'c', 'd', 'e'].map((x) => grant(`cpg_${x}`, 'live')) });
  assert.match(full, /data-care-part-why[^>]*>.*5 عروض سارية/);
  // Nothing the desk can fix on this screen: the reason replaces the form.
  for (const [props, words] of [
    [{ claimOpen: false }, 'المطالبة مغلقة'],
    [{ careActive: false }, 'ليفو كير غير سارٍ'],
    [{ claimsLeft: 0 }, 'استنفد هذا الجهاز'],
  ] as const) {
    const html = render(props);
    assert.match(html, /data-care-part-blocked/);
    assert.ok(html.includes(words), words);
    assert.doesNotMatch(html, /data-care-part-send/);
  }
});

test('the preview is the server\'s arithmetic: floor of the percent, never past the ceiling or the price', () => {
  for (const [price, pct, max] of [[20_000, 30, null], [19_999, 33, null], [20_000, 50, 4_000], [20_000, 90, 0], [1_000, 90, 5_000], [0, 50, null]] as const) {
    assert.equal(partDiscountPreview(price, pct, max), partDiscountOf(price, pct, max), `${price} ${pct}% max ${max}`);
  }
  assert.equal(partDiscountPreview(20_000, 50, 4_000), 4_000);
});

test('source: the contract\'s doors, the misuse rule, and an older server tolerated', () => {
  const panel = read('src/components/adminWarranty/PartOfferPanel.tsx');
  assert.match(panel, /\/api\/devices\/admin\/part-products\?q=\$\{encodeURIComponent\(q\)\}&claim_id=/);
  assert.match(panel, /run\('part-grants', \{ product_id: product\.id, discount_pct: pctN/);
  assert.match(panel, /run\(`part-grants\/\$\{encodeURIComponent\(id\)\}\/revoke`, \{ reason: reason\.trim\(\) \}\)/);
  assert.match(panel, /warrantyActive && !misuse \? s\.whyMisuse/, 'while the warranty was in force, only misuse is Care');
  assert.match(panel, /r\.products \?\? \[\]/);
  for (const lang of ['ar', 'en', 'ckb']) assert.match(panel, new RegExp(`\\n  ${lang}: \\{\\n    title: '`), lang);
  const care = read('src/components/adminWarranty/ClaimCarePanel.tsx');
  assert.match(care, /import PartOfferPanel, \{ type PartGrantAdmin, type PartRules \} from '\.\/PartOfferPanel';/, 'same lazy chunk as the Care panel');
  assert.match(care, /const partGrants = data\.part_grants \?\? \[\];/);
  assert.match(care, /const partRules = data\.part_rules \?\? null;/);
  assert.match(care, /care && \(partRules \|\| partGrants\.length > 0\)/, 'an older server shows no part-offer section');
  assert.match(care, /care\.total_months != null && care\.total_months > 0/, 'the cover line needs the new field');
});
