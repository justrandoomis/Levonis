/**
 * THE STORE BUILDER'S PURE HALF (W4-A): the editor model, the settings forms'
 * values through the ONE gate, the starter templates, and the autosaver.
 *
 *   - every edit (add, move, drag-reorder, duplicate, hide, visibility,
 *     variant, setting, delete + undo) produces a layout `normalizeLayout`
 *     accepts unchanged, and the limits (40 blocks, each type's max, 12
 *     product lists) refuse the edit BEFORE the normaliser would silently
 *     drop something;
 *   - every setting of every block, set to each value its form control can
 *     emit, round-trips through `normalizeLayout` with no issue;
 *   - hostile input through the EDITOR path (unknown keys, `__proto__`,
 *     `javascript:` links, another owner's media, CSS in tokens, forged
 *     reorders) is neutralised, and a fatal layout is never sent;
 *   - the autosaver debounces, keeps one save in flight, fences on the
 *     version, turns 409 DRAFT_CHANGED into a conflict and resolves it.
 *
 * Run: node --import tsx --test tests/storeDesignEditor.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BLOCKS, BLOCK_TYPES, blockMax, type BlockType, type FieldSpec } from '../packages/storeLayout/src/blocks';
import { applyTheme, normalizeLayout, emptyLayout, makeBlock } from '../packages/storeLayout/src/normalize';
import { collectDataNeeds, MAX_PRODUCT_QUERIES } from '../packages/storeLayout/src/data';
import { defaultLayoutFromStore } from '../packages/storeLayout/src/defaults';
import { starterLayout } from '../packages/storeLayout/src/starters';
import { LINK_ROUTES } from '../packages/storeLayout/src/refs';
import { MAX_BLOCKS, type StoreLayout } from '../packages/storeLayout/src/schema';
import { THEME_NAMES, THEME_PRESETS, TOKEN_KEYS, TOKEN_VALUES } from '../packages/storeLayout/src/tokens';
import {
  addBlock,
  canAdd,
  commit,
  duplicateBlock,
  historyOf,
  limitsOf,
  MAX_PRODUCT_LISTS,
  moveBlock,
  moveBy,
  newBlockId,
  redo,
  removeBlock,
  reorder,
  restoreBlock,
  setFooter,
  setHeader,
  setHidden,
  setPreset,
  setSetting,
  setToken,
  setVariant,
  setVisibility,
  starvedProductLists,
  summarizeChanges,
  undo,
  validateLayout,
  issuesFor,
  type EditResult,
} from '../src/components/merchant/storeDesign/editorModel';
import { DraftSaver, type SaveAnswer, type SaverState } from '../src/components/merchant/storeDesign/autosave';
import { BLOCK_COPY, CATEGORIES } from '../src/components/merchant/storeDesign/catalog';

const OWNER = 'owner';
const PIC = 'merchants/owner/public/hero0001.webp';
const VID = 'merchants/owner/public/clip0001.mp4';

const norm = (l: unknown) => normalizeLayout(l, { ownerUserId: OWNER });
/** The gate accepts it exactly as the editor holds it. */
function assertCanonical(l: StoreLayout, what = '') {
  const r = norm(l);
  assert.deepEqual(r.issues, [], `${what}: ${JSON.stringify(r.issues).slice(0, 400)}`);
  assert.deepEqual(r.layout, l, `${what}: the gate changed the layout`);
}
function done(r: EditResult): { layout: StoreLayout; id: string } {
  assert.ok(!('refused' in r), `refused: ${'refused' in r ? r.refused : ''}`);
  return r as { layout: StoreLayout; id: string };
}

// ------------------------------------------------------------ the model

