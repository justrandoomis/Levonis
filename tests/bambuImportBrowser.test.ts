/**
 * THE BROWSER CHECK OF VERIFY (Bambu import spec §I.1.7, §G.2, §G.3, R6, §1
 * row 27) against the FINAL page of build step 7, modelled in
 * tests/fixtures/bambuProductPage.ts (the page's own chooser, gallery and
 * knowledge modules) and — where Chromium and Playwright are installed, as in
 * the sandbox and in workflow 60 — against that page's markup in a real
 * browser.
 *
 *   - R6 over the WHOLE selection: walking every value of PLA Basic (colour,
 *     then spool), the correct page passes and a page that leads with another
 *     colour's picture fails;
 *   - the opening selection is §G.3's: the defaults while they form a
 *     variant, else the first alone, plus the single-value groups — read from
 *     what the page shows pressed;
 *   - an unoffered value (H2D) is marked, says «غير متاح مع هذا الاختيار» and
 *     is PRESSED: the page takes it and lets go of the clashing values
 *     (`chooseValue`), and the check holds the page to that selection and its
 *     pictures; a page that disables it (the dead end), says nothing, marks
 *     nothing, or keeps the clashing value fails; pressing «H2D» from the
 *     opening takes its one fitting «standard»;
 *   - the knowledge tabs are the ones the page's `knowledgeTabs` gives the
 *     expected answer, and a US 110 V row outside «إصدارات أخرى» fails;
 *   - a merge checks only what the import owns on the page;
 *   - the breadcrumb is not applicable (§1 row 28: the page draws none) and
 *     recorded so, never failing; a hero frame with no picture fails;
 *   - in Chromium, on the final markup: each control found by its
 *     `data-option-value` in its group's VISIBLE fieldset (the page draws its
 *     buy column twice, the hidden phone copy first), the marks by
 *     `data-offered`, a chip's own helper line and a swatch's name and group
 *     note, the selection read from what is pressed, the hero from
 *     `[data-gallery-hero]`, the thumbnails from `[data-gallery-strip]`, the
 *     request door from `[data-price-request-cta]` and every knowledge tab
 *     opened by its `data-tab`.
 *
 * Run: node --import tsx --test tests/bambuImportBrowser.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { buildImportPayload, type ImportPayload } from '../packages/catalog/src/bambuImport/payload';
import { extractionFingerprint } from '../packages/catalog/src/bambuImport/fingerprint';
import { chooseValue, valueOffered } from '../src/lib/productChooser';
import type { KnowledgeAnswer } from '../src/lib/productKnowledge';
import { fixtureJson, sample, type SampleHandle } from './fixtures/bambu/load';
import { ModelProductPage } from './fixtures/bambuProductPage';
import { routeKnowledge } from './fixtures/bambuKnowledgeRoute';
import { BrowserChecker, chromiumPath, inspectProductPage, NOT_APPLICABLE, NOT_OFFERED_AR, playwrightModule, REQUEST_AR, UNPRICED_AR } from '../scripts/bambu-import/browser';
import { formsVariant, pageDefaultSelection, pressValue } from '../scripts/bambu-import/selection';
import { expectedKnowledge } from '../scripts/bambu-import/verify';
import type { MediaAnswerRow } from '../scripts/bambu-import/opsClient';

function payloadOf(handle: SampleHandle, merge?: string): ImportPayload {
  const x = sample(handle);
  return buildImportPayload({
    extraction: x,
    writeMode: merge ? 'merge' : 'create',
    mergeProductId: merge,
    extractionSha256: extractionFingerprint(x),
    targets: fixtureJson('compat-targets.json') as never,
    retrievedAt: '2026-10-15T00:00:00Z',
  }).payload;
}

function mediaOf(p: ImportPayload): Map<string, MediaAnswerRow> {
  const m = new Map<string, MediaAnswerRow>();
  for (const i of p.images) m.set(i.source_media_id, { source_media_id: i.source_media_id, status: 'stored', r2_key: `products/import/gallery/${i.source_media_id}.webp`, width: 1000, height: 1000, error_code: '' });
  for (const s of p.swatches) m.set(s.source_media_id, { source_media_id: s.source_media_id, status: 'stored', r2_key: `products/import/gallery/${s.source_media_id}.webp`, width: 128, height: 128, error_code: '' });
  return m;
}

const LEAF = 'خيوط الطباعة PLA';
const valueNamed = (p: ImportPayload, kind: string, re: RegExp) => p.groups.find((g) => g.kind === kind)!.values.find((v) => re.test(v.name_en))!;
const asAnswer = (k: ReturnType<typeof expectedKnowledge>): KnowledgeAnswer => ({ ...k, completeness: null });

test('R6 over the whole selection: every value of PLA Basic on the final page passes, its spool values included', async () => {
  const payload = payloadOf('pla-basic-filament');
  const media = mediaOf(payload);
  const page = new ModelProductPage(payload, media, { breadcrumb: LEAF });
  const r = await inspectProductPage(page, { payload, media, images: payload.images, allValues: true });
  for (const name of ['default_selection', 'selection_images', 'selection_held', 'not_offered_marks', 'not_offered_helper', 'no_dead_end']) assert.equal(r.checks[name], true, `${name}: ${JSON.stringify(r.counts)}`);
  assert.equal(r.counts.values_failed, 0);
  assert.ok(r.counts.values_checked >= 30, `${r.counts.values_checked} values checked`);
  assert.ok(page.clicks > 0);
  // Black + Refill + 1kg is a real variant, and the check met it (the colour walk ends on Black).
  const black = valueNamed(payload, 'color', /^Black/);
  const refill = valueNamed(payload, 'spool', /Refill/);
  assert.ok(r.selections.some((s) => s.includes(black.id) && s.includes(refill.id)), 'Black + Refill was checked');
  for (const s of r.selections) assert.ok(formsVariant(s, payload.variants), 'every recorded selection is one the page could hold');
});

test('R6 the other way: a page that leads with another colour\'s picture once Black and the spool are chosen fails', async () => {
  const payload = payloadOf('pla-basic-filament');
  const media = mediaOf(payload);
  const black = valueNamed(payload, 'color', /^Black/);
  const spool = valueNamed(payload, 'spool', /spool/i);
  const groupOf = new Map(payload.groups.flatMap((g) => g.values.map((v) => [v.id, g.id] as const)));
  const colourGroup = payload.groups.find((g) => g.kind === 'color')!.id;
  // A picture bound to another colour (by value, or by a variant of another colour).
  const other = payload.images.find((i) => {
    if (i.option_value_id) return groupOf.get(i.option_value_id) === colourGroup && i.option_value_id !== black.id;
    const v = payload.variants.find((x) => x.id === i.variant_id);
    return !!v && v.value_ids.some((id) => groupOf.get(id) === colourGroup && id !== black.id);
  })!;
  const wrong = `/files/${media.get(other.source_media_id)!.r2_key}`;
  const page = new ModelProductPage(payload, media, {
    breadcrumb: LEAF,
    heroFor: (sel, right) => (sel.includes(black.id) && sel.includes(spool.id) ? wrong : right),
  });
  const r = await inspectProductPage(page, { payload, media, images: payload.images, allValues: true });
  assert.equal(r.checks.selection_images, false);
  assert.ok(r.counts.values_failed >= 1);
});

test('ordinary arrivals leave defaults and single-value groups unselected', async () => {
  const payload = payloadOf('pla-basic-filament');
  const media = mediaOf(payload);
  assert.deepEqual(pageDefaultSelection(payload), []);
  const result = await inspectProductPage(new ModelProductPage(payload, media, { breadcrumb: LEAF }), { payload, media, images: payload.images, allValues: false });
  assert.equal(result.checks.default_selection, true);
  assert.deepEqual(result.selections[0], []);
  const selected = await inspectProductPage(new ModelProductPage(payload, media, { breadcrumb: LEAF, allDefaults: true }), { payload, media, images: payload.images, allValues: false });
  assert.equal(selected.checks.default_selection, false, 'preselecting catalogue defaults is a regression');
});

test('a press is chooseValue (§1 row 27): an unoffered value is taken and the clash let go; «H2D» from the opening takes its one fitting «standard»', () => {
  const p = payloadOf('h2d');
  const name = (id: string) => p.groups.flatMap((g) => g.values).find((v) => v.id === id)!.name_en;
  const version = p.groups.find((g) => g.kind === 'version')!;
  const opening = p.groups.map((group) => group.default_value_id).filter((id): id is string => !!id);
  assert.deepEqual(opening.map(name), ['H2D AMS Combo', 'Standard']);
  const h2d = version.values.find((v) => v.name_en === 'H2D')!;
  const laser = version.values.find((v) => v.name_en === 'H2D Laser Full Combo')!;
  assert.equal(valueOffered(h2d.id, version.id, opening, p.groups, p.variants), false, '«H2D» is not offered with «Standard»');
  assert.deepEqual(pressValue(opening, p.groups, p.variants, version.id, h2d.id).map(name), ['H2D', 'standard']);
  assert.deepEqual(pressValue(opening, p.groups, p.variants, version.id, laser.id).map(name), ['H2D Laser Full Combo'], 'two fitting options: none taken');
  // The runner's press IS the page's (src/lib/productChooser.ts), never a copy that could drift.
  assert.deepEqual(pressValue(opening, p.groups, p.variants, version.id, h2d.id), chooseValue(h2d.id, version.id, opening, p.groups, p.variants));
});

test('unoffered values (H2D): marked, said, pressed — the page holds chooseValue\'s selection and its pictures; a dead end, silence, no mark or a kept clash fails', async () => {
  const payload = payloadOf('h2d');
  const media = mediaOf(payload);
  const laser = payload.groups.find((g) => g.kind === 'version')!.values.find((v) => v.name_en === 'H2D Laser Full Combo')!;
  const picked = payload.groups.map((group) => group.default_value_id).filter((id): id is string => !!id);
  const withChoice = (knobs: ConstructorParameters<typeof ModelProductPage>[2] = {}) => {
    const page = new ModelProductPage(payload, media, { breadcrumb: LEAF, ...knobs });
    page.selection = [...picked]; // The customer has already chosen this combination.
    return page;
  };
  const page = withChoice();
  const r = await inspectProductPage(page, { payload, media, images: payload.images, allValues: true });
  assert.ok(r.counts.values_not_offered >= 1, 'H2D has values not offered with the customer choice');
  for (const name of ['not_offered_helper', 'not_offered_marks', 'selection_held', 'no_dead_end', 'selection_images']) assert.equal(r.checks[name], true, `${name}: ${JSON.stringify(r.counts)}`);
  assert.equal(r.counts.values_failed, 0);
  assert.ok(r.selections.some((s) => s.length === 1 && s[0] === laser.id), 'the unoffered «H2D Laser Full Combo» was pressed, and «Standard» let go');
  for (const s of r.selections) assert.ok(formsVariant(s, payload.variants), `a recorded selection the page could not hold: ${s.join(',')}`);
  const knob = async (k: ConstructorParameters<typeof ModelProductPage>[2]) =>
    inspectProductPage(withChoice(k), { payload, media, images: payload.images, allValues: true });
  assert.equal((await knob({ noHelper: true })).checks.not_offered_helper, false);
  assert.equal((await knob({ noMarks: true })).checks.not_offered_marks, false);
  const dead = await knob({ disableUnoffered: true });
  assert.equal(dead.checks.no_dead_end, false, 'a disabled value is the dead end §1 row 27 removed');
  assert.ok(dead.counts.values_failed >= 1);
  const kept = await knob({ keepOnPress: true });
  assert.equal(kept.checks.selection_held, false, 'a page that keeps «Standard» beside «H2D Laser Full Combo» holds no variant');
});

test('the knowledge tabs: the ones knowledgeTabs gives the expected answer; a US 110 V row outside «إصدارات أخرى», or no tabs, fails', async () => {
  const payload = payloadOf('h2d');
  const media = mediaOf(payload);
  const expected = asAnswer(expectedKnowledge(payload, media, []));
  const served = asAnswer(routeKnowledge(payload, media));
  const run = (knobs: ConstructorParameters<typeof ModelProductPage>[2]) =>
    inspectProductPage(new ModelProductPage(payload, media, { breadcrumb: LEAF, ...knobs }), { payload, media, images: payload.images, allValues: false, knowledge: expected });
  const r = await run({ knowledge: served });
  assert.equal(r.checks.knowledge_tabs, true);
  assert.equal(r.checks.us_110v_other_versions, true);
  assert.ok(r.counts.knowledge_tabs >= 3, `${r.counts.knowledge_tabs} tabs`);
  assert.ok(r.counts.us_110v_notes >= 1, 'the H2D\'s US 110 V rows are drawn (under «إصدارات أخرى»)');
  assert.equal((await run({ knowledge: served, usInTable: true })).checks.us_110v_other_versions, false);
  assert.equal((await run({})).checks.knowledge_tabs, false, 'tabs expected and none came: an absence is never a match');
  // A product whose answer has nothing to show expects no tabs.
  const bare = await inspectProductPage(new ModelProductPage(payload, media, { breadcrumb: LEAF }), {
    payload,
    media,
    images: payload.images,
    allValues: false,
    knowledge: { specs: [], logistics: { product: [], package: [], shipment: [], carton: [] }, in_the_box: [], compatibility: { compatible: [], not_compatible: [], requires: [], related: [] }, documents: [] },
  });
  assert.equal(bare.checks.knowledge_tabs, true);
});

test('a merge: the existing product keeps its chooser and money; only the main image and the dinar text are checked', async () => {
  const payload = payloadOf('a1', 'p_existing_a1_0001');
  const media = mediaOf(payload);
  const r = await inspectProductPage(new ModelProductPage(payload, media, { breadcrumb: LEAF }), { payload, media, images: payload.images, allValues: true });
  assert.deepEqual(Object.keys(r.checks).sort(), ['image_contain', 'image_decodes', 'no_zero_dinar']);
  assert.ok(Object.values(r.checks).every(Boolean));
  assert.deepEqual(r.selections, []);
});

test('the breadcrumb is not applicable (§1 row 28: the page draws none) and never fails; a hero frame without its picture fails image_decodes', async () => {
  const payload = payloadOf('pla-basic-filament');
  const media = mediaOf(payload);
  // A page with no section name anywhere passes every check it can carry.
  const r = await inspectProductPage(new ModelProductPage(payload, media, { breadcrumb: 'الرئيسية' }), { payload, media, images: payload.images, allValues: false });
  assert.equal('breadcrumb' in r.checks, false, 'never a check: it cannot fail');
  assert.ok(Object.values(r.checks).every(Boolean), JSON.stringify(r.checks));
  assert.deepEqual(NOT_APPLICABLE, { breadcrumb: 'the product page draws no breadcrumb' });
  const broken = await inspectProductPage(new ModelProductPage(payload, media, { breadcrumb: LEAF, brokenHero: true }), { payload, media, images: payload.images, allValues: false });
  assert.equal(broken.checks.image_decodes, false);
});

// ------------------------------------------------------------------ the final step-7 markup in a real browser

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR4nGP8z8DwnwEJMKFzQAAA/RIE/f5JPOIAAAAASUVORK5CYII=', 'base64');
const haveChromium = existsSync(playwrightModule()) && !!chromiumPath();

/** A small imported product: a colour group shown as swatches, a spool group as chips; Black has no Refill. */
function smallProduct(): { payload: ImportPayload; media: Map<string, MediaAnswerRow> } {
  const v = (id: string, name: string) => ({ id, source_id: id, sort: 0, name_en: name, name_ar: '', name_ckb: '', source_label: name }) as unknown as ImportPayload['groups'][number]['values'][number];
  const groups = [
    { id: 'og_c', source_id: 'c', sort: 0, name_en: 'Color', name_ar: 'اللون', name_ckb: '', kind: 'color', source_label: 'Color', default_value_id: 'ov_white', values: [v('ov_white', 'Jade White'), v('ov_black', 'Black')] },
    { id: 'og_s', source_id: 's', sort: 1, name_en: 'Spool', name_ar: 'البكرة', name_ckb: '', kind: 'spool', source_label: 'Spool', default_value_id: 'ov_refill', values: [v('ov_refill', 'Refill'), v('ov_spool', 'With Spool')] },
  ] as unknown as ImportPayload['groups'];
  const variants = [
    { id: 'pv_wr', source_id: '1', combo_key: 'o:ov_refill|o:ov_white', value_ids: ['ov_white', 'ov_refill'] },
    { id: 'pv_ws', source_id: '2', combo_key: 'o:ov_spool|o:ov_white', value_ids: ['ov_white', 'ov_spool'] },
    { id: 'pv_bs', source_id: '3', combo_key: 'o:ov_black|o:ov_spool', value_ids: ['ov_black', 'ov_spool'] },
  ];
  const img = (id: string, sort: number, primary: boolean, value: string | null, variant: string | null) =>
    ({ id: `pi_${id}`, source_media_id: id, source_url: '', sort_order: sort, is_primary: primary, option_value_id: value, variant_id: variant, via_variant_id: null, binding_rule: 'x', alt_en: '', alt_ar: '', alt_ckb: '' });
  const images = [img('white', 0, true, 'ov_white', null), img('black', 1, false, 'ov_black', null), img('general', 2, false, null, null)];
  const payload = { write_mode: 'create', product: { title_en: 'Small PLA' }, groups, variants, images, swatches: [] } as unknown as ImportPayload;
  const media = new Map<string, MediaAnswerRow>(images.map((i) => [i.source_media_id, { source_media_id: i.source_media_id, status: 'stored', r2_key: `${i.source_media_id}.png`, width: 2, height: 2, error_code: '' }]));
  return { payload, media };
}

