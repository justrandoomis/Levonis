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
      { componentType: 'FAQ', data: { anchorId: '3', title: 'Frequently Asked Questions', faqItems: [{ question: 'Q?', answer: '<div>A.</div>' }] } },
      { componentType: 'EndlessModels', data: { title: 'Models', list: [{ name: 'Benchy' }] } },
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
  assert.ok(!d.sections.some((s) => /Models/.test(s.title)), 'EndlessModels is not a description');
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
