/**
 * VERIFY: THE PUBLIC SITE IS THE WITNESS OF COMPLETE (Bambu import spec §I.1).
 *
 * The runner reads the LIVE public site — never the payload it just sent —
 * anonymously, at ≤ 4 requests per second, and records each check's evidence
 * (HTTP status, counts, public URLs) in `edge_evidence`. The Worker recomputes
 * the D1 side at `/complete` (check 10) and accepts COMPLETE only when both
 * sides pass and agree.
 *
 *   1  public v1      GET /api/public/v1/products/<slug>: 200, the name, the
 *                     sections, the distinct image count, price unpriced/null,
 *                     purchase null;
 *   2  structure      GET /api/products/<slug> (anonymous): price_status
 *                     unpriced; option groups (ids, order, labels, defaults),
 *                     variants (combo keys, nothing extra), images (bindings,
 *                     the primary, /files/…webp), swatches;
 *                     GET /api/products/<slug>/knowledge: counts by status and
 *                     region, documents, relations, in-the-box; and the public
 *                     fingerprint (fingerprint.ts) of both answers;
 *   3  listings       GET /api/products?category=<slug>&search=<title> for the
 *                     leaf, its root and each secondary membership (the next
 *                     page while a page is full); the leaf is the reviewed
 *                     map's (a mapped leaf the tree does not name fails); the
 *                     tree count of the leaf ≥ 1;
 *   4  search         GET /api/public/v1/search?q=…: the exact title (hard), each
 *                     model code (hard when unique to the product), each
 *                     searchable external id (hard);
 *   5  not sellable   POST /api/products/<slug>/quote → 409 PRICE_NOT_AVAILABLE;
 *                     POST /api/price-requests signed out → 401 (smoke);
 *   6  media          HEAD every /files/<key> → 200 image/webp; the ops readback;
 *   7  browser        browser.ts (Playwright, the site only);
 *   8  merge          before_fp_equal from /write;
 *   11 compare        GET /api/compare?ids=<id> → 200 with the card; the
 *                     candidates when the type has ≥ 3 compare keys with values.
 *
 * WHAT THE PUBLIC SITE CAN SHOW. A document whose ENRICH check found it dead
 * is stored inactive and never shown (§C.7, §G.2): it is not expected. A
 * relation's state moves when its target is written (pending → resolved,
 * §B.6), so the public projection leaves the state out, as it leaves out the
 * target. A MERGE keeps the existing product's name, price, groups, values,
 * variants and images (§E.2): its checks are the appended images present
 * (bound through the reviewed value map, so by URL), the knowledge answer
 * present, the listings and search through the search alias, the request door,
 * the media and the compare card — the counts (a scoped row lands only where
 * the value map names the option) and the D1 side are the Worker's recompute
 * against what the write recorded (§I.1.10).
 *
 * Answer shapes are read as documented: the v1 product DTO
 * (worker/lib/publicApi/resources/products.ts), publicRelations
 * (worker/lib/productOverlay.ts), the knowledge answer of spec §G.1, the
 * listing (`products`, `total`, `truncated`) and the tree (`roots` of nodes
 * with `id`, `slug`, `name_*`, `product_count`, `children`).
 */
import { mediaPath, projectionFingerprint, type Projection } from '@levonis/catalog/bambuImport/fingerprint';
import { modelsInText } from '@levonis/catalog/bambuImport/registry/models';
import { specKey } from '@levonis/catalog/bambuImport/registry/specKeys';
import type { ImportPayload } from '@levonis/catalog/bambuImport/payload';
import { CACHE_WAIT_MAX, VERIFY_AFTER_CACHE_WAIT } from './deadline';
import { HostFetcher, ImportStop } from './fetch';
import type { DocumentCheck, MediaAnswerRow } from './opsClient';
import { pageDefaultSelection } from './selection';

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => !!v && typeof v === 'object' && !Array.isArray(v);
const list = (v: unknown): Rec[] => (Array.isArray(v) ? v.filter(isRec) : []);
const str = (v: unknown) => (typeof v === 'string' ? v : '');

export interface SiteAnswer {
  status: number;
  json: Rec | null;
  headers: Headers;
}

