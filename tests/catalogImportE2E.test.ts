/**
 * THE IMPORT, END TO END, IN PROCESS (Bambu import spec §I.1, §K.2 step 6 and
 * step 10 (a)): the eight sample pages through the REAL Hono app
 * (worker/index.ts) on the D1 shim behind LimitD1, the R2 and IMAGES doubles
 * and a fetcher double for store.bblcdn.com — driven by the RUNNER'S client:
 * scripts/bambu-import/opsClient.ts when the repository (or
 * LEVONIS_RUNNER_OPS_CLIENT) has it, else tests/fixtures/opsClientMirror.ts, a
 * copy of its calls. The test logs which one it used.
 *
 *   open    hello (the reviewed SHA-256s by the runner's formula), the manifest,
 *           prepare-taxonomy, protect-snapshot before
 *   items   one at a time, in queue order, exactly as run.ts sequences them:
 *           lease, event start, ok ×3, stage, media (≤ 4 a call), ok, write,
 *           publish-finish, readback, VERIFY (the real public routes), complete
 *   verify  the public v1 record, the anonymous structure answer, the
 *           fingerprint of §I.1.2 through the real routes (its knowledge half
 *           when /knowledge exists on this branch), the listing, search,
 *           not-sellable, every /files object, compare
 *   close   status (nothing next), protect-snapshot after (0 changed),
 *           finish, and /hello answers 404 with the job's token
 *
 * And: a full re-run writes zero rows; media already stored are never fetched
 * again; a block after the write hides the created product and the resume puts
 * it back; DEADLINE_EXIT parks without counting toward stage_attempts; with no
 * open run every ops path answers the uniform 404.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT } from './fixtures/d1';
import { buildFor, bundleTexts, manifestRowOf, p0Json } from './fixtures/catalogImportWorld';
import { sample, SAMPLE_HANDLES, type SampleHandle } from './fixtures/bambu/load';
import { CUSTOMER_SESSION, installCdnDouble, openRun, OPS, opsWorld, OWNER_SESSION, restoreFetch, setBundle, TOKEN, type OpsWorld } from './fixtures/catalogImportOps';
import * as mirror from './fixtures/opsClientMirror';
import { projectionFingerprint, projectionFromPayload, projectionFromSite, type Projection } from '../packages/catalog/src/bambuImport/fingerprint';
import type { ImportPayload } from '../packages/catalog/src/bambuImport/payload';
import { specKey } from '../packages/catalog/src/bambuImport/registry/specKeys';
import { reviewedBundleDigest, type ReviewedTexts } from '../worker/lib/catalogImport/reviewed';
import { edgeEvidence, modelCodesOf, Site, verifyPublic, type VerifyOutcome } from '../scripts/bambu-import/verify';
import { HostFetcher } from '../scripts/bambu-import/fetch';
import { Deadline as RunnerDeadline } from '../scripts/bambu-import/deadline';
import { writtenGallery } from '../scripts/bambu-import/gallery';
import { NOT_APPLICABLE } from '../scripts/bambu-import/browser';
import type { DocumentCheck as RunnerDocumentCheck, MediaAnswerRow, WrittenImage } from '../scripts/bambu-import/opsClient';
import { createHash } from 'node:crypto';

after(() => {
  restoreFetch();
  setBundle(null);
});

// ---------------------------------------------------------------- the runner's client

type Client = InstanceType<typeof mirror.OpsClient>;
let clientSource = 'mirror';
async function clientModule(): Promise<{ OpsClient: typeof mirror.OpsClient; deadline: (at: number, clock: mirror.Clock) => mirror.Deadline }> {
  const candidates = [process.env.LEVONIS_RUNNER_OPS_CLIENT ?? '', join(ROOT, 'scripts/bambu-import/opsClient.ts')].filter(Boolean);
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    const mod = (await import(pathToFileURL(path).href)) as { OpsClient: typeof mirror.OpsClient };
    const dl = (await import(pathToFileURL(join(dirname(path), 'deadline.ts')).href)) as { Deadline: new (at: number, clock: mirror.Clock) => mirror.Deadline };
    clientSource = path;
    return { OpsClient: mod.OpsClient, deadline: (at, clock) => new dl.Deadline(at, clock) };
  }
  return { OpsClient: mirror.OpsClient, deadline: () => ({ fits: () => true }) };
}

const clock: mirror.Clock = { now: () => Date.now(), sleep: async () => undefined };

/** The raw answer of the last /write, by source id: the runner's client keeps only the keys it reads. */
const writeAnswers = new Map<string, Record<string, unknown>>();

async function clientFor(w: OpsWorld, token = TOKEN): Promise<Client> {
  const { OpsClient, deadline } = await clientModule();
  const fetchThrough = async (url: string, init?: RequestInit) => {
    const res = await w.fetch(url, init);
    const m = /\/items\/(\d+)\/write$/.exec(new URL(url).pathname);
    if (m && res.status === 200) writeAnswers.set(m[1], (await res.clone().json()) as Record<string, unknown>);
    return res;
  };
  return new OpsClient({ siteOrigin: 'https://levonis-iq.com', token, fetch: fetchThrough as never, clock, deadline: deadline(Date.now() + 6 * 3600_000, clock) as never, githubRunId: '987654321', codeCommit: 'a'.repeat(40) });
}

// ---------------------------------------------------------------- the bundle and the payloads

const HANDLES: readonly SampleHandle[] = SAMPLE_HANDLES;

interface Fixture {
  handle: SampleHandle;
  sid: string;
  row: Record<string, unknown>;
  payload: ImportPayload;
}

function fixtures(): Fixture[] {
  return HANDLES.map((h, i) => {
    const x = sample(h);
    const row = manifestRowOf(x, i + 1);
    return { handle: h, sid: x.sourceProductId, row, payload: buildFor({ queue: i }, h).payload };
  });
}

