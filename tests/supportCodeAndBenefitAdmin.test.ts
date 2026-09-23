/**
 * «الإحالة لا يحصل على أي شيء فقط كود دعم», AND THE BENEFIT ADMIN'S TWO NEW DOORS.
 *
 * The first group pins what the sign-up page says about a code: it is a
 * SUPPORT code, worded as one in all three languages, under a neutral icon —
 * never a «كود الإحالة» under a gift, which reads as a promise of something.
 *
 * The second group pins that the admin screen actually CALLS the two server
 * routes this lane relies on (tests/membershipBenefitsWired.test.ts drives the
 * routes themselves): the «إضافة القيم المقترحة» button and the
 * «تحويل إلى قاعدة قسم» conversion, which must send back the exact rule ids it
 * was shown. This repository has no browser DOM runner, so the wiring is
 * asserted over the source, the way tests/adminUserModal.test.ts does.
 *
 * Run: node --import tsx --test tests/supportCodeAndBenefitAdmin.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './fixtures/d1';

const src = (p: string) => readFileSync(join(ROOT, p), 'utf8');

test('the sign-up bar calls it a support code, in ar/en/ckb, and never shows a gift', () => {
  const bar = src('src/components/auth/ReferralBar.tsx');
  for (const label of ["label: 'كود الدعم'", "label: 'Support code'", "label: 'کۆدی پاڵپشتی'"]) {
    assert.ok(bar.includes(label), `missing ${label}`);
  }
  assert.ok(!/كود (ال)?إحالة/.test(bar.replace(/\/\*[\s\S]*?\*\//g, '')), 'no «كود الإحالة» string left');
  assert.ok(!/Referral code/.test(bar));
  assert.ok(!/\bGift\b/.test(bar), 'no gift icon on a code that gives nothing');
  // The resolved line names a support code too, never an invitation.
  assert.ok(!/دعوة من|Invited by|بانگهێشت/.test(bar), 'no invitation wording left');
  assert.ok(bar.includes('`كود الدعم: ${name} (@${code})`'));
  assert.ok(bar.includes('`Support code: ${name} (@${code})`'));
  assert.ok(bar.includes('`کۆدی پاڵپشتی: ${name} (@${code})`'));
  // Sorani users are told it gives nothing, in PromoCodeField's own sentence.
  assert.ok(src('src/components/PromoCodeField.tsx').includes('ئەم کۆدە هیچ داشکاندنێک ناکات'));
  assert.ok(bar.includes("optionalNote: 'ئارەزوومەندانەیە — ئەم کۆدە هیچ داشکاندنێک ناکات."));
});

test('the review row and the Telegram sign-up say the same thing', () => {
  const auth = src('src/pages/Auth.tsx');
  assert.ok(auth.includes("referralLabel: 'كود الدعم'"));
  assert.ok(auth.includes("referralLabel: 'Support code'"));
  assert.ok(auth.includes("referralLabel: 'کۆدی پاڵپشتی'"));
  const tg = src('src/components/auth/TelegramAuth.tsx');
  assert.ok(tg.includes("referralApplied: 'كود الدعم المرفق:'"));
  assert.ok(tg.includes("referralApplied: 'Support code attached:'"));
  assert.ok(tg.includes("referralApplied: 'کۆدی پاڵپشتی هاوپێچ:'"));
});

test('the rules screen offers the recommended values through the existing route, behind a confirmation', () => {
  const tab = src('src/components/adminBenefits/RulesTab.tsx');
  // The click only PREVIEWS; the POST lives in the dialog's save and sends
  // the keys it listed (the route refuses a bare POST).
  assert.ok(tab.includes("api.get<{ entries: RecommendedEntry[] }>('/api/admin/membership-benefits/recommended')"));
  assert.ok(tab.includes('onClick={() => void previewRecommended()}'));
  assert.ok(!tab.includes('onClick={() => void addRecommended()}'), 'no one-click write');
  assert.ok(tab.includes("api.post<{ created: Array<{ id: string }> }>('/api/admin/membership-benefits/recommended', {"));
  assert.ok(tab.includes('keys: entries.map((e) => e.key)'));
  assert.ok(tab.includes('onSave={() => addRecommended(suggest)}'));
  assert.ok(tab.includes('data-mb-recommended-entry'), 'the dialog lists each rule');
  assert.ok(tab.includes('إضافة القيم المقترحة'));
  assert.ok(tab.includes('<ConsolidationPanel'), 'the conversion panel is on the rules screen');
});

test('the conversion reads the server plan and sends back the ids it was shown', () => {
  const panel = src('src/components/adminBenefits/ConsolidationPanel.tsx');
  assert.ok(panel.includes(".get<Plan>('/api/admin/membership-benefits/consolidation')"));
  assert.ok(
    panel.includes("api.post('/api/admin/membership-benefits/consolidation', { key: g.key, rule_ids: g.rule_ids })"),
    'the POST body is the shape the route checks'
  );
  assert.ok(panel.includes('تحويل إلى قاعدة قسم'));
  const route = src('worker/routes/adminMembershipBenefits.ts');
  assert.ok(route.includes("adminMembershipBenefitRoutes.get('/consolidation'"));
  assert.ok(route.includes("adminMembershipBenefitRoutes.post('/consolidation'"));
  assert.ok(route.includes('body.rule_ids') && route.includes('body.key'));
});

test('the history shows a conversion as one entry', () => {
  const versions = src('src/components/adminBenefits/VersionsTab.tsx');
  assert.ok(versions.includes("consolidate: { ar: 'تحويل إلى قاعدة قسم'"));
  assert.ok(versions.includes('data-mb-version-folded'));
  const route = src('worker/routes/adminMembershipBenefits.ts');
  assert.ok(route.includes("SELECT ?, 'consolidate', ?, ?, ?,"), 'one version row per conversion');
});
