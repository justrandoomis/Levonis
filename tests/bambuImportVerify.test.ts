/**
 * VERIFY'S PUBLIC CHECKS AGAINST ANSWERS OF THE REAL SHAPES (Bambu import spec
 * §I.1; scripts/bambu-import/verify.ts), built from real payloads of the
 * committed fixtures: the anonymous site answer (publicRelations), the public
 * v1 product, the knowledge answer as step 7 serves it (each compatibility
 * item with `relation`, `label`, `target_kind`, `state`, `scope`; documents
 * `active = 1` only), the tree (sections that hold products only), and the
 * listing without a listing key (no `total`, no `truncated`).
 *
 *   - a relation the Worker RESOLVED (its target was written first, §B.6)
 *     while the payload wrote it pending: the fingerprint still agrees;
 *   - a dead document (stored inactive, never shown, §C.7): not expected;
 *   - a MERGE into an existing priced product keeps its name, money,
 *     options and images (§E.2): the appended images, the knowledge, the
 *     listings, the request door and the merge proof are what is checked;
 *   - the mapped leaf: a product filed elsewhere fails even when the mapped
 *     leaf is missing from the tree (an empty section is not listed), and an
 *     empty `leaf` fails; a merge keeps its own section;
 *   - the listing is paged while a page is full (the 51st match is found);
 *   - the edge evidence carries the selections the page held, the opening
 *     one first (§G.3's, the single-value group included);
 *   - the runner never sends /complete without the browser's check 7;
 *   - byte-identical gallery images (§C.4 step 1, A1's #3/#4 copies of A1 and
 *     A1_C): the Worker collapses them, the page shows the rows it WROTE, and
 *     VERIFY passes on those rows — the payload's pre-collapse list fails it;
 *     the runner's recompute of the collapse (a resume with no written rows)
 *     gives the Worker's rows, a general primary handed to its bound copy
 *     included.
 *
 * Run: node --import tsx --test tests/bambuImportVerify.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildImportPayload, type ImportPayload } from '../packages/catalog/src/bambuImport/payload';
import { extractionFingerprint } from '../packages/catalog/src/bambuImport/fingerprint';
import { fixtureJson, sample, type SampleHandle } from './fixtures/bambu/load';
import { edgeEvidence, isPublicSpec, Site, verifyPublic, type VerifyContext } from '../scripts/bambu-import/verify';
import type { HostFetcher } from '../scripts/bambu-import/fetch';
import { writtenImagesOf, type DocumentCheck, type MediaAnswerRow, type WrittenImage } from '../scripts/bambu-import/opsClient';
import { collapseContentDuplicates, recomputedGallery, writtenGallery, type GalleryImage, type StoredGalleryRow } from '../scripts/bambu-import/gallery';
import { pageDefaultSelection } from '../scripts/bambu-import/selection';
import { RUN_ID, World } from './fixtures/bambuImportWorld';

const SITE = 'https://levonis-iq.com';
type Rec = Record<string, unknown>;

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

const BUCKET: Record<string, string> = { compatible_with: 'compatible', not_compatible_with: 'not_compatible', requires: 'requires' };

/** The live product as the public routes answer it. */
interface Live {
  payload: ImportPayload;
  media: Map<string, MediaAnswerRow>;
  slug: string;
  productId: string;
  /** The sections the product is filed under, root → leaf. */
  sections: string[];
  /** Tree nodes besides the product's own path (each holding products, so listed). */
  otherNodes?: Rec[];
  /** Relation states as D1 holds them now (default: the payload's). */
  relationState?: (r: ImportPayload['relations'][number]) => string;
  /** Documents the Worker stored inactive (a dead link): absent from /knowledge. */
  inactive?: Set<string>;
  /** A merge: the existing product's own groups, variants, images, name and price. */
  existing?: { groups: Rec[]; variants: Rec[]; images: Rec[]; name: string; priced: boolean };
  /** Products listed before this one for its own title (the listing's order), per category. */
  ahead?: number;
  /** The image rows the Worker wrote (default: the payload's, when no two pictures are byte-identical). */
  written?: GalleryImage[];
}