test('add / move / reorder / duplicate / hide / visibility / variant: every result is a canonical layout', () => {
  let l = emptyLayout('modern');
  for (const t of BLOCK_TYPES) l = done(addBlock(l, t)).layout;
  assert.equal(l.blocks.length, BLOCK_TYPES.length);
  assertCanonical(l, 'every type added');

  // Inserted where asked.
  const r = done(addBlock(l, 'text', 1, { variant: 'callout' }));
  assert.equal(r.layout.blocks[1].id, r.id);
  assert.equal(r.layout.blocks[1].variant, 'callout');
  assert.equal(done(addBlock(l, 'text', 0, { variant: 'nope' })).layout.blocks[0].variant, 'plain', 'an unknown variant is the default');
  l = r.layout;

  const ids = l.blocks.map((b) => b.id);
  l = moveBlock(l, 0, 3);
  assert.equal(l.blocks[3].id, ids[0]);
  l = moveBy(l, ids[0], -1);
  assert.equal(l.blocks[2].id, ids[0]);
  assert.equal(moveBy(l, l.blocks[0].id, -1), l, 'the first block cannot move up');
  assertCanonical(l, 'moved');

  const rev = [...l.blocks.map((b) => b.id)].reverse();
  const reordered = reorder(l, rev);
  assert.deepEqual(reordered.blocks.map((b) => b.id), rev);
  assertCanonical(reordered, 'reordered');

  const dup = done(duplicateBlock(l, r.id));
  const at = dup.layout.blocks.findIndex((b) => b.id === dup.id);
  assert.equal(dup.layout.blocks[at - 1].id, r.id, 'the copy sits right after the original');
  assert.notEqual(dup.id, r.id);
  assert.deepEqual({ ...dup.layout.blocks[at], id: r.id }, dup.layout.blocks[at - 1]);
  assertCanonical(dup.layout, 'duplicated');

  let v = setHidden(dup.layout, dup.id, true);
  v = setVisibility(v, r.id, { desktop: false });
  v = setVariant(v, r.id, 'plain');
  v = setVariant(v, r.id, '<script>');
  const b = v.blocks.find((x) => x.id === r.id)!;
  assert.deepEqual(b.visibility, { mobile: true, desktop: false });
  assert.equal(b.variant, 'plain', 'a variant outside the list is refused');
  assert.equal(v.blocks.find((x) => x.id === dup.id)!.hidden, true);
  v = setHeader(setFooter(v, 'standard'), 'bar');
  assertCanonical(v, 'hidden, visibility, variant, header, footer');
});

test('new block ids are unique, schema-shaped, and never collide after deletes', () => {
  let l = emptyLayout();
  for (let i = 0; i < 10; i++) l = done(addBlock(l, 'text')).layout;
  const ids = l.blocks.map((b) => b.id);
  assert.equal(new Set(ids).size, 10);
  for (const id of ids) assert.match(id, /^[a-z0-9][a-z0-9_-]{0,31}$/);
  l = removeBlock(l, ids[3]).layout;
  assert.ok(!l.blocks.some((b) => b.id === newBlockId(l, 'text')));
  assert.match(newBlockId(l, 'custom_request_cta'), /^custom-request-cta/);
});

test('delete, then «تراجع»: the block comes back where it was, and refuses when it no longer fits', () => {
  let l = defaultLayoutFromStore(null);
  l = done(addBlock(l, 'text')).layout;
  const before = l;
  const { layout: after, removed } = removeBlock(l, 'hero');
  assert.ok(removed);
  assert.equal(removed.index, 0);
  assert.equal(after.blocks.length, 2);
  assert.deepEqual(done(restoreBlock(after, removed)).layout, before);

  // Its id was taken meanwhile: it returns under a fresh one.
  const { layout: gone, removed: r2 } = removeBlock(before, 'text');
  const taken = done(addBlock(gone, 'text')).layout;
  const back = done(restoreBlock(taken, r2!));
  assert.notEqual(back.id, 'text');
  assertCanonical(back.layout, 'restored under a new id');

  // A second hero was added meanwhile: the hero cannot come back (max 1).
  const noHero = removeBlock(before, 'hero');
  const other = done(addBlock(noHero.layout, 'hero')).layout;
  assert.deepEqual(restoreBlock(other, noHero.removed!), { refused: 'type_max' });
});

