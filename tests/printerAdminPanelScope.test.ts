/**
 * PRINTER PHASE 4 — the admin panel shows ONLY the edited printer (owner, 2026-11-18: «I edit the A1,
 * no need to see the other printers»; DECISIONS row 355).
 *
 *  - The offers tab renders this printer's kits and add-ons; those of other printers are folded and
 *    counted by their own title, and no other printer's name appears anywhere on the page.
 *  - Every select has a visible label, and no select offers «—» as its empty choice.
 *  - The shared price list says, before anything else, that it changes every enrolled printer.
 *  - The status line says other printers' blockers as a count, never by id or name.
 *  - No Tailwind class the rest of src does not already use (the public CSS budget has no room).
 *
 * Run: TZ=UTC node --import tsx --test tests/printerAdminPanelScope.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  DEFAULT_PRINTER_SERVICES,
  type PrinterServicesConfig,
} from '../packages/pricing/src/printerServices';
import PrinterOffersTab from '../src/components/adminPrinterServices/PrinterOffersTab';
import PrinterThisTab, { type ServicesPrinter } from '../src/components/adminPrinterServices/PrinterThisTab';
import SharedPriceListTab from '../src/components/adminPrinterServices/SharedPriceListTab';
import PrinterStatusLine, { scopeIssues } from '../src/components/adminPrinterServices/PrinterStatusLine';
import { withThisPrinter } from '../src/components/adminPrinterServices/PrinterExtrasPanels';
import { S, sharedWithOthers } from '../src/components/adminPrinterServices/adminPrinterStrings';

const ROOT = join(import.meta.dirname, '..');
const DIR = 'src/components/adminPrinterServices';
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const loc = (ar: string) => ar;
const noop = () => {};

const A1 = 'prd_a1'; const H3C = 'prd_h3c'; const X2D = 'prd_x2d';
const printers: ServicesPrinter[] = [
  { id: A1, slug: 'bambu-a1', name: 'Bambu Lab A1', status: 'active', is_used: false, versions: [{ id: 'ov_a1_std', name: 'Standard' }, { id: 'ov_a1_combo', name: 'Combo' }] },
  { id: H3C, slug: 'bambu-h3c', name: 'Bambu Lab H3C', status: 'active', is_used: false, versions: [] },
  { id: X2D, slug: 'bambu-x2d', name: 'Bambu Lab X2D', status: 'active', is_used: false, versions: [] },
];
const OTHER_NAMES = ['Bambu Lab H3C', 'Bambu Lab X2D', 'H3C', 'X2D', 'A1 mini'];

function draft(): PrinterServicesConfig {
  const d = JSON.parse(JSON.stringify(DEFAULT_PRINTER_SERVICES)) as PrinterServicesConfig;
  d.products = {
    [A1]: { warranty_family: 'a1', delivery_class: 'd1' },
    [H3C]: { warranty_family: 'h3c', delivery_class: 'd5' },
    [X2D]: { warranty_family: 'xpa2', delivery_class: 'd2' },
  };
  const title = (s: string) => ({ ar: s, en: s, ckb: s });
  d.kits = [
    { id: 'kit-all', active: true, sort: 0, title: title('باقة للجميع'), items: [], printers: null, discount: { mode: 'percent', value: 10 } },
    { id: 'kit-h3c', active: true, sort: 1, title: title('باقة الطابعة الكبيرة'), items: [], printers: [{ product_id: H3C, option_value_id: null }], discount: null },
    { id: 'kit-a1', active: true, sort: 2, title: title('باقة الطابعة الصغيرة'), items: [], printers: [{ product_id: A1, option_value_id: null }], discount: null },
  ];
  d.addons = [
    { id: 'addon-x2d', active: true, sort: 0, title: title('فوهة خاصة'), product_id: 'prd_nozzle', option_value_ids: [], color_id: null, color_mode: 'fixed', qty: 1, discount: null, printers: [{ product_id: X2D, option_value_id: null }] },
  ];
  return d;
}

/** Every <select> in the markup sits inside a <label> or is named by a <label for>. */
function selectsLabelled(html: string): string[] {
  const bad: string[] = [];
  const re = /<select\b[^>]*>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const before = html.slice(0, m.index);
    const open = (before.match(/<label\b/g) ?? []).length - (before.match(/<\/label>/g) ?? []).length;
    const id = /\bid="([^"]+)"/.exec(m[0])?.[1];
    if (open > 0) continue;
    if (id && html.includes(`for="${id}"`)) continue;
    bad.push(m[0]);
  }
  return bad;
}