const files = (l: Live, id: string) => {
  const m = l.media.get(id);
  return m ? `/files/${m.r2_key}` : '';
};

function knowledge(l: Live): Rec {
  const p = l.payload;
  const pub = p.specs.filter(isPublicSpec);
  const groups = new Map<string, Rec[]>();
  for (const r of pub.filter((x) => x.key !== 'package.contents')) {
    const rows = groups.get(r.group) ?? [];
    rows.push({ key: r.key, value_num: r.value_num, unit: r.unit, status: r.status, region: r.region, scope: { kind: r.scope_kind, id: r.scope_id } });
    groups.set(r.group, rows);
  }
  const compatibility: Record<string, Rec[]> = { compatible: [], not_compatible: [], requires: [], related: [] };
  for (const r of p.relations) {
    compatibility[BUCKET[r.relation] ?? 'related'].push({ relation: r.relation, label: r.target_label, target_kind: r.target_kind, state: l.relationState ? l.relationState(r) : r.state, scope: { kind: r.scope_kind, id: r.scope_id } });
  }
  const box = pub.filter((x) => x.key === 'package.contents').flatMap((x) => x.value_list.map((v) => ({ text: typeof v === 'object' && v ? v.text : String(v), scope: { kind: x.scope_kind, id: x.scope_id } })));
  return {
    specs: [...groups].map(([group, rows]) => ({ group, rows })),
    logistics: { product: [], package: [], shipment: [], carton: [] },
    in_the_box: box,
    compatibility,
    documents: p.documents.filter((d) => !l.inactive?.has(d.id)).map((d) => ({ kind: d.kind, url: d.url, scope: { kind: d.scope_kind, id: d.scope_id } })),
    swatches: l.existing ? [] : p.swatches.map((s) => ({ option_value_id: s.value_id, url: files(l, s.source_media_id) })),
  };
}

function siteAnswer(l: Live): Rec {
  const p = l.payload;
  const appended = (l.written ?? p.images).filter((i) => files(l, i.source_media_id));
  if (l.existing) {
    // The existing product: its own options and images first, the import's appended after, product-level here.
    const images = [...l.existing.images, ...appended.map((i, n) => ({ id: `pi_appended_${n}`, url: files(l, i.source_media_id), is_primary: false, option_value_id: null, variant_id: null }))];
    return { price_status: l.existing.priced ? 'priced' : 'unpriced', relations: { option_groups: l.existing.groups, variants: l.existing.variants, images } };
  }
  const swatch = new Map(p.swatches.map((w) => [w.value_id, files(l, w.source_media_id)]));
  return {
    price_status: 'unpriced',
    relations: {
      option_groups: p.groups.map((g) => ({ id: g.id, name_en: g.name_en, sort: g.sort, default_value_id: g.default_value_id || undefined, values: g.values.map((v) => ({ id: v.id, sort: v.sort, ...(swatch.get(v.id) ? { swatch: { url: swatch.get(v.id) } } : {}) })) })),
      variants: p.variants.map((v) => ({ id: v.id, combo_key: v.combo_key })),
      images: appended.map((i) => ({ id: i.id, url: files(l, i.source_media_id), is_primary: i.is_primary, option_value_id: i.option_value_id, variant_id: i.variant_id })),
    },
  };
}

function v1(l: Live): Rec {
  const p = l.payload;
  const own = l.existing ? l.existing.images.map((i) => String(i.url)) : [];
  const urls = [...new Set([...own, ...p.images.map((i) => files(l, i.source_media_id)).filter(Boolean)])];
  return {
    data: {
      slug: l.slug,
      name: { ar: l.existing?.name ?? p.product.title_en, en: l.existing?.name ?? p.product.title_en, ckb: '' },
      sections: l.sections.map((slug) => ({ slug })),
      images: urls.map((u) => ({ url: `${SITE}${u}` })),
      price: l.existing?.priced ? { currency: 'IQD', status: 'priced', amount: 1_250_000 } : { currency: 'IQD', status: 'unpriced', amount: null },
      purchase: l.existing?.priced ? { url: `${SITE}/product/${l.slug}` } : null,
    },
  };
}