function textsFor(rows: Array<Record<string, unknown>>): ReviewedTexts {
  return bundleTexts({ manifestRows: rows, matches: [] }, { searchSynonyms: JSON.stringify(p0Json('search-synonyms.json')) });
}

/** The /manifest request row, as scripts/bambu-import/discover.ts `manifestRequestRow` builds it. */
const manifestRequestRow = (row: Record<string, unknown>, at: string) => ({
  source_product_id: row.source_product_id,
  handle: row.handle,
  type: row.type ?? '',
  curated: row.curated === true,
  hold_code: row.hold_code ?? '',
  queue_position: row.queue_position,
  canonical_url: row.canonical_url ?? '',
  source_collections: [],
  breadcrumbs: '',
  discovery_sources: ['sitemap'],
  discovered_at: at,
});

/** The runner's document checks (scripts/bambu-import/enrich.ts): every document answered 200, one dead link. */
function documentChecks(p: ImportPayload): mirror.DocumentCheck[] {
  return p.documents.map((d, i) => ({
    document_id: d.id,
    check_status: i === 0 && p.documents.length > 2 ? 404 : 200,
    content_type: 'application/pdf',
    byte_size: 1000 + i,
    content_sha256: createHash('sha256').update(d.url).digest('hex'),
    checked_at: '2026-10-15T00:00:00.000Z',
    tracker_source: '',
  }));
}

/** The media run.ts `ingest` sends, in its order: gallery, swatches, description images, in-the-box pictures. */
function wantedMedia(p: ImportPayload): mirror.MediaRequest[] {
  const wanted = new Map<string, mirror.MediaRequest>();
  for (const i of p.images) if (i.source_media_id && i.source_url) wanted.set(i.source_media_id, { source_media_id: i.source_media_id, role: 'gallery', source_url: i.source_url });
  for (const s of p.swatches) if (!wanted.has(s.source_media_id)) wanted.set(s.source_media_id, { source_media_id: s.source_media_id, role: 'swatch', source_url: s.source_url });
  for (const b of p.content_blocks) if (b.kind === 'image' && b.source_media_id && !wanted.has(b.source_media_id)) wanted.set(b.source_media_id, { source_media_id: b.source_media_id, role: 'description', source_url: b.source_url });
  for (const s of p.specs) {
    if (s.key !== 'package.contents') continue;
    for (const item of s.value_list) {
      if (typeof item === 'object' && item && item.source_media_id && item.source_url && !wanted.has(item.source_media_id)) {
        wanted.set(item.source_media_id, { source_media_id: item.source_media_id, role: 'in_the_box', source_url: item.source_url });
      }
    }
  }
  return [...wanted.values()];
}

async function ingest(client: Client, sid: string, token: string, p: ImportPayload): Promise<Map<string, mirror.MediaAnswerRow>> {
  const out = new Map<string, mirror.MediaAnswerRow>();
  const pending = wantedMedia(p);
  let rounds = 0;
  while (pending.length) {
    const batch = pending.splice(0, 4);
    const rows = await client.media(sid, token, batch);
    for (const r of rows) out.set(r.source_media_id, r);
    const again = batch.filter((m) => (out.get(m.source_media_id)?.status ?? 'pending') === 'pending');
    if (again.length) {
      assert.ok(++rounds < 20, 'media keep coming back pending');
      pending.push(...again);
    }
  }
  return out;
}

// ---------------------------------------------------------------- VERIFY, through the real routes

const json = async (r: Response) => (await r.json()) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/** The structure half of §I.1.2's projection: no knowledge answer on either side (it is the knowledge route's half). */
const structural = (p: Projection): Projection => ({ ...p, swatches: [], specs: [], documents: [], relations: [], images: p.images.map((i) => ({ ...i, via_variant_id: '' })) });

/** Handles whose compare answer was COMPARE_NO_SPECS (accepted only below 3 compare keys; reported). */
const compareTolerated = new Set<string>();

interface Verified {
  evidence: Record<string, unknown>;
  knowledgeRoute: boolean;
}

type WrittenRow = { id: string; source_media_id: string; r2_key: string; sort_order: number; is_primary: boolean; option_value_id: string | null; variant_id: string | null; binding_rule: string };

