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
 * PRINTER PHASE 5 — the same panel as ONE calm screen (owner, 2026-11-18; DECISIONS row 358):
 *
 *  - The status header says in words what a customer sees for THIS printer and the single next step
 *    (choose → save → publish).
 *  - «ما يراه الزبون» lists everything the printer offers, Levo Care with its total cover: 12 / 24 /
 *    36 months beside no warranty / 12 / 24.
 *  - The shared price list is locked until it is opened on purpose; a ready package is said in words,
 *    never by its stored codes; a kit is named by its title in what blocks a publish.
 *  - Section ٤ of the product form is «خدمات الطابعة» on a printer and «الحالة والأبعاد» on anything
 *    else; the old delivery line and the old extended-warranty editor are gone.
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
import PrinterStatusLine, { nextStepOf, scopeIssues } from '../src/components/adminPrinterServices/PrinterStatusLine';
import CustomerPreview from '../src/components/adminPrinterServices/CustomerPreview';
import { withThisPrinter } from '../src/components/adminPrinterServices/itemToolkit';
import { issueText } from '../src/components/adminPrinterServices/issueWords';
import { S, packageContents, sharedWithOthers } from '../src/components/adminPrinterServices/adminPrinterStrings';

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
  // Phase 5: opened from ONE printer's page, the list every printer shares is locked until opened on purpose.
  assert.match(html, /data-shared-locked="yes"/);
  assert.match(html, /<fieldset disabled=""[^>]*data-shared-fields/, 'every price is readable, none editable, until unlocked');
  assert.ok(html.includes(`${S.sharedUnlock[0]} (3)`), 'the unlock button says how many printers it reaches');
  assert.ok(html.indexOf('data-shared-unlock') < html.indexOf('data-shared-fields'), 'the unlock button sits outside the locked fields');
  // A ready package is said in words — never the stored codes joined by « · ».
  assert.doesNotMatch(html, /\b(w12|w24|c12)\b/);
  assert.doesNotMatch(html, /(extra|full|standard) · /);
  assert.deepEqual(packageContents({ warranty: 'w24', care: 'c12', packaging: 'extra', inspection: 'full' }, loc),
    ['ضمان 24 شهراً', 'ليفو كير (التغطية الكلية 36 شهراً)', 'تغليف حماية إضافية', 'فحص قبل الشحن']);
  assert.deepEqual(packageContents({ warranty: 'w12', care: 'none', packaging: 'standard', inspection: 'none' }, loc), ['ضمان 12 شهراً', 'تغليف عادي']);
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
  // Phase 5: the single next step, said in words. Unsaved edits come before what blocks the publish.
  assert.match(html, /data-printer-next-step="save"/);
  assert.ok(html.includes(S.nextSave[0]));
  assert.ok(html.includes(S.stIssuesLive[0]), 'while editing, the list says it is worked out from the screen');
  assert.match(html, /data-step-state="done"[^>]*>.*?الاختيار/, 'the family and class are chosen: stage 1 is done');
});

