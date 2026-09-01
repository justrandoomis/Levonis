#!/usr/bin/env node
/**
 * The import dialog in a real browser — mandate §10 and §12's responsive rows.
 *
 * What this proves that the API script cannot: that the panel is actually
 * REACHABLE (the dialog opens, the Devices/Materials tab is the DEFAULT and
 * the TXT tools are the second tab), that the section picker only offers
 * sections that can produce a template, and that the whole dialog fits a phone
 * without a horizontal scrollbar.
 *
 * It asserts the panel is on screen BEFORE it measures anything: measuring the
 * product list instead would make every responsive check pass with the dialog
 * never rendered.
 *
 *   node scripts/e2e-import-ui.mjs            (expects wrangler dev on :8787)
 */
import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BASE = process.env.BASE_URL || 'http://127.0.0.1:8787';
const OUT = path.join(ROOT, 'docs', 'evidence', 'import');

let chromium;
try {
  ({ chromium } = require('playwright'));
} catch {
  try {
    ({ chromium } = require('playwright-core'));
  } catch {
    ({ chromium } = require('/opt/node22/lib/node_modules/playwright/index.js'));
  }
}

let passed = 0;
let failed = 0;
const failures = [];
function check(label, ok, detail = '') {
  if (ok) {
    passed++;
    console.log(`  ok   ${label}`);
  } else {
    failed++;
    failures.push(`${label}${detail ? ` — ${detail}` : ''}`);
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

function sql(statement) {
  const tpl = process.env.PROMOTE_CMD || 'npx wrangler d1 execute levonis-db --local --command {SQL}';
  execSync(tpl.replace('{SQL}', JSON.stringify(statement)), { cwd: ROOT, stdio: 'pipe' });
}

const rnd = Math.random().toString(36).slice(2, 8);

async function main() {
  mkdirSync(OUT, { recursive: true });
  console.log(`\nLEVONIS import dialog — ${BASE}\n`);

  // An admin session, obtained the same way a person would.
  const email = `impui-${rnd}@test.local`;
  const password = 'import-ui-pass-1';
  let cookie = '';
  const call = async (p, body) => {
    const res = await fetch(BASE + p, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
      body: JSON.stringify(body),
    });
    const sc = res.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0];
    return res.status;
  };
  check(
    'admin registered',
    (await call('/api/auth/register', { email, username: `iu${rnd}`, name: 'Import UI', password })) === 200
  );
  sql(`UPDATE users SET role='admin' WHERE email='${email}'`);
  check('admin signed in', (await call('/api/auth/login', { email, password })) === 200);

  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium',
    args: ['--no-sandbox'],
  });

  for (const width of [390, 768, 1024]) {
    const ctx = await browser.newContext({ viewport: { width, height: 900 }, deviceScaleFactor: 1, locale: 'ar' });
    await ctx.addCookies([
      {
        name: cookie.split('=')[0],
        value: cookie.split('=').slice(1).join('='),
        domain: '127.0.0.1',
        path: '/',
      },
    ]);
    const page = await ctx.newPage();
    await page.goto(`${BASE}/admin`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(500);

    // The admin tab is component state; below lg the sidebar is a drawer.
    if ((await page.locator('[data-tab="products"]:visible').count()) === 0) {
      await page.locator('[data-action="open-sidebar"]').first().click();
      await page.waitForTimeout(400);
    }
    await page.locator('[data-tab="products"]:visible').first().click({ timeout: 15000 });
    await page.waitForTimeout(800);

    await page.locator('[data-testid="admin-import-open"]').first().click({ timeout: 15000 });
    await page.waitForTimeout(1200);

    const panel = page.locator('[data-panel="import-v2"]');
    check(`${width}px — the dialog opens on the section-templates panel`, (await panel.count()) === 1);
    if ((await panel.count()) !== 1) {
      await ctx.close();
      continue;
    }
    check(`${width}px — both tabs are offered`, (await page.locator('[data-import-tab]').count()) === 2);
    check(
      `${width}px — the section-templates tab is the DEFAULT`,
      await page.locator('[data-import-tab="new"]').first().evaluate((el) => el.className.includes('bg-zinc-800'))
    );

    const sections = await page.locator('[data-import="section"] option').count();
    check(`${width}px — the section picker is populated`, sections > 1, `options=${sections}`);

    // Before a section is chosen, every download button is disabled: a button
    // that 400s is worse than a button that says "choose a section first".
    const disabledBefore = await page
      .locator('[data-import="template-csv"]')
      .first()
      .evaluate((el) => el.disabled);
    check(`${width}px — downloads are disabled until a section is chosen`, disabledBefore === true);

    const value = await page.locator('[data-import="section"] option').nth(1).getAttribute('value');
    await page.selectOption('[data-import="section"]', value);
    await page.waitForTimeout(300);
    const disabledAfter = await page
      .locator('[data-import="template-csv"]')
      .first()
      .evaluate((el) => el.disabled);
    check(`${width}px — downloads enable once a section is chosen`, disabledAfter === false);

    check(
      `${width}px — all four downloads are present (CSV, ZIP, export CSV, export ZIP)`,
      (await page.locator('[data-import^="template-"], [data-import^="export-"]').count()) === 4
    );
    check(
      `${width}px — preview is disabled until a file is chosen`,
      await page.locator('[data-import="preview"]').first().evaluate((el) => el.disabled)
    );

    // No horizontal overflow anywhere in the dialog (§1, carried into §10).
    const overflow = await page.evaluate(() => {
      const de = document.documentElement;
      return { doc: de.scrollWidth - de.clientWidth };
    });
    check(`${width}px — the dialog does not scroll the page sideways`, overflow.doc <= 1, `overflow=${overflow.doc}`);

    const wide = await page.evaluate(() => {
      const panel = document.querySelector('[data-panel="import-v2"]');
      if (!panel) return -1;
      let worst = 0;
      for (const el of panel.querySelectorAll('*')) {
        const r = el.getBoundingClientRect();
        if (r.width > 0) worst = Math.max(worst, Math.ceil(r.right) - window.innerWidth);
      }
      return worst;
    });
    check(`${width}px — no element inside the panel spills past the viewport`, wide <= 2, `spill=${wide}px`);

    // Same rule as e2e-product-form: INPUTS/SELECTS keep the 40px floor,
    // BUTTONS sit at the owner's 36px scale (the density mandate shrank
    // every admin button; 44/40px buttons were the pre-mandate standard).
    const tall = await page.evaluate(() => {
      const inRoot = (sel) => [...document.querySelectorAll(`[data-panel="import-v2"] ${sel}`)];
      const min = (els) => (els.length ? Math.min(...els.map((b) => b.getBoundingClientRect().height)) : Infinity);
      return { buttons: min(inRoot('button')), fields: min(inRoot('input:not([type="file"]),select')) };
    });
    check(`${width}px — buttons at least 36px tall`, tall.buttons >= 36, `min=${Math.round(tall.buttons)}px`);
    check(
      `${width}px — inputs/selects at least 40px tall`,
      tall.fields === Infinity || tall.fields >= 40,
      `min=${Math.round(tall.fields)}px`
    );

    await page.screenshot({ path: path.join(OUT, `import-${width}.png`) });

    // At one width, drive the whole flow through the UI itself: choosing a
    // file, previewing and confirming. The API script proves the endpoints;
    // this proves the panel is actually wired to them.
    if (width === 1024) {
      const columns = await page.evaluate(async (id) => {
        const res = await fetch(`/api/admin/import/template?category=${encodeURIComponent(id)}&format=csv`, {
          credentials: 'same-origin',
        });
        const text = await res.text();
        return text.replace(/^\uFEFF/, '').split(/\r?\n/)[0].split(',');
      }, value);
      const key = `UI-${rnd}`;
      const cell = (v) => columns.map((c) => v[c] ?? '');
      const q = (r) => r.map((c) => (/[",\r\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(',');
      const csv = [
        q(columns),
        // The section is named by its id here; the resolver accepts a slug, an
        // English name, an Arabic name or the id itself.
        q(cell({ row_type: 'product', key, name: `UI Import ${rnd}`, category: value, price_iqd: '450000', status: 'draft' })),
        q(cell({ row_type: 'option', key, group: 'Size', value: 'Large', active: 'yes' })),
      ].join('\r\n');

      await page.setInputFiles('[data-import="file"]', {
        name: 'ui-import.csv',
        mimeType: 'text/csv',
        buffer: Buffer.from(csv, 'utf8'),
      });
      await page.waitForTimeout(300);
      await page.locator('[data-import="preview"]').first().click();
      await page.waitForTimeout(2500);

      const previewText = await panel.innerText();
      check('the UI preview lists the product row', previewText.includes(key), previewText.replace(/\s+/g, ' ').slice(0, 160));
      check('the UI preview offers a confirm button', (await page.locator('[data-import="confirm"]').count()) === 1);
      check(
        'the UI preview says plainly that nothing was written',
        previewText.includes('لا تكتب') || previewText.includes('writes nothing')
      );
      await page.screenshot({ path: path.join(OUT, 'import-preview-1024.png') });

      await page.locator('[data-import="confirm"]').first().click();
      await page.waitForTimeout(3000);
      const resultText = await panel.innerText();
      check('the UI reports the applied result', /أُنشئ 1|1 created/.test(resultText), resultText.replace(/\s+/g, ' ').slice(0, 160));
      check('the report download is offered', (await page.locator('[data-import="report"]').count()) === 1);
      await page.screenshot({ path: path.join(OUT, 'import-result-1024.png') });

      const saved = await page.evaluate(async (k) => {
        const res = await fetch(`/api/admin/products-v2?search=${encodeURIComponent(k)}`, {
          credentials: 'same-origin',
        });
        const data = await res.json();
        return (data.products ?? []).length;
      }, key);
      check('the product really exists after the UI confirm', saved === 1, `found=${saved}`);
    }

    // The legacy tab is reachable and really renders the TXT tools.
    await page.locator('[data-import-tab="legacy"]').first().click();
    await page.waitForTimeout(900);
    check(
      `${width}px — the legacy TXT tools are still reachable on the second tab`,
      (await page.locator('[data-panel="import-v2"]').count()) === 0 &&
        (await page.locator('text=/TXT|قالب/i').count()) > 0
    );

    await ctx.close();
  }

  await browser.close();
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failures.length) {
    console.log('\nfailures:');
    for (const f of failures) console.log(`  - ${f}`);
  }
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