/** Its knowledge answer: a product-level fact and a US 110 V one (the specifications tab), and a document. */
function smallKnowledge(): KnowledgeAnswer {
  const row = (key: string, region: '' | 'us_110v') => ({
    key, label: { ar: key, en: key, ckb: key }, value_text: '1', value_num: 1, value_num_max: null, unit: '', status: 'verified' as const, region,
    scope: { kind: 'product' as const, id: '' }, source: { kind: 'store_page', title: '', locator: '', excerpt: '' }, test_method: '', test_condition: '', conflict: false,
  });
  return {
    specs: [{ group: 'electrical', label: { ar: 'الكهرباء', en: 'Electrical', ckb: 'کارەبا' }, rows: [row('electrical.power', ''), row('electrical.voltage', 'us_110v')] }],
    logistics: { product: [], package: [], shipment: [], carton: [] },
    in_the_box: [],
    compatibility: { compatible: [], not_compatible: [], requires: [], related: [] },
    documents: [{ kind: 'manual', title: { ar: 'دليل', en: 'Manual', ckb: 'ڕێبەر' }, url: 'https://wiki.bambulab.com/x', host: 'wiki.bambulab.com', scope: { kind: 'product', id: '' } }],
  };
}

/** The final step-7 markup (src/pages/Product.tsx, ProductKnowledgeTabs), driven by a table of what each selection shows. */
function stepSevenPage(payload: ImportPayload, media: Map<string, MediaAnswerRow>, opts: { brokenHero: boolean; usInTable: boolean }): string {
  const model = new ModelProductPage(payload, media);
  const groups = payload.groups;
  const table: Record<string, { gallery: string[]; offered: Record<string, boolean>; press: Record<string, string[]> }> = {};
  const choices = groups.reduce<string[][]>((all, g) => all.flatMap((sel) => [sel, ...g.values.map((v) => [...sel, v.id])]), [[]]);
  for (const sel of choices) {
    model.selection = sel;
    const offered: Record<string, boolean> = {};
    const press: Record<string, string[]> = {};
    for (const g of groups) {
      for (const v of g.values) {
        offered[v.id] = model.offered(v.id, g.id);
        press[v.id] = chooseValue(v.id, g.id, sel, groups, payload.variants);
      }
    }
    table[[...sel].sort().join(',')] = { gallery: model.galleryUrls(), offered, press };
  }
  const opening = new ModelProductPage(payload, media).selection;
  const fieldsets = groups
    .map((g) => {
      const buttons = g.values
        .map((v) =>
          g.kind === 'color'
            ? `<button type="button" aria-pressed="false" aria-label="${v.name_en}" title="${v.name_en}" data-option-value="${v.id}" data-swatch="${v.id}" data-group="${g.id}" data-label="${v.name_en}"><span aria-hidden="true"><img src="/files/${v.id}-swatch.png" alt="" width="28" height="28"></span></button>`
            : `<button type="button" aria-pressed="false" class="lv-choice" data-option-value="${v.id}" data-group="${g.id}"><span class="min-w-0"><span class="block truncate">${v.name_en}</span><span data-no-price>بلا سعر</span></span></button>`
        )
        .join('');
      return `<fieldset class="lv-section" data-option-group="${g.id}" data-group-kind="${g.kind}"><legend>${g.name_ar}</legend><div>${buttons}</div></fieldset>`;
    })
    .join('');
  const us = opts.usInTable
    ? `<div data-knowledge-row="electrical.voltage"><dt>V</dt><dd>1</dd><dd data-knowledge-note="us_110v">US</dd></div>`
    : `<details data-knowledge-other><summary>إصدارات أخرى<svg width="8" height="8"></svg></summary><dl><div data-knowledge-row="electrical.voltage"><dt>V</dt><dd>1</dd><dd data-knowledge-note="us_110v">US</dd></div></dl></details>`;
  const panels = {
    specs: `<div data-knowledge-tab="specs"><dl><div data-knowledge-row="electrical.power"><dt>P</dt><dd>1</dd></div></dl>${us}</div>`,
    documents: `<ul data-knowledge-tab="documents"><li><a href="https://wiki.bambulab.com/x" target="_blank" rel="noopener noreferrer">Manual</a></li></ul>`,
  };
  return `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"></head><body><main>
<section aria-label="صور المنتج"><div class="hero" data-gallery-hero style="width:400px;height:400px"><img id="hero" style="object-fit:contain;width:400px;height:400px"><span><button type="button" aria-label="تكبير"><svg width="10" height="10"></svg></button></span></div><div id="thumbs" data-gallery-strip aria-label="صور المنتج"></div></section>
<nav>الرئيسية / ${LEAF}</nav><div data-price-status="unpriced"><p>${UNPRICED_AR}</p><button type="button" data-price-request-cta="signed_out">${REQUEST_AR}</button></div>
<div data-option-groups style="display:none">${fieldsets}</div><div data-option-groups>${fieldsets}</div>
<div style="height:1600px"></div>
<div data-product-knowledge></div></main>
<script>
const TABLE = ${JSON.stringify(table)};
const PANELS = ${JSON.stringify(panels)};
const BROKEN = ${JSON.stringify(opts.brokenHero)};
let selection = ${JSON.stringify(opening)};
function setImg(img, url) {
  img.onerror = () => { const f = document.createElement('div'); f.className = 'fallback'; img.replaceWith(f); };
  img.src = url;
}
function render() {
  const row = TABLE[[...selection].sort().join(',')];
  const frame = document.querySelector('[data-gallery-hero]');
  frame.querySelector('img, .fallback')?.remove();
  const hero = document.createElement('img');
  hero.style.cssText = 'object-fit:contain;width:400px;height:400px';
  frame.prepend(hero);
  setImg(hero, BROKEN ? '/files/missing.png' : row.gallery[0]);
  const thumbs = document.getElementById('thumbs');
  thumbs.innerHTML = '';
  if (row.gallery.length > 1) row.gallery.forEach((u, i) => { const b = document.createElement('button'); b.type = 'button'; b.setAttribute('aria-pressed', String(i === 0)); const im = document.createElement('img'); im.src = u + '?w=96'; im.style.objectFit = 'contain'; b.append(im); thumbs.append(b); });
  for (const fs of document.querySelectorAll('[data-option-group]')) {
    let blocked = false;
    for (const b of fs.querySelectorAll('[data-option-value]')) {
      const id = b.dataset.optionValue;
      b.setAttribute('aria-pressed', String(selection.includes(id)));
      const offered = row.offered[id];
      if (offered) b.removeAttribute('data-offered'); else { b.setAttribute('data-offered', 'false'); blocked = true; }
      if (b.dataset.swatch) { const name = b.dataset.label + (offered ? '' : ' — ${NOT_OFFERED_AR}'); b.setAttribute('aria-label', name); b.title = name; }
      else { b.querySelector('[data-not-offered]')?.remove(); if (!offered) { const s = document.createElement('span'); s.dataset.notOffered = ''; s.textContent = '${NOT_OFFERED_AR}'; b.firstElementChild.append(s); } }
    }
    fs.querySelector('[data-not-offered-note]')?.remove();
    if (fs.dataset.groupKind === 'color' && blocked) { const n = document.createElement('p'); n.dataset.notOfferedNote = ''; n.textContent = '${NOT_OFFERED_AR}'; fs.append(n); }
  }
}
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-option-value]');
  if (b) { selection = TABLE[[...selection].sort().join(',')].press[b.dataset.optionValue]; render(); return; }
  const t = e.target.closest('[role="tab"]');
  if (t) { for (const x of document.querySelectorAll('[role="tab"]')) x.setAttribute('aria-selected', String(x === t)); document.getElementById('panel').innerHTML = PANELS[t.dataset.tab]; }
});
// The knowledge tabs arrive once their slot nears the viewport (IntersectionObserver in the page).
new IntersectionObserver((entries, io) => {
  if (!entries.some((x) => x.isIntersecting)) return;
  io.disconnect();
  setTimeout(() => {
    document.querySelector('[data-product-knowledge]').innerHTML = '<section data-knowledge="tabs" aria-label="tabs"><div role="tablist"><button type="button" role="tab" data-tab="specs" aria-selected="true">المواصفات</button><button type="button" role="tab" data-tab="documents" aria-selected="false">المستندات والأدلة</button></div><div id="panel" role="tabpanel">' + PANELS.specs + '</div></section>';
  }, 150);
}, { rootMargin: '400px' }).observe(document.querySelector('[data-product-knowledge]'));
render();
</script></body></html>`;
}