/** The public site, read anonymously through the spaced HostFetcher. */
export class Site {
  constructor(
    readonly origin: string,
    private readonly fetcher: HostFetcher,
    private readonly afterMs: () => number
  ) {}

  url(path: string): string {
    return `${this.origin.replace(/\/+$/, '')}${path}`;
  }

  async read(method: 'GET' | 'POST' | 'HEAD', path: string, body?: Rec): Promise<SiteAnswer> {
    const res = await this.fetcher.request(
      this.url(path),
      {
        method,
        redirect: 'manual',
        headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        maxBytes: 8 * 1024 * 1024,
      },
      this.afterMs()
    );
    let json: Rec | null = null;
    if (res.body) {
      try {
        const parsed: unknown = JSON.parse(res.body);
        json = isRec(parsed) ? parsed : null;
      } catch {
        json = null;
      }
    }
    return { status: res.status, json, headers: res.headers };
  }
}

export interface CheckResult {
  ok: boolean;
  hard: boolean;
  status?: number;
  counts?: Record<string, number>;
  detail?: Record<string, unknown>;
}

export interface VerifyContext {
  payload: ImportPayload;
  productId: string;
  slug: string;
  /** source_media_id → what /media stored. */
  media: ReadonlyMap<string, MediaAnswerRow>;
  /** ENRICH's document checks (sent with /write): a dead document is stored inactive and never shown. */
  documentChecks?: readonly DocumentCheck[];
  /** The taxonomy entry the leaf resolves from (`@key` of taxonomy-map `create`, or a catalog id). */
  leaf: string;
  /** Secondary memberships (`also`), same notation. */
  also: readonly string[];
  taxonomy: Rec;
  /** Model tokens of the title with whether the token is unique to this product in the manifest. */
  modelCodes: ReadonlyArray<{ code: string; unique: boolean }>;
  /** For a merge: the protected-fields equality and where the runner has it from (run.ts mergeEvidence). */
  merge: { before_fp_equal: boolean | null; source?: string } | null;
  readback: () => Promise<{ ok: boolean; mismatches: number }>;
}

export interface VerifyOutcome {
  ok: boolean;
  checks: Record<string, CheckResult>;
  /** The breadcrumb name of the leaf in Arabic (the browser check), when the tree gave it. */
  leafName: string;
  /** Section slugs the listings were checked under. */
  sections: { leaf: string; root: string; secondary: string[] };
  /** The longest s-maxage seen on a failing answer (the cache rule), in ms. */
  cacheMs: number;
}

// ------------------------------------------------------------------ expectations

/** Owner-only keys never reach /knowledge, whatever a row's visibility says (CBM, warranty notes). */
export function isPublicSpec(s: { key: string; group: string; visibility: string }): boolean {
  if (s.visibility !== 'public') return false;
  if (specKey(s.key)?.ownerOnly) return false;
  if (s.group === 'manufacturer_terms' || s.key.startsWith('manufacturer_terms.')) return false;
  return !/volume_m3|(^|[._])cbm($|[._])/i.test(s.key);
}

const tally = (xs: readonly string[]) => xs.reduce<Record<string, number>>((m, x) => ((m[x] = (m[x] ?? 0) + 1), m), {});
const sameTally = (a: Record<string, number>, b: Record<string, number>) => {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) if ((a[k] ?? 0) !== (b[k] ?? 0)) return false;
  return true;
};

export function bindingOf(i: { option_value_id: string | null; variant_id: string | null }): 'value' | 'variant' | 'general' {
  return i.variant_id ? 'variant' : i.option_value_id ? 'value' : 'general';
}

/** The Worker's rule (writer.ts documentAlive): a document answered 2xx/3xx is shown; one with no check stays active. */
export function documentShown(doc: { id: string }, checks: readonly DocumentCheck[]): boolean {
  const c = checks.find((k) => k.document_id === doc.id);
  return !c || (c.check_status >= 200 && c.check_status < 400);
}

