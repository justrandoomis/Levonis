/** Real mounted UI with explicit API fixtures. Run against Vite on :4181:
 * PLAYWRIGHT_MODULE=/path/to/playwright node scripts/e2e-inventory-workspace.mjs
 * CHROMIUM_PATH may select an already-installed browser. This runner does not
 * install a browser or use a signed-in session. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir } from 'node:fs/promises';

const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.INVENTORY_TEST_URL || 'http://127.0.0.1:4181/tests/browser/inventory-workspace.html';
const output = process.env.OUT_DIR || '/tmp/levonis-inventory-workspace';
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}), args: ['--no-sandbox'] });
let checks = 0;
const check = (name, condition) => { assert.ok(condition, name); checks++; console.log(`ok ${name}`); };
const requests = (page) => page.evaluate(() => window.inventoryRequests);
const noOverflow = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
try {
  for (const theme of ['dark', 'light']) {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true, deviceScaleFactor: 1 });
    const crashes = [];
    page.on('pageerror', (e) => crashes.push(e.message));
    await page.goto(`${base}?theme=${theme}`, { waitUntil: 'networkidle' });
    check(`${theme}: four clear start actions`, await page.locator('.inventory-start button').count() === 4);
    check(`${theme}: no page overflow on 390px`, await noOverflow(page));
    const before = (await requests(page)).length;
    await page.waitForTimeout(700);
    check(`${theme}: initial load settles without repeated requests`, (await requests(page)).length === before);

    await page.locator('.inventory-start button').filter({ hasText: 'شراء جديد' }).click();
    await page.getByRole('button', { name: 'اختر منتجًا', exact: true }).click();
    await page.getByRole('option', { name: /طابعة تجريبية.*PRINTER/ }).click();
    await page.getByLabel('الخيار واللون / النسخة').selectOption('color:black');
    await page.getByRole('button', { name: 'إضافة المنتج', exact: true }).click();
    await page.getByRole('button', { name: 'التالي', exact: true }).click();
    const unitCost = page.getByLabel('تكلفة الوحدة (IQD)', { exact: true });
    check(`${theme}: last purchase cost fills automatically`, await unitCost.inputValue() === '500000');
    check(`${theme}: selling reference shown beside cost`, (await page.locator('.inventory-lines').first().innerText()).includes('800,000'));
    await unitCost.fill('510000');
    await page.getByRole('button', { name: 'إضافة شحن أو تكلفة', exact: true }).click();
    await page.getByLabel('إجمالي بالدينار', { exact: true }).fill('15000');
    await page.getByRole('button', { name: 'التالي', exact: true }).click();
    check(`${theme}: review has exact landed cost`, (await page.locator('.inventory-total').innerText()).includes('525,000'));
    check(`${theme}: purchase review fits 390px`, await noOverflow(page));
    await page.screenshot({ path: `${output}/${theme}-purchase-mobile.png`, fullPage: true });
    await page.getByRole('button', { name: 'تأكيد الشراء', exact: true }).click();
    await page.getByText('تم تأكيد أمر الشراء', { exact: true }).waitFor();
    const saved = (await requests(page)).find((r) => r.path === '/api/admin/procurement/documents' && r.method === 'POST');
    check(`${theme}: exact selected colour sent, no manual IDs`, saved?.body.lines[0].scope_id === 'black' && saved.body.lines[0].source_unit_amount === 510000 && saved.body.charges[0].amount_iqd === 15000);
    check(`${theme}: confirm saves ordered state once`, saved?.body.status === 'ordered' && (await requests(page)).filter((r) => r.path === saved.path && r.method === 'POST').length === 1);

    await page.getByText('ربط هذا الشراء بمستثمر', { exact: true }).click();
    await page.locator('details').filter({ has: page.getByText('ربط هذا الشراء بمستثمر', { exact: true }) }).getByRole('button').click();
    await page.getByRole('dialog').waitFor();
    check(`${theme}: investment starts on saved incoming line`, await page.getByLabel('الدفعة المشمولة', { exact: true }).inputValue() === 'incoming-0');
    await page.getByRole('dialog').getByRole('button', { name: 'رجوع', exact: true }).click();

    await page.locator('.inventory-start button').filter({ hasText: 'جرد المخزون' }).click();
    await page.getByLabel('الدفعة والموقع', { exact: true }).selectOption('lot-fixture');
    await page.getByLabel('الكمية التي عددتها فعليًا', { exact: true }).fill('11');
    check(`${theme}: lot count fits phone`, await noOverflow(page));
    await page.getByRole('button', { name: 'تثبيت الجرد', exact: true }).click();
    await page.getByText('تم تثبيت جرد الدفعة', { exact: true }).waitFor();
    const count = (await requests(page)).find((r) => r.path.endsWith('/lot-counts') && r.method === 'POST');
    check(`${theme}: lot count sends actual total without required reason`, count?.body.counted_qty === 11 && count.body.lot_id === 'lot-fixture' && !('reason' in count.body));

    // Reset the operational scenario: a cost correction correctly refuses an
    // origin whose physical loss is still unresolved in the real API.
    await page.reload({ waitUntil: 'networkidle' });
    await page.getByRole('tab', { name: 'تقارير ودفعات المخزون', exact: true }).click();
    await page.getByRole('button', { name: 'تفاصيل', exact: true }).click();
    await page.getByRole('button', { name: 'تعديل تكلفة الوحدة', exact: true }).click();
    const newCost = page.getByLabel('التكلفة الجديدة للوحدة بالدينار', { exact: true });
    await newCost.fill('530000');
    await page.getByRole('button', { name: 'حفظ التكلفة الجديدة', exact: true }).click();
    await page.getByText('تم تسجيل التكلفة الجديدة', { exact: true }).waitFor();
    const correction = (await requests(page)).find((r) => r.path.endsWith('/lot-cost-adjustments') && r.method === 'POST');
    check(`${theme}: cost adjustment sends one new cost and origin only`, correction?.body.new_unit_cost_iqd === 530000 && correction.body.incoming_id === 'incoming-fixture' && !('amount_iqd' in correction.body) && !('reason' in correction.body));
    await page.getByText(/سجل تعديل التكلفة/).click();
    check(`${theme}: previous and new costs recorded automatically`, (await page.locator('details').filter({ hasText: 'سجل تعديل التكلفة' }).innerText()).includes('530,000'));
    const scan = page.getByLabel('مسح باركود الدفعة أو رقم الجهاز', { exact: true });
    await scan.fill('WRONG');
    await page.getByRole('button', { name: 'تحقق', exact: true }).click();
    await page.getByText('الرمز يخص دفعة أخرى من هذا المنتج', { exact: true }).waitFor();
    check(`${theme}: pick validates exact lot before success`, !(await requests(page)).some((r) => r.path.endsWith('/transfers')));
    check(`${theme}: detail and history fit 390px`, await noOverflow(page));
    await page.screenshot({ path: `${output}/${theme}-lot-mobile.png`, fullPage: true });

    await page.getByRole('tab', { name: 'الجرد والمستودعات', exact: true }).click();
    await page.getByRole('tab', { name: 'الأجهزة والمرتجعات', exact: true }).click();
    await page.getByLabel('حالة المرتجع المفتوحة', { exact: true }).selectOption('return-fixture');
    const inspect = page.getByRole('button', { name: 'حفظ نتيجة الفحص', exact: true });
    check(`${theme}: mixed origins require an exact allocation`, await inspect.isDisabled());
    await page.getByLabel('دفعة ممولة', { exact: true }).fill('1');
    await page.getByLabel('دفعة المالك', { exact: true }).fill('2');
    check(`${theme}: claimed units cannot be returned twice`, await inspect.isDisabled());
    await page.getByLabel('دفعة المالك', { exact: true }).fill('1');
    check(`${theme}: exact return split enables inspection`, await inspect.isEnabled());
    await inspect.click();
    await page.getByText('تم حفظ الفحص', { exact: true }).waitFor();
    const inspection = (await requests(page)).find((r) => r.path.endsWith('/return-inspections') && r.method === 'POST');
    check(`${theme}: return evidence uses consumed allocations`, inspection?.body.allocations.length === 2 && inspection.body.allocations[0].allocation_id === 'allocation-funded' && inspection.body.allocations.every((a) => a.qty === 1));
    check(`${theme}: no runtime crashes`, crashes.length === 0 && await page.locator('[data-fixture-error]').count() === 0);
    await page.close();
  }
  const investorPage = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true });
  await investorPage.goto(`${base}?panel=investors&theme=light`, { waitUntil: 'networkidle' });
  await investorPage.getByRole('button').filter({ hasText: 'اتفاق تجريبي' }).click();
  await investorPage.getByText('تصحيح اتفاق لم يُموّل أو تُبع قطعه', { exact: true }).click();
  await investorPage.getByRole('button', { name: 'إبطال الاتفاق', exact: true }).click();
  check('void requires an explicit confirmation of the shown agreement', !(await requests(investorPage)).some((r) => r.path.endsWith('/void')));
  await investorPage.getByRole('button', { name: 'تأكيد الإبطال', exact: true }).click();
  await investorPage.getByText('تم إبطال الاتفاق وحفظ السجل.', { exact: true }).waitFor();
  const voidRequest = (await requests(investorPage)).find((r) => r.path.endsWith('/void'));
  check('void uses the exact agreement and a stable operation ID', voidRequest.path === '/api/admin/investment-finance/contracts/contract-fixture/void' && typeof voidRequest.body.operation_id === 'string' && voidRequest.body.operation_id.length >= 8);
  check('void record remains visible and funding is unavailable', await investorPage.getByText('الاتفاق مبطل', { exact: true }).count() === 1 && await investorPage.getByRole('button', { name: 'تسجيل تمويل مستلم', exact: true }).count() === 0);
  await investorPage.getByRole('button', { name: 'إنشاء اتفاق بديل', exact: true }).click();
  check('replacement selects the original purchase line', await investorPage.getByLabel('الدفعة المشمولة', { exact: true }).inputValue() === 'incoming-fixture');
  check('void and replacement stay within 390px', await noOverflow(investorPage));
  await investorPage.goto(`${base}?panel=investors&funded=1`, { waitUntil: 'networkidle' });
  await investorPage.getByRole('button').filter({ hasText: 'اتفاق تجريبي' }).click();
  check('server can_void=false hides void for funded agreements', await investorPage.getByRole('button', { name: 'إبطال الاتفاق', exact: true }).count() === 0 && await investorPage.getByText('تصحيح اتفاق لم يُموّل أو تُبع قطعه', { exact: true }).count() === 0);
  await investorPage.close();
  console.log(`${checks} inventory browser checks passed`);
} finally { await browser.close(); }