test('limits are refused BEFORE the normaliser would drop anything: 40 blocks, each type\'s max, 12 product lists', () => {
  // 40 blocks.
  let l = emptyLayout();
  const fill: BlockType[] = ['text', 'faq', 'banner', 'image_text', 'cta', 'gallery'];
  outer: for (const t of fill) {
    while (l.blocks.length < MAX_BLOCKS) {
      const r = addBlock(l, t);
      if ('refused' in r) continue outer;
      l = r.layout;
    }
  }
  assert.equal(l.blocks.length, MAX_BLOCKS);
  assert.equal(canAdd(l, 'about'), 'max_blocks');
  assert.deepEqual(addBlock(l, 'about'), { refused: 'max_blocks' });
  assert.deepEqual(duplicateBlock(l, l.blocks[0].id), { refused: 'max_blocks' });
  assertCanonical(l, '40 blocks');

  // Each type's own maximum.
  for (const t of BLOCK_TYPES) {
    let m = emptyLayout();
    for (let i = 0; i < blockMax(t); i++) {
      const r = addBlock(m, t);
      if ('refused' in r) {
        assert.equal(r.refused, 'product_lists', `${t} refused early for ${r.refused}`);
        break;
      }
      m = r.layout;
    }
    if (limitsOf(m).productLists < MAX_PRODUCT_LISTS) {
      assert.equal(canAdd(m, t), 'type_max', t);
      assertCanonical(m, `${t} at its max`);
    }
  }

  // Twelve product lists across grid, carousel and deals.
  let p = emptyLayout();
  const kinds: BlockType[] = ['products_grid', 'products_carousel', 'deals'];
  for (let i = 0; i < MAX_PRODUCT_LISTS; i++) p = done(addBlock(p, kinds[i % 3])).layout;
  assert.equal(limitsOf(p).productLists, 12);
  for (const k of kinds) assert.equal(canAdd(p, k), 'product_lists');
  assert.equal(canAdd(p, 'text'), null, 'other blocks still fit');
  assert.equal(MAX_PRODUCT_LISTS, MAX_PRODUCT_QUERIES);
});

test('a list the data planner would skip is flagged: the 13th DISTINCT product query', () => {
  let l = emptyLayout();
  // Twelve different collections, then a tab strip and one more.
  for (let i = 0; i < 10; i++) {
    const r = done(addBlock(l, i % 2 ? 'products_grid' : 'products_carousel'));
    l = setSetting(setSetting(r.layout, r.id, 'source', 'collection'), r.id, 'collection_id', `sec${i}`);
  }
  assert.equal(starvedProductLists(l).size, 0);
  l = done(addBlock(l, 'tabs')).layout; // latest + deals = 12 queries
  assert.equal(collectDataNeeds(norm(l).layout).products.length, 12);
  assert.equal(starvedProductLists(l).size, 0);
  const last = done(addBlock(l, 'products_grid'));
  const extra = setSetting(setSetting(last.layout, last.id, 'source', 'collection'), last.id, 'collection_id', 'sec99');
  assert.deepEqual([...starvedProductLists(extra)], [last.id]);
  // Same source as an existing list: shares its query, not starved.
  assert.equal(starvedProductLists(setSetting(extra, last.id, 'collection_id', 'sec3')).size, 0);
});

test('undo / redo, and keystrokes into one field are one step', () => {
  const a = defaultLayoutFromStore(null);
  const b = done(addBlock(a, 'text'));
  let h = commit(historyOf(a), b.layout);
  const t1 = setSetting(b.layout, b.id, 'title', { ar: 'م', en: '', ckb: '' });
  const t2 = setSetting(t1, b.id, 'title', { ar: 'مر', en: '', ckb: '' });
  const t3 = setSetting(t2, b.id, 'title', { ar: 'مرح', en: '', ckb: '' });
  h = commit(h, t1, 'text.title.ar');
  h = commit(h, t2, 'text.title.ar');
  h = commit(h, t3, 'text.title.ar');
  assert.equal(h.past.length, 2, 'three keystrokes, one step');
  h = undo(h);
  assert.equal(h.present, b.layout);
  h = undo(h);
  assert.equal(h.present, a);
  assert.equal(undo(h), h, 'nothing more to undo');
  h = redo(redo(h));
  assert.equal(h.present, t3);
  h = commit(undo(h), a);
  assert.equal(h.future.length, 0, 'a new edit drops the redo stack');
});