function tree(l: Live): Rec {
  let node: Rec | null = null;
  for (let i = l.sections.length - 1; i >= 0; i--) node = { id: `cat_${l.sections[i]}`, slug: l.sections[i], name_ar: `قسم ${l.sections[i]}`, name_en: l.sections[i], product_count: 1, children: node ? [node] : [] };
  return { roots: [...(node ? [node] : []), ...(l.otherNodes ?? [])] };
}

const answer = (status: number, body: unknown, headers: Record<string, string> = {}) => ({ status, headers: new Headers({ 'content-type': 'application/json', ...headers }), body: JSON.stringify(body), bytes: null });

/** The public routes, answered the way the live Worker answers them. */
function fetcher(l: Live, reads: string[] = []) {
  return {
    async request(u: string, init: { method?: string } = {}) {
      const url = new URL(u);
      const p = url.pathname;
      reads.push(`${init.method ?? 'GET'} ${p}${url.search}`);
      const slug = encodeURIComponent(l.slug);
      if ((init.method ?? 'GET') === 'HEAD' && p.startsWith('/files/')) return { status: 200, headers: new Headers({ 'content-type': 'image/webp' }), body: '', bytes: null };
      if (p === `/api/public/v1/products/${slug}`) return answer(200, v1(l));
      if (p === `/api/products/${slug}`) return answer(200, siteAnswer(l));
      if (p === `/api/products/${slug}/knowledge`) return answer(200, knowledge(l));
      if (p === `/api/products/${slug}/quote`) return l.existing?.priced ? answer(200, { success: true, total: 1_250_000 }) : answer(409, { success: false, code: 'PRICE_NOT_AVAILABLE' });
      if (p === '/api/price-requests') return answer(401, { success: false, error: 'Authentication required' });
      if (p === '/api/catalog/tree') return answer(200, tree(l));
      if (p === '/api/products') {
        // listCatalogProducts without a listing key: { success, category, suggestion, products } — no total, no truncated.
        const cat = url.searchParams.get('category') ?? '';
        const offset = Number(url.searchParams.get('offset') ?? 0);
        const all = l.sections.includes(cat) ? [...Array.from({ length: l.ahead ?? 0 }, (_, i) => ({ id: `p_other_${i}`, slug: `other-${i}` })), { id: l.productId, slug: l.slug }] : [];
        return answer(200, { success: true, category: { slug: cat }, suggestion: null, products: all.slice(offset, offset + 50) });
      }
      if (p === '/api/public/v1/search') return answer(200, { data: { products: [{ slug: l.slug }] } });
      if (p === '/api/compare') return answer(200, { success: true, products: [{ id: l.productId }] });
      if (p === '/api/compare/candidates') return answer(200, { success: true, products: [{ id: l.productId }] });
      return answer(404, { success: false, error: 'Not found' });
    },
  };
}

function live(handle: SampleHandle, over: Partial<Live> = {}): Live {
  const payload = over.payload ?? payloadOf(handle);
  return { payload, media: mediaOf(payload), slug: handle, productId: payload.product_id, sections: ['spare-parts', 'parts-leaf'], ...over };
}

function verify(l: Live, ctx: Partial<VerifyContext> = {}, reads: string[] = []) {
  return verifyPublic(new Site(SITE, fetcher(l, reads) as unknown as HostFetcher, () => 0), {
    payload: l.payload,
    productId: l.productId,
    slug: l.slug,
    media: l.media,
    images: l.written ?? l.payload.images,
    documentChecks: [],
    leaf: `cat_${l.sections.at(-1)}`,
    also: [],
    taxonomy: { create: [] },
    modelCodes: [],
    merge: l.payload.write_mode === 'merge' ? { before_fp_equal: true, source: 'write' } : null,
    readback: async () => ({ ok: true, mismatches: 0 }),
    ...ctx,
  });
}

