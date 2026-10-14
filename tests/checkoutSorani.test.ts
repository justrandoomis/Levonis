/**
 * THE CHECKOUT READS IN SORANI (DECISIONS row 183: a Sorani slot never carries
 * the Arabic).
 *
 * The Release A browser walk read the checkout in Sorani at 390 and 1280 px and
 * found it mostly Arabic: «دفع آمن», «إتمام الطلب», «عنوان التوصيل», «طريقة
 * الشحن», «ملخص الطلب», «المجموع الفرعي», «تكلفة التوصيل إلى البيت», «استخدام
 * كود خاص», and every delivery and payment method name. Two causes, both pinned
 * here:
 *
 *  1. `dir === 'rtl' ? ar : en` — Sorani is right-to-left too, so the test
 *     handed it the Arabic — and `loc(ar, en)` with no third argument, which
 *     falls back to the Arabic by design;
 *  2. the method lists are the owner's settings, stored as whole arrays with
 *     no Sorani field at all.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import ts from 'typescript';
import { ROOT } from './fixtures/d1';
import { asD1 } from './fixtures/app';
import { SETTING_DEFAULTS, getSetting, getSettings } from '../worker/lib/settings';
import { methodDesc, methodTitle } from '../src/lib/methodText';

const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');
const ARABIC = /[؀-ۿ]/;

/** Every `loc(...)` call and every `dir === 'rtl' ? <text> : <text>` in a file. */
function strings(rel: string) {
  const sf = ts.createSourceFile(rel, read(rel), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const locCalls: { line: number; args: string[] }[] = [];
  const rtlText: { line: number; text: string }[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'loc') {
      locCalls.push({ line: sf.getLineAndCharacterOfPosition(n.getStart()).line + 1, args: n.arguments.map((a) => a.getText()) });
    }
    if (ts.isConditionalExpression(n) && /\bdir\s*===\s*'rtl'/.test(n.condition.getText())) {
      const yes = n.whenTrue.getText();
      // A class name or an icon is direction, not language; text is language.
      if (ARABIC.test(yes) || /title(Ar|En)|desc(Ar|En)/.test(yes)) {
        rtlText.push({ line: sf.getLineAndCharacterOfPosition(n.getStart()).line + 1, text: n.getText().slice(0, 90) });
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return { locCalls, rtlText };
}

test('every checkout string is written in three languages, and no Sorani slot copies the Arabic', () => {
  const { locCalls, rtlText } = strings('src/pages/Checkout.tsx');
  assert.ok(locCalls.length > 80, `the scan found the checkout's strings (${locCalls.length})`);
  assert.deepEqual(rtlText, [], 'a `dir === "rtl"` text choice hands a Sorani reader the Arabic');
  const twoArg = locCalls.filter((c) => c.args.length === 2);
  assert.deepEqual(twoArg, [], 'loc(ar, en) without a Sorani argument');
  const copies = locCalls.filter((c) => c.args.length === 3 && c.args[0] === c.args[2]);
  assert.deepEqual(copies, [], 'a Sorani argument that repeats the Arabic');
});

test('the cart and the checkout name a method through methodText, never by text direction', () => {
  for (const rel of ['src/pages/Checkout.tsx', 'src/pages/Cart.tsx']) {
    const code = read(rel);
    assert.doesNotMatch(code, /dir === 'rtl' \? \w+\.title(Ar|En)/, `${rel} picks a method title by direction`);
    assert.doesNotMatch(code, /dir === 'rtl' \? \w+\.desc(Ar|En)/, `${rel} picks a method description by direction`);
    assert.match(code, /methodTitle\(/, `${rel} names methods through src/lib/methodText.ts`);
  }
});

test('every shipped method carries its own Sorani, never the Arabic', () => {
  const lists = [
    ...SETTING_DEFAULTS.checkoutDeliveryMethods,
    ...SETTING_DEFAULTS.checkoutPaymentMethods,
    ...SETTING_DEFAULTS.cartShippingMethods,
  ] as Array<{ id: string; titleAr: string; titleCkb?: string; descAr?: string; descCkb?: string }>;
  for (const m of lists) {
    assert.ok(m.titleCkb && m.titleCkb.trim(), `${m.id} has no Sorani title`);
    assert.notEqual(m.titleCkb, m.titleAr, `${m.id}: the Sorani title is the Arabic`);
    if (m.descAr) {
      assert.ok(m.descCkb && m.descCkb.trim(), `${m.id} has no Sorani description`);
      assert.notEqual(m.descCkb, m.descAr, `${m.id}: the Sorani description is the Arabic`);
    }
  }
});

function settingsDb(rows: Record<string, unknown>) {
  const raw = new DatabaseSync(':memory:');
  raw.exec('CREATE TABLE admin_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  for (const [k, v] of Object.entries(rows)) raw.prepare('INSERT INTO admin_settings (key, value) VALUES (?, ?)').run(k, JSON.stringify(v));
  return asD1(raw);
}

test('a shop saved before the Sorani field reads the shipped Sorani — only where it still says what we shipped', async () => {
  const db = settingsDb({
    checkoutDeliveryMethods: [
      // Exactly the shipped Arabic: the shipped Sorani is lent.
      { id: 'standard', titleAr: 'توصيل عادي', titleEn: 'Standard Delivery', descAr: '2-3 أيام عمل', descEn: '2-3 business days', price_iqd: 5000, icon: 'Truck' },
      // Renamed by the owner: nothing this file has seen, so no Sorani is invented.
      { id: 'personal', titleAr: 'مندوب خاص', titleEn: 'Courier', descAr: 'نفس اليوم', descEn: 'Same day', price_iqd: 10000, icon: 'User' },
      // The owner's own Sorani is never replaced.
      { id: 'pickup', titleAr: 'استلام من المخزن', titleEn: 'Store Pickup', titleCkb: 'وەرگرتنی خۆت', descAr: 'جاهز خلال ساعتين', descEn: 'Ready in 2 hours', price_iqd: 0, icon: 'Store' },
    ],
    checkoutPaymentMethods: [{ id: 'cash', titleAr: 'الدفع عند الاستلام', titleEn: 'Cash on Delivery', icon: 'Banknote' }],
  });
  const delivery = await getSetting(db, 'checkoutDeliveryMethods');
  const byId = new Map(delivery.map((m) => [m.id, m]));
  assert.equal(byId.get('standard')?.titleCkb, 'گەیاندنی ئاسایی');
  assert.equal(byId.get('standard')?.descCkb, '2-3 ڕۆژی کار');
  assert.equal(byId.get('personal')?.titleCkb, undefined, 'a renamed method borrows no translation of the old name');
  assert.equal(byId.get('personal')?.descCkb, 'هەمان ڕۆژ', 'its description still says what we shipped');
  assert.equal(byId.get('pickup')?.titleCkb, 'وەرگرتنی خۆت', 'the owner’s Sorani wins');
  assert.equal(byId.get('pickup')?.descCkb, 'لە ماوەی دوو کاتژمێردا ئامادەیە');

  // The public settings read (getSettings) answers the same, and the bnpl/gini rescue still works.
  const all = await getSettings(db, ['checkoutPaymentMethods']);
  const payment = all.checkoutPaymentMethods as Array<{ id: string; titleCkb?: string }>;
  assert.equal(payment.find((m) => m.id === 'cash')?.titleCkb, 'پارەدان لە کاتی گەیاندن');
  assert.ok(payment.some((m) => m.id === 'gini' && m.titleCkb), 'the rescued gini row carries its Sorani');

  // What the reader sees: the Sorani, or the Arabic when the owner wrote none.
  assert.equal(methodTitle(byId.get('standard')!, 'ckb'), 'گەیاندنی ئاسایی');
  assert.equal(methodTitle(byId.get('personal')!, 'ckb'), 'مندوب خاص');
  assert.equal(methodTitle(byId.get('personal')!, 'en'), 'Courier');
  assert.equal(methodDesc(byId.get('standard')!, 'ar'), '2-3 أيام عمل');
});

test('the admin can write the Sorani of every method, so a lent Sorani is visible before it is saved', () => {
  const admin = read('src/components/AdminStoreSettings.tsx');
  for (const field of ['titleCkb', 'descCkb']) {
    assert.match(admin, new RegExp(`value=\\{row\\.value\\.${field} \\|\\| ''\\}`), `no ${field} field in the method editor`);
  }
  assert.equal((admin.match(/placeholder="Title \(Ckb\)"/g) || []).length, 3, 'delivery, payment and cart shipping each take a Sorani title');
});