test('the offers tab: this printer\'s kits only, others folded and counted, no other printer named', () => {
  const html = renderToStaticMarkup(createElement(PrinterOffersTab, { draft: draft(), upd: noop, loc, lang: 'ar', printers, productId: A1 }));
  for (const name of OTHER_NAMES) assert.ok(!html.includes(name), `another printer is named on the A1 page: ${name}`);
  assert.match(html, /data-printer-services-kit="kit-all"/, 'a kit for every printer shows here');
  assert.match(html, /data-printer-services-kit="kit-a1"/, 'this printer\'s own kit shows here');
  assert.doesNotMatch(html, /data-printer-services-kit="kit-h3c"/, 'another printer\'s kit is not edited here');
  assert.match(html, /data-every-printer/, 'the every-printer kit carries its badge');
  assert.match(html, new RegExp(`${S.others[0]} \\(2\\)`), 'the other printers\' kit and add-on are counted');
  assert.ok(html.includes('باقة الطابعة الكبيرة') && html.includes('فوهة خاصة'), 'each folded one is said by its own title');
  assert.ok(html.includes(S.addHere[0]));
  assert.doesNotMatch(html, /الطابعات التي تناسبها/, 'the old checklist of every mapped printer is gone');
  assert.deepEqual(selectsLabelled(html), []);
});

test('a kit / add-on shared by a list with other printers says «مشتركة مع N طابعات أخرى» — a count, never names', () => {
  const d = draft();
  d.kits![2].printers = [{ product_id: A1, option_value_id: null }, { product_id: H3C, option_value_id: null }, { product_id: X2D, option_value_id: 'ov_x' }, { product_id: X2D, option_value_id: 'ov_y' }];
  d.addons![0].printers = [{ product_id: X2D, option_value_id: null }, { product_id: A1, option_value_id: 'ov_a1_combo' }];
  const html = renderToStaticMarkup(createElement(PrinterOffersTab, { draft: d, upd: noop, loc, lang: 'ar', printers, productId: A1 }));
  for (const name of OTHER_NAMES) assert.ok(!html.includes(name), `another printer is named: ${name}`);
  assert.match(html, /data-shared-printers="2"[^>]*>مشتركة مع طابعتين أخريين</, 'two other printers (X2D counted once over its versions)');
  assert.match(html, /data-shared-printers="1"[^>]*>مشتركة مع طابعة أخرى</, 'the add-on shared with one other printer');
  // A kit for this printer alone, or for every printer, carries no shared count.
  const alone = renderToStaticMarkup(createElement(PrinterOffersTab, { draft: draft(), upd: noop, loc, lang: 'ar', printers, productId: A1 }));
  assert.doesNotMatch(alone, /data-shared-printers/);
  assert.deepEqual([sharedWithOthers(1)[1], sharedWithOthers(3)[0], sharedWithOthers(11)[0], sharedWithOthers(3)[2]],
    ['Shared with 1 other printer', 'مشتركة مع 3 طابعات أخرى', 'مشتركة مع 11 طابعة أخرى', 'هاوبەشە لەگەڵ 3 پرینتەری تر']);
});