const failed = (o: Awaited<ReturnType<typeof verifyPublic>>) => Object.entries(o.checks).filter(([, c]) => !c.ok && c.hard).map(([k]) => k);

test('a relation the Worker resolved (its target was written first) while the payload wrote it pending: the fingerprint agrees', async () => {
  for (const handle of ['bambu-hotend-a1-a2', 'bambu-textured-pei-plate', 'pla-basic-filament'] as const) {
    const l = live(handle);
    assert.ok(l.payload.relations.some((r) => r.state === 'pending'), `${handle} has pending relations (else this proves nothing)`);
    const o = await verify({ ...l, relationState: (r) => (r.state === 'pending' ? 'resolved' : r.state) });
    assert.deepEqual(failed(o), [], handle);
    assert.equal(o.checks.fingerprint.ok, true, handle);
  }
});

test('a dead document is stored inactive and never shown (§C.7): VERIFY does not expect it; one with no check is expected', async () => {
  const l = live('pla-basic-filament', { sections: ['filament', 'pla'] });
  const dead = l.payload.documents[0];
  const checks: DocumentCheck[] = [
    { document_id: dead.id, check_status: 404, content_type: '', byte_size: null, content_sha256: '', checked_at: '2026-10-15T00:00:00Z', tracker_source: '' },
    { document_id: l.payload.documents[1].id, check_status: 200, content_type: 'application/pdf', byte_size: 1, content_sha256: '', checked_at: '2026-10-15T00:00:00Z', tracker_source: '' },
  ];
  const o = await verify({ ...l, inactive: new Set([dead.id]) }, { documentChecks: checks });
  assert.deepEqual(failed(o), []);
  assert.equal(o.checks.knowledge.counts?.documents, l.payload.documents.length - 1);
  // The same answer is wrong when the document was alive (a check of 200): the site lost one.
  const alive = checks.map((c) => (c.document_id === dead.id ? { ...c, check_status: 200 } : c));
  assert.ok(failed(await verify({ ...l, inactive: new Set([dead.id]) }, { documentChecks: alive })).includes('knowledge'));
});

test('a MERGE into an existing priced product (§E.2): its own name, money, options and images stay; the import\'s part is checked', async () => {
  const payload = payloadOf('h2d', 'p_existing_h2d_0001');
  const media = mediaOf(payload);
  const existing = {
    name: 'Bambu Lab H2D 3D Printer',
    priced: true,
    groups: [{ id: 'og_existing', name_en: 'Bundle', sort: 0, default_value_id: 'ov_existing_a', values: [{ id: 'ov_existing_a', sort: 0 }, { id: 'ov_existing_b', sort: 1 }] }],
    variants: [{ id: 'pv_existing_a', combo_key: 'o:ov_existing_a' }, { id: 'pv_existing_b', combo_key: 'o:ov_existing_b' }],
    images: [{ id: 'pi_existing_main', url: '/files/products/existing-main.webp', is_primary: true, option_value_id: null, variant_id: null }],
  };
  const l = live('h2d', { payload, media, slug: 'bambu-lab-h2d', productId: 'p_existing_h2d_0001', sections: ['printers', 'fdm-printers'], existing });
  const o = await verify(l);
  assert.deepEqual(failed(o), [], JSON.stringify(Object.fromEntries(Object.entries(o.checks).map(([k, c]) => [k, c.detail]))));
  assert.equal(o.checks.merge.ok, true);
  assert.equal(o.checks.fingerprint.hard, false, 'a merge\'s ids are the existing product\'s: no payload projection');
  // An appended image that did not land still fails it.
  const missing = new Map(media);
  const first = payload.images[0].source_media_id;
  const o2 = await verify({ ...l, media: missing }, { media: new Map([...missing].map(([k, v]) => [k, k === first ? { ...v, r2_key: 'products/import/gallery/not-there.webp' } : v])) });
  assert.ok(failed(o2).includes('structure') && failed(o2).includes('v1'));
});

