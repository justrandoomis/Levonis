/**
 * DESCRIPTIONS: THE SOURCE FORMATS INTO ONE NEUTRAL TREE (Bambu import spec
 * §C.5; format E found in P0 on the newest printer pages).
 *
 * describe.ts turns each format into sections of kinds overview / features /
 * specs / in_the_box / compat / instructions / faq / warning / comparison /
 * other, with typed blocks, and sorts every link: documents, wiki, tracker
 * (kept whole for ENRICH), videos, store links (by handle) and the rest.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describe, parseBoxItem, type Described } from '../packages/catalog/src/bambuImport/describe';
import { sample } from './fixtures/bambu/load';

const kinds = (d: Described) => new Set(d.sections.map((s) => s.kind));
const blocks = (d: Described, kind: string, t: string) => d.sections.filter((s) => s.kind === kind).flatMap((s) => s.blocks.filter((b) => b.t === t));

test('A (legacy HTML): AMS 2 Pro feeder unit — compatibility, specs table and in-the-box', () => {
  const d = describe(sample('ams-2-pro-feeder-unit').description);
  assert.equal(d.format, 'legacy_html');
  for (const k of ['compat', 'specs', 'in_the_box']) assert.ok(kinds(d).has(k as never), `missing ${k}`);
  assert.equal(blocks(d, 'specs', 'table').length, 1);
  assert.equal(d.trackerLinks.length, 1, 'the wiki installation link is a tracker link, kept for ENRICH');
  assert.match(d.trackerLinks[0].url, /^https:\/\/e\.bambulab\.com\/t\?c=/);
});

test('B (named sections): build-plate combo — one specs table per plate, comparison kept as a table', () => {
  const d = describe(sample('build-plate-combo').description);
  assert.equal(d.format, 'sections_html');
  assert.equal(blocks(d, 'specs', 'table').length, 3);
  assert.ok(blocks(d, 'comparison', 'table').length >= 1);
});

test('C (page builder): PLA Basic — documents (TDS, SDS, hex codes) and an FAQ', () => {
  const d = describe(sample('pla-basic-filament').description);
  assert.equal(d.format, 'page_builder');
  assert.ok(d.documents.length >= 3, `documents: ${d.documents.length}`);
  assert.ok(d.documents.every((x) => !x.url.includes('?')), 'queries are stripped from kept links');
  assert.ok(blocks(d, 'faq', 'faq').length > 0);
});

test('D1 (Shopify port): A1 — specs table, 7 box items plus the Combo add-ons, and the recall FAQ', () => {
  const d = describe(sample('a1').description);
  assert.equal(d.format, 'bespoke_shopify_port');
  const table = blocks(d, 'specs', 'table')[0];
  assert.ok(table && table.t === 'table' && table.grid.rows.length === 18);
  const box = d.sections.filter((s) => s.kind === 'in_the_box');
  const items = box.flatMap((s) => s.blocks.filter((b) => b.t === 'box_item'));
  assert.ok(items.length >= 11, `box items: ${items.length}`);
  assert.ok(box.some((s) => /combo add-?ons/i.test(s.title)), 'the Combo add-ons section is its own section');
  const faq = blocks(d, 'faq', 'faq');
  assert.ok(faq.some((b) => b.t === 'faq' && /recalled/.test(b.question)));
});

test('D2 (bespoke components): H2D — specs tables, in-the-box items and the FAQ', () => {
  const d = describe(sample('h2d').description);
  assert.equal(d.format, 'bespoke_new');
  assert.ok(blocks(d, 'specs', 'table').length >= 1);
  assert.ok(d.sections.some((s) => s.kind === 'in_the_box' && s.blocks.some((b) => b.t === 'box_item')));
  assert.ok(blocks(d, 'faq', 'faq').length > 0);
});

test('E (component list): sections by component, version-scoped in-the-box items, tables, FAQ; the model showcase is skipped', () => {
  const d = describe({
    kind: 'component_list',
    components: [
      { componentType: 'Anchor', data: { list: [{ id: '1', name: 'Overview' }, { id: '2', name: 'Specs' }, { id: '3', name: 'FAQ' }] } },
      { componentType: 'Banner', componentName: 'Banner', data: { anchorId: '1', title: 'Your Personal#Manufacturing Hub', src: { url: 'https://store.bblcdn.com/s7/a/pc.jpg' }, videoUrl: { url: 'https://store.bblcdn.com/s7/a/tvc.mp4' } } },
      { componentType: 'SpecTable', componentName: 'SpecTable', data: { anchorId: '2', title: 'X Specs', link: 'https://store.bblcdn.com/s7/x.pdf', notCollapseTable: '<table><tr><td>Voltage</td><td>100-120 VAC</td></tr></table>', tableNote: 'Note text' } },
      {
        componentType: 'Inbox',
        componentName: 'InboxInfo',
        data: {
          title: "What's in the box",
          headers: { column1: '', column2: 'X AMS Combo', column3: 'X' },
          items: [
            { column1: { text: 'Printer', image: [{ url: 'https://store.bblcdn.com/s7/p.jpg' }] }, column2: { showCheckIcon: true }, column3: { showCheckIcon: true } },
            { column1: { text: 'AMS 2 Pro' }, column2: { showCheckIcon: true }, column3: { showCheckIcon: false } },
          ],
        },
      },
      { componentType: 'FAQ', data: { anchorId: '3', title: 'Frequently Asked Questions', faqItems: [{ question: 'Q?', answer: '<div>A. See the <a href="https://wiki.bambulab.com/en/x/faq">wiki</a>.</div>' }] } },
      // The MakerWorld model showcase (EndlessModels on the H2S, MakerWorldDialog on the P2S) is no description …
      { componentType: 'EndlessModels', componentName: 'MakerWorldDialog', data: { title: 'Models', items: [{ featureTitle: 'Over a Million Models', featureSubtitle: 'MakerWorld', description: 'Print anything.' }] } },
      // … but the same component type carries real product content elsewhere (the H2C's "Vortek Hotend Change System").
      {
        componentType: 'EndlessModels',
        componentName: 'WhatIs1',
        data: {
          title: 'Vortek Hotend Change System',
          items: [{ featureTitle: 'Fully Automatic Filament Change', description: 'Swaps the whole hotend.', featureImage: { src: { url: 'https://store.bblcdn.com/s7/v.jpg' } }, link: { text: 'Learn More', url: 'https://bambulab.com' } }],
        },
      },
      // Sections titled by a {text} object; pictures on the store's test CDN are never taken.
      { componentType: 'SellPoint', componentName: 'SellPoints1', data: { mainTitle: { text: 'Top Tier Printing' }, infoList: [{ title: 'Fast', leftImage: { url: 'https://store-test.bblcdn.com/s7/t.png' }, mainImage: { url: 'https://store-dev.bblcdn.com/s1/d.mp4' } }] } },
    ],
  });
  assert.equal(d.format, 'component_list');
  assert.equal(d.sections[0].title, 'Your Personal Manufacturing Hub', "'#' is a line break in E titles");
  assert.ok(d.sections[0].blocks.some((b) => b.t === 'image') && d.sections[0].blocks.some((b) => b.t === 'video'));
  const specs = d.sections.find((s) => s.kind === 'specs')!;
  assert.equal(specs.blocks.filter((b) => b.t === 'table').length, 1);
  assert.deepEqual(d.documents.map((x) => x.url), ['https://store.bblcdn.com/s7/x.pdf']);
  const box = d.sections.find((s) => s.kind === 'in_the_box')!.blocks.filter((b) => b.t === 'box_item');
  assert.deepEqual(
    box.map((b) => (b.t === 'box_item' ? [b.text, b.scopes ?? null, !!b.image] : null)),
    [['Printer', null, true], ['AMS 2 Pro', ['X AMS Combo'], false]]
  );
  assert.equal(blocks(d, 'faq', 'faq').length, 1);
  assert.ok(!d.sections.some((s) => /Models/.test(s.title)), 'the MakerWorld showcase is not a description');
  const vortek = d.sections.find((s) => s.title === 'Vortek Hotend Change System');
  assert.ok(vortek, 'an EndlessModels component with product content is kept');
  assert.ok(vortek!.blocks.some((b) => b.t === 'text' && /Swaps the whole hotend/.test(b.text)));
  assert.ok(!vortek!.blocks.some((b) => b.t === 'image' && /bambulab\.com$/.test(b.url)), 'a "Learn More" button is a link, never a picture');
  assert.ok(vortek!.blocks.some((b) => b.t === 'link' && b.text === 'Learn More'));
  const sell = d.sections.find((s) => s.title === 'Top Tier Printing');
  assert.ok(sell, 'a {text} title object titles its section');
  assert.ok(!d.sections.flatMap((s) => s.blocks).some((b) => (b.t === 'image' || b.t === 'video') && /store-(?:test|dev)\./.test(b.url)), 'no test or dev CDN media');
  assert.deepEqual(d.wikiLinks.map((x) => x.url), ['https://wiki.bambulab.com/en/x/faq'], 'a wiki link inside an FAQ answer is a document');
});

/**
 * FORMAT E ON THE REAL H2C (owner-questions §E.5): the component list as the
 * closed read list keeps it (tests/fixtures/bambu/h2c.json). SpecTable,
 * Inbox with per-version columns, FAQ, anchor-named sections, the Vortek
 * sections, the wiki links of the FAQ answers; no picture from the store's
 * test or dev CDN (SellPoints1/2 still point at them).
 */