/** The facts the public answers must show, from the payload, the stored media and the document checks. */
export function expectedFacts(payload: ImportPayload, media: ReadonlyMap<string, MediaAnswerRow>, documentChecks: readonly DocumentCheck[] = []) {
  const stored = (id: string) => {
    const m = media.get(id);
    return m && m.status === 'stored' && m.r2_key ? `/files/${m.r2_key}` : '';
  };
  const images = payload.images.filter((i) => stored(i.source_media_id));
  const publicSpecs = payload.specs.filter(isPublicSpec);
  const shownDocuments = payload.documents.filter((d) => documentShown(d, documentChecks));
  const box = publicSpecs.filter((s) => s.key === 'package.contents');
  return {
    groups: payload.groups.map((g) => ({ id: g.id, sort: g.sort, name_en: g.name_en, default_value_id: g.default_value_id, values: g.values.map((v) => v.id) })),
    comboKeys: payload.variants.map((v) => v.combo_key).sort(),
    images,
    imageUrls: images.map((i) => stored(i.source_media_id)),
    distinctImages: new Set(images.map((i) => stored(i.source_media_id))).size,
    bindings: tally(images.map((i) => bindingOf(i))),
    primaryId: images.find((i) => i.is_primary)?.id ?? '',
    swatches: payload.swatches.filter((s) => stored(s.source_media_id)).map((s) => ({ value_id: s.value_id, url: stored(s.source_media_id) })),
    specsByStatus: tally(publicSpecs.filter((s) => s.key !== 'package.contents').map((s) => s.status)),
    specsByRegion: tally(publicSpecs.filter((s) => s.key !== 'package.contents' && s.region).map((s) => s.region)),
    documents: shownDocuments.length,
    relations: payload.relations.length,
    inTheBox: box.reduce((n, s) => n + s.value_list.length, 0),
    files: [
      ...new Set([
        ...images.map((i) => stored(i.source_media_id)),
        ...payload.swatches.map((s) => stored(s.source_media_id)),
        ...box.flatMap((s) => s.value_list.flatMap((x) => (isRec(x) && typeof x.source_media_id === 'string' && x.source_media_id ? [stored(x.source_media_id)] : []))),
      ]),
    ].filter(Boolean),
    projection: reducedProjection({
      groups: payload.groups.map((g) => ({ id: g.id, sort: g.sort, default_value_id: g.default_value_id, values: g.values.map((v) => ({ id: v.id, sort: v.sort })) })),
      variants: payload.variants.map((v) => ({ id: v.id, combo_key: v.combo_key })),
      images: images.map((i) => ({ id: i.id, url: stored(i.source_media_id), is_primary: i.is_primary, option_value_id: i.option_value_id ?? '', variant_id: i.variant_id ?? '', via_variant_id: i.via_variant_id ?? '' })),
      swatches: payload.swatches.filter((s) => stored(s.source_media_id)).map((s) => ({ value_id: s.value_id, url: stored(s.source_media_id) })),
      specs: publicSpecs
        .filter((s) => s.key !== 'package.contents')
        .map((s) => ({ key: s.key, scope_kind: s.scope_kind, scope_id: s.scope_id, region: s.region, status: s.status, unit: s.unit, value_num: s.value_num })),
      documents: shownDocuments.map((d) => ({ kind: d.kind, url: d.url })),
      relations: payload.relations.map((r) => ({ relation: r.relation, scope_kind: r.scope_kind, scope_id: r.scope_id, label: r.target_label, state: r.state, target: '' })),
    }),
  };
}

/**
 * The public fingerprint over what both sides can state: the knowledge answer
 * names a relation's target only while it is visible and never its source
 * handle, and a representative row's source variant only when the page needs
 * it, so relation targets and `via_variant_id` are left out of the projection.
 * A relation's STATE is left out too: the payload writes a handle target
 * `pending`, and the Worker resolves it in D1 when that target is (or was
 * already) written — the queue puts printers and the AMS first precisely so
 * that most compatibility resolves at the subject's own write (§B.6, §J.4).
 */
export function reducedProjection(p: Projection): string {
  return projectionFingerprint({
    ...p,
    images: p.images.map((i) => ({ ...i, via_variant_id: '' })),
    relations: p.relations.map((r) => ({ ...r, target: '', state: '' })),
  });
}