async function verifyLive(w: OpsWorld, p: ImportPayload, written: mirror.WriteAnswer & { images?: WrittenRow[] }, media: Map<string, mirror.MediaAnswerRow>): Promise<Verified> {
  const checks: Record<string, { ok: boolean; hard: boolean; status?: number; counts?: Record<string, number> }> = {};
  const slug = written.slug;
  // 1. public v1
  const v1 = await w.call(`/api/public/v1/products/${encodeURIComponent(slug)}`, { token: null, protocol: null });
  const v1j = v1.status === 200 ? await json(v1) : {};
  const price = v1j.data?.price ?? {};
  checks.v1 = { ok: v1.status === 200 && price.status === 'unpriced' && price.amount === null && v1j.data?.purchase === null, hard: true, status: v1.status };
  // 2. structure: the anonymous site answer and the fingerprint
  const site = await w.call(`/api/products/${encodeURIComponent(slug)}`, { token: null, protocol: null });
  const sj = site.status === 200 ? await json(site) : {};
  const rel = sj.relations ?? sj.product?.relations ?? {};
  const live = projectionFromSite(
    {
      option_groups: (rel.option_groups ?? []).map((g: any) => ({ id: g.id, sort: g.sort, default_value_id: g.default_value_id ?? '', values: (g.values ?? []).map((v: any) => ({ id: v.id, sort: v.sort })) })), // eslint-disable-line @typescript-eslint/no-explicit-any
      variants: (rel.variants ?? []).map((v: any) => ({ id: v.id, combo_key: v.combo_key })), // eslint-disable-line @typescript-eslint/no-explicit-any
      images: (rel.images ?? []).map((i: any) => ({ id: i.id, url: i.url, is_primary: !!i.is_primary, option_value_id: i.option_value_id ?? null, variant_id: i.variant_id ?? null })), // eslint-disable-line @typescript-eslint/no-explicit-any
    },
    { swatches: [], specs: [], documents: [], relations: [] }
  );
  // The expected side: the payload, the /media results and the rows the write WROTE (§I.1.2), as the runner builds it
  // (scripts/bambu-import/gallery.ts): each the payload image of its id with the written position, primary and binding —
  // the primary moves with the content-duplicate collapse when a later copy leads.
  const byId = new Map(p.images.map((i) => [i.id, i]));
  const expectedImages = written.images
    ? written.images.map((r) => ({ ...byId.get(r.id)!, sort_order: r.sort_order, is_primary: r.is_primary, option_value_id: r.option_value_id, variant_id: r.variant_id, binding_rule: r.binding_rule }))
    : p.images;
  const expectedPayload = { ...p, images: expectedImages };
  const mediaResults = [...media.values()].filter((m) => m.status === 'stored').map((m) => ({ source_media_id: m.source_media_id, r2_key: m.r2_key }));
  const expected = projectionFromPayload(expectedPayload, mediaResults);
  const fpOk = projectionFingerprint(structural(expected)) === projectionFingerprint(structural(live));
  checks.structure = { ok: site.status === 200 && sj.price_status === 'unpriced' && (rel.variants ?? []).length === p.variants.length, hard: true, status: site.status };
  checks.fingerprint = { ok: fpOk, hard: true };
  // The knowledge half lands with step 7 (GET /api/products/:slug/knowledge); counted here when it exists.
  const k = await w.call(`/api/products/${encodeURIComponent(slug)}/knowledge`, { token: null, protocol: null });
  const knowledgeRoute = k.status === 200;
  checks.knowledge = { ok: knowledgeRoute || k.status === 404, hard: true, status: k.status };
  // 3. listing and 4. search
  const listing = await w.call(`/api/products?search=${encodeURIComponent(p.product.title_en.slice(0, 60))}&limit=48`, { token: null, protocol: null });
  const lj = listing.status === 200 ? await json(listing) : {};
  const listed = JSON.stringify(lj).includes(`"${slug}"`);
  checks.listings = { ok: listing.status === 200 && listed, hard: true, status: listing.status };
  const search = await w.call(`/api/public/v1/search?q=${encodeURIComponent(p.product.title_en.slice(0, 60))}`, { token: null, protocol: null });
  const found = search.status === 200 && JSON.stringify(await json(search)).includes(slug);
  checks.search = { ok: found, hard: true, status: search.status };
  // 5. not sellable (the request door's own eligibility is the Worker's check 10)
  checks.sellable = { ok: sj.price_status === 'unpriced' && v1j.data?.purchase === null, hard: true };
  // 6. media: every /files object of the product answers
  const files = [...new Set((rel.images ?? []).map((i: { url: string }) => i.url))] as string[];
  let failed = 0;
  for (const f of files) {
    const r = await w.call(new URL(f, 'https://levonis-iq.com').pathname, { token: null, protocol: null });
    if (r.status !== 200) failed++;
  }
  checks.media = { ok: files.length > 0 && failed === 0, hard: true, counts: { heads: files.length, failed } };
  // 11. compare
  const cmp = await w.call(`/api/compare?ids=${encodeURIComponent(written.product_id)}`, { token: null, protocol: null });
  // The runner asks 200 (scripts/bambu-import/verify.ts); the compare route answers 400 COMPARE_NO_SPECS for a
  // product with no comparable specification. Accepted here only where §I.1.11 records the absence as expected
  // for the type (fewer than 3 compare keys) — a difference this step reports for the runner (§K step 8).
  const compareKeys = new Set(p.specs.filter((s) => s.visibility === 'public' && (s.status === 'verified' || s.status === 'unverified') && specKey(s.key)?.compare).map((s) => s.key)).size;
  const cmpCode = cmp.status === 200 ? '' : String(((await cmp.clone().json().catch(() => ({}))) as { code?: unknown }).code ?? '');
  const noSpecs = cmp.status === 400 && cmpCode === 'COMPARE_NO_SPECS' && compareKeys < 3;
  if (noSpecs) compareTolerated.add(p.handle);
  checks.compare = { ok: (cmp.status === 200 && JSON.stringify(await cmp.clone().json()).includes(written.product_id)) || noSpecs, hard: true, status: cmp.status, counts: { compare_keys: compareKeys } };
  if (!written.created) checks.merge = { ok: written.before_fp_equal === true, hard: true };
  // 7. The browser's own check (scripts/bambu-import/browser.ts runs Playwright on the step-7 page; this world has no
  //    browser): recorded as the runner records it. The Worker refuses a COMPLETE without it (§I.1.7).
  (checks as Record<string, unknown>).browser = { ok: true, checks: { hero: true, gallery: true, selection: true } };
  const evidence = {
    version: 1,
    live_url: `https://levonis-iq.com/product/${slug}`,
    round: 1,
    checks,
    sections: { leaf: '', root: '', secondary: [] },
    selections_checked: [p.groups.map((g) => g.default_value_id).filter(Boolean)],
    counts: {
      groups: p.groups.length,
      values: p.groups.reduce((n, g) => n + g.values.length, 0),
      variants: p.variants.length,
      images: p.images.length,
      swatches: p.swatches.length,
      documents: p.documents.length,
      relations: p.relations.length,
      specs: p.specs.length,
    },
  };
  return { evidence, knowledgeRoute };
}

// ---------------------------------------------------------------- one item, as run.ts sequences it

interface ItemOutcome {
  state: string;
  write: mirror.WriteAnswer & { images?: WrittenRow[] };
  failedChecks: string[];
  knowledgeRoute: boolean;
}