test('the switch edits only this printer\'s entry; off on an every-printer kit keeps it on the others', () => {
  const enrolled = [A1, H3C, X2D];
  assert.deepEqual(withThisPrinter(null, A1, false, enrolled), [{ product_id: H3C, option_value_id: null }, { product_id: X2D, option_value_id: null }]);
  assert.equal(withThisPrinter(null, A1, true, enrolled), null);
  const list = [{ product_id: H3C, option_value_id: null }];
  assert.deepEqual(withThisPrinter(list, A1, true, enrolled), [...list, { product_id: A1, option_value_id: null }]);
  assert.deepEqual(withThisPrinter([...list, { product_id: A1, option_value_id: 'ov_a1_combo' }], A1, false, enrolled), list);
});

test('this printer: visible labels with hints, «اختر…» and «مثل الطابعة», never «—»; only this printer\'s versions', () => {
  const printer = printers[0];
  const html = renderToStaticMarkup(createElement(PrinterThisTab, { draft: draft(), upd: noop, loc, printer }));
  assert.deepEqual(selectsLabelled(html), []);
  assert.match(html, new RegExp(`<label for="ps-fam-${A1}"[^>]*>${S.famLabel[0]}</label>`));
  assert.match(html, new RegExp(`<label for="ps-cls-${A1}"[^>]*>${S.clsLabel[0]}</label>`));
  assert.ok(html.includes(S.famHint[0]) && html.includes(S.clsHint[0]));
  assert.ok(html.includes(S.sameAsPrinter[0]), 'a version\'s empty choice is said in words');
  assert.doesNotMatch(html, /<option value="">—<\/option>/);
  // Other printers are never named; the warranty FAMILIES keep their series names (what the owner prices by).
  for (const name of OTHER_NAMES.filter((n) => n.startsWith('Bambu'))) assert.ok(!html.includes(name), name);
  // A delivery class is said by its box size, never by the printers in it.
  assert.doesNotMatch(html, /X2D|A1 mini|Snapmaker|P1S|A2L/);
});

test('the shared list: a banner that it changes every enrolled printer, this printer\'s family first', () => {
  const html = renderToStaticMarkup(createElement(SharedPriceListTab, { draft: draft(), upd: noop, loc, published: null, productId: A1 }));
  assert.match(html, /data-shared-warning/);
  assert.ok(html.includes(`${S.sharedBanner[0]} (3)`), 'the banner counts the enrolled printers');
  assert.ok(html.indexOf(S.thisFamily[0]) > -1 && html.indexOf(S.thisFamily[0]) < html.indexOf(S.otherFamilies[0]));
  assert.match(html, /data-shared-group="warranty"/);
  assert.deepEqual(selectsLabelled(html), []);
});

test('the status line: other printers\' blockers are counted, never named', () => {
  const issues = [`products.${H3C}: needs a delivery class`, `products.${A1}.warranty_family: needs a family`, 'care.terms: write the Levo Care terms before publishing Care'];
  assert.deepEqual(scopeIssues(issues, A1, printers.map((p) => p.id)), { mine: [issues[1], issues[2]], others: 1 });
  const html = renderToStaticMarkup(createElement(PrinterStatusLine, {
    loc, productId: A1, listed: true, draft: draft(), published: null, publishIssues: issues,
    printerIds: printers.map((p) => p.id), dirty: true, issueSay: (i: string) => ({ text: i, translated: false }),
  }));
  assert.ok(!html.includes(H3C), 'another printer\'s id is not shown');
  assert.match(html, /و1 في طابعات أخرى/);
  assert.ok(html.includes(S.stUnsaved[0]) && html.includes(S.stNotPublished[0]));
});