/** The knowledge answer of §G.1 flattened into the projection's lists. */
export function knowledgeFacts(k: Rec) {
  const rows: Rec[] = [];
  for (const g of list(k.specs)) rows.push(...list(g.rows));
  if (isRec(k.logistics)) for (const part of Object.values(k.logistics)) rows.push(...list(part));
  const scopeOf = (r: Rec) => (isRec(r.scope) ? { kind: str(r.scope.kind) || 'product', id: str(r.scope.id) } : { kind: str(r.scope_kind) || 'product', id: str(r.scope_id) });
  const specs = rows
    .filter((r) => str(r.key) !== 'package.contents')
    .map((r) => {
      const s = scopeOf(r);
      return { key: str(r.key), scope_kind: s.kind, scope_id: s.id, region: str(r.region), status: str(r.status), unit: str(r.unit), value_num: typeof r.value_num === 'number' ? r.value_num : null };
    });
  const compat = isRec(k.compatibility) ? k.compatibility : {};
  const relations = Object.values(compat).flatMap((items) =>
    list(items).map((r) => {
      const s = scopeOf(r);
      return { relation: str(r.relation), scope_kind: s.kind, scope_id: s.id, label: str(r.label) || str(r.target_label), state: str(r.state), target: '' };
    })
  );
  const documents = list(k.documents).map((d) => ({ kind: str(d.kind), url: str(d.url) }));
  const swatches = list(k.swatches).map((s) => ({ value_id: str(s.option_value_id), url: str(s.url) }));
  return {
    specs,
    relations,
    documents,
    swatches,
    inTheBox: list(k.in_the_box).length,
    specsByStatus: tally(specs.map((s) => s.status)),
    specsByRegion: tally(specs.filter((s) => s.region).map((s) => s.region)),
  };
}

/** publicRelations of the anonymous site answer, as far as the checks read it. */
export function siteFacts(relations: Rec) {
  const groups = list(relations.option_groups).map((g) => ({
    id: str(g.id),
    sort: typeof g.sort === 'number' ? g.sort : 0,
    name_en: str(g.name_en),
    default_value_id: typeof g.default_value_id === 'string' ? g.default_value_id : null,
    values: list(g.values).map((v) => ({ id: str(v.id), sort: typeof v.sort === 'number' ? v.sort : 0, swatch: isRec(v.swatch) ? str(v.swatch.url) : '' })),
  }));
  const variants = list(relations.variants).map((v) => ({ id: str(v.id), combo_key: str(v.combo_key) }));
  const images = list(relations.images).map((i) => ({
    id: str(i.id),
    url: str(i.url),
    is_primary: i.is_primary === true,
    option_value_id: str(i.option_value_id) || null,
    variant_id: str(i.variant_id) || null,
    via_variant_id: str(i.via_variant_id),
  }));
  return { groups, variants, images };
}

// ------------------------------------------------------------------ the tree

export interface TreeNode {
  id: string;
  slug: string;
  parent_id: string;
  name_ar: string;
  name_en: string;
  product_count: number;
}

export function flattenTree(json: Rec | null): TreeNode[] {
  const out: TreeNode[] = [];
  const walk = (nodes: Rec[], parent: string) => {
    for (const n of nodes) {
      out.push({ id: str(n.id), slug: str(n.slug), parent_id: str(n.parent_id) || parent, name_ar: str(n.name_ar), name_en: str(n.name_en), product_count: typeof n.product_count === 'number' ? n.product_count : 0 });
      walk(list(n.children), str(n.id));
    }
  };
  walk(list(json?.roots), '');
  return out;
}

/** A taxonomy reference (`@key` of the map's `create`, or a catalog id) → the live tree node. */
export function resolveSection(ref: string, taxonomy: Rec, tree: readonly TreeNode[]): TreeNode | null {
  if (!ref) return null;
  if (!ref.startsWith('@')) return tree.find((n) => n.id === ref) ?? null;
  const entry = list(taxonomy.create).find((c) => str(c.key) === ref.slice(1) || str(c.key) === ref);
  if (!entry) return null;
  const parent = resolveSection(str(entry.parent), taxonomy, tree);
  const candidates = tree.filter((n) => (!parent || n.parent_id === parent.id) && (n.name_en === str(entry.name_en) || n.slug === str(entry.slug) || n.slug.startsWith(`${str(entry.slug)}-`)));
  return candidates[0] ?? null;
}