async function runItem(w: OpsWorld, client: Client, f: Fixture): Promise<ItemOutcome> {
  const lease = await client.lease(f.sid);
  const t = lease.lease_token;
  assert.equal(lease.state, 'DISCOVERED');
  await client.event(f.sid, t, { state: 'EXTRACTING', outcome: 'start' });
  await client.event(f.sid, t, { state: 'ENRICHING', outcome: 'ok', detail: { source_fingerprint: f.payload.extraction_sha256 } });
  await client.event(f.sid, t, { state: 'VALIDATING', outcome: 'ok', detail: { documents_checked: f.payload.documents.length } });
  const checks = documentChecks(f.payload);
  const staged = await client.stage(f.sid, t, f.payload, checks);
  assert.match(staged.payload_sha256, /^[0-9a-f]{64}$/);
  assert.ok(staged.invocation_estimate > 0 && staged.invocation_estimate <= 900, `${f.handle}: estimate ${staged.invocation_estimate}`);
  await client.event(f.sid, t, { state: 'INGESTING_MEDIA', outcome: 'ok', detail: { payload_sha256: staged.payload_sha256, invocation_estimate: staged.invocation_estimate } });
  const media = await ingest(client, f.sid, t, f.payload);
  await client.event(f.sid, t, { state: 'WRITING', outcome: 'ok', detail: { stored: [...media.values()].filter((m) => m.status === 'stored').length } });
  const written = (await client.write(f.sid, t, staged.payload_sha256, f.payload, checks)) as ItemOutcome['write'];
  // The image rows the write bound (after the content-duplicate collapse), from the /write answer itself.
  written.images = (writeAnswers.get(f.sid)?.images ?? []) as ItemOutcome['write']['images'];
  assert.ok(written.images!.length > 0, `${f.handle}: the write answer names its image rows`);
  const finished = await client.publishFinish(f.sid, t);
  assert.equal(finished.state, 'VERIFYING_LIVE');
  const rb = await client.readback(f.sid);
  assert.equal(rb.ok, true, `${f.handle}: readback ${JSON.stringify(rb.raw)}`);
  const { evidence, knowledgeRoute } = await verifyLive(w, f.payload, written, media);
  const done = await client.complete(f.sid, t, String(evidence.live_url), evidence);
  const failedChecks = Object.entries(evidence.checks as Record<string, { ok: boolean }>).filter(([, c]) => !c.ok).map(([k]) => k);
  return { state: done.state, write: written, failedChecks: [...failedChecks, ...(((done.d1_checks as { agreement?: { failed?: string[] } }).agreement?.failed) ?? [])], knowledgeRoute };
}