test('the publish summary names what changes for visitors', () => {
  const live = defaultLayoutFromStore(null);
  assert.equal(summarizeChanges(live, live).none, true);
  let next = setPreset(live, 'premium_dark');
  next = done(addBlock(next, 'faq')).layout;
  next = removeBlock(next, 'tabs').layout;
  next = setSetting(next, 'hero', 'show_stats', false);
  next = setHeader(next, 'bar');
  const s = summarizeChanges(live, next);
  assert.equal(s.theme, true);
  assert.ok(s.tokens.includes('surface'));
  assert.deepEqual(s.added.map((b) => b.type), ['faq']);
  assert.deepEqual(s.removed.map((b) => b.type), ['tabs']);
  assert.deepEqual(s.edited.map((b) => b.id), ['hero']);
  assert.equal(s.header, true);
  assert.equal(s.footer, false);
  assert.equal(s.none, false);
  const swapped = reorder(done(addBlock(live, 'faq')).layout, ['tabs', 'hero', 'faq']);
  assert.equal(summarizeChanges(done(addBlock(live, 'faq')).layout, swapped).reordered, true);
});

test('the catalogue names every block and puts each in exactly one picker category', () => {
  const listed = CATEGORIES.flatMap((c) => c.types);
  assert.deepEqual([...listed].sort(), [...BLOCK_TYPES].sort());
  assert.equal(new Set(listed).size, listed.length);
  for (const t of BLOCK_TYPES) assert.ok(BLOCK_COPY[t].name[0] && BLOCK_COPY[t].name[1], t);
});

// ------------------------------------------------------------ settings forms through the gate

/** Every value the control for `spec` can emit (fields.tsx), as the control emits it. */
function controlValues(spec: FieldSpec): unknown[] {
  switch (spec.t) {
    case 'bool':
      return [true, false];
    case 'enum':
      return [...spec.values];
    case 'int':
      return [spec.min, spec.max, Math.round((spec.min + spec.max) / 2)];
    case 'text': {
      const long = 'ب'.repeat(spec.max);
      return [
        { ar: 'نص عربي', en: 'English words', ckb: 'دەقی کوردی' },
        { ar: long, en: '', ckb: '' },
        { ar: '', en: '', ckb: '' },
        ...(spec.multiline ? [{ ar: 'سطر\nسطر ثانٍ\n\nفقرة', en: '', ckb: '' }] : []),
      ];
    }
    case 'media':
      return [spec.kind === 'video' ? VID : PIC, ''];
    case 'link':
      return [
        { kind: 'none' },
        ...LINK_ROUTES.map((route) => ({ kind: 'route', route })),
        { kind: 'product', id: 'p1' },
        { kind: 'collection', id: 'sec1' },
        { kind: 'external', url: 'https://example.com/a?b=1' },
      ];
    case 'date':
      return ['2027-03-01T18:30:00.000Z', ''];
    case 'ref':
      return [spec.ref === 'coupon' ? 'cp1' : spec.ref === 'collection' ? 'sec1' : 'p1', ''];
    case 'refs':
      return [[], ['a1', 'b2', 'c3'].slice(0, spec.max), Array.from({ length: spec.max }, (_, i) => `id${i}`)];
    case 'set':
      return [[...spec.d], spec.values.slice(0, spec.max), [...spec.values.slice(0, spec.min)].reverse()];
    case 'socials':
      return [[], [{ provider: 'instagram', handle: 'ali3d' }, { provider: 'whatsapp', handle: '9647701234567' }]];
    case 'list': {
      const item: Record<string, unknown> = {};
      for (const [k, s] of Object.entries(spec.item)) item[k] = controlValues(s)[0];
      return [[], [item], Array.from({ length: spec.max }, () => ({ ...item }))];
    }
  }
}