// ------------------------------------------------------------------ the checks

const ALLOWED_IMAGE = /^\/files\/[A-Za-z0-9/_.-]+\.webp$/;

export async function verifyPublic(site: Site, ctx: VerifyContext): Promise<VerifyOutcome> {
  const checks: Record<string, CheckResult> = {};
  const exp = expectedFacts(ctx.payload, ctx.media, ctx.documentChecks ?? []);
  const title = ctx.payload.product.title_en;
  /** A merge keeps the existing product's own name, money, options and images (§E.2). */
  const merge = ctx.payload.write_mode === 'merge';
  const appended = [...new Set(exp.imageUrls)];
  const slugPath = `/api/products/${encodeURIComponent(ctx.slug)}`;
  let cacheMs = 0;
  const noteCache = (a: SiteAnswer) => {
    const m = /s-maxage=(\d+)/.exec(a.headers.get('cache-control') ?? '');
    if (m) cacheMs = Math.max(cacheMs, Math.min(CACHE_WAIT_MAX, (Number(m[1]) + 60) * 1000));
  };
  const record = (name: string, r: CheckResult, a?: SiteAnswer) => {
    checks[name] = r;
    if (!r.ok && a) noteCache(a);
  };

  // 1. public v1
  const v1 = await site.read('GET', `/api/public/v1/products/${encodeURIComponent(ctx.slug)}`);
  const d = isRec(v1.json?.data) ? (v1.json!.data as Rec) : {};
  const v1Sections = list(d.sections).map((s) => str(s.slug));
  const v1ImageSet = new Set(list(d.images).map((i) => mediaPath(str(i.url))));
  const v1Images = v1ImageSet.size;
  const price = isRec(d.price) ? d.price : {};
  const name = isRec(d.name) ? d.name : {};
  const unpriced = price.status === 'unpriced' && price.amount === null;
  const v1ok = merge
    ? v1.status === 200 && v1Sections.length >= 1 && appended.every((u) => v1ImageSet.has(u))
    : v1.status === 200 && str(name.en) === title && v1Sections.length >= 1 && v1Images === exp.distinctImages && unpriced && d.purchase === null;
  record(
    'v1',
    {
      ok: v1ok,
      hard: true,
      status: v1.status,
      counts: { sections: v1Sections.length, images: v1Images, expected_images: merge ? appended.length : exp.distinctImages },
      detail: merge
        ? { merge: true, appended_present: appended.every((u) => v1ImageSet.has(u)), unpriced }
        : { name_ok: str(name.en) === title, unpriced, purchase_null: d.purchase === null },
    },
    v1
  );

  // 2. structure: the anonymous site answer
  const siteAnswer = await site.read('GET', slugPath);
  const rel = isRec(siteAnswer.json?.relations) ? (siteAnswer.json!.relations as Rec) : {};
  const sf = siteFacts(rel);
  const groupsOk =
    sf.groups.length === exp.groups.length &&
    exp.groups.every((g, i) => {
      const s = sf.groups[i];
      return s && s.id === g.id && s.name_en === g.name_en && (s.default_value_id === null || s.default_value_id === g.default_value_id) && s.values.map((v) => v.id).join(',') === g.values.join(',');
    });
  const combos = sf.variants.map((v) => v.combo_key).sort();
  const variantsOk = combos.length === exp.comboKeys.length && combos.every((c, i) => c === exp.comboKeys[i]);
  const siteBindings = tally(sf.images.map((i) => bindingOf(i)));
  const imagesOk =
    sf.images.length === exp.images.length &&
    sameTally(siteBindings, exp.bindings) &&
    (sf.images.find((i) => i.is_primary)?.id ?? '') === exp.primaryId &&
    sf.images.every((i) => ALLOWED_IMAGE.test(mediaPath(i.url)));
  const swatchUrl = new Map(sf.groups.flatMap((g) => g.values.map((v) => [v.id, v.swatch] as const)));
  const swatchesOk = exp.swatches.every((s) => !!swatchUrl.get(s.value_id));
  // A merge: the appended images are on the product (bound through the reviewed value map, so found by URL), each
  // one ours; the product's own groups, values, variants and money are the existing product's (§E.2).
  const siteUrls = new Set(sf.images.map((i) => mediaPath(i.url)));
  const appendedOk = appended.every((u) => siteUrls.has(u) && ALLOWED_IMAGE.test(u));
  const structureOk = merge
    ? siteAnswer.status === 200 && appendedOk
    : siteAnswer.status === 200 && siteAnswer.json?.price_status === 'unpriced' && groupsOk && variantsOk && imagesOk && swatchesOk;
  record(
    'structure',
    {
      ok: structureOk,
      hard: true,
      status: siteAnswer.status,
      counts: { groups: sf.groups.length, variants: sf.variants.length, images: sf.images.length, swatches: exp.swatches.filter((s) => !!swatchUrl.get(s.value_id)).length, ...Object.fromEntries(Object.entries(siteBindings).map(([k, v]) => [`images_${k}`, v])) },
      detail: merge
        ? { merge: true, appended_present: appendedOk }
        : { unpriced: siteAnswer.json?.price_status === 'unpriced', groups_ok: groupsOk, variants_ok: variantsOk, images_ok: imagesOk, swatches_ok: swatchesOk },
    },
    siteAnswer
  );

  const know = await site.read('GET', `${slugPath}/knowledge`);
  const kf = knowledgeFacts(know.json ?? {});
  // A merge writes a scoped row only where the reviewed value map names the existing option (§E.2: an unmapped
  // one is a `variant_not_merged` conflict), so its counts are the write's, not the payload's: the Worker's recompute
  // compares D1 with what the write recorded (§I.1.10); here the answer must exist and is recorded.
  const knowledgeOk =
    know.status === 200 &&
    (merge ||
      (sameTally(kf.specsByStatus, exp.specsByStatus) &&
        sameTally(kf.specsByRegion, exp.specsByRegion) &&
        kf.documents.length === exp.documents &&
        kf.relations.length === exp.relations &&
        kf.inTheBox === exp.inTheBox));
  record(
    'knowledge',
    {
      ok: knowledgeOk,
      hard: true,
      status: know.status,
      counts: { documents: kf.documents.length, relations: kf.relations.length, in_the_box: kf.inTheBox, ...Object.fromEntries(Object.entries(kf.specsByStatus).map(([k, v]) => [`specs_${k}`, v])) },
    },
    know
  );
  const live = reducedProjection({
    groups: sf.groups.map((g) => ({ id: g.id, sort: g.sort, default_value_id: g.default_value_id ?? '', values: g.values.map((v) => ({ id: v.id, sort: v.sort })) })),
    variants: sf.variants,
    images: sf.images.map((i) => ({ id: i.id, url: i.url, is_primary: i.is_primary, option_value_id: i.option_value_id ?? '', variant_id: i.variant_id ?? '', via_variant_id: '' })),
    swatches: kf.swatches.length ? kf.swatches : sf.groups.flatMap((g) => g.values.filter((v) => v.swatch).map((v) => ({ value_id: v.id, url: v.swatch }))),
    specs: kf.specs,
    documents: kf.documents,
    relations: kf.relations,
  });
  // A merge's ids are the existing product's (the reviewed value map): its projection is not the payload's. The
  // knowledge counts above and the Worker's recompute against what the write recorded stand for it.
  if (merge) record('fingerprint', { ok: true, hard: false, detail: { not_applicable: 'merge' } });
  else record('fingerprint', { ok: live === exp.projection, hard: true, detail: { expected: exp.projection, live } });

  // 3. listings and the tree
  const treeAnswer = await site.read('GET', '/api/catalog/tree');
  const tree = flattenTree(treeAnswer.json);
  const leafSlug = v1Sections.at(-1) ?? '';
  const rootSlug = v1Sections[0] ?? '';
  // The leaf the product must be filed under is the reviewed map's. The tree lists only sections that hold
  // products, so a mapped leaf it does not name is a leaf the product is NOT in: that fails, never passes. A merge
  // keeps a non-empty existing category (§E.2): its leaf is not compared.
  const leafNode = ctx.leaf ? resolveSection(ctx.leaf, ctx.taxonomy, tree) : null;
  const leafMatches: boolean | null = merge ? null : !!leafNode && leafNode.slug === leafSlug;
  // The live listing answers `total` / `truncated` only with a listing key; a full page means there may be more.
  const listed = async (category: string) => {
    for (let offset = 0, page = 0; page < 8; page++, offset += 50) {
      const a = await site.read('GET', `/api/products?category=${encodeURIComponent(category)}&search=${encodeURIComponent(title)}&limit=50&offset=${offset}`);
      const items = list(a.json?.products);
      if (a.status !== 200) return { ok: false, status: a.status, pages: page + 1 };
      if (items.some((p) => str(p.slug) === ctx.slug)) return { ok: true, status: a.status, pages: page + 1 };
      if (items.length < 50 && a.json?.truncated !== true) return { ok: false, status: a.status, pages: page + 1 };
    }
    return { ok: false, status: 200, pages: 8 };
  };
  const leafListed = leafSlug ? await listed(leafSlug) : { ok: false, status: 0, pages: 0 };
  const rootListed = rootSlug && rootSlug !== leafSlug ? await listed(rootSlug) : leafListed;
  const secondary: string[] = [];
  let secondaryOk = true;
  for (const ref of ctx.also) {
    const node = resolveSection(ref, ctx.taxonomy, tree);
    if (!node) {
      secondaryOk = false;
      continue;
    }
    secondary.push(node.slug);
    if (!(await listed(node.slug)).ok) secondaryOk = false;
  }
  const treeCount = tree.find((n) => n.slug === leafSlug)?.product_count ?? 0;
  record('listings', {
    ok: leafListed.ok && rootListed.ok && secondaryOk && treeCount >= 1 && leafMatches !== false,
    hard: true,
    status: leafListed.status,
    counts: { leaf_pages: leafListed.pages, secondary: secondary.length, tree_count: treeCount },
    detail: { leaf: leafListed.ok, root: rootListed.ok, secondary: secondaryOk, leaf_is_mapped: leafMatches },
  });

  // 4. search
  const found = async (q: string) => {
    const a = await site.read('GET', `/api/public/v1/search?q=${encodeURIComponent(q.slice(0, 100))}&limit=24`);
    const products = isRec(a.json?.data) ? list((a.json!.data as Rec).products) : [];
    return a.status === 200 && products.some((p) => str(p.slug) === ctx.slug);
  };
  const titleFound = await found(title);
  let hardMisses = 0;
  let softMisses = 0;
  for (const m of ctx.modelCodes) {
    if (await found(m.code)) continue;
    if (m.unique) hardMisses++;
    else softMisses++;
  }
  const ids = [...new Set(ctx.payload.external_ids.filter((e) => e.searchable).map((e) => e.value))];
  let idMisses = 0;
  for (const value of ids) if (!(await found(value))) idMisses++;
  record('search', {
    ok: titleFound && hardMisses === 0 && idMisses === 0,
    hard: true,
    counts: { model_codes: ctx.modelCodes.length, model_hard_misses: hardMisses, model_soft_misses: softMisses, external_ids: ids.length, external_id_misses: idMisses },
    detail: { title: titleFound },
  });

  // 5. not sellable, and the request door. A merge keeps the existing product's money (§E.2, §I.1.8 "the V2 status
  // is unchanged"): its quote is whatever it was, and the protected-fields check proves nothing moved.
  const selection = merge ? [] : defaultSelection(ctx.payload);
  const quote = await site.read('POST', `${slugPath}/quote`, { qty: 1, optionValueIds: selection });
  const request = await site.read('POST', '/api/price-requests', { product_id: ctx.productId, option_value_ids: selection });
  const notSellable = quote.status === 409 && quote.json?.code === 'PRICE_NOT_AVAILABLE';
  record('sellable', {
    ok: (merge || notSellable) && request.status === 401,
    hard: true,
    status: quote.status,
    detail: { quote_code: str(quote.json?.code), price_request_status: request.status, ...(merge ? { merge: true } : {}) },
  });

  // 6. media integrity
  let heads = 0;
  let headFailed = 0;
  for (const file of exp.files) {
    heads++;
    const a = await site.read('HEAD', file);
    if (a.status !== 200 || !/^image\/webp\b/.test(a.headers.get('content-type') ?? '')) headFailed++;
  }
  const rb = await ctx.readback();
  record('media', { ok: headFailed === 0 && rb.ok && rb.mismatches === 0, hard: true, counts: { heads, failed: headFailed, readback_mismatches: rb.mismatches } });

  // 8. existing products
  if (ctx.merge) record('merge', { ok: ctx.merge.before_fp_equal === true, hard: true, detail: { before_fp_equal: ctx.merge.before_fp_equal, source: ctx.merge.source ?? 'write' } });

  // 11. compare
  const cmp = await site.read('GET', `/api/compare?ids=${encodeURIComponent(ctx.productId)}`);
  const cmpOk = cmp.status === 200 && JSON.stringify(cmp.json ?? {}).includes(ctx.productId);
  const compareKeys = new Set(
    ctx.payload.specs.filter((s) => isPublicSpec(s) && (s.status === 'verified' || s.status === 'unverified') && specKey(s.key)?.compare).map((s) => s.key)
  ).size;
  let candidates: 'present' | 'absent_expected' | 'missing' = 'absent_expected';
  if (compareKeys >= 3) {
    const c = await site.read('GET', `/api/compare/candidates?q=${encodeURIComponent(title.slice(0, 120))}`);
    candidates = c.status === 200 && JSON.stringify(c.json ?? {}).includes(ctx.productId) ? 'present' : 'missing';
  }
  record('compare', { ok: cmpOk && candidates !== 'missing', hard: true, status: cmp.status, counts: { compare_keys: compareKeys }, detail: { candidates } });

  const ok = Object.values(checks).every((c) => c.ok || !c.hard);
  // The breadcrumb names the section the product IS in (the leaf of its public sections); none named, none matched.
  const leafName = tree.find((n) => n.slug === leafSlug)?.name_ar ?? '';
  return { ok, checks, leafName, sections: { leaf: leafSlug, root: rootSlug, secondary }, cacheMs: cacheMs || CACHE_WAIT_MAX };
}