/** Every row of the import's tables and the catalogue: a re-run must leave this identical. */
function snapshot(w: OpsWorld): Record<string, number> {
  const out: Record<string, number> = {};
  for (const t of [
    'products', 'product_option_groups', 'product_option_values', 'product_variants', 'product_images', 'product_catalogs', 'product_source_refs',
    'product_spec_values', 'product_documents', 'product_relations', 'product_external_ids', 'product_option_value_swatches', 'product_translations',
    'search_tokens', 'catalog_import_items', 'catalog_import_events', 'catalog_import_media', 'catalog_import_conflicts', 'catalogs', 'brands', 'search_synonyms',
  ]) {
    out[t] = Number((w.raw.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n);
  }
  return out;
}

// ---------------------------------------------------------------- the run

test('the eight samples through the real app with the runner\'s client: COMPLETE, fingerprints equal, a full re-run writes nothing, the run closes', async () => {
  const w = opsWorld();
  const fx = fixtures();
  const texts = textsFor(fx.map((f) => f.row));
  setBundle(texts);
  openRun(w.raw);
  installCdnDouble(w);
  const client = await clientFor(w);
  console.log(`catalogImportE2E: the runner client is ${clientSource === 'mirror' ? 'the mirror (tests/fixtures/opsClientMirror.ts)' : clientSource}`);

  // open (run.ts `open`)
  const hello = await client.hello();
  assert.equal(hello.protocol, 2);
  assert.deepEqual(hello.migrations_present, { '0193': true, '0194': true, '0195': true });
  const local: Record<string, string> = {};
  for (const [file, text] of Object.entries({
    'manifest.json': texts.manifest, 'taxonomy-map.json': texts.taxonomyMap, 'existing-matches.json': texts.existingMatches, 'compat-targets.json': texts.compatTargets,
    'identity-map.json': texts.identityMap, 'media-overrides.json': texts.mediaOverrides, 'curated/index.json': texts.curatedIndex, 'search-synonyms.json': texts.searchSynonyms,
  })) local[file] = createHash('sha256').update(text).digest('hex');
  assert.deepEqual(hello.reviewed, local, 'the runner compares these byte for byte');
  const stored = (w.raw.prepare('SELECT reviewed_bundle_sha256 AS d, github_run_id AS g FROM catalog_import_runs').get() as { d: string; g: string });
  assert.equal(stored.d, reviewedBundleDigest(local), 'the run stores the runner\'s combined digest');
  assert.equal(stored.g, '987654321');
  const at = new Date().toISOString();
  assert.equal((await client.manifest(fx.map((f) => manifestRequestRow(f.row, at)))).accepted, fx.length);
  const tax = await client.prepareTaxonomy();
  assert.ok(tax.created_nodes > 0 && tax.brand_created && tax.synonyms_inserted > 0);
  assert.deepEqual(await client.prepareTaxonomy(), { created_nodes: 0, brand_created: false, synonyms_inserted: 0 }, 'insert-only: a second call adds nothing');
  const before = await client.protectSnapshot('before');
  assert.ok(before.subjects > 10);

  // the queue (run.ts `runQueue`)
  const outcomes: Array<{ handle: string; o: ItemOutcome }> = [];
  for (;;) {
    const st = await client.status();
    const ref = st.current ?? st.next;
    if (!ref) break;
    const f = fx.find((x) => x.sid === ref.source_product_id)!;
    assert.ok(f, 'the status names a manifest item');
    const o = await runItem(w, client, f);
    outcomes.push({ handle: f.handle, o });
    assert.equal(o.state, 'COMPLETE', `${f.handle}: not COMPLETE, failed ${JSON.stringify(o.failedChecks)}`);
  }
  assert.equal(outcomes.length, fx.length);
  for (const { handle, o } of outcomes) {
    assert.deepEqual(o.failedChecks, [], `${handle}: failed checks`);
    assert.equal(o.state, 'COMPLETE', handle);
    assert.equal(o.write.created, true);
    assert.equal(o.write.after_money_default, true);
  }
  const counts = (w.raw.prepare("SELECT processing_state AS s, COUNT(*) AS n FROM catalog_import_items GROUP BY 1").all() as Array<{ s: string; n: number }>).map((r) => `${r.s}:${r.n}`);
  assert.deepEqual(counts, [`COMPLETE:${fx.length}`]);
  // Money: price 0, no cost, stock or package; the stock decision not configured; no request row.
  const bad = w.raw.prepare("SELECT COUNT(*) AS n FROM products WHERE price_iqd <> 0 OR product_cost_iqd IS NOT NULL OR stock IS NOT NULL OR package_weight_g IS NOT NULL").get() as { n: number };
  assert.equal(Number(bad.n), 0);
  assert.equal(Number((w.raw.prepare("SELECT COUNT(*) AS n FROM product_source_refs WHERE stock_decision <> 'not_configured'").get() as { n: number }).n), 0);
  assert.equal(Number((w.raw.prepare('SELECT COUNT(*) AS n FROM product_price_requests').get() as { n: number }).n), 0);
  // A dead document link is stored inactive (never shown).
  assert.ok(Number((w.raw.prepare('SELECT COUNT(*) AS n FROM product_documents WHERE active = 0 AND check_status = 404').get() as { n: number }).n) > 0);
  // Only store.bblcdn.com was asked, never another host.
  assert.deepEqual(w.cdn.refused, []);
  assert.ok(w.cdn.served.length > 50);

  // A full re-run: the status names nothing, a lease of a finished item takes nothing, /media fetches nothing.
  const rows = snapshot(w);
  const served = w.cdn.served.length;
  const st = await client.status();
  assert.equal(st.current, null);
  assert.equal(st.next, null);
  for (const f of fx) {
    const l = await client.lease(f.sid);
    assert.equal(l.state, 'COMPLETE');
    assert.equal(l.lease_token, '');
  }
  assert.deepEqual(snapshot(w), rows, 'a full re-run writes zero rows');
  assert.equal(w.cdn.served.length, served);

  // close (run.ts `close`)
  const afterSnap = await client.protectSnapshot('after');
  assert.equal(afterSnap.changed, 0, 'no pre-existing product and no global counter changed');
  assert.equal((await client.finish()).state, 'closed');
  await assert.rejects(() => client.hello(), (e: unknown) => e instanceof Error && (e as { kind?: string }).kind === 'gone', '/hello answers the uniform 404 after the close');
  console.log(`catalogImportE2E: compare answered COMPARE_NO_SPECS for ${[...compareTolerated].join(', ') || 'none'}`);
  const knowledge = outcomes.some(({ o }) => o.knowledgeRoute);
  console.log(`catalogImportE2E: knowledge route ${knowledge ? 'present: its half of the fingerprint was compared' : 'not on this branch (step 7 adds it): the structural half of the fingerprint was compared'}`);
});

test('a block after the write hides the created product and the resume puts it back; DEADLINE_EXIT never counts; stored media are never fetched again', async () => {
  const w = opsWorld();
  const fx = fixtures().filter((f) => f.handle === 'ams-2-pro-feeder-unit');
  setBundle(textsFor(fx.map((f) => ({ ...f.row, queue_position: 1 }))));
  openRun(w.raw);
  installCdnDouble(w);
  const client = await clientFor(w);
  await client.hello();
  await client.manifest(fx.map((f) => manifestRequestRow({ ...f.row, queue_position: 1 }, new Date().toISOString())));
  await client.prepareTaxonomy();
  const f = fx[0];
  let t = (await client.lease(f.sid)).lease_token;
  await client.event(f.sid, t, { state: 'EXTRACTING', outcome: 'start' });
  await client.event(f.sid, t, { state: 'ENRICHING', outcome: 'ok' });
  await client.event(f.sid, t, { state: 'VALIDATING', outcome: 'ok' });
  const staged = await client.stage(f.sid, t, f.payload, []);
  await client.event(f.sid, t, { state: 'INGESTING_MEDIA', outcome: 'ok' });
  const media = await ingest(client, f.sid, t, f.payload);
  const served = w.cdn.served.length;
  // Asked again (a resumed runner learning the keys): nothing fetched, the same keys.
  const again = await ingest(client, f.sid, t, f.payload);
  assert.equal(w.cdn.served.length, served, 'a stored medium whose object HEADs is never fetched again');
  assert.deepEqual([...again.values()].map((m) => m.r2_key), [...media.values()].map((m) => m.r2_key));
  // A transient retry counts; the deadline park does not.
  const r1 = await client.event(f.sid, t, { state: 'RETRYING', outcome: 'retry', code: 'MEDIA_TIMEOUT', retry_at: new Date(Date.now() + 30_000).toISOString() });
  assert.equal(r1.stage_attempts, 1);
  await client.event(f.sid, t, { state: 'INGESTING_MEDIA', outcome: 'resume' });
  const parked = await client.event(f.sid, t, { state: 'RETRYING', outcome: 'retry', code: 'DEADLINE_EXIT', retry_at: new Date().toISOString(), release: true });
  assert.equal(parked.stage_attempts, 1, 'DEADLINE_EXIT never counts toward stage_attempts');
  // The released lease is gone; the next job leases again and resumes.
  await assert.rejects(() => client.event(f.sid, t, { state: 'INGESTING_MEDIA', outcome: 'resume' }), (e: unknown) => (e as { kind?: string }).kind === 'stale');
  const next = await client.lease(f.sid);
  assert.notEqual(next.lease_token, t);
  assert.equal(next.state, 'RETRYING');
  t = next.lease_token;
  await client.event(f.sid, t, { state: 'INGESTING_MEDIA', outcome: 'resume' });
  const toWrite = await client.event(f.sid, t, { state: 'WRITING', outcome: 'ok' });
  assert.equal(toWrite.stage_attempts, 0, 'a completed stage starts the count again');
  const written = await client.write(f.sid, t, staged.payload_sha256, f.payload, []);
  await client.publishFinish(f.sid, t);
  const status = () => (w.raw.prepare('SELECT status FROM products WHERE id = ?').get(written.product_id) as { status: string }).status;
  assert.equal(status(), 'active');
  // Blocked after WRITTEN: hidden in the same call, flagged, the run blocked.
  const blocked = await client.event(f.sid, t, { state: 'BLOCKED', outcome: 'blocked', code: 'VERIFY_FAILED_PERSISTENT' });
  assert.equal(blocked.state, 'BLOCKED');
  assert.equal(status(), 'hidden');
  const item = () => w.raw.prepare('SELECT unpublished_on_block AS f, blocker_code AS b, resume_instruction AS r FROM catalog_import_items').get() as { f: number; b: string; r: string };
  assert.equal(item().f, 1);
  assert.equal(item().b, 'VERIFY_FAILED_PERSISTENT');
  assert.match(item().r, /workflow 60/);
  assert.equal((w.raw.prepare('SELECT state FROM catalog_import_runs').get() as { state: string }).state, 'blocked');
  // Resume (workflow 60 resume=true): straight into VERIFYING_LIVE, the product back in the same batch.
  const l = await client.lease(f.sid, t);
  assert.equal(l.state, 'BLOCKED');
  assert.equal(l.blocker_code, 'VERIFY_FAILED_PERSISTENT');
  const resumed = await client.event(f.sid, l.lease_token, { state: 'VERIFYING_LIVE', outcome: 'resume' });
  assert.equal(resumed.state, 'VERIFYING_LIVE');
  assert.equal(status(), 'active');
  assert.equal(item().f, 0);
  const stages = (w.raw.prepare('SELECT stage FROM catalog_import_events ORDER BY seq').all() as Array<{ stage: string }>).map((e) => e.stage);
  assert.ok(stages.includes('UNPUBLISHED') && stages.includes('REPUBLISHED'));
  // And it completes, from the rows the write RECORDED (stage_data.images on the lease): what a runner resumed in a
  // later job, with no /write answer, verifies against.
  const rows = (l.stage_data as { images?: WrittenRow[] }).images;
  assert.ok(rows && rows.length > 0, 'the written rows come back with the lease');
  assert.deepEqual(rows, writeAnswers.get(f.sid)?.images, 'the same rows the /write answer named');
  const { evidence } = await verifyLive(w, f.payload, { ...written, images: rows }, media);
  const done = await client.complete(f.sid, l.lease_token, String(evidence.live_url), evidence);
  assert.equal(done.state, 'COMPLETE');
});

test('a collapse that hands the primary on: the hotend\'s general lead picture is the same file as its 0.4 mm hero — verified against the written rows', async () => {
  const w = opsWorld();
  const fx = fixtures().filter((f) => f.handle === 'bambu-hotend-a1-a2');
  setBundle(textsFor(fx.map((f) => ({ ...f.row, queue_position: 1 }))));
  openRun(w.raw);
  const lead = fx[0].payload.images.find((i) => i.sort_order === 0)!;
  const hero = fx[0].payload.images.find((i) => i.sort_order === 2)!;
  assert.ok(lead.is_primary && lead.binding_rule === 'general' && hero.option_value_id);
  // The store serves the hero's bytes under the lead's name (a re-upload): one content-addressed object.
  installCdnDouble(w, { bytesOf: (url) => (url === lead.source_url ? hero.source_url : url) });
  try {
    const client = await clientFor(w);
    await client.hello();
    await client.manifest(fx.map((f) => manifestRequestRow({ ...f.row, queue_position: 1 }, new Date().toISOString())));
    await client.prepareTaxonomy();
    const o = await runItem(w, client, fx[0]);
    assert.deepEqual(o.failedChecks, []);
    assert.equal(o.state, 'COMPLETE');
    const primary = o.write.images!.find((i) => i.is_primary)!;
    assert.notEqual(primary.id, lead.id, 'the payload\'s primary was collapsed away: the primary moved to the hero copy');
    assert.equal(o.write.images!.length, fx[0].payload.images.length - 1);
  } finally {
    restoreFetch();
  }
});

// ---------------------------------------------------------------- the runner's own VERIFY over the real routes

/**
 * One item as run.ts sequences it, VERIFIED BY THE RUNNER'S OWN CODE: scripts/bambu-import/verify.ts `verifyPublic`
 * reads the real public routes of this app — the v1 product, the anonymous structure answer, step 7's
 * /api/products/<slug>/knowledge (fact by fact against the route's own assembly of the payload), the listings and
 * the tree, search, the quote and the request door, every /files object, compare — and its `edgeEvidence` is what
 * /complete judges. The browser has no place in-process: its part is recorded as the runner records a passing one.
 */
async function runItemVerifiedByRunner(w: OpsWorld, client: Client, f: Fixture, texts: ReviewedTexts, titles: string[]): Promise<{ outcome: VerifyOutcome; done: { state: string; d1_checks: Record<string, unknown> } }> {
  const lease = await client.lease(f.sid);
  const t = lease.lease_token;
  await client.event(f.sid, t, { state: 'EXTRACTING', outcome: 'start' });
  await client.event(f.sid, t, { state: 'ENRICHING', outcome: 'ok', detail: { source_fingerprint: f.payload.extraction_sha256 } });
  await client.event(f.sid, t, { state: 'VALIDATING', outcome: 'ok', detail: { documents_checked: f.payload.documents.length } });
  const checks = documentChecks(f.payload);
  const staged = await client.stage(f.sid, t, f.payload, checks);
  await client.event(f.sid, t, { state: 'INGESTING_MEDIA', outcome: 'ok', detail: { payload_sha256: staged.payload_sha256, invocation_estimate: staged.invocation_estimate } });
  const media = await ingest(client, f.sid, t, f.payload);
  await client.event(f.sid, t, { state: 'WRITING', outcome: 'ok', detail: { stored: [...media.values()].filter((m) => m.status === 'stored').length } });
  const written = await client.write(f.sid, t, staged.payload_sha256, f.payload, checks);
  const rows = (writeAnswers.get(f.sid)?.images ?? []) as WrittenImage[];
  assert.equal((await client.publishFinish(f.sid, t)).state, 'VERIFYING_LIVE');
  // The runner's site reader, spaced on a clock that does not sleep, through this app.
  let now = Date.now();
  const fakeClock = { now: () => now, sleep: async (ms: number) => void (now += ms) };
  const fetcher = new HostFetcher({ fetch: (url, init) => w.fetch(url, init), clock: fakeClock, deadline: new RunnerDeadline(now + 6 * 3600_000, fakeClock), siteOrigin: 'https://levonis-iq.com' });
  const site = new Site('https://levonis-iq.com', fetcher, () => 0);
  const runnerMedia = media as unknown as Map<string, MediaAnswerRow>;
  const gallery = writtenGallery(f.payload, runnerMedia, { rows, source: 'write' });
  const outcome = await verifyPublic(site, {
    payload: f.payload,
    productId: written.product_id,
    slug: written.slug,
    media: runnerMedia,
    images: gallery.images,
    documentChecks: checks as unknown as RunnerDocumentCheck[],
    leaf: String(f.row.leaf ?? ''),
    also: (f.row.also as string[]) ?? [],
    taxonomy: JSON.parse(texts.taxonomyMap) as Record<string, unknown>,
    modelCodes: modelCodesOf(f.payload.product.title_en, titles),
    merge: null,
    readback: async () => {
      const rb = await client.readback(f.sid);
      return { ok: rb.ok, mismatches: rb.mismatches };
    },
  });
  const browser = { ok: true, checks: { image_decodes: true, image_contain: true, selection_images: true }, counts: { values_checked: 1 }, selections: [], not_applicable: { ...NOT_APPLICABLE } };
  const liveUrl = `https://levonis-iq.com/product/${written.slug}`;
  const done = await client.complete(f.sid, t, liveUrl, edgeEvidence(outcome, browser, liveUrl, f.payload, 1));
  return { outcome, done };
}

test('the runner\'s own VERIFY over the real routes (§I.1): H2D, PLA Basic and a collapsed hotend — every check passes, /knowledge fact by fact, COMPLETE on its evidence', async () => {
  const w = opsWorld();
  const fx = fixtures()
    .filter((f) => ['h2d', 'pla-basic-filament', 'bambu-hotend-a1-a2'].includes(f.handle))
    .map((f, i) => ({ ...f, row: { ...f.row, queue_position: i + 1 } }));
  const texts = textsFor(fx.map((f) => f.row));
  setBundle(texts);
  openRun(w.raw);
  // The hotend's general lead is the same file as its 0.4 mm hero: the writer collapses it (§C.4 step 1).
  const hotend = fx.find((f) => f.handle === 'bambu-hotend-a1-a2')!.payload;
  const lead = hotend.images.find((i) => i.sort_order === 0)!;
  const hero = hotend.images.find((i) => i.sort_order === 2)!;
  installCdnDouble(w, { bytesOf: (url) => (url === lead.source_url ? hero.source_url : url) });
  try {
    const client = await clientFor(w);
    await client.hello();
    await client.manifest(fx.map((f) => manifestRequestRow(f.row, new Date().toISOString())));
    await client.prepareTaxonomy();
    const titles = fx.map((f) => f.payload.product.title_en);
    for (;;) {
      const st = await client.status();
      const ref = st.current ?? st.next;
      if (!ref) break;
      const f = fx.find((x) => x.sid === ref.source_product_id)!;
      const { outcome, done } = await runItemVerifiedByRunner(w, client, f, texts, titles);
      const line = Object.entries(outcome.checks)
        .map(([name, c]) => `${name} ${c.ok ? 'ok' : 'FAILED'}${c.status ? ` (${c.status})` : ''}`)
        .join(', ');
      console.log(`catalogImportE2E runner VERIFY ${f.handle}: ${line}; knowledge ${JSON.stringify(outcome.checks.knowledge.counts)}; compare ${JSON.stringify(outcome.checks.compare.detail)}`);
      for (const [name, c] of Object.entries(outcome.checks)) assert.ok(c.ok || !c.hard, `${f.handle}: ${name} ${JSON.stringify({ status: c.status, counts: c.counts, detail: name === 'fingerprint' ? undefined : c.detail })}`);
      assert.equal(outcome.ok, true, f.handle);
      for (const part of ['rows', 'box', 'documents', 'relations', 'swatches']) assert.equal(outcome.checks.knowledge.counts?.[`mismatched_${part}`], 0, `${f.handle}: /knowledge ${part}`);
      assert.equal(outcome.checks.fingerprint.ok, true, `${f.handle}: the public fingerprint, its knowledge half included`);
      assert.equal(done.state, 'COMPLETE', `${f.handle}: ${JSON.stringify(done.d1_checks)}`);
    }
    assert.deepEqual(
      (w.raw.prepare('SELECT processing_state AS s, COUNT(*) AS n FROM catalog_import_items GROUP BY 1').all() as Array<{ s: string; n: number }>).map((r) => `${r.s}:${r.n}`),
      ['COMPLETE:3']
    );
    // The collapse happened, and VERIFY expected the rows the writer wrote.
    const pid = hotend.product_id;
    assert.equal(Number((w.raw.prepare('SELECT COUNT(*) AS n FROM product_images WHERE product_id = ?').get(pid) as { n: number }).n), hotend.images.length - 1);
  } finally {
    restoreFetch();
  }
});

test('with no open run every ops path is the uniform 404', async () => {
  const w = opsWorld();
  setBundle(textsFor([]));
  const paths = ['/hello', '/manifest', '/items/1/lease', '/items/1/event', '/items/1/stage', '/items/1/media', '/items/1/write', '/items/1/publish-finish', '/items/1/complete', '/items/1/withdraw', '/run/prepare-taxonomy', '/run/protect-snapshot', '/run/finish'];
  for (const p of paths) {
    const r = await w.call(`${OPS}${p}`, { body: {} });
    assert.equal(r.status, 404, p);
    assert.deepEqual(await r.json(), { error: 'Not found' }, p);
  }
  for (const p of ['/items/1/readback', '/run/status']) {
    const r = await w.call(`${OPS}${p}`);
    assert.equal(r.status, 404, p);
    assert.deepEqual(await r.json(), { error: 'Not found' }, p);
  }
});

test('the owner\'s dashboard API reads the run from D1: counts, the item\'s records, report.json and report.csv; no one else reads it', async () => {
  const w = opsWorld();
  const fx = fixtures().filter((f) => f.handle === 'bambu-hotend-a1-a2').map((f) => ({ ...f, row: { ...f.row, queue_position: 1 } }));
  setBundle(textsFor(fx.map((f) => f.row)));
  const runId = openRun(w.raw);
  installCdnDouble(w);
  const client = await clientFor(w);
  await client.hello();
  await client.manifest(fx.map((f) => manifestRequestRow(f.row, new Date().toISOString())));
  await client.prepareTaxonomy();
  const o = await runItem(w, client, fx[0]);
  assert.equal(o.state, 'COMPLETE', JSON.stringify(o.failedChecks));
  const owner: Parameters<OpsWorld['call']>[1] = { token: null, protocol: null, cookie: `levonis_session=${OWNER_SESSION}` };
  const base = '/api/admin/catalog-import';
  const get = async (path: string, as: Parameters<OpsWorld['call']>[1] = owner) => {
    const r = await w.call(`${base}${path}`, as);
    return { status: r.status, text: await r.text(), type: r.headers.get('content-type') ?? '', cache: r.headers.get('cache-control') ?? '' };
  };
  const runs = await get('/runs');
  assert.equal(runs.status, 200);
  const list = JSON.parse(runs.text) as { runs: Array<{ id: string; counts: Record<string, number> }> };
  assert.equal(list.runs[0].id, runId);
  assert.deepEqual(list.runs[0].counts, { COMPLETE: 1 });
  const one = JSON.parse((await get(`/runs/${runId}`)).text) as { progress: Record<string, unknown>; last_verified_url: string; rate: { estimate: boolean; stages: Record<string, { n: number; median_s: number | null }> } };
  assert.equal(one.rate.stages.EXTRACTING.n, 1, 'one measured EXTRACTING span');
  assert.ok(one.rate.stages.VERIFYING_LIVE.n >= 1 && one.rate.stages.VERIFYING_LIVE.median_s !== null);
  assert.equal(one.progress.complete_count, 1);
  assert.equal(one.progress.created_count, 1);
  assert.match(one.last_verified_url, /^https:\/\/levonis-iq\.com\/product\//);
  assert.equal(one.rate.estimate, true);
  const items = JSON.parse((await get(`/runs/${runId}/items?state=COMPLETE&q=${encodeURIComponent('hotend')}`)).text) as { items: Array<{ id: string }>; next_cursor: number | null };
  assert.equal(items.items.length, 1);
  assert.equal(items.next_cursor, null);
  assert.equal((JSON.parse((await get(`/runs/${runId}/items?q=${encodeURIComponent('٪_no_such')}`)).text) as { items: unknown[] }).items.length, 0);
  const item = JSON.parse((await get(`/items/${items.items[0].id}`)).text) as { item: Record<string, any>; events: unknown[]; media: unknown[] }; // eslint-disable-line @typescript-eslint/no-explicit-any
  assert.equal(item.item.state, 'COMPLETE');
  assert.equal(item.item.d1_checks.ok, true);
  assert.equal(item.item.edge_evidence.version, 1);
  assert.ok(item.events.length >= 8 && item.media.length > 0);
  const json = await get(`/runs/${runId}/report.json`);
  assert.equal(json.status, 200);
  assert.match(json.type, /application\/json/);
  assert.equal(json.cache, 'private, no-store');
  const report = JSON.parse(json.text) as { items: Array<Record<string, unknown>>; progress: Record<string, unknown> };
  assert.equal(report.items.length, 1);
  assert.equal(report.items[0].state, 'COMPLETE');
  const csv = await get(`/runs/${runId}/report.csv`);
  assert.match(csv.type, /text\/csv/);
  const lines = csv.text.trim().split('\n');
  assert.equal(lines.length, 2);
  assert.match(lines[0], /^queue_position,source_product_id,handle,state,/);
  assert.equal(lines[0].split(',').length, lines[1].split(',').length, 'every column has its cell');
  assert.match(lines[1], /,(product|value|variant|color):\d+/, 'the image bindings by rule');
  // Nothing private in any answer: no token hash, no lease, no protected digest, no source URL.
  for (const t of [runs.text, json.text, csv.text, JSON.stringify(item)]) {
    assert.doesNotMatch(t, /token_sha256|lease_token|lse_|digest|bblcdn|us\.store\.bambulab\.com|price_iqd|cost/);
  }
  // A customer and an anonymous caller are refused, with nothing of the run.
  for (const as of [{ token: null, protocol: null, cookie: `levonis_session=${CUSTOMER_SESSION}` }, { token: null, protocol: null }]) {
    const r = await get('/runs', as);
    assert.ok(r.status === 401 || r.status === 403, String(r.status));
    assert.ok(!r.text.includes(runId));
  }
});