test('the mapped leaf: filed elsewhere fails even when the mapped leaf is missing from the tree; an empty leaf fails; a merge keeps its own', async () => {
  const l = live('bambu-hotend-a1-a2', { sections: ['laser-crafting', 'laser-accessories'] });
  const taxonomy = { create: [{ key: 'parts-x1p1', slug: 'x1-p1-series-parts', name_en: 'X1 & P1 series parts', name_ar: 'قطع X1 وP1', parent: '' }] };
  // The mapped leaf exists but holds no product yet: the tree does not list it.
  const absent = await verify(l, { leaf: '@parts-x1p1', taxonomy });
  assert.ok(failed(absent).includes('listings'));
  assert.equal(absent.checks.listings.detail?.leaf_is_mapped, false);
  const empty = await verify(l, { leaf: '' });
  assert.equal(empty.checks.listings.detail?.leaf_is_mapped, false);
  // Filed where the map says: passes, and the breadcrumb is the leaf it is in.
  const right = await verify(live('bambu-hotend-a1-a2', { sections: ['spare-parts', 'x1-p1-series-parts'] }), { leaf: '@parts-x1p1', taxonomy });
  assert.deepEqual(failed(right), []);
  assert.equal(right.leafName, 'قسم x1-p1-series-parts');
  // A merge keeps its existing (non-empty) category (§E.2): not compared.
  const merged = live('bambu-hotend-a1-a2', { payload: payloadOf('bambu-hotend-a1-a2', 'p_existing_hotend'), sections: ['laser-crafting', 'laser-accessories'] });
  const m = await verify(merged, { leaf: '@parts-x1p1', taxonomy });
  assert.equal(m.checks.listings.detail?.leaf_is_mapped, null);
  assert.equal(m.checks.listings.ok, true);
});

test('the listing has no total in this mode: a full page means the next one is read (the 51st match is found)', async () => {
  const reads: string[] = [];
  const o = await verify(live('bambu-hotend-a1-a2', { ahead: 50 }), {}, reads);
  assert.equal(o.checks.listings.ok, true);
  assert.ok(reads.some((r) => /\/api\/products\?.*offset=50/.test(r)), 'page 2 was read');
  const none = await verify(live('bambu-hotend-a1-a2', { ahead: 50, sections: ['spare-parts', 'parts-leaf'] }), { slug: 'not-this-one' } as Partial<VerifyContext>);
  assert.equal(none.checks.listings.ok, false);
});

test('the edge evidence: the selections the page held (the opening one first, §G.3 with its single-value group), never one value alone', async () => {
  const payload = payloadOf('pla-basic-filament');
  const o = await verify(live('pla-basic-filament', { payload, sections: ['filament', 'pla'] }));
  const opening = pageDefaultSelection(payload);
  assert.equal(opening.length, payload.groups.length);
  const held = [opening, [...opening.slice(0, 0), payload.groups[0].values[3].id, ...opening.slice(1)]];
  const ev = edgeEvidence(o, { ok: true, checks: {}, counts: {}, selections: held }, `${SITE}/product/pla-basic-filament`, payload, 1) as { selections_checked: string[][] };
  assert.deepEqual(ev.selections_checked, held);
  const without = edgeEvidence(o, null, `${SITE}/product/pla-basic-filament`, payload, 1) as { selections_checked: string[][] };
  assert.deepEqual(without.selections_checked, [opening]);
});