test('EVERY setting of EVERY block round-trips through normalizeLayout for every value its form control emits', () => {
  let checked = 0;
  for (const type of BLOCK_TYPES) {
    const settings = BLOCKS[type].settings as Record<string, FieldSpec>;
    for (const variant of BLOCKS[type].variants as readonly string[]) {
      for (const [key, spec] of Object.entries(settings)) {
        for (const value of controlValues(spec)) {
          let l = done(addBlock(emptyLayout(), type, 0, { variant })).layout;
          const id = l.blocks[0].id;
          // A grid's collection only counts with the «collection» source (the form hides it otherwise).
          if (key === 'collection_id') l = setSetting(l, id, 'source', 'collection');
          // …and choosing «a collection» as the source is done together with picking one.
          if (key === 'source' && value === 'collection') l = setSetting(l, id, 'collection_id', 'sec1');
          l = setSetting(l, id, key, value);
          if (key === 'collection_id' && value === '') l = setSetting(l, id, 'source', 'latest');
          const v = validateLayout(l, OWNER);
          assert.deepEqual(v.result.issues, [], `${type}/${variant}.${key} = ${JSON.stringify(value).slice(0, 80)}: ${JSON.stringify(v.result.issues)}`);
          assert.deepEqual(
            (v.result.layout.blocks[0].settings as Record<string, unknown>)[key],
            key === 'ends_at' && value ? new Date(value as string).toISOString() : value,
            `${type}.${key} changed on the way through`
          );
          checked++;
        }
      }
    }
  }
  assert.ok(checked > 600, `only ${checked} values checked`);
});

test('theme tokens and presets: every enum value is accepted, anything else is not written', () => {
  let l = defaultLayoutFromStore(null);
  for (const k of TOKEN_KEYS) {
    for (const v of TOKEN_VALUES[k] as readonly unknown[]) {
      l = setToken(l, k, v as never);
      assert.equal(l.tokens[k], v);
      assertCanonical(l, `${k}=${String(v)}`);
    }
  }
  for (const t of THEME_NAMES) {
    const p = setPreset(l, t);
    assert.deepEqual(p, applyTheme(l, t), 'the same as the schema\'s applyTheme');
    assert.deepEqual(p.tokens, THEME_PRESETS[t]);
    assert.deepEqual(p.blocks, l.blocks, 'a preset never touches the blocks');
  }
  for (const bad of ['red', '#fff', 'url(javascript:alert(1))', 'var(--x)', '1;background:red', 4, null]) {
    for (const k of TOKEN_KEYS) assert.equal(setToken(l, k, bad as never), l, `${k} took ${String(bad)}`);
  }
  assert.equal(setToken(l, 'style' as never, 'x' as never), l);
});

// ------------------------------------------------------------ hostile input through the editor path

test('the editor path neutralises hostile input: unknown keys, prototype keys, scripts, links, media, forged reorders', () => {
  const base = done(addBlock(defaultLayoutFromStore(null), 'cta'));
  const id = base.id;
  let l = base.layout;

  // Only declared settings are written.
  for (const k of ['onclick', 'style', 'className', 'html', 'dangerouslySetInnerHTML', '__proto__', 'constructor', 'src']) {
    assert.equal(setSetting(l, id, k, '<img src=x onerror=alert(1)>'), l, k);
  }
  assert.equal(Object.getPrototypeOf(l.blocks.find((x) => x.id === id)!.settings), Object.prototype);

  // Markup in text is kept as characters (React renders text), never parsed; the gate caps it.
  const hostile = '<script>alert(1)</script><iframe src="https://evil.example"></iframe>';
  l = setSetting(l, id, 'title', { ar: hostile, en: hostile, ckb: hostile, onload: 'x' });
  let v = validateLayout(l, OWNER);
  assert.deepEqual(issuesFor(v, id, 'title').map((i) => i.code), ['unknown_key']);
  assert.equal((v.result.layout.blocks.find((x) => x.id === id)!.settings as { title: { ar: string } }).title.ar, hostile, 'kept as the characters typed');
  assert.equal(v.fatal, false);
  assert.ok(!('onload' in (v.result.layout.blocks.find((x) => x.id === id)!.settings as unknown as Record<string, Record<string, string>>).title));

  // A typed link: every foreign scheme is FATAL, and the saved layout would not carry it.
  for (const url of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'java\tscript:alert(1)', 'data:text/html,<script>', 'http://example.com', '//evil.example/x', 'https://user:pw@example.com', 'https://127.0.0.1/']) {
    const bad = setSetting(l, id, 'link', { kind: 'external', url });
    const r = validateLayout(bad, OWNER);
    assert.equal(r.fatal, true, url);
    assert.deepEqual(issuesFor(r, id, 'link').map((i) => i.code), [url.startsWith('https://') ? 'unsafe_link' : 'unsafe_link']);
    assert.deepEqual((r.result.layout.blocks.find((x) => x.id === id)!.settings as Record<string, unknown>).link, { kind: 'none' });
  }
  assert.equal(validateLayout(setSetting(l, id, 'link', 'javascript:alert(1)'), OWNER).fatal, true, 'a bare string link too');
  assert.equal(issuesFor(validateLayout(setSetting(l, id, 'link', { kind: 'route', route: '../../admin' }), OWNER), id, 'link')[0].code, 'invalid_value');

  // Media: only this owner's keys; a URL or someone else's key is fatal.
  const banner = done(addBlock(l, 'banner'));
  for (const [key, code] of [
    ['https://evil.example/pixel.gif', 'invalid_media'],
    ['/files/merchants/other/public/their001.webp', 'foreign_media'],
    ['merchants/owner/public/../other/x.webp', 'invalid_media'],
    ['data:image/png;base64,AAAA', 'invalid_media'],
    ['merchants/owner/public/hero0001.svg', 'invalid_media'],
  ] as const) {
    const r = validateLayout(setSetting(banner.layout, banner.id, 'image', key), OWNER);
    assert.equal(r.fatal, true, key);
    assert.equal(issuesFor(r, banner.id, 'image')[0].code, code, key);
  }

  // A forged reorder (a new id, a dropped id, a repeated id) changes nothing.
  const ids = l.blocks.map((b) => b.id);
  assert.equal(reorder(l, [...ids.slice(1), 'evil']), l);
  assert.equal(reorder(l, [...ids, 'evil']), l);
  assert.equal(reorder(l, [ids[0], ids[0], ids[2]]), l);

  // A variant and a visibility cannot carry anything but their values.
  assert.equal(setVariant(l, id, 'subtle" onmouseover="x'), l);
  v = validateLayout(setVisibility(l, id, { mobile: 'yes' as never }), OWNER);
  assert.equal(v.result.layout.blocks.find((x) => x.id === id)!.visibility.mobile, true);
});

