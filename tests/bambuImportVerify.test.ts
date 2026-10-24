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
 *     included;
 *   - compare (§I.1.11): 400 COMPARE_NO_SPECS for this product is the
 *     expected absence when the type has fewer than 3 compare keys with
 *     values (recorded `not_applicable`), a failure with 3 or more, and any
 *     other refusal fails either way; the candidates are asked by the name the
 *     site shows (a merge keeps the existing product's, which need not contain
 *     the store title — the route matches the product's own names);
 *   - the cache rule hears a stale listing and a stale search too (their
 *     s-maxage, as the live routes send it).
 *
 * Run: node --import tsx --test tests/bambuImportVerify.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertImportPayload, buildImportPayload, type ImportPayload } from '../packages/catalog/src/bambuImport/payload';
import { buildFor, newWorld as newWriterWorld, rebundle as rebundleWriter, RUN_ID as WRITER_RUN, stage as stageForWriter, write as writerWrite, type World as WriterWorld } from './fixtures/catalogImportWorld';
import { extractionFingerprint } from '../packages/catalog/src/bambuImport/fingerprint';
import { fixtureJson, pageOf, sample, type SampleHandle } from './fixtures/bambu/load';
import { compareKeysOf, edgeEvidence, expectedKnowledge, knowledgeDiff, knowledgeProjection, Site, verifyPublic, type VerifyContext } from '../scripts/bambu-import/verify';
import { COMPARE_KEY_FIELDS, comparedFields, knowledgeCellsFor } from '../worker/lib/knowledge/compareKeys';
import { FILTER_ONLY_FIELDS } from '../worker/lib/templateFamilies';
import type { HostFetcher } from '../scripts/bambu-import/fetch';
import { writtenImagesOf, type DocumentCheck, type MediaAnswerRow, type WrittenImage } from '../scripts/bambu-import/opsClient';
import { collapseContentDuplicates, galleryFromWritten, recomputedGallery, writtenGallery, type GalleryImage, type StoredGalleryRow } from '../scripts/bambu-import/gallery';
import { pageDefaultSelection } from '../scripts/bambu-import/selection';
import { CACHE, likeBody, RUN_ID, World } from './fixtures/bambuImportWorld';
import { modelsInText } from '../packages/catalog/src/bambuImport/registry/models';
import { mergedSelections, storedExternalIds } from '../packages/catalog/src/bambuImport/merge';
import { routeKnowledge, type StoredKnowledgeKnobs } from './fixtures/bambuKnowledgeRoute';

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

/** A stored key as the Worker names one (content-addressed, a safe media key: `swatch:123` is not). */
const keyOf = (id: string) => `products/import/gallery/${id.replace(/[^A-Za-z0-9._-]/g, '_')}.webp`;

function mediaOf(p: ImportPayload): Map<string, MediaAnswerRow> {
  const m = new Map<string, MediaAnswerRow>();
  for (const i of p.images) m.set(i.source_media_id, { source_media_id: i.source_media_id, status: 'stored', r2_key: keyOf(i.source_media_id), width: 1000, height: 1000, error_code: '' });
  for (const s of p.swatches) m.set(s.source_media_id, { source_media_id: s.source_media_id, status: 'stored', r2_key: keyOf(s.source_media_id), width: 128, height: 128, error_code: '' });
  return m;
}

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
  /** The compare route's answer for `?ids=<id>` (default: 200 with the card). */
  compare?: () => { status: number; body: unknown };
  /** What D1 holds beside the payload (tests/fixtures/bambuKnowledgeRoute.ts knobs). */
  stored?: StoredKnowledgeKnobs;
  /** A route that answers otherwise than the real one (one fault at a time). */
  knowledgeEdit?: (k: Rec) => Rec;
  /** The listing does not show the product yet (a stale cached page): every listing read misses it. */
  unlisted?: boolean;
  /** The search does not find the product yet (a stale cached answer). */
  unsearched?: boolean;
  /** Searchable ids the Worker never stored: the site's index does not hold them (no typo tolerance here). */
  notStored?: readonly string[];
}

/** The name the site shows: a merge keeps the existing product's own (§E.2), a create carries the store title. */
const shownName = (l: Live) => l.existing?.name ?? l.payload.product.title_en;

/** What the site's search finds the product by: its name, its aliases (the store title), model tokens, searchable ids. */
const searchText = (l: Live) =>
  [
    shownName(l),
    l.payload.product.title_en,
    ...modelsInText(l.payload.product.title_en).map((m) => m.token),
    ...l.payload.external_ids.filter((e) => e.searchable && !l.notStored?.includes(e.value)).map((e) => e.value),
  ].join(' \n ').toLowerCase();

const files = (l: Live, id: string) => {
  const m = l.media.get(id);
  return m ? `/files/${m.r2_key}` : '';
};