test('no browser, no COMPLETE: a browser that cannot launch stops the job before any item is claimed', async () => {
  const w = new World({ handles: ['filament-buffer'] });
  try {
    const code = await w.importer({}, async () => {
      throw new Error('Executable does not exist at /ms-playwright/chromium');
    }).main();
    assert.equal(code, 1);
    assert.deepEqual(w.outputs, { more: 'false', blocked: 'true', run_id: RUN_ID });
    assert.equal(w.calls.filter((c) => /\/lease$/.test(c.path)).length, 0, 'no item was leased');
    assert.equal(w.calls.filter((c) => /\/complete$/.test(c.path)).length, 0);
    assert.ok(w.logLines.some((l) => /::error::BROWSER_UNAVAILABLE/.test(l)));
    assert.ok(!w.logLines.some((l) => /ms-playwright/.test(l)), 'the launch error itself is never printed');
  } finally {
    w.dispose();
  }
});

// ---------------------------------------------------------------- the gallery as written (§C.4 step 1)

/** A1's gallery #3 and #4 (`A1-compressed.jpg`, `A1_C-compressed.jpg` again) are byte-for-byte A1 and A1_C (§C.4). */
function a1WithCopies() {
  const payload = payloadOf('a1');
  const media = mediaOf(payload);
  const byName = (name: string) => [...new Set(payload.images.filter((i) => i.source_url.endsWith(`/${name}`)).map((i) => i.source_media_id))];
  const pairs = ['A1-compressed.jpg', 'A1_C-compressed.jpg'].map((name) => {
    const ids = byName(name);
    assert.equal(ids.length, 2, `${name}: two gallery entries (else this proves nothing)`);
    const [first, copy] = ids.sort((a, b) => Math.min(...payload.images.filter((i) => i.source_media_id === a).map((i) => i.sort_order)) - Math.min(...payload.images.filter((i) => i.source_media_id === b).map((i) => i.sort_order)));
    return { first, copy };
  });
  for (const { first, copy } of pairs) media.set(copy, { ...media.get(copy)!, r2_key: media.get(first)!.r2_key });
  const copies = new Set(pairs.map((p) => p.copy));
  // What the Worker writes (writer.ts collapseContentDuplicates): the copies are general, the originals bound, so
  // the general copies go and nothing else moves.
  const written = payload.images.filter((i) => !(copies.has(i.source_media_id) && i.binding_rule === 'general'));
  assert.equal(written.length, payload.images.length - 2);
  return { payload, media, written, copies };
}

const asWritten = (rows: readonly GalleryImage[], media: ReadonlyMap<string, MediaAnswerRow>): WrittenImage[] =>
  rows.map((i) => ({ id: i.id, source_media_id: i.source_media_id, r2_key: media.get(i.source_media_id)!.r2_key, sort_order: i.sort_order, is_primary: i.is_primary, option_value_id: i.option_value_id, variant_id: i.variant_id, color_id: null, binding_rule: i.binding_rule }));

test('byte-identical gallery images: the page shows the rows the Worker wrote; VERIFY passes on them, and the pre-collapse payload fails', async () => {
  const { payload, media, written } = a1WithCopies();
  const l = live('a1', { payload, media, written, sections: ['printers', 'fdm-printers'] });
  // The expectation from the /write answer's rows (gallery.ts), as run.ts builds it.
  const gallery = writtenGallery(payload, media, { rows: asWritten(written, media), source: 'write' });
  assert.deepEqual(gallery.images.map((i) => i.id), written.map((i) => i.id));
  const o = await verify(l, { images: gallery.images });
  assert.deepEqual(failed(o), [], JSON.stringify(Object.fromEntries(Object.entries(o.checks).map(([k, c]) => [k, c.detail]))));
  assert.equal(o.checks.fingerprint.ok, true);
  assert.equal(o.checks.structure.counts?.images, payload.images.length - 2);
  assert.equal(o.checks.structure.counts?.expected_images, payload.images.length - 2);
  // The same live product checked against the payload's pre-collapse gallery (what VERIFY did before): it fails.
  const before = await verify(l, { images: payload.images });
  assert.ok(failed(before).includes('structure') && failed(before).includes('fingerprint'), JSON.stringify(failed(before)));
  // The evidence the Worker compares with stage_data.payload_counts still counts the PAYLOAD's images.
  const ev = edgeEvidence(o, null, `${SITE}/product/a1`, payload, 1) as { counts: Record<string, number> };
  assert.equal(ev.counts.images, payload.images.length);
  // A written row that is not a payload row with its own binding is not believed: the payload stays the witness.
  const rebound = gallery.images.map((i, n) => (n === 1 ? { ...i, option_value_id: payload.groups[0].values.at(-1)!.id } : i));
  assert.equal((await verify({ ...l, written: rebound }, { images: rebound })).checks.structure.detail?.written_from_payload, false);
});

