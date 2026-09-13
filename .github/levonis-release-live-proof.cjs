const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium, webkit } = require(process.env.PLAYWRIGHT_MODULE);
const origin = 'https://levonis-iq.com';
const out = '/tmp/levonis-live-proof';
const report = { origin, verified_at: new Date().toISOString(), api: [], browsers: [] };
function save() { fs.writeFileSync(out + '/report.json', JSON.stringify(report, null, 2)); }
async function settle(page) {
  await page.waitForFunction(() => document.querySelector('.lv-app-intro')?.getAttribute('data-phase') === 'docked', {}, { timeout: 60000 });
  await page.waitForTimeout(700);
  assert.equal(await page.locator('svg.lv-bloub').count(), 1, 'One persistent SVG');
  const geometry = await page.evaluate(() => {
    const target = document.querySelector('[data-bloub-occupied="true"]');
    const svg = document.querySelector('.lv-app-intro__character');
    if (!target || !svg) return null;
    const a = target.getBoundingClientRect(), b = svg.getBoundingClientRect();
    return { anchor: target.getAttribute('data-bloub-anchor'), dx: Math.abs(a.x + a.width / 2 - b.x - b.width / 2), dy: Math.abs(a.y + a.height / 2 - b.y - b.height / 2), size: b.width };
  });
  assert.ok(geometry && geometry.dx < 3 && geometry.dy < 3, 'Character occupies measured live slot');
  return geometry;
}
(async () => {
  fs.mkdirSync(out, { recursive: true });
  let catalogCount;
  for (const path of ['/api/health', '/api/policies?lang=ar', '/api/policies?lang=en', '/api/policies?lang=ckb', '/api/products?limit=50']) {
    const response = await fetch(origin + path, { signal: AbortSignal.timeout(30000) });
    const entry = { path, status: response.status }; report.api.push(entry); save(); assert.equal(response.status, 200, path);
    const data = await response.json();
    if (path.startsWith('/api/policies')) assert.ok(Array.isArray(data.policies), 'Public policy list');
    if (path.startsWith('/api/products')) {
      assert.ok(Array.isArray(data.products), 'Public catalog must return an explicit products array');
      catalogCount = data.products.length; entry.product_count = catalogCount;
      report.product_test_scope = catalogCount ? 'Published-product navigation will be exercised' : 'Anonymous catalog is empty; verify its truthful empty state and Home return. Real-product/checkout flow cannot be exercised against absent published data.';
      save();
    }
  }
  for (const [engine, language, width] of [[chromium, 'ar', 375], [webkit, 'ar', 375], [chromium, 'en', 1440], [webkit, 'en', 1440]]) {
    const name = engine.name() + '-' + language + '-' + width;
    const browser = await engine.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width, height: 812 }, locale: language === 'ar' ? 'ar-IQ' : 'en-US' });
    await context.addInitScript(lang => localStorage.setItem('levo_lang', lang), language);
    const blocked = [];
    await context.route('**/*', route => {
      if (!['GET', 'HEAD', 'OPTIONS'].includes(route.request().method())) {
        blocked.push(new URL(route.request().url()).pathname); return route.abort();
      }
      return route.continue();
    });
    const page = await context.newPage();
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    const item = { name, blocked_write_requests: blocked, page_errors: errors }; report.browsers.push(item);
    try {
      const home = await page.goto(origin + '/', { waitUntil: 'domcontentloaded', timeout: 60000 });
      assert.equal(home.status(), 200); item.home = await settle(page);
      await page.screenshot({ path: out + '/' + name + '-home.png' });
      await page.evaluate(() => { window.__releaseSvg = document.querySelector('svg.lv-bloub'); });
      await page.locator('a[href="/products"]').first().click();
      await page.waitForURL(/\/products(?:\?|$)/, { waitUntil: 'domcontentloaded' });
      await settle(page);
      if (catalogCount > 0) {
        const product = page.locator('a[href^="/product/"]').first();
        await product.waitFor({ state: 'visible', timeout: 30000 });
        item.product_path = await product.getAttribute('href'); await product.click({ timeout: 20000 });
        await page.waitForURL(/\/product\//, { waitUntil: 'domcontentloaded' }); item.product = await settle(page);
        assert.equal(await page.evaluate(() => window.__releaseSvg === document.querySelector('svg.lv-bloub')), true, 'Same SVG through actual product navigation');
        assert.equal(item.product.anchor, 'top-header');
        await page.screenshot({ path: out + '/' + name + '-product.png' });
        await page.locator('a.lv-character-home').first().click(); item.product_navigation = 'passed';
      } else {
        await page.getByText(language === 'ar' ? 'لا توجد منتجات' : 'No products found', { exact: true }).waitFor({ timeout: 30000 });
        assert.equal(await page.locator('a[href^="/product/"]').count(), 0, 'Empty live API and visible catalog must agree');
        await page.screenshot({ path: out + '/' + name + '-catalog.png' });
        item.catalog_empty_state = 'passed; matches anonymous API';
        item.product_navigation = 'Not exercised: no published products returned by the live API';
        await page.locator('[data-bloub-home-button]').click();
      }
      await page.waitForURL(origin + '/', { waitUntil: 'domcontentloaded' }); await settle(page);
      assert.equal(await page.evaluate(() => window.__releaseSvg === document.querySelector('svg.lv-bloub')), true, 'Same SVG on actual Home return');
      item.home_navigation = 'passed';
      const legacy = await page.goto(origin + '/policy', { waitUntil: 'domcontentloaded' }); assert.equal(legacy.status(), 200);
      const heading = language === 'ar' ? 'سياسات المتجر' : 'Store Policies';
      await page.getByRole('heading', { name: heading, exact: true }).waitFor({ timeout: 30000 }); await settle(page);
      item.legacy_policy_alias = 'Visible policy reader rendered successfully';
      await page.screenshot({ path: out + '/' + name + '-policies.png' });
      await page.goto(origin + '/policies/terms?version=0&lang=' + language, { waitUntil: 'domcontentloaded' });
      await page.getByText(language === 'ar' ? 'رقم نسخة السياسة غير صالح؛ لم تُعرض نسخة بديلة.' : 'Invalid policy version; no replacement version has been shown.', { exact: true }).waitFor({ timeout: 30000 });
      assert.equal(await page.locator('article').count(), 0, 'Invalid version never substitutes another document');
      assert.deepEqual(errors, [], 'No unhandled frontend errors');
      item.result = 'passed'; console.log('PASS ' + name + ': Home, catalog state, same-SVG Home return, rendered policy alias and invalid-version protection');
    } catch (error) {
      item.result = 'failed'; item.error = String(error);
      await page.screenshot({ path: out + '/' + name + '-failure.png' }).catch(() => {}); throw error;
    } finally { save(); await browser.close(); }
  }
  report.result = 'passed'; save(); console.log('All available anonymous read-only live release probes passed. Scope limitations are explicit in report.json.');
})().catch(error => { report.result = 'failed'; report.error = String(error); save(); console.error(error); process.exitCode = 1; });
