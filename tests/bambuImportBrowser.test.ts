/**
 * THE BROWSER CHECK OF VERIFY (Bambu import spec §I.1.7, §G.3, R6) against
 * the page build step 7 renders, modelled in tests/fixtures/bambuProductPage.ts
 * (its chooser and gallery rules written from the storefront's code), and —
 * where Chromium and Playwright are installed, as in the sandbox and in
 * workflow 60 — against that page's markup in a real browser.
 *
 *   - R6 over the WHOLE selection: walking every value of PLA Basic (colour,
 *     then spool, the other groups' choices kept as the page keeps them), the
 *     correct page passes and a page that leads with another colour's picture
 *     fails;
 *   - the opening selection is §G.3's: the defaults while they form a
 *     variant, else the first alone, plus the single-value groups;
 *   - an impossible value (H2D) is disabled with its helper and never
 *     clicked; a page without the helper fails; every recorded selection is
 *     the one the page held;
 *   - a merge checks only what the import owns on the page;
 *   - a breadcrumb the tree does not name, and a hero frame with no picture,
 *     fail (an absence is never a match);
 *   - in Chromium: swatches found by their value id inside their group's
 *     fieldset, chips by their exact name beside the «بلا سعر» tag, native
 *     `disabled`, and the hero read from its own frame, not a thumbnail.
 *
 * Run: node --import tsx --test tests/bambuImportBrowser.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { buildImportPayload, type ImportPayload } from '../packages/catalog/src/bambuImport/payload';
import { extractionFingerprint } from '../packages/catalog/src/bambuImport/fingerprint';
import { fixtureJson, sample, type SampleHandle } from './fixtures/bambu/load';
import { ModelProductPage } from './fixtures/bambuProductPage';
import { BrowserChecker, chromiumPath, inspectProductPage, NOT_OFFERED_AR, playwrightModule, REQUEST_AR, UNPRICED_AR } from '../scripts/bambu-import/browser';
import { formsVariant, pageDefaultSelection } from '../scripts/bambu-import/selection';
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

test('R6 over the whole selection: every value of PLA Basic on the step-7 page passes, its spool values included', async () => {
  const payload = payloadOf('pla-basic-filament');
  const media = mediaOf(payload);
  const page = new ModelProductPage(payload, media, { breadcrumb: LEAF });
  const r = await inspectProductPage(page, { payload, media, leafName: LEAF, allValues: true });
  assert.equal(r.checks.default_selection, true);
  assert.equal(r.checks.selection_images, true, JSON.stringify(r.counts));
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
  const r = await inspectProductPage(page, { payload, media, leafName: LEAF, allValues: true });
  assert.equal(r.checks.selection_images, false);
  assert.ok(r.counts.values_failed >= 1);
});

test('§G.3 opening selection: the defaults while they form a variant, else the first alone; a single-value group is chosen too', async () => {
  const payload = payloadOf('pla-basic-filament');
  const media = mediaOf(payload);
  // As built: colour, spool and the one weight form an exact variant.
  const opening = pageDefaultSelection(payload);
  assert.equal(opening.length, payload.groups.length, 'the single-value weight group is part of it');
  assert.ok(payload.variants.some((v) => v.value_ids.length === opening.length && opening.every((id) => v.value_ids.includes(id))));
  const r = await inspectProductPage(new ModelProductPage(payload, media, { breadcrumb: LEAF }), { payload, media, leafName: LEAF, allValues: false });
  assert.equal(r.checks.default_selection, true);
  assert.deepEqual(r.selections[0], opening, 'the opening selection is recorded first, whole');

  // Defaults that form no variant: the page opens on the first default alone (and the weight, when it fits).
  const colours = payload.groups.find((g) => g.kind === 'color')!;
  const spools = payload.groups.find((g) => g.kind === 'spool')!;
  const pair = colours.values.flatMap((c) => spools.values.map((s) => [c.id, s.id] as const)).find(([c, s]) => !formsVariant([c, s], payload.variants))!;
  assert.ok(pair, 'PLA Basic has a colour without one of the spools');
  const odd: ImportPayload = JSON.parse(JSON.stringify(payload));
  odd.groups.find((g) => g.id === colours.id)!.default_value_id = pair[0];
  odd.groups.find((g) => g.id === spools.id)!.default_value_id = pair[1];
  const right = await inspectProductPage(new ModelProductPage(odd, media, { breadcrumb: LEAF }), { payload: odd, media, leafName: LEAF, allValues: false });
  assert.equal(right.checks.default_selection, true, 'the page that follows §G.3 passes');
  assert.ok(right.selections[0].includes(pair[0]) && !right.selections[0].includes(pair[1]));
  const old = await inspectProductPage(new ModelProductPage(odd, media, { breadcrumb: LEAF, allDefaults: true }), { payload: odd, media, leafName: LEAF, allValues: false });
  assert.equal(old.checks.default_selection, false, 'a page that presses defaults forming no variant does not');
});

test('impossible values (H2D): disabled with their helper and never clicked; without the helper the check fails', async () => {
  const payload = payloadOf('h2d');
  const media = mediaOf(payload);
  const page = new ModelProductPage(payload, media, { breadcrumb: LEAF });
  const r = await inspectProductPage(page, { payload, media, leafName: LEAF, allValues: true });
  assert.ok(r.counts.values_not_offered >= 1, 'H2D has values not offered with the opening choice');
  assert.equal(r.checks.not_offered_helper, true);
  assert.equal(r.checks.selection_images, true, JSON.stringify(r.counts));
  for (const s of r.selections) assert.ok(formsVariant(s, payload.variants), `a recorded selection the page could not hold: ${s.join(',')}`);
  assert.ok(r.selections.slice(1).some((s) => s.length === payload.groups.length), 'the selections after a click are whole (the other groups kept)');
  const bare = await inspectProductPage(new ModelProductPage(payload, media, { breadcrumb: LEAF, noHelper: true }), { payload, media, leafName: LEAF, allValues: true });
  assert.equal(bare.checks.not_offered_helper, false);
});

test('a merge: the existing product keeps its chooser and money; only the main image, the dinar text and the breadcrumb are checked', async () => {
  const payload = payloadOf('a1', 'p_existing_a1_0001');
  const media = mediaOf(payload);
  const r = await inspectProductPage(new ModelProductPage(payload, media, { breadcrumb: LEAF }), { payload, media, leafName: LEAF, allValues: true });
  assert.deepEqual(Object.keys(r.checks).sort(), ['breadcrumb', 'image_contain', 'image_decodes', 'no_zero_dinar']);
  assert.ok(Object.values(r.checks).every(Boolean));
  assert.deepEqual(r.selections, []);
});

test('an absence is never a match: no leaf name fails the breadcrumb; a hero frame without its picture fails image_decodes', async () => {
  const payload = payloadOf('pla-basic-filament');
  const media = mediaOf(payload);
  const noLeaf = await inspectProductPage(new ModelProductPage(payload, media, { breadcrumb: LEAF }), { payload, media, leafName: '', allValues: false });
  assert.equal(noLeaf.checks.breadcrumb, false);
  const broken = await inspectProductPage(new ModelProductPage(payload, media, { breadcrumb: LEAF, brokenHero: true }), { payload, media, leafName: LEAF, allValues: false });
  assert.equal(broken.checks.image_decodes, false);
});

// ------------------------------------------------------------------ the step-7 markup in a real browser

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

/** The step-7 markup (src/pages/Product.tsx), driven by a table of what each selection shows. */
function stepSevenPage(payload: ImportPayload, media: Map<string, MediaAnswerRow>, brokenHero: boolean): string {
  const model = new ModelProductPage(payload, media);
  const groups = payload.groups;
  const table: Record<string, { gallery: string[]; offered: Record<string, boolean> }> = {};
  const choices = groups.reduce<string[][]>((all, g) => all.flatMap((sel) => [sel, ...g.values.map((v) => [...sel, v.id])]), [[]]);
  for (const sel of choices) {
    model.selection = sel;
    const offered: Record<string, boolean> = {};
    for (const g of groups) for (const v of g.values) offered[v.id] = model.offered(v.id, g.id);
    table[[...sel].sort().join(',')] = { gallery: model.galleryUrls(), offered };
  }
  const opening = new ModelProductPage(payload, media).selection;
  const fieldsets = groups
    .map((g) => {
      const buttons = g.values
        .map((v) =>
          g.kind === 'color'
            ? `<button type="button" aria-pressed="false" aria-label="${v.name_en}" title="${v.name_en}" data-swatch="${v.id}" data-value="${v.id}" data-group="${g.id}" data-label="${v.name_en}"><span aria-hidden="true"><img src="/files/${v.id}-swatch.png" alt="" width="28" height="28"></span></button>`
            : `<button type="button" aria-pressed="false" class="lv-choice" data-value="${v.id}" data-group="${g.id}"><span class="min-w-0"><span class="block truncate">${v.name_en}</span><span class="tag">بلا سعر</span></span></button>`
        )
        .join('');
      return `<fieldset class="lv-section" data-option-group="${g.id}" data-group-kind="${g.kind}"><legend>${g.name_ar}</legend><div>${buttons}</div></fieldset>`;
    })
    .join('');
  return `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"></head><body><main>
<section aria-label="صور المنتج"><div class="hero" style="width:400px;height:400px"><img id="hero" style="object-fit:contain;width:400px;height:400px"><span><button type="button" aria-label="تكبير"><svg width="10" height="10"></svg></button></span></div><div id="thumbs" aria-label="صور المنتج"></div></section>
<nav>الرئيسية / ${LEAF}</nav><p>${UNPRICED_AR}</p><button data-price-request-cta>${REQUEST_AR}</button>
<div data-option-groups>${fieldsets}</div></main>
<script>
const TABLE = ${JSON.stringify(table)};
const GROUPS = ${JSON.stringify(groups.map((g) => ({ id: g.id, values: g.values.map((v) => v.id) })))};
const BROKEN = ${JSON.stringify(brokenHero)};
let selection = ${JSON.stringify(opening)};
function setImg(img, url) {
  img.onerror = () => { const f = document.createElement('div'); f.className = 'fallback'; img.replaceWith(f); };
  img.src = url;
}
function render() {
  const row = TABLE[[...selection].sort().join(',')];
  const frame = document.querySelector('.hero');
  frame.querySelector('img, .fallback')?.remove();
  const hero = document.createElement('img');
  hero.style.cssText = 'object-fit:contain;width:400px;height:400px';
  frame.prepend(hero);
  setImg(hero, BROKEN ? '/files/missing.png' : row.gallery[0]);
  const thumbs = document.getElementById('thumbs');
  thumbs.innerHTML = '';
  if (row.gallery.length > 1) row.gallery.forEach((u, i) => { const b = document.createElement('button'); b.type = 'button'; b.setAttribute('aria-pressed', String(i === 0)); const im = document.createElement('img'); im.src = u + '?w=96'; im.style.objectFit = 'contain'; b.append(im); thumbs.append(b); });
  for (const b of document.querySelectorAll('[data-value]')) {
    const id = b.dataset.value;
    b.setAttribute('aria-pressed', String(selection.includes(id)));
    const offered = row.offered[id];
    b.disabled = !offered;
    if (b.dataset.swatch) { const name = b.dataset.label + (offered ? '' : ' — ${NOT_OFFERED_AR}'); b.setAttribute('aria-label', name); b.title = name; }
    else { b.querySelector('[data-not-offered]')?.remove(); if (!offered) { const s = document.createElement('span'); s.dataset.notOffered = ''; s.textContent = '${NOT_OFFERED_AR}'; b.firstElementChild.append(s); } }
  }
}
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-value]');
  if (!b || b.disabled) return;
  const g = GROUPS.find((x) => x.id === b.dataset.group);
  const was = selection.includes(b.dataset.value);
  selection = GROUPS.flatMap((x) => x.id === g.id ? (was ? [] : [b.dataset.value]) : x.values.filter((id) => selection.includes(id)));
  render();
});
render();
</script></body></html>`;
}

test('in Chromium, on the step-7 markup: swatches by value id in their fieldset, chips by exact name, native disabled, the hero from its own frame', { skip: haveChromium ? false : 'Playwright and Chromium are not installed here' }, async () => {
  const { payload, media } = smallProduct();
  for (const brokenHero of [false, true]) {
    const html = stepSevenPage(payload, media, brokenHero);
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
      const r = await checker.check({ slug: 'small-pla', payload, media, leafName: LEAF, allValues: true, screenshot: false });
      if (brokenHero) {
        assert.equal(r.checks.image_decodes, false, 'the thumbnails decode, the main image does not: the check reads the main one');
        continue;
      }
      assert.equal(r.checks.image_decodes, true, JSON.stringify(r.checks));
      assert.equal(r.checks.default_selection, true, 'the swatch and the chip of the opening selection are found and pressed');
      assert.equal(r.checks.selection_images, true, JSON.stringify(r.counts));
      assert.equal(r.checks.not_offered_helper, true);
      assert.ok(r.counts.values_not_offered >= 1, 'Refill is disabled once Black is chosen');
      assert.equal(r.counts.values_failed, 0);
      assert.ok(r.ok, JSON.stringify(r.checks));
    } finally {
      await checker.close();
      server.close();
    }
  }
});
