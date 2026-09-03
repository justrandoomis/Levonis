#!/usr/bin/env node
/**
 * The import/export window in a real browser — one window, three formats, and
 * no import before a check.
 *
 * What this proves that an API script cannot:
 *
 *   - the window opens on ONE panel (the two tabs are gone) and asks the
 *     format question first, with all three formats offered and described;
 *   - each format shows its OWN clearly named template download and nothing
 *     from the other two lanes;
 *   - the import button does not exist before a check has answered, and stays
 *     disabled when the check found blocking errors;
 *   - a bad file's report NAMES the product, the line and the field, and
 *     counts errors / missing fields / missing images / duplicates separately;
 *   - CSV, ZIP and TXT each go all the way through the UI to a product that is
 *     really in the database afterwards;
 *   - the whole window fits a phone with no sideways scroll.
 *
 *   node scripts/e2e-import-ui.mjs            (expects wrangler dev on :8787)
 */
import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipSync, strToU8 } from 'fflate';

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

/** The smallest thing that sniffs as a real PNG, so the ZIP lane stores it. */
const PNG_1x1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

const q = (row) => row.map((c) => (/[",\r\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(',');

async function main() {
  mkdirSync(OUT, { recursive: true });
  console.log(`\nLEVONIS import window — ${BASE}\n`);

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
      { name: cookie.split('=')[0], value: cookie.split('=').slice(1).join('='), domain: '127.0.0.1', path: '/' },
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
    check(`${width}px — the window opens on one import panel`, (await panel.count()) === 1);
    if ((await panel.count()) !== 1) {
      await ctx.close();
      continue;
    }

    // ---------------------------------------------- 1. the format question
    check(`${width}px — the old two-tab strip is gone`, (await page.locator('[data-import-tab]').count()) === 0);
    check(
      `${width}px — all three formats are offered`,
      (await page.locator('[data-import-format]').count()) === 3,
      `found=${await page.locator('[data-import-format]').count()}`
    );
    for (const f of ['csv', 'zip', 'txt']) {
      const text = await page.locator(`[data-import-format="${f}"]`).first().innerText();
      check(`${width}px — the ${f.toUpperCase()} choice explains itself`, text.replace(/\s+/g, ' ').trim().length > 40, text.slice(0, 60));
    }
    check(
      `${width}px — CSV is the format the window starts on`,
      (await page.locator('[data-import-format="csv"]').first().getAttribute('aria-checked')) === 'true'
    );

    // -------------------------------------- 2. each lane shows its template
    check(`${width}px — the CSV lane offers the CSV template`, (await page.locator('[data-import="template-csv"]').count()) === 1);
    check(`${width}px — and nothing from the other lanes`, (await page.locator('[data-import="template-zip"], [data-import="template-txt"]').count()) === 0);

    await page.locator('[data-import-format="zip"]').click();
    await page.waitForTimeout(250);
    check(`${width}px — the ZIP lane offers the ZIP template`, (await page.locator('[data-import="template-zip"]').count()) === 1);

    await page.locator('[data-import-format="txt"]').click();
    await page.waitForTimeout(250);
    check(`${width}px — the TXT lane offers the TXT template`, (await page.locator('[data-import="template-txt"]').count()) === 1);
    check(`${width}px — and a filled TXT example`, (await page.locator('[data-import="template-txt-example"]').count()) === 1);
    check(`${width}px — the TXT lane takes pasted text too`, (await page.locator('[data-import="paste"]').count()) === 1);

    await page.locator('[data-import-format="csv"]').click();
    await page.waitForTimeout(250);

    // --------------------------------------------- 3. the compact pickers
    const chips = await page.locator('[data-import="types"] button').count();
    check(`${width}px — the product types are compact chips`, chips >= 5, `chips=${chips}`);
    const sections = await page.locator('[data-import="section"] option').count();
    check(`${width}px — the section picker is populated`, sections > 1, `options=${sections}`);

    // ------------------------------------------ 4. no import before a check
    check(
      `${width}px — there is no import button before a check`,
      (await page.locator('[data-import="confirm"]').count()) === 0
    );
    check(
      `${width}px — the check is disabled until a section and a file are chosen`,
      await page.locator('[data-import="check"]').first().evaluate((el) => el.disabled)
    );

    const value = await page.locator('[data-import="section"] option').nth(1).getAttribute('value');
    await page.selectOption('[data-import="section"]', value);
    await page.waitForTimeout(300);
    check(
      `${width}px — the export enables once a section is chosen`,
      (await page.locator('[data-import="export-csv"]').first().evaluate((el) => el.disabled)) === false
    );

    // ------------------------------------------------------- 5. responsive
    const overflow = await page.evaluate(() => {
      const de = document.documentElement;
      return de.scrollWidth - de.clientWidth;
    });
    check(`${width}px — the window does not scroll the page sideways`, overflow <= 1, `overflow=${overflow}`);

    const wide = await page.evaluate(() => {
      const p = document.querySelector('[data-panel="import-v2"]');
      if (!p) return -1;
      let worst = 0;
      for (const el of p.querySelectorAll('*')) {
        const r = el.getBoundingClientRect();
        if (r.width > 0) worst = Math.max(worst, Math.ceil(r.right) - window.innerWidth);
      }
      return worst;
    });
    check(`${width}px — no element inside the panel spills past the viewport`, wide <= 2, `spill=${wide}px`);

    // Admin density: BUTTONS at the owner's 36px scale, INPUTS/SELECTS at 40px.
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

    // ---------------------------------------- 6. the whole flow, at one width
    if (width === 1024) {
      const columns = await page.evaluate(async (id) => {
        const res = await fetch(`/api/admin/import/template?category=${encodeURIComponent(id)}&format=csv`, {
          credentials: 'same-origin',
        });
        const text = await res.text();
        return text.replace(/^\uFEFF/, '').split(/\r?\n/)[0].split(',');
      }, value);
      const cell = (v) => columns.map((c) => v[c] ?? '');

      // ---- 6a. a BAD file: the check must refuse it, and say why usefully.
      const badKey = `BAD-${rnd}`;
      const badCsv = [
        q(columns),
        // no name and no price: two missing required fields.
        q(cell({ row_type: 'product', key: badKey, category: value, status: 'draft' })),
        // the same key twice: a duplicate.
        q(cell({ row_type: 'product', key: badKey, name: `Dup ${rnd}`, category: value, price_iqd: '1000', status: 'draft' })),
        // an image that is in no archive and is not a URL: a missing image.
        q(cell({ row_type: 'image', key: badKey, image: 'nowhere.png' })),
      ].join('\r\n');

      await page.setInputFiles('[data-import="file"]', {
        name: 'bad.csv',
        mimeType: 'text/csv',
        buffer: Buffer.from(badCsv, 'utf8'),
      });
      await page.waitForTimeout(300);
      await page.locator('[data-import="check"]').first().click();
      await page.waitForTimeout(2500);

      const report = page.locator('[data-import="check-report"]');
      check('a bad file produces a check report', (await report.count()) === 1);
      const stat = async (k) =>
        parseInt((await page.locator(`[data-import-stat="${k}"] span[dir="ltr"]`).first().innerText()) || '0', 10);
      check('the report counts the products in the file', (await stat('count-products')) >= 1, `n=${await stat('count-products')}`);
      check('the report counts errors', (await stat('count-errors')) > 0, `n=${await stat('count-errors')}`);
      check('the report counts missing fields separately', (await stat('count-missing')) > 0, `n=${await stat('count-missing')}`);
      check('the report counts missing images separately', (await stat('count-images')) > 0, `n=${await stat('count-images')}`);
      check('the report counts duplicates separately', (await stat('count-duplicates')) > 0, `n=${await stat('count-duplicates')}`);

      const errText = await page.locator('[data-import-issues="bad"]').first().innerText();
      check('an error names its product', errText.includes(badKey), errText.replace(/\s+/g, ' ').slice(0, 140));
      check('an error names its line', /سطر \d+|line \d+/.test(errText), errText.replace(/\s+/g, ' ').slice(0, 140));
      check('an error names its field', /الحقل \w+|field \w+/.test(errText), errText.replace(/\s+/g, ' ').slice(0, 140));

      check(
        'the import button exists but is DISABLED while the file is blocked',
        (await page.locator('[data-import="confirm"]').count()) === 1 &&
          (await page.locator('[data-import="confirm"]').first().evaluate((el) => el.disabled)) === true
      );
      await page.screenshot({ path: path.join(OUT, 'import-check-blocked.png') });

      // ---- 6a2. A MIXED file: one good row, one broken. The good row must
      // still import — /confirm applies what the check accepted — but only
      // after the admin has seen the check say so.
      const mixKey = `MIX-${rnd}`;
      const mixCsv = [
        q(columns),
        q(cell({ row_type: 'product', key: mixKey, name: `UI MIX ${rnd}`, category: value, price_iqd: '470000', status: 'draft' })),
        q(cell({ row_type: 'product', key: `${mixKey}-BAD`, category: value, status: 'draft' })),
      ].join('\r\n');
      await page.setInputFiles('[data-import="file"]', {
        name: 'mixed.csv',
        mimeType: 'text/csv',
        buffer: Buffer.from(mixCsv, 'utf8'),
      });
      await page.waitForTimeout(300);
      await page.locator('[data-import="check"]').first().click();
      await page.waitForTimeout(2500);
      check('a mixed file reports exactly one blocked row', (await stat('count-blocked')) === 1, `n=${await stat('count-blocked')}`);
      check(
        'a blocked row is skipped, not a veto over the good ones',
        (await page.locator('[data-import="confirm"]').first().evaluate((el) => el.disabled)) === false
      );
      await page.locator('[data-import="confirm"]').first().click();
      await page.waitForTimeout(3500);
      check(
        'the mixed import creates the good row only',
        /أُنشئ 1|1 created/.test(await page.locator('[data-import="result"]').first().innerText())
      );

      // ---- 6b. CSV, all the way through.
      const csvKey = `CSV-${rnd}`;
      const goodCsv = [
        q(columns),
        q(cell({ row_type: 'product', key: csvKey, name: `UI CSV ${rnd}`, category: value, price_iqd: '450000', status: 'draft' })),
        q(cell({ row_type: 'option', key: csvKey, group: 'Size', value: 'Large', active: 'yes' })),
      ].join('\r\n');
      await page.setInputFiles('[data-import="file"]', {
        name: 'good.csv',
        mimeType: 'text/csv',
        buffer: Buffer.from(goodCsv, 'utf8'),
      });
      await page.waitForTimeout(300);
      await page.locator('[data-import="check"]').first().click();
      await page.waitForTimeout(2500);
      check('a clean CSV reports zero errors', (await stat('count-errors')) === 0, `n=${await stat('count-errors')}`);
      check(
        'and only then is the import button enabled',
        (await page.locator('[data-import="confirm"]').first().evaluate((el) => el.disabled)) === false
      );
      check(
        'the panel says plainly that the check wrote nothing',
        /لا يكتب|لا تكتب|writes nothing/.test(await panel.innerText()),
        (await panel.innerText()).replace(/\s+/g, ' ').slice(0, 120)
      );
      await page.screenshot({ path: path.join(OUT, 'import-check-clean.png') });

      await page.locator('[data-import="confirm"]').first().click();
      await page.waitForTimeout(3500);
      const csvResult = await page.locator('[data-import="result"]').first().innerText();
      check('the CSV import reports its result', /أُنشئ 1|1 created/.test(csvResult), csvResult.replace(/\s+/g, ' ').slice(0, 140));
      check('the CSV result offers the report download', (await page.locator('[data-import="report"]').count()) === 1);

      const found = async (needle) =>
        page.evaluate(async (k) => {
          const res = await fetch(`/api/admin/products-v2?search=${encodeURIComponent(k)}`, { credentials: 'same-origin' });
          const data = await res.json();
          return (data.products ?? []).length;
        }, needle);
      check('the CSV product really exists afterwards', (await found(csvKey)) === 1);
      await page.screenshot({ path: path.join(OUT, 'import-result-csv.png') });

      // ---- 6c. ZIP: the same sheet plus an images/ folder.
      await page.locator('[data-import-format="zip"]').click();
      await page.waitForTimeout(250);
      await page.selectOption('[data-import="section"]', value);
      await page.waitForTimeout(200);

      const zipKey = `ZIP-${rnd}`;
      const zipCsv = [
        q(columns),
        q(cell({ row_type: 'product', key: zipKey, name: `UI ZIP ${rnd}`, category: value, price_iqd: '460000', status: 'draft' })),
        q(cell({ row_type: 'image', key: zipKey, image: 'images/pic.png', is_main: 'yes' })),
      ].join('\r\n');
      const zipBytes = zipSync({
        'data.csv': strToU8(zipCsv),
        'images/pic.png': new Uint8Array(PNG_1x1),
      });
      await page.setInputFiles('[data-import="file"]', {
        name: 'good.zip',
        mimeType: 'application/zip',
        buffer: Buffer.from(zipBytes),
      });
      await page.waitForTimeout(300);
      await page.locator('[data-import="check"]').first().click();
      await page.waitForTimeout(3000);
      check('the ZIP check finds its image inside the archive', (await stat('count-images')) === 0, `missing=${await stat('count-images')}`);
      check('the ZIP check reports no missing-image product', (await stat('count-no-images')) === 0);
      check('the ZIP check reports zero errors', (await stat('count-errors')) === 0);
      await page.locator('[data-import="confirm"]').first().click();
      await page.waitForTimeout(3500);
      check('the ZIP import reports its result', /أُنشئ 1|1 created/.test(await page.locator('[data-import="result"]').first().innerText()));
      check('the ZIP product really exists afterwards', (await found(zipKey)) === 1);
      await page.screenshot({ path: path.join(OUT, 'import-result-zip.png') });

      // ---- 6d. TXT: the served example, made unique, through the same steps.
      await page.locator('[data-import-format="txt"]').click();
      await page.waitForTimeout(250);

      const tplTyped = await page.evaluate(async () => {
        const res = await fetch('/api/admin/template/blank?type=printer', { credentials: 'same-origin' });
        return { status: res.status, text: await res.text() };
      });
      check('the TXT template can be fetched for a product type', tplTyped.status === 200);
      check(
        'the typed TXT template carries that type’s specification sheet',
        tplTyped.text.includes('spec_groups.1.rows.1.label_ar='),
        tplTyped.text.slice(0, 60)
      );
      check(
        'the typed TXT template says the repeated groups have no fixed count',
        /No fixed number|لا حد ثابت/.test(tplTyped.text)
      );

      const txtName = `UI TXT ${rnd}`;
      const example = await page.evaluate(async () => {
        const res = await fetch('/api/admin/template/example', { credentials: 'same-origin' });
        return res.text();
      });
      /** /apply refuses a duplicate by slug OR Arabic name, so each copy of the
       *  example needs both of its own. */
      const uniq = (slug, name) =>
        example
          .replace('slug=levonis-template-example', `slug=${slug}`)
          .replace(/^name_en=.*$/m, `name_en=${name}`)
          .replace(/^name_ar=.*$/m, `name_ar=${name} AR`);
      const txt = uniq(`ui-txt-${rnd}`, txtName);

      await page.setInputFiles('[data-import="file"]', {
        name: 'product.txt',
        mimeType: 'text/plain',
        buffer: Buffer.from(txt, 'utf8'),
      });
      await page.waitForTimeout(300);
      await page.locator('[data-import="check"]').first().click();
      await page.waitForTimeout(3000);
      check('the TXT check reports one product', (await stat('count-products')) === 1, `n=${await stat('count-products')}`);
      check('the TXT check reports zero errors', (await stat('count-errors')) === 0, `n=${await stat('count-errors')}`);
      check(
        'the TXT import button is enabled only after that check',
        (await page.locator('[data-import="confirm"]').first().evaluate((el) => el.disabled)) === false
      );
      await page.screenshot({ path: path.join(OUT, 'import-check-txt.png') });

      await page.locator('[data-import="confirm"]').first().click();
      await page.waitForTimeout(4000);
      const txtResult = await page.locator('[data-import="result"]').first().innerText();
      check('the TXT import reports its result', /أُنشئ 1|1 created/.test(txtResult), txtResult.replace(/\s+/g, ' ').slice(0, 140));
      check('the TXT product really exists afterwards', (await found(`ui-txt-${rnd}`)) === 1);
      await page.screenshot({ path: path.join(OUT, 'import-result-txt.png') });

      // ---- 6e. TXT again, as a ZIP of .txt files.
      const zipTxtSlug = `ui-txtzip-${rnd}`;
      const bundle = zipSync({
        'a.txt': strToU8(uniq(`${zipTxtSlug}-a`, `UI ZIPTXT A ${rnd}`)),
        'b.txt': strToU8(uniq(`${zipTxtSlug}-b`, `UI ZIPTXT B ${rnd}`)),
      });
      await page.setInputFiles('[data-import="file"]', {
        name: 'bundle.zip',
        mimeType: 'application/zip',
        buffer: Buffer.from(bundle),
      });
      await page.waitForTimeout(300);
      await page.locator('[data-import="check"]').first().click();
      await page.waitForTimeout(4000);
      check('a ZIP of .txt files checks every file', (await stat('count-products')) === 2, `n=${await stat('count-products')}`);
      check('the ZIP-of-TXT check reports zero errors', (await stat('count-errors')) === 0, `n=${await stat('count-errors')}`);
      await page.locator('[data-import="confirm"]').first().click();
      await page.waitForTimeout(6000);
      check('both .txt files import', (await found(`${zipTxtSlug}`)) === 2, `found=${await found(zipTxtSlug)}`);
      await page.screenshot({ path: path.join(OUT, 'import-result-txtzip.png') });

      // ---- 6f. the duplicate question: same Arabic name, new slug. The check
      // cannot know (parse does not look for duplicates), so the refusal comes
      // from /apply and the panel must ASK rather than pick for the admin.
      await page.setInputFiles('[data-import="file"]', {
        name: 'dup.txt',
        mimeType: 'text/plain',
        buffer: Buffer.from(
          example
            .replace('slug=levonis-template-example', `slug=ui-dup-${rnd}`)
            .replace(/^name_en=.*$/m, `name_en=UI DUP ${rnd}`)
            .replace(/^name_ar=.*$/m, `name_ar=${txtName} AR`),
          'utf8'
        ),
      });
      await page.waitForTimeout(300);
      await page.locator('[data-import="check"]').first().click();
      await page.waitForTimeout(3000);
      await page.locator('[data-import="confirm"]').first().click();
      await page.waitForTimeout(3500);
      check(
        'a duplicate is a QUESTION, not a silent choice',
        (await page.locator('[data-import="duplicate"]').count()) === 1
      );
      check(
        'both ways out are offered',
        (await page.locator('[data-import="dup-update"]').count()) === 1 &&
          (await page.locator('[data-import="dup-new"]').count()) === 1
      );
      await page.screenshot({ path: path.join(OUT, 'import-duplicate.png') });
      await page.locator('[data-import="dup-new"]').first().click();
      await page.waitForTimeout(4000);
      check('choosing "new draft" imports it', (await found(`ui-dup-${rnd}`)) === 1, `found=${await found(`ui-dup-${rnd}`)}`);
    }

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