test('a layout carrying extra keys (as a tampered editor state would) is stripped by the gate before any save', () => {
  const l = defaultLayoutFromStore(null) as unknown as Record<string, unknown>;
  const tampered = {
    ...l,
    css: 'body{display:none}',
    script: 'alert(1)',
    blocks: [{ ...(l.blocks as object[])[0], html: '<b>x</b>', style: 'position:fixed', settings: { ...((l.blocks as Array<{ settings: object }>)[0].settings), onClick: 'x' } }, { id: 'x', type: 'iframe', settings: { src: 'https://evil' } }],
  };
  const v = validateLayout(tampered as unknown as StoreLayout, OWNER);
  const out = JSON.stringify(v.result.layout);
  for (const bad of ['css', 'script', 'html', 'position:fixed', 'onClick', 'iframe', 'evil']) assert.ok(!out.includes(bad), bad);
  assert.deepEqual(v.result.layout.blocks.map((b) => b.type), ['hero']);
});

// ------------------------------------------------------------ starters

test('every starter template is a canonical page: its preset\'s tokens, within every cap, visible, with no fake content', () => {
  for (const t of THEME_NAMES) {
    const l = starterLayout(t);
    assertCanonical(l, t);
    assert.equal(l.theme, t);
    assert.deepEqual(l.tokens, THEME_PRESETS[t]);
    assert.ok(l.blocks.length >= 2 && l.blocks.length <= MAX_BLOCKS);
    assert.ok(l.blocks.some((b) => b.type === 'hero'), `${t} has no hero`);
    assert.ok(collectDataNeeds(l).products.length <= MAX_PRODUCT_QUERIES);
    assert.equal(starvedProductLists(l).size, 0);
    // No words, pictures or links of ours in a merchant's page.
    const json = JSON.stringify(l.blocks);
    assert.ok(!/"(ar|en|ckb)":"[^"]/.test(json), `${t} carries written text`);
    assert.ok(!json.includes('merchants/') && !json.includes('https://'), `${t} carries media or a link`);
    for (const b of l.blocks) assert.equal(canAdd({ ...l, blocks: l.blocks.filter((x) => x !== b) }, b.type), null);
  }
  assert.deepEqual(starterLayout('classic'), defaultLayoutFromStore(null));
});