/** The default selection the page opens with (§G.3, selection.ts): what the quote and the request door are asked with. */
export function defaultSelection(payload: ImportPayload): string[] {
  return pageDefaultSelection(payload);
}

/** The model codes of a title, with whether no other manifest title names the same code. */
export function modelCodesOf(title: string, allTitles: readonly string[]): Array<{ code: string; unique: boolean }> {
  const tokens = [...new Set(modelsInText(title).map((m) => m.token))];
  return tokens.map((code) => ({ code, unique: allTitles.filter((t) => modelsInText(t).some((m) => m.token === code)).length <= 1 }));
}

/** The cache rule (§I.1.9): how long to wait after a second purge — s-maxage + 60 s, at most 360 s. */
export function cacheWaitOf(outcome: VerifyOutcome): number {
  return Math.min(CACHE_WAIT_MAX, Math.max(0, outcome.cacheMs));
}

/** What VERIFY still needs after its cache wait (the wait's deadline check). */
export const AFTER_CACHE_WAIT = VERIFY_AFTER_CACHE_WAIT;

/** Turns one outcome (plus the browser's) into the `edge_evidence` stored on the item. */
export function edgeEvidence(outcome: VerifyOutcome, browser: Record<string, unknown> | null, liveUrl: string, payload: ImportPayload, round: number): Rec {
  return {
    version: 1,
    live_url: liveUrl,
    round,
    checks: { ...outcome.checks, ...(browser ? { browser } : {}) },
    sections: outcome.sections,
    // The selections the page held when the browser checked it (the opening one first); without a browser, the opening one.
    selections_checked: (browser?.selections as string[][] | undefined)?.length ? (browser!.selections as string[][]) : [defaultSelection(payload)],
    counts: {
      groups: payload.groups.length,
      values: payload.groups.reduce((n, g) => n + g.values.length, 0),
      variants: payload.variants.length,
      images: payload.images.length,
      swatches: payload.swatches.length,
      documents: payload.documents.length,
      relations: payload.relations.length,
      specs: payload.specs.length,
    },
  };
}

export { ImportStop };