test('the next step: save the product → choose → fix → save → complete → publish → nothing', () => {
  const base = { listed: true, used: false, mapped: true, held: false, dirty: false, issues: 0, upToDate: false };
  assert.equal(nextStepOf({ ...base, listed: false }), 'save-product');
  assert.equal(nextStepOf({ ...base, used: true }), 'none', 'a used printer takes no services');
  assert.equal(nextStepOf({ ...base, mapped: false, dirty: true }), 'map');
  assert.equal(nextStepOf({ ...base, held: true, dirty: true }), 'fix-local', 'a save the server would refuse is not the next step');
  assert.equal(nextStepOf({ ...base, dirty: true, issues: 2 }), 'save');
  assert.equal(nextStepOf({ ...base, issues: 2 }), 'fix');
  assert.equal(nextStepOf(base), 'publish');
  assert.equal(nextStepOf({ ...base, upToDate: true }), 'done');

  const ids = printers.map((p) => p.id);
  const say = (i: string) => ({ text: i, translated: false });
  const render = (props: Record<string, unknown>) => renderToStaticMarkup(createElement(PrinterStatusLine, {
    loc, productId: A1, listed: true, draft: draft(), published: null, publishIssues: [], printerIds: ids, dirty: false, issueSay: say, ...props,
  }));
  // Saved, nothing missing, never published: publish is the step, and customers see nothing yet.
  const ready = render({});
  assert.match(ready, /data-printer-status="off"/);
  assert.match(ready, /data-printer-next-step="publish"/);
  // Published at the draft's revision: customers see it, nothing is left to do.
  const live = render({ published: draft() });
  assert.match(live, /data-printer-status="live"/);
  assert.ok(live.includes(S.stPublished[0]) && live.includes(S.nextDone[0]));
  // Published, then saved again: customers still see the OLDER copy — said plainly.
  const newer = draft(); newer.revision = 9;
  const older = render({ draft: newer, published: draft() });
  assert.ok(older.includes(S.stPublishedOlder[0]));
  assert.match(older, /data-printer-next-step="publish"/);
  // Not mapped yet.
  const blank = draft(); delete blank.products[A1];
  assert.match(render({ draft: blank }), /data-printer-next-step="map"/);
  // Not a saved printer: no stages, one instruction.
  const unlisted = render({ listed: false });
  assert.match(unlisted, /data-printer-status="not-listed"/);
  assert.doesNotMatch(unlisted, /data-printer-status-steps/);
  assert.ok(unlisted.includes(S.nextSaveProduct[0]));
  // A used printer.
  assert.ok(render({ used: true }).includes(S.stUsed[0]));
});

test('«ما يراه الزبون»: every service of this printer, Levo Care with its total cover 12 / 24 / 36', () => {
  const d = draft();
  // A customer is offered a kit only once it has an item: the fixture's empty kits get one each.
  for (const k of d.kits!) k.items = [{ product_id: 'prd_pla', option_value_ids: [], color_id: null, qty: 4 }];
  const html = renderToStaticMarkup(createElement(CustomerPreview, { draft: d, loc, lang: 'ar', printer: printers[0] }));
  for (const key of ['warranty', 'care', 'packaging', 'inspection', 'delivery', 'packages', 'membership', 'kits', 'addons', 'bundles']) {
    assert.match(html, new RegExp(`data-preview-group="${key}"`), key);
  }
  // Care is the 12 months AFTER the warranty: alone 12, with 12 months 24, with 24 months 36.
  assert.deepEqual([...html.matchAll(/data-care-total="(\d+)"/g)].map((m) => m[1]), ['12', '24', '36']);
  assert.ok(html.includes(S.pvNoWarranty[0]) && html.includes(S.pvMonths12[0]) && html.includes(S.pvMonths24[0]));
  assert.ok(html.includes(S.previewNote[0]), 'the preview says it is the draft on screen');
  // This printer's kits by their titles; another printer's kit, and any other printer's name, never.
  assert.ok(html.includes('باقة للجميع') && html.includes('باقة الطابعة الصغيرة'));
  assert.ok(!html.includes('باقة الطابعة الكبيرة'));
  for (const name of OTHER_NAMES) assert.ok(!html.includes(name), name);
  assert.doesNotMatch(html, /kit-all|kit-a1|\b(w12|w24|c12)\b/, 'no code reaches the preview');
  assert.deepEqual(selectsLabelled(html), []);
  // No family and class yet: the preview says what to do instead of showing an empty offer.
  delete d.products[A1];
  const none = renderToStaticMarkup(createElement(CustomerPreview, { draft: d, loc, lang: 'ar', printer: printers[0] }));
  assert.match(none, /data-preview-empty/);
  assert.ok(none.includes(S.noOffer[0]));
});

