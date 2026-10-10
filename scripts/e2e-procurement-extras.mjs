/** «تكاليف إضافية للقطعة» on the mounted purchase screen with explicit API
 * fixtures (tests/browser/procurement-extras.html). Run against Vite:
 * PLAYWRIGHT_MODULE=/path/to/playwright PROCUREMENT_TEST_URL=http://127.0.0.1:4191/tests/browser/procurement-extras.html node scripts/e2e-procurement-extras.mjs
 * CHROMIUM_PATH may select an already-installed browser. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir } from 'node:fs/promises';

const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.PROCUREMENT_TEST_URL || 'http://127.0.0.1:4181/tests/browser/procurement-extras.html';
const output = process.env.OUT_DIR || '/tmp/levonis-procurement-extras';
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}), args: ['--no-sandbox'] });
let checks = 0;
const check = (name, condition) => { assert.ok(condition, name); checks++; console.log(`ok ${name}`); };
const noOverflow = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
const next = (page) => page.locator('.inventory-footer').getByRole('button', { name: 'التالي', exact: true });
const row = (page, label) => page.locator('dl.inventory-review > div').filter({ has: page.locator('dt', { hasText: label }) }).first().locator('dd').first();
const toCosts = async (page) => {
  await page.getByRole('button', { name: 'استكمال مسودة هذه الجلسة', exact: true }).click();
  await next(page).click();
  await next(page).click();
};
try {
  for (const [theme, width] of [['dark', 390], ['light', 390], ['dark', 1280]]) {
    const tag = `${theme}-${width}`;
    const page = await browser.newPage({ viewport: { width, height: 900 }, hasTouch: width < 600, deviceScaleFactor: 1 });
    const crashes = [];
    page.on('pageerror', (e) => crashes.push(e.message));

    // 1. The owner's line with no extra expense: extras are 0, landed = raw + freight.
    await page.goto(`${base}?draft=route&theme=${theme}`, { waitUntil: 'networkidle' });
    await toCosts(page);
    check(`${tag}: raw per unit after FX`, (await row(page, 'شراء القطعة الخام بالدينار').innerText()).includes('1,382,432.4'));
    check(`${tag}: freight per unit by weight`, (await row(page, 'شحن القطعة').innerText()).includes('132,551.2'));
    check(`${tag}: no extra expense is 0 IQD`, (await row(page, 'تكاليف إضافية للقطعة').innerText()).trim() === '0 د.ع');
    check(`${tag}: landed = raw + freight`, (await row(page, 'تكلفة القطعة النهائية').innerText()).includes('1,514,983.6'));
    const toggle = page.getByRole('button', { name: /^تفاصيل: تكاليف إضافية للقطعة/ });
    await toggle.click();
    check(`${tag}: details explain an empty list`, (await page.getByRole('region', { name: /تكاليف إضافية للقطعة — X2D Combo/ }).innerText()).includes('لذلك قيمتها 0 د.ع'));
    check(`${tag}: details toggle is announced`, await toggle.getAttribute('aria-expanded') === 'true');
    const box = await toggle.boundingBox();
    check(`${tag}: details toggle sits beside its label`, !!box && box.height >= 20);
    await page.screenshot({ path: `${output}/${tag}-1-no-extras.png`, fullPage: true });

    // 2. Two actual expenses: one for the shipment, one per piece.
    await page.getByRole('button', { name: 'إضافة مصروف إضافي', exact: true }).click();
    check(`${tag}: a new charge has no invented name or amount`, await page.getByLabel(/^اسم التكلفة/).inputValue() === '' && await page.getByLabel(/^المبلغ الإجمالي بالدينار/).inputValue() === '');
    check(`${tag}: an empty charge blocks continuing`, await next(page).isDisabled());
    await page.getByLabel(/^اسم التكلفة/).fill('توصيل محلي');
    await page.getByLabel(/^المبلغ الإجمالي بالدينار/).fill('50000');
    check(`${tag}: shipment amount recomputes at once`, (await row(page, 'تكاليف إضافية للقطعة').innerText()).trim() === '10,000 د.ع' && (await row(page, 'تكلفة القطعة النهائية').innerText()).includes('1,524,983.6'));
    await page.getByRole('button', { name: 'إضافة مصروف إضافي', exact: true }).click();
    await page.getByLabel(/^اسم التكلفة/).nth(1).fill('تغليف');
    await page.getByLabel(/^تخص/).nth(1).selectOption('unit');
    await page.getByLabel(/^المبلغ لكل قطعة بالدينار/).fill('2000');
    check(`${tag}: per-piece amount adds exactly once`, (await row(page, 'تكاليف إضافية للقطعة').innerText()).trim() === '12,000 د.ع' && (await row(page, 'تكلفة القطعة النهائية').innerText()).includes('1,526,983.6'));
    const details = await page.getByRole('region', { name: /تكاليف إضافية للقطعة — X2D Combo/ }).innerText();
    check(`${tag}: details name each expense, its value, scope, split and share`, ['توصيل محلي', '50,000 د.ع', 'الشحنة كاملة', 'حسب عدد القطع', '50,000 د.ع على البند ÷ 5', 'تغليف', '2,000 د.ع', 'كل قطعة', 'مبلغ ثابت لكل قطعة', '10,000 د.ع على البند ÷ 5', '12,000 د.ع'].every((t) => details.includes(t)));
    check(`${tag}: no page overflow`, await noOverflow(page));
    await page.screenshot({ path: `${output}/${tag}-2-actual-extras.png`, fullPage: true });
    await next(page).click();
    await page.getByRole('button', { name: 'تأكيد الشراء القادم', exact: true }).click();
    await page.getByText('تم تأكيد أمر الشراء', { exact: true }).waitFor();
    const sent = (await page.evaluate(() => window.procurementRequests)).find((r) => r.method === 'POST');
    check(`${tag}: request carries only typed charges`, JSON.stringify(sent?.body.charges) === JSON.stringify([
      { title: 'توصيل محلي', scope: 'shipment', basis: 'quantity', amount_iqd: 50000, unit_amount_iqd: null, applies_to: null },
      { title: 'تغليف', scope: 'unit', basis: 'quantity', amount_iqd: null, unit_amount_iqd: 2000, applies_to: null },
    ]));

    // 3. The saved document splits freight and extras, and explains the extras.
    check(`${tag}: saved view shows route freight on its own`, (await row(page, 'شحن القطعة').innerText()).includes('132,551.2'));
    check(`${tag}: saved view shows only extras as extras`, (await row(page, 'تكاليف إضافية للقطعة').innerText()).trim() === '12,000 د.ع');
    await page.getByRole('button', { name: /^تفاصيل: تكاليف إضافية للقطعة/ }).click();
    check(`${tag}: saved shares come from the document`, (await page.getByRole('region', { name: /تكاليف إضافية للقطعة — X2D Combo/ }).innerText()).includes('10,000 د.ع على البند ÷ 5'));
    await page.screenshot({ path: `${output}/${tag}-3-saved.png`, fullPage: true });

    // 4. A copy never carries the old shipment's extras or rates.
    await page.getByRole('button', { name: 'نسخ لشراء جديد', exact: true }).click();
    await next(page).click();
    await next(page).click();
    check(`${tag}: copy starts with no extra expense`, await page.getByText('لا توجد مصاريف إضافية؛ قيمتها 0 د.ع.', { exact: true }).isVisible() && (await row(page, 'تكاليف إضافية للقطعة').innerText()).trim() === '0 د.ع');
    check(`${tag}: copy uses the route's current rates`, await page.getByLabel('سعر اليورو الواحد بالدينار العراقي', { exact: true }).inputValue() === '1,650' && await page.getByLabel('سعر الكيلوغرام بالدينار العراقي', { exact: true }).inputValue() === '6,100');

    // 5. Manual freight carried into a route waits for a decision and counts nothing.
    await page.goto(`${base}?draft=manual&theme=${theme}`, { waitUntil: 'networkidle' });
    await toCosts(page);
    check(`${tag}: manual mode labels freight and charges together`, (await row(page, 'الشحن والتكاليف اليدوية للقطعة').innerText()).includes('93,266'));
    await page.getByLabel(/^مسار المورد والشحن/).selectOption('germany_land');
    await page.getByLabel(/^سعر شراء القطعة الخام من المورد \(EUR\)/).fill('855');
    await page.getByLabel(/^وزن كرتون القطعة مع التغليف بالكيلوغرام/).fill('22.3');
    check(`${tag}: carried manual charge is held for review`, await page.getByRole('alert').filter({ hasText: 'لا تُحتسب حتى تختار' }).isVisible());
    check(`${tag}: held charge adds nothing`, (await row(page, 'تكاليف إضافية للقطعة').innerText()).trim() === '0 د.ع');
    check(`${tag}: held charge blocks continuing`, await next(page).isDisabled());
    await page.screenshot({ path: `${output}/${tag}-4-review.png`, fullPage: true });
    await page.getByRole('button', { name: 'حذفها', exact: true }).click();
    check(`${tag}: removing it leaves raw + freight`, !(await next(page).isDisabled()));
    check(`${tag}: no crashes`, crashes.length === 0);
    await page.close();
  }
  console.log(`${checks} checks passed; screenshots in ${output}`);
} finally {
  await browser.close();
}