test('source: every select labelled, no «—» option, other printers never mapped into the page, owner-only save kept', () => {
  const files = readdirSync(join(ROOT, DIR)).filter((f) => f.endsWith('.tsx'));
  for (const f of files) {
    const src = read(`${DIR}/${f}`);
    assert.doesNotMatch(src, /<option[^>]*>\s*—\s*<\/option>/, `${f}: a «—» option`);
    assert.doesNotMatch(src, /<select[^>]*aria-label=/, `${f}: a select named only for screen readers`);
    assert.doesNotMatch(src, /\b(mapped|printers)\.(map|flatMap)\(\(p\) => [(<]/, `${f}: a list of every printer rendered`);
  }
  const panel = read(`${DIR}/AdminPrinterServices.tsx`);
  assert.match(panel, /state\.printers\.find\(\(p\) => p\.id === productId\)/);
  assert.match(panel, /const readOnly = !isOwner;/);
  assert.match(panel, /<fieldset disabled=\{readOnly\}/);
  assert.match(panel, /e instanceof ApiError && e\.status === 409/);
  assert.match(panel, /data-printer-services-stale/);
  assert.match(panel, /base_revision: state!\.draft\.revision/);
  // Section ٤: one folded block per subject, the panel lazy and printers-only, the data-form hooks kept.
  const form = read('src/components/adminProducts/ProductForm.tsx');
  assert.match(form, /const AdminPrinterServices = React\.lazy\(\(\) => import\('\.\.\/adminPrinterServices\/AdminPrinterServices'\)\)/);
  for (const key of ['delivery', 'printer-services', 'warranty', 'condition', 'dimensions', 'instalments']) assert.match(form, new RegExp(`s4Block\\(\\s*'${key}'`), key);
  for (const hook of ['warranty-preserved', 'payment-options-preserved', 'gini-url']) assert.match(form, new RegExp(`data-form="${hook}"`), hook);
  assert.match(form, /block\?\.closest\('details'\)\?\.setAttribute\('open', ''\)/, '«الأبعاد والوزن» opens before the scroll to it');
});

// ---------------------------------------------------------------- no new Tailwind class

function classTokens(src: string): Set<string> {
  const out = new Set<string>();
  const re = /className=(?:"([^"]*)"|\{([\s\S]*?)\}(?=[\s>/]))/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const strs = m[1] !== undefined ? [m[1]] : [...m[2].matchAll(/'([^']*)'|"([^"]*)"|`([^`]*)`/g)].map((x) => (x[1] ?? x[2] ?? x[3]).replace(/\$\{[^}]*\}/g, ' '));
    for (const s of strs) for (const t of s.split(/\s+/)) if (t && /^[!a-z0-9:[\]\-._/%]+$/i.test(t) && /[a-z]/.test(t)) out.add(t);
  }
  return out;
}
function wordsOf(dir: string, skip: (path: string) => boolean): Set<string> {
  const words = new Set<string>();
  const walk = (d: string) => {
    for (const f of readdirSync(d)) {
      const p = join(d, f);
      if (statSync(p).isDirectory()) walk(p);
      else if (!skip(p.split('\\').join('/'))) for (const w of readFileSync(p, 'utf8').split(/[\s"'`{}]+/)) words.add(w);
    }
  };
  walk(dir);
  return words;
}

test('no Tailwind class the rest of src does not already use (the public CSS has no room)', () => {
  const outside = wordsOf(join(ROOT, 'src'), (p) => p.includes(`/${DIR}/`) || p.endsWith('/adminProducts/ProductForm.tsx'));
  const form = read('src/components/adminProducts/ProductForm.tsx');
  const s4 = form.slice(form.indexOf('{/* Section ٤, redesigned'), form.indexOf('{/* 5 ───'));
  assert.ok(s4.length > 1000, 'section ٤ is found');
  const rest = form.replace(s4, '');
  for (const w of rest.split(/[\s"'`{}]+/)) outside.add(w);
  const fresh: string[] = [];
  for (const f of readdirSync(join(ROOT, DIR)).filter((x) => x.endsWith('.tsx'))) {
    for (const t of classTokens(read(`${DIR}/${f}`))) if (!outside.has(t)) fresh.push(`${f}: ${t}`);
  }
  for (const t of classTokens(s4)) if (!outside.has(t)) fresh.push(`ProductForm §4: ${t}`);
  assert.deepEqual(fresh, []);
});