/** The knowledge route's answer for what was written (tests/fixtures/bambuKnowledgeRoute.ts: the writer's rows, the route's assembly). */
function knowledge(l: Live): Rec {
  const k = routeKnowledge(l.payload, l.media, { inactiveDocuments: l.inactive, relationState: l.relationState, ...l.stored }) as unknown as Rec;
  return l.knowledgeEdit ? l.knowledgeEdit(JSON.parse(JSON.stringify(k))) : k;
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
    meta: { version: 'v1', pagination: null },
    links: { self: `${SITE}/api/public/v1/products/${l.slug}`, next: null, web: `${SITE}/product/${l.slug}` },
    data: {
      slug: l.slug,
      name: { ar: shownName(l), en: shownName(l), ckb: '' },
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
      if ((init.method ?? 'GET') === 'HEAD' && p.startsWith('/files/')) return { status: 200, headers: new Headers({ 'content-type': 'image/webp', 'cache-control': CACHE.files }), body: '', bytes: null };
      if (p === `/api/public/v1/products/${slug}`) return answer(200, v1(l), { 'cache-control': CACHE.v1 });
      if (p === `/api/products/${slug}`) return answer(200, siteAnswer(l), { 'cache-control': CACHE.site });
      if (p === `/api/products/${slug}/knowledge`) return answer(200, knowledge(l), { 'cache-control': CACHE.knowledge });
      if (p === `/api/products/${slug}/quote`) return l.existing?.priced ? answer(200, { success: true, total: 1_250_000 }) : answer(409, { success: false, code: 'PRICE_NOT_AVAILABLE' });
      if (p === '/api/price-requests') return answer(401, { success: false, error: 'Authentication required' });
      if (p === '/api/catalog/tree') return answer(200, tree(l), { 'cache-control': CACHE.tree });
      if (p === '/api/products') {
        // listCatalogProducts without a listing key: { success, category, suggestion, products } — no total, no truncated;
        // `search`, `limit` and `offset` honoured. The `ahead` products match the product's own title too.
        const cat = url.searchParams.get('category') ?? '';
        const search = (url.searchParams.get('search') ?? '').trim().toLowerCase();
        const offset = Number(url.searchParams.get('offset') ?? 0);
        const limit = Math.min(50, Number(url.searchParams.get('limit') ?? 20));
        const self = !l.unlisted && (!search || searchText(l).includes(search)) ? [{ id: l.productId, slug: l.slug }] : [];
        const all = l.sections.includes(cat) ? [...Array.from({ length: l.ahead ?? 0 }, (_, i) => ({ id: `p_other_${i}`, slug: `other-${i}` })), ...self] : [];
        return answer(200, { success: true, category: { slug: cat }, suggestion: null, products: all.slice(offset, offset + limit) }, { 'cache-control': CACHE.site });
      }
      if (p === '/api/public/v1/search') {
        const q = (url.searchParams.get('q') ?? '').trim().toLowerCase();
        const products = !l.unsearched && q && searchText(l).includes(q) ? [{ slug: l.slug }] : [];
        return answer(200, { data: { query: q, suggestion: null, products, sections: [], brands: [] }, meta: { version: 'v1', pagination: null }, links: { self: u, next: null, web: null } }, { 'cache-control': CACHE.v1 });
      }
      if (p === '/api/compare') {
        const c = l.compare?.();
        return c ? answer(c.status, c.body, { 'cache-control': CACHE.private }) : answer(200, { success: true, products: [{ id: l.productId, slug: l.slug }] }, { 'cache-control': CACHE.private });
      }
      if (p === '/api/compare/candidates') {
        // browseCompareCandidates: `q` against the product's OWN name (LIKE, the first 48 bytes); no anchor without `for`.
        const q = likeBody(url.searchParams.get('q') ?? '').toLowerCase();
        const products = !q || shownName(l).toLowerCase().includes(q) ? [{ id: l.productId, slug: l.slug, name: { ar: shownName(l), en: shownName(l), ckb: '' } }] : [];
        return answer(200, { success: true, for: null, products }, { 'cache-control': CACHE.private });
      }
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

test('review 2: a resumed VERIFY reads the documents as the write stored them (stage_data), never its own checks; unrecorded, the live answer stands for them', async () => {
  const l = live('pla-basic-filament', { sections: ['filament', 'pla'] });
  const [dead, other] = l.payload.documents;
  const timeout = (id: string): DocumentCheck => ({ document_id: id, check_status: 0, content_type: '', byte_size: null, content_sha256: '', checked_at: '2026-10-16T00:00:00Z', tracker_source: '' });
  // Every document stored active; the re-taken checks lost one to a timeout: the record is what counts.
  const recorded = await verify(l, { documentChecks: [timeout(dead.id)], writtenDocuments: { inactive: [] } });
  assert.deepEqual(failed(recorded), []);
  assert.equal(recorded.checks.knowledge.detail?.documents_from, 'stage_data');
  assert.equal(recorded.checks.knowledge.counts?.expected_documents, l.payload.documents.length);
  // One stored inactive: expected off the page — and its absence on the page is right, its presence a difference.
  const off = await verify({ ...l, inactive: new Set([dead.id]) }, { writtenDocuments: { inactive: [dead.id] } });
  assert.deepEqual(failed(off), []);
  assert.equal(off.checks.knowledge.counts?.expected_documents, l.payload.documents.length - 1);
  assert.ok(failed(await verify(l, { writtenDocuments: { inactive: [dead.id] } })).includes('knowledge'), 'the page shows one the write stored inactive');
  assert.ok(failed(await verify({ ...l, inactive: new Set([other.id]) }, { writtenDocuments: { inactive: [] } })).includes('knowledge'), 'the page lost one the write stored active');
  // Not recorded (a Worker before this review): the documents the page shows, each one the payload's, stand.
  const unknown = await verify({ ...l, inactive: new Set([dead.id]) }, { writtenDocuments: 'not_recorded' });
  assert.deepEqual(failed(unknown), []);
  assert.equal(unknown.checks.knowledge.detail?.documents_from, 'not_recorded');
  assert.equal(unknown.checks.knowledge.counts?.expected_documents, l.payload.documents.length - 1);
  assert.equal(unknown.checks.fingerprint.ok, true);
  // …but never one the payload does not hold: an extra document on the page still fails.
  const foreign = await verify(
    { ...l, knowledgeEdit: (k) => ({ ...k, documents: [...(k.documents as Rec[]), { ...(k.documents as Rec[])[0], url: 'https://store.bblcdn.com/s7/planted-foreign.pdf' }] }) },
    { writtenDocuments: 'not_recorded' }
  );
  assert.ok(failed(foreign).includes('knowledge'), JSON.stringify(foreign.checks.knowledge));
  // This job's /write: its checks are the ones it sent, as before.
  const sent = await verify(l, {});
  assert.equal(sent.checks.knowledge.detail?.documents_from, 'write');
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

test('a MERGE expects the searchable ids the writer stores (one rule, merge.ts): an unmerged variant\'s code is not asked; a merged one missing still fails', async () => {
  // The writer stores a merge's own ids and those of the variants and values the reviewed map merges, nothing of
  // the rest (variant_not_merged) — bambu-reusable-spool's RSP002, or here every colour but Jade White. VERIFY
  // used to ask for every payload id, so an unmerged code passed only when the typo tolerance happened to reach a
  // stored neighbour (RSP002 → RSP001). The fake site holds exactly what the writer stored, and no typo tolerance.
  // Built as the writer's world builds it (its manifest row carries the SKU codes, one per variant).
  const { payload } = buildFor(newWriterWorld(), 'pla-basic-filament', { writeMode: 'merge', mergeProductId: 'p_existing_pla_0001' });
  const white = payload.groups[0].values.find((v) => /^Jade White/.test(v.name_en))!;
  const value_map: Record<string, { color_id: string }> = {};
  for (const v of payload.variants) if (v.value_ids.includes(white.id)) value_map[v.source_id] = { color_id: 'c_white' };
  const mergeMatch = { value_map, unmapped_variants: [] };
  const stored = new Set(storedExternalIds(payload.external_ids, mergedSelections(payload, mergeMatch)).filter((e) => e.searchable).map((e) => e.value));
  const notStored = [...new Set(payload.external_ids.filter((e) => e.searchable && !stored.has(e.value)).map((e) => e.value))];
  assert.ok(stored.has('10100') && [...stored].some((v) => v.startsWith('A00-W1-')), 'precondition: Jade White\'s colour and SKU codes are stored');
  assert.ok(notStored.includes('10101') && notStored.some((v) => v.startsWith('A00-K0-')), 'precondition: the other colours\' codes and SKU codes are not');
  const existing = { name: 'Bambu Lab PLA Basic Filament 1kg', priced: true, groups: [], variants: [], images: [{ id: 'pi_existing_pla', url: '/files/products/existing-pla.webp', is_primary: true, option_value_id: null, variant_id: null }] };
  const l = live('pla-basic-filament', { payload, slug: 'bambu-lab-pla-basic-filament', productId: 'p_existing_pla_0001', sections: ['printing-materials', 'fdm-materials'], existing, notStored });
  const o = await verify(l, { mergeMatch });
  assert.ok(!failed(o).includes('search'), JSON.stringify(o.checks.search));
  assert.equal(o.checks.search.counts?.external_ids, stored.size, 'exactly the stored ids were asked');
  assert.equal(o.checks.search.counts?.external_id_misses, 0);
  // Without the reviewed map the runner cannot say what was stored: every payload id is expected (fails closed).
  assert.ok(failed(await verify(l)).includes('search'));
  // A merged colour's code the site does not find is still a hard failure.
  const o3 = await verify({ ...l, notStored: [...notStored, '10100'] }, { mergeMatch });
  assert.ok(failed(o3).includes('search'));
  assert.equal(o3.checks.search.counts?.external_id_misses, 1);
});

test('compare for a MERGE: the candidates are asked by the name the site shows — the existing product\'s, which need not contain the store title', async () => {
  const payload = payloadOf('h2d', 'p_existing_h2d_0002');
  const existing = {
    // The live route matches `q` against the product's OWN names; a merge keeps this one (§E.2), and it does not
    // contain the store's «Bambu Lab H2D».
    name: 'H2D 3D Printer — Bambu Lab (H2D Combo / Laser Full Combo)',
    priced: false,
    groups: [{ id: 'og_existing', name_en: 'Bundle', sort: 0, default_value_id: 'ov_existing_a', values: [{ id: 'ov_existing_a', sort: 0 }] }],
    variants: [{ id: 'pv_existing_a', combo_key: 'o:ov_existing_a' }],
    images: [{ id: 'pi_existing_main', url: '/files/products/existing-main.webp', is_primary: true, option_value_id: null, variant_id: null }],
  };
  assert.ok(!existing.name.includes(payload.product.title_en), 'the existing name does not contain the store title (else this proves nothing)');
  const l = live('h2d', { payload, media: mediaOf(payload), slug: 'bambu-lab-h2d', productId: 'p_existing_h2d_0002', sections: ['printers', 'fdm-printers'], existing });
  const reads: string[] = [];
  const o = await verify(l, {}, reads);
  assert.ok(o.checks.compare.counts!.compare_keys >= 3, 'a type with 3 or more compare keys: the candidates are a hard part of the check');
  assert.deepEqual(failed(o), [], JSON.stringify(o.checks.compare));
  assert.equal(o.checks.compare.detail?.candidates, 'present');
  const asked = reads.find((r) => r.includes('/api/compare/candidates'));
  assert.equal(asked, `GET /api/compare/candidates?q=${encodeURIComponent(existing.name)}`, 'asked by the shown name, never the store title');
  // The store title finds nothing on that route: the very answer the check must not be built on.
  assert.equal(likeBody(payload.product.title_en), 'Bambu Lab H2D');
  assert.ok(!existing.name.toLowerCase().includes(likeBody(payload.product.title_en).toLowerCase()));
});

test('the cache rule hears a stale listing and a stale search too: their s-maxage sets the wait, not the 6-minute default', async () => {
  const l = live('bambu-hotend-a1-a2');
  const listing = await verify({ ...l, unlisted: true });
  assert.deepEqual(failed(listing), ['listings']);
  assert.equal(listing.cacheMs, (120 + 60) * 1000, 'the listing answers s-maxage=120 (live): wait 120 s + 60 s');
  const search = await verify({ ...l, unsearched: true });
  assert.deepEqual(failed(search), ['search']);
  assert.equal(search.cacheMs, (120 + 60) * 1000, 'the v1 search answers s-maxage=120 (live)');
  // A failing knowledge answer (s-maxage=300) still sets the longest wait.
  const both = await verify({ ...l, unlisted: true, knowledgeEdit: (k) => ({ ...k, documents: [] }) });
  assert.ok(failed(both).includes('listings') && failed(both).includes('knowledge'), JSON.stringify(failed(both)));
  assert.equal(both.cacheMs, (300 + 60) * 1000);
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
  assert.deepEqual(opening, []);
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
  // A general primary whose bytes come back later bound to a value: the general copy goes, the bound copy takes its
  // position and the primary — a representative keeping its rule and its variant (the package rule, mediaCollapse.ts).
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
    [['v1', 1, false, 'variant', null], ['g2', 2, false, 'general', null], ['x3', 0, true, 'representative', 'pv_9']]
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

// ---------------------------------------------------------------- compare (§I.1.11)

const noSpecs = (productId: string) => () => ({
  status: 400,
  body: { success: false, error: 'No specifications are recorded for “x”, so there is nothing to compare it on.', code: 'COMPARE_NO_SPECS', details: { product_id: productId } },
});

test('compare: COMPARE_NO_SPECS is the expected absence for a type with fewer than 3 compare keys, recorded not_applicable', async () => {
  const payload = payloadOf('build-plate-combo');
  const reads: string[] = [];
  const o = await verify(live('build-plate-combo', { payload, compare: noSpecs(payload.product_id) }), {}, reads);
  assert.deepEqual(failed(o), []);
  const c = o.checks.compare;
  assert.deepEqual({ ok: c.ok, hard: c.hard, status: c.status }, { ok: true, hard: true, status: 400 });
  assert.equal(c.counts?.compare_keys, 0);
  assert.equal(c.counts?.not_applicable, 1, 'kept by the Worker, which stores a check\'s counts and never its detail');
  assert.equal(c.detail?.compare, 'not_applicable');
  assert.match(String(c.detail?.reason), /COMPARE_NO_SPECS: fewer than 3 compare keys/);
  assert.ok(!reads.some((r) => r.includes('/api/compare/candidates')), 'no candidates are expected for the type');
  const ev = edgeEvidence(o, null, `${SITE}/product/build-plate-combo`, payload, 1) as { checks: Record<string, { detail?: Record<string, unknown> }> };
  assert.equal(ev.checks.compare.detail?.compare, 'not_applicable');
  // PLA Basic: its diameter is a product fact; its net weight is its «1kg» value's, which a bare product id never reads.
  const one = await verify(live('pla-basic-filament', { sections: ['filament', 'pla'], compare: noSpecs(payloadOf('pla-basic-filament').product_id) }));
  assert.equal(one.checks.compare.counts?.compare_keys, 1);
  assert.equal(one.checks.compare.ok, true);
  // The card answered: passes too, and says so.
  const card = await verify(live('build-plate-combo', { payload }));
  assert.equal(card.checks.compare.detail?.compare, 'card');
  assert.equal(card.checks.compare.counts?.not_applicable, undefined);
});

test('compare: a type with 3 or more compare keys must show the card and the candidates; any other refusal fails either way', async () => {
  const h2d = payloadOf('h2d');
  const reads: string[] = [];
  const o = await verify(live('h2d', { payload: h2d, sections: ['printers', 'fdm-printers'], compare: noSpecs(h2d.product_id) }), {}, reads);
  assert.ok(o.checks.compare.counts!.compare_keys >= 3);
  assert.deepEqual(failed(o), ['compare']);
  assert.equal(o.checks.compare.detail?.compare, 'failed');
  assert.ok(reads.some((r) => r.includes('/api/compare/candidates')), 'the candidates are read for the type');
  const ok = await verify(live('h2d', { payload: h2d, sections: ['printers', 'fdm-printers'] }));
  assert.deepEqual({ ok: ok.checks.compare.ok, compare: ok.checks.compare.detail?.compare, candidates: ok.checks.compare.detail?.candidates }, { ok: true, compare: 'card', candidates: 'present' });
  // Fewer than 3 keys, but not exactly this product's COMPARE_NO_SPECS: another code, another product, a 500.
  const plate = payloadOf('build-plate-combo');
  for (const compare of [
    () => ({ status: 400, body: { success: false, error: 'x', code: 'COMPARE_NOT_VISIBLE' } }),
    noSpecs('p_some_other_product'),
    () => ({ status: 400, body: { success: false, error: 'x', code: 'COMPARE_NO_SPECS' } }),
    () => ({ status: 500, body: { success: false, error: 'x', code: 'INTERNAL' } }),
  ]) {
    const bad = await verify(live('build-plate-combo', { payload: plate, compare }));
    assert.deepEqual(failed(bad), ['compare'], JSON.stringify(compare()));
  }
});

test('compare keys are counted by the route\'s own rule (R4): a value-scoped, a US 110 V or an owner fact never counts toward the three', async () => {
  const base = payloadOf('pla-basic-filament');
  const fact = (key: string, extra: Partial<ImportPayload['specs'][number]>) => ({ ...base.specs.find((x) => x.key === 'material.diameter')!, id: `ps_${key}_${extra.region ?? ''}${extra.scope_id ?? ''}`, key, value_num: 1.24, value_text: '1.24', ...extra });
  const colour = base.groups.find((g) => g.kind === 'color')!.values[0].id;
  const p: ImportPayload = {
    ...base,
    specs: [
      ...base.specs,
      fact('material.density', { region: 'us_110v' }),
      fact('mechanical.tensile_strength', { scope_kind: 'option_value', scope_id: colour, group: 'mechanical' }),
      fact('mechanical.tensile_strength', { visibility: 'owner', group: 'mechanical' }),
    ],
  };
  // Counted any scope and region, these were four keys (diameter, net weight, density, tensile strength): "typed",
  // and the route's honest COMPARE_NO_SPECS failed the product. The single-id answer reads one of them.
  assert.equal(compareKeysOf(p), 1);
  const o = await verify(live('pla-basic-filament', { payload: p, sections: ['filament', 'pla'], compare: noSpecs(p.product_id) }));
  assert.equal(o.checks.compare.ok, true, JSON.stringify(o.checks.compare));
  assert.equal(o.checks.compare.detail?.compare, 'not_applicable');
  // The same rule as the route's single-id column: the cells a bare product id stands on.
  const rows = p.specs.map((s) => ({ canonical_key: s.key, scope_kind: s.scope_kind, scope_id: s.scope_id, region: s.region, value_text: s.value_text, value_num: s.value_num, value_num_max: s.value_num_max, unit: s.unit, status: s.status, test_method: s.test_method, visibility: s.visibility }));
  assert.deepEqual(comparedFields(rows, null), ['diameter']);
  assert.ok(!('density' in knowledgeCellsFor(rows.filter((r) => r.region === 'us_110v'), null)), 'a US 110 V fact is no cell at all');
  // The family filter's code is never a compare key (FILTER_ONLY_FIELDS).
  assert.ok(![...COMPARE_KEY_FIELDS.values()].some((f) => FILTER_ONLY_FIELDS.has(f)));
  // Three product facts with values do make the type comparable (R2 stays: only < 3 accepts COMPARE_NO_SPECS).
  // (PLA Basic already states its density «not found» at product scope: that row stands, and states no value.)
  const three: ImportPayload = { ...p, specs: [...p.specs, fact('motion.max_acceleration', { group: 'motion' }), fact('mechanical.tensile_strength', { group: 'mechanical' })] };
  assert.equal(compareKeysOf(three), 3);
  const refused = await verify(live('pla-basic-filament', { payload: three, sections: ['filament', 'pla'], compare: noSpecs(three.product_id) }));
  assert.deepEqual(failed(refused), ['compare']);
});

// ---------------------------------------------------------------- the knowledge answer, fact by fact (W3)

test('the knowledge answer is the route\'s own for what was written: weights as published, the US 110 V table, logistics in their parts', async () => {
  const p = payloadOf('h2d');
  const l = live('h2d', { payload: p, sections: ['printers', 'fdm-printers'] });
  const o = await verify(l);
  assert.deepEqual(failed(o), [], JSON.stringify(o.checks.knowledge));
  const k = expectedKnowledge(p, l.media, []);
  assert.equal(k.logistics.product.find((r) => r.key === 'product.net_weight')?.value_text, '31 kg', 'the weight as published, never 31000 g');
  assert.deepEqual(k.logistics.shipment.filter((r) => r.region === 'us_110v').map((r) => r.value_text).sort(), ['40.6 kg', '44.2 kg', '48.2 kg']);
  assert.ok(k.specs.flatMap((g) => g.rows).some((r) => r.region === 'us_110v'), 'the US 110 V rows are in the answer (the page puts them under «إصدارات أخرى»)');
  // A writer that stored a weight's text from its grams: the row differs, the check fails.
  const grams = await verify({ ...l, stored: { storeSpec: (r) => (r.unit === 'g' && r.value_num !== null ? { ...r, value_text: `${r.value_num} g` } : r) } });
  assert.ok(failed(grams).includes('knowledge'));
  assert.ok((grams.checks.knowledge.counts?.mismatched_rows ?? 0) > 0);
  // A route that dropped the US 110 V table, or filed a logistics row among the specifications: fails.
  const noUs = await verify({ ...l, knowledgeEdit: (a) => ({ ...a, specs: (a.specs as Rec[]).map((g) => ({ ...g, rows: (g.rows as Rec[]).filter((r) => r.region !== 'us_110v') })) }) });
  assert.ok(failed(noUs).includes('knowledge'));
  const misfiled = await verify({
    ...l,
    knowledgeEdit: (a) => {
      const L = a.logistics as Record<string, Rec[]>;
      return { ...a, logistics: { ...L, shipment: [] }, specs: [...(a.specs as Rec[]), { group: 'physical', rows: L.shipment }] };
    },
  });
  assert.ok(failed(misfiled).includes('knowledge'));
});

test('live scopes only: facts on a value, variant or group the page does not hold are never expected; a value left inactive is a failure', async () => {
  const base = payloadOf('h2d');
  const gone = (s: ImportPayload['specs'][number]) => ({ ...s, id: `${s.id}_gone`, scope_kind: 'option_value' as const, scope_id: 'ov_not_on_this_product' });
  const p: ImportPayload = {
    ...base,
    specs: [...base.specs, gone(base.specs[0])],
    documents: [...base.documents, { ...base.documents[0], id: 'pd_gone', url: `${base.documents[0].url}?v=gone`, scope_kind: 'variant', scope_id: 'pv_not_on_this_product' }],
    relations: [
      ...base.relations,
      { id: 'prel_gone', scope_kind: 'option_value', scope_id: 'ov_not_on_this_product', relation: 'compatible_with', target_kind: 'printer', target_product_id: null, target_source: 'bambu_us', target_source_handle: 'a1', target_family: '', target_label: 'A1', state: 'pending', evidence_kind: 'compat_section', evidence_text: '' },
      // A relation the answer has no list for.
      { id: 'prel_fits', scope_kind: 'product', scope_id: '', relation: 'fits', target_kind: 'printer', target_product_id: null, target_source: 'bambu_us', target_source_handle: 'a1', target_family: '', target_label: 'A1', state: 'pending', evidence_kind: 'compat_section', evidence_text: '' },
    ],
    // A swatch of a value the product does not hold.
    swatches: [...base.swatches, { value_id: 'ov_not_on_this_product', source_media_id: base.images[0].source_media_id, source_url: '' }],
  };
  const l = live('h2d', { payload: p, sections: ['printers', 'fdm-printers'] });
  const o = await verify(l);
  assert.deepEqual(failed(o), [], JSON.stringify(o.checks.knowledge));
  // The H2D's per-version facts: a version the writer left inactive takes its rows off the page — VERIFY sees it.
  const scoped = p.specs.find((s) => s.scope_kind === 'option_value' && s.visibility === 'public')!;
  const off = await verify({ ...l, stored: { inactiveValues: new Set([scoped.scope_id]) } });
  assert.ok(failed(off).includes('knowledge'));
});

test('the box as the route draws it: an item with no text is not an item, and a picture is the stored object\'s', async () => {
  const base = payloadOf('a1');
  const box = base.specs.find((s) => s.key === 'package.contents' && s.visibility === 'public')!;
  assert.ok(box, 'A1 has a box');
  const p: ImportPayload = { ...base, specs: base.specs.map((s) => (s === box ? { ...s, value_list: [...s.value_list, { text: '  ', qty: 1, source_media_id: '', source_url: '', section: '' }] } : s)) };
  const l = live('a1', { payload: p, sections: ['printers', 'fdm-printers'] });
  const o = await verify(l);
  assert.deepEqual(failed(o), [], JSON.stringify(o.checks.knowledge));
  const items = base.specs.filter((s) => s.key === 'package.contents' && s.visibility === 'public').reduce((n, s) => n + s.value_list.length, 0);
  assert.equal(o.checks.knowledge.counts?.in_the_box, items, 'every item of every version\'s box, the empty one left out');
  const lost = await verify({ ...l, knowledgeEdit: (a) => ({ ...a, in_the_box: (a.in_the_box as Rec[]).slice(1) }) });
  assert.ok(failed(lost).includes('knowledge'));
  assert.equal(lost.checks.knowledge.counts?.mismatched_box, 1);
});

// ---------------------------------------------------------------- the runner's gallery IS the writer's (W4)

/** A copy's media row on the canonical's stored object (byte-identical pictures share one content-addressed key). */
function sameBytes(w: WriterWorld, copy: string, canonical: string): void {
  const c = w.raw.prepare('SELECT r2_key, width, height, bytes, sha256 FROM catalog_import_media WHERE run_id = ? AND source_media_id = ?').get(WRITER_RUN, canonical) as Record<string, unknown>;
  w.raw
    .prepare('UPDATE catalog_import_media SET r2_key = ?, width = ?, height = ?, bytes = ?, sha256 = ? WHERE run_id = ? AND source_media_id = ?')
    .run(c.r2_key as string, c.width as number, c.height as number, c.bytes as number, c.sha256 as string, WRITER_RUN, copy);
}

test('W4: the runner\'s gallery is the real writer\'s rows for every moved shape — a representative, a reviewed override, a value copy carrying a variant', async () => {
  const w = newWriterWorld();
  // The hotend: one general picture (sort 1) and one entry (sort 2–5: a value row and three representatives) share
  // the lead's bytes (sort 0); a later value row (sort 6) shares the second general picture's.
  const s = stageForWriter(w, 'bambu-hotend-a1-a2', {
    mutate: (p) => {
      const entry = p.images.filter((i) => i.sort_order >= 2 && i.sort_order <= 5);
      assert.deepEqual(entry.map((i) => i.binding_rule), ['value', 'representative', 'representative', 'representative']);
      entry[0].binding_rule = 'reviewed_override';
      const later = p.images.find((i) => i.sort_order === 6)!;
      assert.equal(later.binding_rule, 'value');
      later.via_variant_id = p.variants[0].id;
    },
  });
  const p = s.payload;
  // The override is a reviewed one (data/bambu-import/media-overrides.json), or the writer refuses it.
  const override = p.images.find((i) => i.binding_rule === 'reviewed_override')!;
  rebundleWriter(w, { mediaOverrides: JSON.stringify({ version: 1, overrides: [{ handle: p.handle, resourceFileId: override.source_media_id, valueIds: [override.option_value_id] }] }) });
  const at = (sort: number) => p.images.find((i) => i.sort_order === sort)!.source_media_id;
  sameBytes(w, at(2), at(0));
  sameBytes(w, at(6), at(1));
  const { result } = await writerWrite(w, s);
  const media = new Map<string, MediaAnswerRow>(
    (w.raw.prepare("SELECT source_media_id, r2_key FROM catalog_import_media WHERE run_id = ? AND status = 'stored'").all(WRITER_RUN) as Array<{ source_media_id: string; r2_key: string }>).map((m) => [
      m.source_media_id,
      { source_media_id: m.source_media_id, status: 'stored', r2_key: m.r2_key, width: 64, height: 48, error_code: '' },
    ])
  );
  // What the page reads of each row's source variant: the writer's stored image source refs.
  const storedVia = new Map(
    (w.raw.prepare("SELECT levonis_id, via_variant_id FROM product_option_source_refs WHERE product_id = ? AND kind = 'image'").all(p.product_id) as Array<{ levonis_id: string; via_variant_id: string }>).map((r) => [r.levonis_id, r.via_variant_id || null])
  );
  const shape = (rows: ReadonlyArray<{ id: string; sort_order: number; is_primary: boolean; option_value_id: string | null; variant_id: string | null; binding_rule: string }>) =>
    rows.map((r) => ({ id: r.id, sort_order: r.sort_order, is_primary: r.is_primary, option_value_id: r.option_value_id, variant_id: r.variant_id, binding_rule: r.binding_rule })).sort((a, b) => (a.id < b.id ? -1 : 1));
  // The resume path (no /write answer): the runner's recompute is the writer's /write rows, and names what D1 stores.
  const recomputed = recomputedGallery(p, media);
  assert.deepEqual(shape(recomputed), shape(result.images));
  for (const r of recomputed) assert.equal(r.via_variant_id, storedVia.get(r.id) ?? null, `${r.id}: the source variant the page reads`);
  // This job's own answer gives the same gallery.
  assert.deepEqual(galleryFromWritten(p, result.images), recomputed);
  // The shapes, one by one.
  const row = (sort: number) => recomputed.filter((r) => p.images.find((i) => i.id === r.id)!.sort_order === sort);
  assert.deepEqual(row(0), [], 'the general lead went: its bound copies hold its place');
  const moved = recomputed.filter((r) => r.sort_order === 0);
  assert.deepEqual(moved.map((r) => r.binding_rule).sort(), ['representative', 'representative', 'representative', 'reviewed_override']);
  for (const r of moved.filter((x) => x.binding_rule === 'representative')) assert.ok(r.via_variant_id, 'a moved representative keeps the variant whose hero it shows (R6)');
  const copy = recomputed.find((r) => r.id === p.images.find((i) => i.sort_order === 6)!.id)!;
  assert.deepEqual([copy.sort_order, copy.binding_rule, copy.via_variant_id], [1, 'content_duplicate', null], 'a moved value copy names no variant');
  assert.equal(recomputed.filter((r) => r.is_primary).length, 1);
  // The fourth shape — a colour-bound copy — never reaches the writer: an import image names no colour (the allow-list).
  const coloured = JSON.parse(JSON.stringify(p)) as ImportPayload;
  (coloured.images[0] as unknown as Record<string, unknown>).color_id = 'col_1';
  assert.throws(() => assertImportPayload(coloured));
});

// ---------------------------------------------------------------- one item per label, and the translation memory (I18N-DESIGN §C.2)

test('I18N §C.2: VERIFY expects the deduped compatibility and ignores *_i18n — the live route with visible targets and translations agrees', async () => {
  const x = pageOf('filament-buffer').extraction;
  const payload = buildImportPayload({
    extraction: x,
    writeMode: 'create',
    extractionSha256: extractionFingerprint(x),
    targets: fixtureJson('compat-targets.json') as never,
    retrievedAt: '2026-10-16T00:00:00Z',
  }).payload;
  assert.equal(payload.relations.length, 7, 'the canary\'s seven relation rows (else this proves nothing)');
  const l = live('a1', { payload, slug: 'filament-buffer', productId: payload.product_id });
  const targets: Record<string, { id: string; slug: string; name: string }> = {
    p1s: { id: 'p_p1s', slug: 'p1s', name: 'Bambu Lab P1S' },
    'refurbished-p1s': { id: 'p_rp1s', slug: 'refurbished-p1s', name: 'Refurbished P1S' },
    'refurbished-x1c': { id: 'p_rx1c', slug: 'refurbished-x1c', name: 'Refurbished X1C' },
    'ams-hub': { id: 'p_hub', slug: 'ams-hub', name: 'AMS Hub' },
  };
  const translations = new Map([
    ['Below 10mA', { ar: 'أقل من 10mA', ckb: 'کەمتر لە 10mA' }],
    ['Plastics, PCBA', { ar: 'بلاستيك، PCBA', ckb: 'پلاستیک، PCBA' }],
    ['Gray', { ar: 'رمادي', ckb: 'خۆڵەمێشی' }],
  ]);
  const stored = { relationState: () => 'resolved', visibleTarget: (r: ImportPayload['relations'][number]) => targets[r.target_source_handle] ?? null, translations };
  const expected = expectedKnowledge(payload, l.media, []);
  const answered = routeKnowledge(payload, l.media, stored);
  // The live answer really is the decorated one: links, `more`, and the memory's words.
  assert.deepEqual(answered.compatibility.compatible.map((c) => c.label), ['P1 Series', 'X1 Series']);
  assert.deepEqual(answered.compatibility.requires.map((c) => c.label), ['AMS Hub']);
  const p1 = answered.compatibility.compatible[0];
  assert.equal(p1.product?.slug, 'p1s');
  assert.deepEqual(p1.more?.map((m) => m.slug), ['refurbished-p1s']);
  assert.equal(answered.compatibility.requires[0].product?.slug, 'ams-hub');
  const current = answered.specs.flatMap((g) => g.rows).find((r) => r.key === 'electrical.current')!;
  assert.deepEqual(current.value_i18n, { ar: 'أقل من 10mA', ckb: 'کەمتر لە 10mA' });
  // …and VERIFY's expectation (no targets, no memory) is the same facts.
  assert.deepEqual(knowledgeDiff(knowledgeProjection(expected as never), knowledgeProjection(answered as never)), { rows: 0, box: 0, documents: 0, relations: 0, swatches: 0 });
  const o = await verify({ ...l, stored });
  assert.equal(o.checks.knowledge.ok, true, JSON.stringify(o.checks.knowledge));
  assert.equal(o.checks.fingerprint.ok, true, JSON.stringify(o.checks.fingerprint));
});