test('makeBlock defaults, which «أضف» inserts, are canonical for every type and variant', () => {
  for (const t of BLOCK_TYPES) {
    for (const v of BLOCKS[t].variants as readonly string[]) {
      const l = { ...emptyLayout(), blocks: [makeBlock(t, 'b', { variant: v })] };
      assertCanonical(l, `${t}/${v}`);
    }
  }
});

// ------------------------------------------------------------ autosave

interface Fake {
  saver: DraftSaver;
  states: SaverState[];
  sent: Array<{ layout: StoreLayout; version: number }>;
  tick: () => Promise<void>;
  answer: (fn: (layout: StoreLayout, version: number) => Promise<SaveAnswer>) => void;
}

function fakeSaver(version = 0, initial: StoreLayout = defaultLayoutFromStore(null)): Fake {
  const timers: Array<() => void> = [];
  const states: SaverState[] = [];
  const sent: Fake['sent'] = [];
  let respond = async (layout: StoreLayout, v: number): Promise<SaveAnswer> => ({ version: v + 1, layout, issues: [] });
  const saver = new DraftSaver(
    {
      save: (layout, v) => {
        sent.push({ layout, version: v });
        return respond(layout, v);
      },
      onState: (s) => states.push(s),
      setTimer: (fn) => {
        timers.push(fn);
        return timers.length - 1;
      },
      clearTimer: (h) => {
        timers[h as number] = () => {};
      },
    },
    { version, layout: initial }
  );
  return {
    saver,
    states,
    sent,
    tick: async () => {
      const due = timers.splice(0);
      due.forEach((f) => f());
      for (let i = 0; i < 5; i++) await Promise.resolve();
      await new Promise((r) => setImmediate(r));
    },
    answer: (fn) => {
      respond = fn;
    },
  };
}

const gated = (l: StoreLayout) => {
  const v = validateLayout(l, OWNER);
  return [v.result.layout, v.fatal] as const;
};

test('autosave: debounced, sends the GATE\'s output with the version, and follows the version it gets back', async () => {
  const f = fakeSaver(0);
  const base = defaultLayoutFromStore(null);
  f.saver.update(...gated(base));
  assert.equal(f.saver.snapshot.status, 'saved', 'nothing changed, nothing to save');
  const a = done(addBlock(base, 'text'));
  const t1 = setSetting(a.layout, a.id, 'title', { ar: '  مرحبا  ', en: '', ckb: '' });
  f.saver.update(...gated(a.layout));
  f.saver.update(...gated(t1));
  assert.equal(f.saver.snapshot.status, 'pending');
  assert.equal(f.sent.length, 0, 'nothing sent before the pause');
  await f.tick();
  assert.equal(f.sent.length, 1, 'several edits, one save');
  assert.equal(f.sent[0].version, 0);
  assert.equal((f.sent[0].layout.blocks[2].settings as { title: { ar: string } }).title.ar, 'مرحبا', 'what is sent is normalised (trimmed)');
  assert.equal(f.saver.snapshot.status, 'saved');
  assert.equal(f.saver.snapshot.version, 1);

  f.saver.update(...gated(setHidden(t1, a.id, true)));
  await f.tick();
  assert.equal(f.sent[1].version, 1, 'the next save is fenced on the version the last returned');
  assert.equal(f.saver.snapshot.version, 2);
});

test('autosave: a layout with a fatal issue is never sent; fixing it resumes saving', async () => {
  const f = fakeSaver(3);
  const a = done(addBlock(defaultLayoutFromStore(null), 'cta'));
  const bad = setSetting(a.layout, a.id, 'link', { kind: 'external', url: 'javascript:alert(1)' });
  f.saver.update(...gated(bad));
  assert.equal(f.saver.snapshot.status, 'blocked');
  await f.tick();
  assert.equal(await f.saver.flush(), false);
  assert.equal(f.sent.length, 0, 'the fatal layout was never sent');
  f.saver.update(...gated(setSetting(bad, a.id, 'link', { kind: 'external', url: 'https://example.com/' })));
  await f.tick();
  assert.equal(f.sent.length, 1);
  assert.equal(f.saver.snapshot.status, 'saved');
});