test('E (real H2C): spec table, version-scoped box items, FAQ with its wiki links, the Vortek sections, no test-CDN media', () => {
  const x = sample('h2c');
  assert.equal(x.description.kind, 'component_list');
  const d = describe(x.description);
  assert.equal(d.format, 'component_list');
  const spec = blocks(d, 'specs', 'table');
  assert.equal(spec.length, 1);
  assert.ok(spec[0].t === 'table' && spec[0].grid.rows.length >= 20, 'the H2C spec table');
  const box = d.sections.filter((s) => s.kind === 'in_the_box').flatMap((s) => s.blocks.filter((b) => b.t === 'box_item'));
  assert.equal(box.length, 20);
  const scoped = box.filter((b) => b.t === 'box_item' && b.scopes);
  assert.ok(scoped.length > 0 && scoped.every((b) => b.t === 'box_item' && b.scopes!.every((sc) => ['H2C AMS Combo', 'H2C Laser Full Combo'].includes(sc))), 'per-version columns name the versions');
  assert.equal(blocks(d, 'faq', 'faq').length, 8);
  assert.deepEqual(
    d.wikiLinks.map((l) => l.url).sort(),
    ['https://wiki.bambulab.com/en/h2/h2d-tpu-printing-guide', 'https://wiki.bambulab.com/en/h2c/h2c-filament-printing-guide', 'https://wiki.bambulab.com/en/h2c/manual/h2c-faq']
  );
  for (const t of ['Vortek Hotend Change System', 'Why Vortek?']) assert.ok(d.sections.some((s) => s.title === t), t);
  assert.ok(d.sections.every((s) => s.title), 'every section has a title (its own or its anchor)');
  const media = d.sections.flatMap((s) => s.blocks).filter((b) => b.t === 'image' || b.t === 'video');
  assert.ok(media.length > 20);
  assert.ok(media.every((b) => (b.t === 'image' || b.t === 'video') && /^https:\/\/store\.bblcdn\.com\//.test(b.url)), 'every picture and video on the production CDN');
});

test('E: the P2S in-the-box shape (a list of titled pictures, no version columns)', () => {
  const d = describe({
    kind: 'component_list',
    components: [
      {
        componentType: 'Inbox',
        componentName: 'InboxInfo',
        data: {
          anchorId: '593648',
          title: "What's in the box",
          items: [
            { title: 'Bambu Lab P2S', imageSrc: { url: 'https://store.bblcdn.com/s7/default/d8e274a920d548ad95abfc3a0bc96504/P2S.jpg' } },
            { title: 'AMS 2 Pro (combo version)', imageSrc: { url: 'https://store.bblcdn.com/s7/default/618a560d51c74cbd83e50fc44a018807/AMS_2_Pro_(combo_version).jpg' } },
            { title: 'Spool Holder' },
          ],
        },
      },
    ],
  });
  const box = blocks(d, 'in_the_box', 'box_item');
  assert.deepEqual(
    box.map((b) => (b.t === 'box_item' ? [b.text, b.qty, !!b.image, b.scopes ?? null] : null)),
    [['Bambu Lab P2S', null, true, null], ['AMS 2 Pro (combo version)', null, true, null], ['Spool Holder', null, false, null]]
  );
});

test('links are sorted: tracker links keep their query, store links become handles, the placeholder alt is dropped', () => {
  const d = describe({
    kind: 'legacy_html',
    html:
      '<h3>Overview</h3><p>See <a href="https://e.bambulab.com/t?c=abc123">installation</a> and ' +
      '<a href="../../../products/ams-2-pro?id=5">AMS 2 Pro</a>, <a href="https://wiki.bambulab.com/en/ams?x=1">wiki</a>, ' +
      '<a href="https://cdn.shopify.com/s/files/manual.pdf?v=2">Manual</a>.</p><img src="https://store.bblcdn.com/a.jpg" alt="图片加载失败文案">',
  });
  assert.deepEqual(d.trackerLinks.map((x) => x.url), ['https://e.bambulab.com/t?c=abc123']);
  assert.deepEqual(d.storeLinks.map((x) => x.handle), ['ams-2-pro']);
  assert.deepEqual(d.wikiLinks.map((x) => x.url), ['https://wiki.bambulab.com/en/ams']);
  assert.deepEqual(d.documents.map((x) => x.url), ['https://cdn.shopify.com/s/files/manual.pdf']);
  const img = d.sections.flatMap((s) => s.blocks).find((b) => b.t === 'image');
  assert.ok(img && img.t === 'image' && img.alt === '');
});

test('box item counts: "*2" after a word, "x4", "(x4)", "2x …" — never a dimension', () => {
  assert.deepEqual(parseBoxItem('- BT2-8 Screw *2'), { text: 'BT2-8 Screw', qty: 2 });
  assert.deepEqual(parseBoxItem('2x M3*21.5 screws'), { text: 'M3*21.5 screws', qty: 2 });
  assert.deepEqual(parseBoxItem('Spool Holder (x4)'), { text: 'Spool Holder', qty: 4 });
  assert.deepEqual(parseBoxItem('PTFE Tube x 2'), { text: 'PTFE Tube', qty: 2 });
  assert.deepEqual(parseBoxItem('M3*21'), { text: 'M3*21', qty: null });
});

/**
 * DOCUMENT KINDS (review 4, finding 9): a safety data sheet is one whatever
 * its spelling — `_MSDS` in a file name ('_' is a word character, so `\b`
 * never matched before the m) or the plural "Safety Data Sheets". The five
 * corpus documents that read as a plain 'Link' are now SDS.
 */
test('document kinds: _MSDS file names and "Safety Data Sheets" are SDS; a TDS file name the same way', async () => {
  const { documentKindOf } = await import('../packages/catalog/src/bambuImport/registry/documents');
  const corpus: Array<[string, string]> = [
    ['Material Safety Data Sheets', 'https://store.bblcdn.com/s7/default/a/Glue_Stick_MSDS.pdf'], // glue-stick-for-build-plate
    ['', 'https://store.bblcdn.com/s7/default/b/Liquid_Glue_MSDS.pdf'], // liquid-glue-for-build-plate
    ['', 'https://store.bblcdn.com/s7/default/c/LGL001_MSDS.pdf'],
    ['', 'https://store.bblcdn.com/s7/default/d/Bambu_Lab_FAZ030_MSDS.pdf'], // lubricant-grease
    ['', 'https://store.bblcdn.com/s7/default/e/Lubricant_Oil_MSDS.pdf'], // lubricant-oil
    ['Safety Data Sheet', 'https://store.bblcdn.com/x.pdf'],
    ['SDS', 'https://store.bblcdn.com/x.pdf'],
  ];
  for (const [text, url] of corpus) assert.equal(documentKindOf(text, url), 'sds', `${text} ${url}`);
  assert.equal(documentKindOf('', 'https://store.bblcdn.com/PLA_Basic_TDS_V2.pdf'), 'tds');
  assert.equal(documentKindOf('Technical Data Sheets', 'https://store.bblcdn.com/x.pdf'), 'tds');
  // Near misses stay what they are.
  assert.equal(documentKindOf('Assembly guide', 'https://store.bblcdn.com/x.pdf'), 'guide');
  assert.equal(documentKindOf('Downloads', 'https://store.bblcdn.com/x.pdf'), 'other');
});

/**
 * A YOUTUBE WATCH LINK KEEPS ITS VIDEO (review 4, finding 11): its id is the
 * query string, so stripping every query wrote the bare
 * https://www.youtube.com/watch (obxidian-high-flow-hotend). It keeps `v`;
 * one without an id is no link at all. Every other kept link still loses
 * its query.
 */
test('kept links: a YouTube watch link keeps v=, a watch link without one is dropped, other queries go', async () => {
  const { keptLinkUrl } = await import('../packages/catalog/src/bambuImport/normalize');
  assert.equal(keptLinkUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42s&si=abc'), 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');
  assert.equal(keptLinkUrl('https://youtube.com/watch?feature=share&v=dQw4w9WgXcQ'), 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');
  assert.equal(keptLinkUrl('https://m.youtube.com/watch?v=dQw4w9WgXcQ#x'), 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');
  assert.equal(keptLinkUrl('https://www.youtube.com/watch'), '');
  assert.equal(keptLinkUrl('https://www.youtube.com/watch?list=PL123'), '');
  assert.equal(keptLinkUrl('https://youtu.be/dQw4w9WgXcQ?si=abc'), 'https://youtu.be/dQw4w9WgXcQ');
  assert.equal(keptLinkUrl('https://cdn.shopify.com/s/files/manual.pdf?v=2'), 'https://cdn.shopify.com/s/files/manual.pdf');
  const d = describe({
    kind: 'legacy_html',
    html: '<p><a href="https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=3s">Install video</a> <a href="https://www.youtube.com/watch">bare</a></p>',
  });
  assert.deepEqual(d.videos.map((x) => x.url), ['https://www.youtube.com/watch?v=dQw4w9WgXcQ']);
  // Through the payload: the document is the watch link with its id, never the bare /watch.
  const { buildImportPayload } = await import('../packages/catalog/src/bambuImport/payload');
  const { extractionFingerprint } = await import('../packages/catalog/src/bambuImport/fingerprint');
  const x = sample('bambu-hotend-a1-a2');
  const y = { ...x, description: { kind: 'legacy_html' as const, html: '<p><a href="https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=3s">Install video</a> <a href="https://www.youtube.com/watch">bare</a></p>' }, videos: [] };
  const p = buildImportPayload({ extraction: y, writeMode: 'create', extractionSha256: extractionFingerprint(y), targets: null, retrievedAt: '2026-10-15T00:00:00Z' }).payload;
  const videos = p.documents.filter((doc) => doc.kind === 'video').map((doc) => doc.url);
  assert.deepEqual(videos, ['https://www.youtube.com/watch?v=dQw4w9WgXcQ']);
});

/**
 * PER-OPTION IN-THE-BOX LISTS (review 4, finding 10; §C.5 scopes a section
 * to the value it names, the A1 "Combo Add-ons" rule). A line "For H2D/H2C"
 * or "For LightGrip Cutting Mat:" heads the items after it: they are scoped
 * to the value(s) it names and the line itself is no item. A line naming no
 * value stays a sub-title of the items after it, never an item.
 */
test('in the box: "For <value>" lines scope the items after them; an unresolved one is a sub-title, not an item', async () => {
  const { buildImportPayload } = await import('../packages/catalog/src/bambuImport/payload');
  const { extractionFingerprint } = await import('../packages/catalog/src/bambuImport/fingerprint');
  const x = sample('bambu-textured-pei-plate');
  const html =
    '<h3>In the Box</h3><p>For H2D/H2C</p><ul><li>Nozzle Wiping Pad x5</li></ul>' +
    '<p>For H2S:</p><ul><li>Nozzle Wiping Strips x3</li><li>BT3-8 Screws x3</li></ul>' +
    '<p>For Only Laser Module</p><ul><li>Bracket x1</li></ul>';
  const y = { ...x, description: { kind: 'legacy_html' as const, html } };
  const res = buildImportPayload({ extraction: y, writeMode: 'create', extractionSha256: extractionFingerprint(y), targets: null, retrievedAt: '2026-10-15T00:00:00Z' });
  const p = res.payload;
  const valueName = (id: string) => p.groups.flatMap((g) => g.values).find((v) => v.id === id)?.name_en ?? '(product)';
  const box = p.specs.filter((s) => s.key === 'package.contents');
  const by = new Map(box.map((s) => [s.scope_kind === 'product' ? '(product)' : valueName(s.scope_id), (s.value_list as Array<{ text: string; qty: number | null; section: string }>)]));
  assert.deepEqual(by.get('H2D')?.map((i) => [i.text, i.qty]), [['Nozzle Wiping Pad', 5]]);
  assert.deepEqual(by.get('H2C')?.map((i) => [i.text, i.qty]), [['Nozzle Wiping Pad', 5]]);
  assert.deepEqual(by.get('H2S')?.map((i) => [i.text, i.qty]), [['Nozzle Wiping Strips', 3], ['BT3-8 Screws', 3]]);
  assert.deepEqual(by.get('(product)')?.map((i) => [i.text, i.qty, i.section]), [['Bracket', 1, 'Only Laser Module']]);
  const all = box.flatMap((s) => s.value_list as Array<{ text: string }>).map((i) => i.text);
  assert.ok(!all.some((t) => /^for\b/i.test(t)), `no header line is an item: ${all.join(' | ')}`);
});

/**
 * Two corpus pages the first version of that rule got wrong. On
 * bambu-4-in-1-ptfe-adapter the header "For A2L/X2D/P2S/P1 Series/X1 Series"
 * names the value "A2L/X2D/P2S/P1/X1" only — the other value, "H2 Series/P1
 * Series/X1 Series", shares two of its parts but does not name it — so the
 * adapter must not appear in the H2 box. On cutting-mat-combo-3-pcs each item
 * is the value's own name with a count ("LightGrip Cutting Mat*3"): a bare
 * value name is a label, a counted one is the item, and the box was empty.
 */
test('in the box: a header names the one value covering all its parts; an item named like its value keeps its count', async () => {
  const { buildImportPayload } = await import('../packages/catalog/src/bambuImport/payload');
  const { extractionFingerprint } = await import('../packages/catalog/src/bambuImport/fingerprint');
  const base = sample('bambu-textured-pei-plate');
  /** The fixture with its one group's first values renamed (and only their SKUs kept). */
  const withValues = (names: string[], html: string) => {
    const g = base.groups[0];
    const old = new Map(g.values.slice(0, names.length).map((v, i) => [v.value, names[i]]));
    const x = {
      ...base,
      groups: [{ ...g, values: g.values.slice(0, names.length).map((v, i) => ({ ...v, value: names[i] })) }],
      skus: base.skus.filter((s) => s.props.every((q) => old.has(q.value))).map((s) => ({ ...s, props: s.props.map((q) => ({ ...q, value: old.get(q.value)! })) })),
      description: { kind: 'legacy_html' as const, html },
    };
    const p = buildImportPayload({ extraction: x, writeMode: 'create', extractionSha256: extractionFingerprint(x), targets: null, retrievedAt: '2026-10-15T00:00:00Z' }).payload;
    const valueName = (id: string) => p.groups.flatMap((q) => q.values).find((v) => v.id === id)?.name_en ?? '(product)';
    return new Map(
      p.specs
        .filter((s) => s.key === 'package.contents')
        .map((s) => [s.scope_kind === 'product' ? '(product)' : valueName(s.scope_id), (s.value_list as Array<{ text: string; qty: number | null }>).map((i) => [i.text, i.qty])])
    );
  };
  const adapter = withValues(
    ['A2L/X2D/P2S/P1/X1', 'H2 Series/P1 Series/X1 Series'],
    '<h3>In the Box</h3><p>For A2L/X2D/P2S/P1 Series/X1 Series</p><ul><li>Bambu 4-in-1 PTFE Adapter x1</li></ul>' +
      '<p>For H2 Series/P1 Series/X1 Series</p><ul><li>4-In-1 PTFE Adapter II x1</li><li>4-in-1 PTFE adapter filament II cleaning pad x5</li></ul>'
  );
  assert.deepEqual(adapter.get('A2L/X2D/P2S/P1/X1'), [['Bambu 4-in-1 PTFE Adapter', 1]]);
  assert.deepEqual(adapter.get('H2 Series/P1 Series/X1 Series'), [['4-In-1 PTFE Adapter II', 1], ['4-in-1 PTFE adapter filament II cleaning pad', 5]]);
  assert.equal(adapter.get('(product)'), undefined);

  const mats = withValues(
    ['LightGrip Cutting Mat', 'StrongGrip Cutting Mat'],
    '<h3>In the Box</h3><p>For LightGrip Cutting Mat:</p><p>- LightGrip Cutting Mat*3</p><p>For StrongGrip Cutting Mat:</p><p>- StrongGrip Cutting Mat*3</p>'
  );
  assert.deepEqual(mats.get('LightGrip Cutting Mat'), [['LightGrip Cutting Mat', 3]]);
  assert.deepEqual(mats.get('StrongGrip Cutting Mat'), [['StrongGrip Cutting Mat', 3]]);
  // A bare value name, with no count, is still a label and never an item.
  const label = withValues(['LightGrip Cutting Mat', 'StrongGrip Cutting Mat'], '<h3>In the Box</h3><ul><li>LightGrip Cutting Mat</li><li>Blade x2</li></ul>');
  assert.deepEqual(label.get('(product)'), [['Blade', 2]]);
});
