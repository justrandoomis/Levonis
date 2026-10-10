/** A stock purchase named and reviewed for DIRECT SALE (owner request
 * 2026-10-10) on the mounted purchase card with explicit API fixtures
 * (tests/browser/procurement-direct.html). Run against Vite:
 * PLAYWRIGHT_MODULE=/path/to/playwright PROCUREMENT_TEST_URL=http://127.0.0.1:4192/tests/browser/procurement-direct.html node scripts/e2e-procurement-direct.mjs
 * CHROMIUM_PATH may select an already-installed browser; OUT_DIR the screenshots. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir } from 'node:fs/promises';

const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.PROCUREMENT_TEST_URL || 'http://127.0.0.1:4192/tests/browser/procurement-direct.html';
const output = process.env.OUT_DIR || '/tmp/levonis-procurement-direct';
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}), args: ['--no-sandbox'] });
let checks = 0;
const check = (name, condition) => { assert.ok(condition, name); checks++; console.log(`ok ${name}`); };
const noOverflow = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
const requests = (page) => page.evaluate(() => window.procurementRequests);
const NAME = 'شحنة ألمانيا تشرين الأول';
const RENAMED = 'شحنة ألمانيا — الدفعة الأولى';

const T = {
  ar: { resume: 'استكمال مسودة هذه الجلسة', next: 'التالي', name: 'اسم الشراء أو رقم الفاتورة', row: 'الاسم', direct: 'البيع المباشر', none: 'بدون زيادة البيع المباشر (0)', needed: 'لتسعير البيع المباشر أدخل زيادة البيع المباشر أعلاه', channel: 'طريقة البيع', cell: 'سعر البيع المباشر المقترح', caption: 'زيادة البيع المباشر 0', confirm: 'تأكيد الشراء القادم', rename: 'تغيير الاسم', save: 'حفظ الاسم', edit: 'تعديل / إكمال المسودة', fallback: 'شراء بلا اسم' },
  ckb: { resume: 'بەردەوامبوون لە ڕەشنووسی ئەم دانیشتنە', next: 'بەردەوامبە', name: 'ناوی کڕین یان ژمارەی پسوولە', row: 'ناوی کڕین', direct: 'فرۆشتنی ڕاستەوخۆ', none: 'بێ زیادەی فرۆشتنی ڕاستەوخۆ (0)', needed: 'بۆ نرخدانانی فرۆشتنی ڕاستەوخۆ', channel: 'جۆری فرۆشتن', cell: 'نرخی پێشنیارکراوی فرۆشتنی ڕاستەوخۆ', caption: 'زیادەی فرۆشتنی ڕاستەوخۆ 0', confirm: 'پشتڕاستکردنەوەی کڕینی چاوەڕوانکراو', rename: 'گۆڕینی ناو', save: 'پاشەکەوتکردنی ناو', edit: 'تعديل / إكمال المسودة', fallback: 'کڕینی بێ ناو' },
};

try {
  for (const [theme, width, lang] of [['dark', 390, 'ar'], ['light', 390, 'ar'], ['dark', 1280, 'ar'], ['dark', 390, 'ckb']]) {
    const t = T[lang];
    const tag = `${lang}-${theme}-${width}`;
    const page = await browser.newPage({ viewport: { width, height: 900 }, hasTouch: width < 600, deviceScaleFactor: 1 });
    const crashes = [];
    page.on('pageerror', (e) => crashes.push(e.message));
    await page.goto(`${base}?theme=${theme}&lang=${lang}`, { waitUntil: 'networkidle' });
    // The session draft action is translated in all three languages.
    await page.getByRole('button', { name: t.resume, exact: true }).click();

    // 1. The name sits above the four steps, on every step.
    const field = page.getByLabel(t.name, { exact: false }).first();
    check(`${tag}: the name field is on step 1`, await field.isVisible());
    const above = await page.evaluate(() => {
      const name = document.querySelector('[data-purchase-name]');
      const steps = document.querySelector('.inventory-stepper');
      return !!name && !!steps && !!(name.compareDocumentPosition(steps) & Node.DOCUMENT_POSITION_FOLLOWING);
    });
    check(`${tag}: …above the stepper`, above);
    await field.fill(NAME);
    const next = page.locator('.inventory-footer').getByRole('button', { name: t.next, exact: true });
    for (let i = 0; i < 3; i++) await next.click();
    check(`${tag}: the name field is still there on the review`, await page.getByLabel(t.name, { exact: false }).first().isVisible());
    const nameRow = page.locator('dl.inventory-review > div').filter({ has: page.locator('dt', { hasText: t.row }) }).first().locator('dd');
    check(`${tag}: the review's name row`, (await nameRow.innerText()).trim() === NAME);

    // 2. Data only: the review contains direct-sale rows and no preorder disclosure.
    await page.locator('[data-direct-block]').first().waitFor();
    const layout = await page.evaluate(() => {
      const block = document.querySelector('[data-direct-block]');
      const pre = document.querySelector('[data-preorder-block]');
      return { direct: !!block, preorder: !!pre, heads: [...(block?.querySelectorAll('th') ?? [])].map((th) => th.textContent) };
    });
    check(`${tag}: the direct block is present`, layout.direct);
    check(`${tag}: no preorder disclosure is present`, layout.preorder === false);
    check(`${tag}: the direct table has no channel column`, !layout.heads.includes(t.channel));
    check(`${tag}: the notice asks for the extra in place`, (await page.locator('[data-pricing-product="a1"]').innerText()).includes(t.needed));
    await page.screenshot({ path: `${output}/${tag}-1-data-only.png`, fullPage: true });

    // 3. «بدون زيادة البيع المباشر (0)»: the next preview carries it; the confirm now writes, and shows what.
    await page.getByRole('button', { name: t.none, exact: true }).click();
    await page.waitForFunction(() => document.querySelector('[data-direct-block]')?.textContent.includes('875,000'), null, { timeout: 5000 });
    const sent = (await requests(page)).filter((r) => r.path === '/api/admin/pricing/procurement/preview').at(-1);
    check(`${tag}: the preview request carries the typed extra`, JSON.stringify(sent.body.pricing.direct_sale_extras) === JSON.stringify([{ product_id: 'a1', scope: 'product', scope_id: '', amount_iqd: 0 }]));
    const direct = await page.locator('[data-direct-block]').innerText();
    check(`${tag}: the direct row reads 875,000`, direct.includes('875,000'));
    check(`${tag}: preorder rows remain absent after the direct price is computed`, await page.locator('[data-preorder-block]').count() === 0 && !direct.includes('749,000'));
    const bar = await page.locator('[data-pricing-summary]').first().innerText();
    check(`${tag}: the line bar's cell 4 is the direct sale price`, bar.includes(t.cell) && bar.includes('875,000'));
    check(`${tag}: …with its two parts in the caption`, bar.includes(t.caption));
    const tick = page.locator('[data-pricing-large="a1"]');
    check(`${tag}: the large-change tick is shown`, await tick.isVisible());
    check(`${tag}: no page overflow on the review`, await noOverflow(page));
    await page.screenshot({ path: `${output}/${tag}-2-direct-priced.png`, fullPage: true });

    // 4. Confirm: the purchase carries the name; the apply carries the extra and the tick.
    await tick.check();
    await page.locator('.inventory-footer').getByRole('button', { name: t.confirm, exact: true }).click();
    await page.getByRole('button', { name: t.rename, exact: true }).waitFor();
    const all = await requests(page);
    const posted = all.find((r) => r.path === '/api/admin/procurement/documents' && r.method === 'POST');
    check(`${tag}: the confirm POST names the purchase`, posted?.body?.invoice_no === NAME);
    const applied = all.find((r) => r.path === '/api/admin/pricing/products/a1/apply-purchase');
    check(`${tag}: the apply sends the product's extra`, JSON.stringify(applied?.body?.direct_sale_extras) === JSON.stringify([{ scope: 'product', scope_id: '', amount_iqd: 0 }]));
    check(`${tag}: …with the owner's tick`, applied?.body?.confirm_large_change === true);

    // 5. The list and the saved card show the name; a funded purchase is renamed in place.
    const list = await page.locator('.inventory-line').filter({ hasText: NAME }).count();
    check(`${tag}: the register lists the purchase by its name`, list > 0);
    check(`${tag}: an unnamed purchase reads «${t.fallback}»`, (await page.getByText(t.fallback, { exact: true }).count()) > 0);
    check(`${tag}: no full edit on an investor-funded purchase`, (await page.getByRole('button', { name: t.edit, exact: true }).count()) === 0);
    await page.getByRole('button', { name: t.rename, exact: true }).click();
    const renameField = page.locator('[data-purchase-rename]').getByLabel(t.name, { exact: false });
    await renameField.fill(RENAMED);
    await page.getByRole('button', { name: t.save, exact: true }).click();
    await page.getByRole('button', { name: t.rename, exact: true }).waitFor();
    const patched = (await requests(page)).find((r) => r.method === 'PATCH');
    check(`${tag}: the rename PATCH`, patched?.path === '/api/admin/procurement/documents/doc-1/name' && patched.body.name === RENAMED && patched.body.before === NAME);
    check(`${tag}: the card title follows`, (await page.locator('body').innerText()).includes(RENAMED));
    check(`${tag}: no page overflow on the saved card`, await noOverflow(page));
    await page.screenshot({ path: `${output}/${tag}-3-renamed.png`, fullPage: true });

    if (lang === 'ckb') {
      const text = await page.locator('body').innerText();
      check(`${tag}: no Arabic copy of the new Sorani labels`, !text.includes('اسم الشراء أو رقم الفاتورة') && !text.includes('شراء بلا اسم'));
    }
    check(`${tag}: no page error`, crashes.length === 0);
    await page.close();
  }
  console.log(`${checks} checks passed; screenshots in ${output}`);
} finally {
  await browser.close();
}