test('what blocks a publish is said in words: a kit by its title, a package by its name, never a code', () => {
  const d = draft();
  const say = (i: string) => issueText(i, loc, d.kits ?? [], d.addons ?? []);
  assert.deepEqual(say('kits.kit-a1: needs at least one item'), { text: 'الباقة «باقة الطابعة الصغيرة»: تحتاج منتجاً واحداً على الأقل', translated: true });
  assert.equal(say('kits[1].sort: 0 to 999').text.startsWith('الباقة «باقة الطابعة الكبيرة»'), true);
  assert.equal(say('addons.addon-x2d: a printer cannot be an add-on').text.startsWith('الإضافة «فوهة خاصة»'), true);
  assert.equal(say(`products.${A1}: no warranty family`).translated, true);
  assert.equal(say(`products.${A1}: no delivery class`).translated, true);
  assert.match(say('packages.smart: includes Levo Care, which is not priced').text, /^الاختيار الذكي: /);
  assert.match(say('packages.complete: a package must include a warranty').text, /^التجربة الكاملة: /);
  assert.equal(say('care.terms: write the Levo Care terms before publishing Care').translated, true);
  for (const i of ['kits.kit-a1: needs at least one item', 'addons.addon-x2d: a printer cannot be an add-on', `products.${A1}: no warranty family`]) {
    assert.doesNotMatch(say(i).text, /kit-a1|addon-x2d|prd_/, i);
  }
  // An unknown issue keeps the server's line, marked untranslated.
  assert.deepEqual(say('something: new'), { text: 'something: new', translated: false });
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
  // Phase 5 (owner, 2026-11-18): the old delivery line and the old extended-warranty editor are gone;
  // a non-printer keeps «تتبّع الأرقام التسلسلية», a used printer «ضمان الجهاز المستعمل».
  for (const key of ['printer-services', 'serial-tracking', 'used-warranty', 'condition', 'dimensions', 'instalments']) assert.match(form, new RegExp(`s4Block\\(\\s*'${key}'`), key);
  for (const gone of ['delivery', 'warranty']) assert.doesNotMatch(form, new RegExp(`s4Block\\(\\s*'${gone}'`), `the old ${gone} block is gone`);
  assert.doesNotMatch(form, /DeliveryRuleLine/);
  assert.match(form, /ar=\{isPrinterCatalog \? 'خدمات الطابعة' : 'الحالة والأبعاد'\}/);
  assert.match(form, /en=\{isPrinterCatalog \? 'Printer services' : 'Condition & size'\}/);
  // The fields the old editor wrote still travel through the save untouched.
  for (const field of ['warranty_plans', 'warranty_base_months', 'serialized']) assert.match(form, new RegExp(`doc\\.${field}\\b`), field);
  const warranty = read('src/components/adminProducts/form/WarrantySection.tsx');
  assert.doesNotMatch(warranty, /data-form="extended-warranty"|warranty-plan-\$\{ext\}|fee_percent/, 'no extension-plan editor is left');
  for (const hook of ['serial-tracking', 'warranty-not-printer', 'device-warranty', 'warranty-old-plans-clear']) assert.match(warranty, new RegExp(`data-form="${hook}"`), hook);
  // The panel says once what it is: the block's own title is «خصص طابعتك», and the panel carries no heading of its own.
  assert.doesNotMatch(panel, /<h3\b/);
  // Every switched-off button says why beside it.
  for (const why of ['whySave', 'whyPublish']) assert.match(panel, new RegExp(`const ${why}: Tri \\| null =`), why);
  assert.match(panel, /disabled=\{!!whySave\}/);
  assert.match(panel, /disabled=\{!!whyPublish\}/);
  assert.match(panel, /data-printer-services-why="save"/);
  assert.match(panel, /data-printer-services-why="publish"/);
  // What blocks a publish follows the draft on screen (the same pure check the server runs).
  assert.match(panel, /publishIssues\(c\)/);
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