test('in Chromium, on the final step-7 markup: controls by data-option-value, marks, helpers, the held selection, the hero frame, the request door and every knowledge tab', { skip: haveChromium ? false : 'Playwright and Chromium are not installed here' }, async () => {
  const { payload, media } = smallProduct();
  for (const variant of [{ brokenHero: false, usInTable: false }, { brokenHero: true, usInTable: false }, { brokenHero: false, usInTable: true }]) {
    const html = stepSevenPage(payload, media, variant);
    const server = createServer((req, res) => {
      if (req.url?.startsWith('/product/')) return void res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(html);
      if (req.url?.startsWith('/files/missing')) return void res.writeHead(404).end();
      if (req.url?.startsWith('/files/')) return void res.writeHead(200, { 'content-type': 'image/png' }).end(PNG);
      res.writeHead(404).end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const checker = await BrowserChecker.launch(origin);
    try {
      const r = await checker.check({ slug: 'small-pla', payload, media, images: payload.images, allValues: true, knowledge: smallKnowledge(), screenshot: false });
      if (variant.brokenHero) {
        assert.equal(r.checks.image_decodes, false, 'the thumbnails decode, the main image does not: the check reads the main one');
        continue;
      }
      if (variant.usInTable) {
        assert.equal(r.checks.us_110v_other_versions, false, 'a US 110 V row in the table, outside «إصدارات أخرى»');
        assert.equal(r.checks.knowledge_tabs, true);
        continue;
      }
      assert.equal(r.checks.image_decodes, true, JSON.stringify(r.checks));
      assert.equal(r.checks.request_door, true, 'the request door by its hook');
      assert.equal(r.checks.default_selection, true, 'the initial swatches and option chips remain unpressed');
      for (const name of ['selection_images', 'selection_held', 'not_offered_marks', 'not_offered_helper', 'no_dead_end', 'knowledge_tabs', 'us_110v_other_versions']) assert.equal(r.checks[name], true, `${name}: ${JSON.stringify(r.counts)}`);
      assert.equal(r.counts.values_not_offered, 1, 'Refill beside Black after an explicit choice');
      // Black lets Refill go and takes its one spool; Refill then lets Black go and takes its one colour.
      assert.deepEqual(r.selections, [[], ['ov_white'], ['ov_black'], ['ov_white', 'ov_refill'], ['ov_white', 'ov_spool']]);
      assert.equal(r.counts.values_failed, 0);
      assert.deepEqual([r.counts.knowledge_tabs, r.counts.us_110v_notes], [2, 1]);
      // This page names its section in a nav; the real one does not (§1 row 28): either way, never a check.
      assert.deepEqual(r.not_applicable, { breadcrumb: 'the product page draws no breadcrumb' });
      assert.ok(r.ok, JSON.stringify(r.checks));
    } finally {
      await checker.close();
      server.close();
    }
  }
});