test('autosave: edits during a save go right after it; one save in flight at a time', async () => {
  const f = fakeSaver(0);
  let release!: () => void;
  f.answer((layout, v) => new Promise((r) => (release = () => r({ version: v + 1, layout, issues: [] }))));
  const base = defaultLayoutFromStore(null);
  const a = done(addBlock(base, 'text')).layout;
  f.saver.update(...gated(a));
  await f.tick();
  assert.equal(f.saver.snapshot.status, 'saving');
  const b = done(addBlock(a, 'faq')).layout;
  f.saver.update(...gated(b));
  await f.tick();
  assert.equal(f.sent.length, 1, 'no second save while the first is in flight');
  f.answer(async (layout, v) => ({ version: v + 1, layout, issues: [] }));
  release();
  await f.tick();
  await f.tick();
  assert.equal(f.sent.length, 2);
  assert.equal(f.sent[1].version, 1);
  assert.equal(f.sent[1].layout.blocks.length, 4);
  assert.equal(f.saver.snapshot.status, 'saved');
});

test('autosave: 409 DRAFT_CHANGED is a conflict — no more saves until «reload» (adopt) or «keep mine»', async () => {
  const f = fakeSaver(2);
  f.answer(async () => {
    throw Object.assign(new Error('changed'), { code: 'DRAFT_CHANGED', details: { version: 5 } });
  });
  const a = done(addBlock(defaultLayoutFromStore(null), 'text')).layout;
  f.saver.update(...gated(a));
  await f.tick();
  assert.equal(f.saver.snapshot.status, 'conflict');
  assert.equal(f.saver.snapshot.conflictVersion, 5);
  f.saver.update(...gated(done(addBlock(a, 'faq')).layout));
  await f.tick();
  assert.equal(f.sent.length, 1, 'typing during a conflict does not overwrite anything');
  assert.equal(await f.saver.flush(), false);

  // Keep mine: saved over the newer draft, fenced on ITS version.
  f.answer(async (layout, v) => ({ version: v + 1, layout, issues: [] }));
  assert.equal(await f.saver.keepMine(5), true);
  assert.equal(f.sent[1].version, 5);
  assert.equal(f.saver.snapshot.status, 'saved');
  assert.equal(f.saver.snapshot.version, 6);

  // Reload: the server's draft becomes the baseline, nothing is sent.
  const g = fakeSaver(1);
  g.answer(async () => {
    throw Object.assign(new Error('changed'), { code: 'DRAFT_CHANGED', details: { version: 9 } });
  });
  g.saver.update(...gated(a));
  await g.tick();
  g.saver.adopt(9, starterLayout('minimal'));
  assert.equal(g.saver.snapshot.status, 'saved');
  assert.equal(g.saver.snapshot.version, 9);
  assert.equal(g.saver.unsaved, false);
});

test('autosave: a failed save is an error the next change or flush retries — never a loop', async () => {
  const f = fakeSaver(0);
  let fail = true;
  f.answer(async (layout, v) => {
    if (fail) throw Object.assign(new Error('net'), { code: 'RATE_LIMITED' });
    return { version: v + 1, layout, issues: [] };
  });
  f.saver.update(...gated(done(addBlock(defaultLayoutFromStore(null), 'text')).layout));
  await f.tick();
  assert.equal(f.saver.snapshot.status, 'error');
  assert.equal(f.saver.snapshot.errorCode, 'RATE_LIMITED');
  await f.tick();
  await f.tick();
  assert.equal(f.sent.length, 1, 'no retry loop');
  fail = false;
  assert.equal(await f.saver.flush(), true);
  assert.equal(f.sent.length, 2);
  assert.equal(f.saver.snapshot.status, 'saved');

  // The server refusing the layout (LAYOUT_REJECTED) blocks with its issues.
  const g = fakeSaver(0);
  g.answer(async () => {
    throw Object.assign(new Error('no'), { code: 'LAYOUT_REJECTED', details: { issues: [{ path: 'blocks[0]', code: 'unsafe_link', fatal: true }] } });
  });
  g.saver.update(...gated(done(addBlock(defaultLayoutFromStore(null), 'text')).layout));
  await g.tick();
  assert.equal(g.saver.snapshot.status, 'blocked');
  assert.equal(g.saver.snapshot.issues[0].code, 'unsafe_link');
});