test('the runner\'s recompute of the collapse (a resume with no written rows) gives the Worker\'s rows', () => {
  const { payload, media, written } = a1WithCopies();
  assert.deepEqual(recomputedGallery(payload, media), written, 'A1: the general copies of bound pictures go, nothing else moves');
  assert.deepEqual(recomputedGallery(payload, mediaOf(payload)), payload.images, 'no two pictures alike: the payload\'s gallery');
  // A general primary whose bytes come back later bound to a value: the general copy goes, the bound copy takes
  // its position with rule content_duplicate (no representative's variant any more) and the primary.
  const row = (id: string, key: string, sort: number, extra: Partial<StoredGalleryRow> = {}): StoredGalleryRow => ({
    id, source_media_id: `m_${id}`, source_url: '', r2_key: key, sort_order: sort, is_primary: false, option_value_id: null, variant_id: null, via_variant_id: null, binding_rule: 'general', alt_en: '', alt_ar: '', alt_ckb: '', ...extra,
  });
  const rows = [
    row('g0', 'k_same', 0, { is_primary: true }),
    row('v1', 'k_v1', 1, { variant_id: 'pv_1', binding_rule: 'variant' }),
    row('g2', 'k_g2', 2),
    row('x3', 'k_same', 3, { option_value_id: 'ov_x', via_variant_id: 'pv_9', binding_rule: 'representative' }),
    row('x4', 'k_same', 4, { option_value_id: 'ov_x', binding_rule: 'value' }),
    row('g5', 'k_g2', 5),
  ];
  const out = collapseContentDuplicates(rows);
  assert.equal(out.collapsed, 3);
  assert.deepEqual(
    out.rows.map((r) => [r.id, r.sort_order, r.is_primary, r.binding_rule, r.via_variant_id]),
    [['v1', 1, false, 'variant', null], ['g2', 2, false, 'general', null], ['x3', 0, true, 'content_duplicate', null]]
  );
  // The rows of ONE entry (a value set: one picture, one row per value) never collapse into each other.
  const set = [row('a', 'k', 0, { is_primary: true, option_value_id: 'ov_a', binding_rule: 'value_set' }), { ...row('b', 'k', 1, { option_value_id: 'ov_b', binding_rule: 'value_set' }), source_media_id: 'm_a' }];
  assert.equal(collapseContentDuplicates(set).collapsed, 0);
});

test('the written rows as the Worker answers them: read whole or not at all', () => {
  const good = [{ id: 'pi_1', source_media_id: 'm1', r2_key: 'products/import/gallery/a.webp', sort_order: 0, is_primary: true, option_value_id: null, variant_id: 'pv_1', color_id: null, binding_rule: 'variant' }];
  assert.deepEqual(writtenImagesOf(good), good);
  assert.equal(writtenImagesOf(undefined), null, 'an answer without rows: the runner recomputes');
  assert.equal(writtenImagesOf([...good, { id: 'pi_2', source_media_id: 'm2', sort_order: 1 }]), null, 'a row without its stored key is no gallery');
  assert.deepEqual(writtenImagesOf([]), []);
});
