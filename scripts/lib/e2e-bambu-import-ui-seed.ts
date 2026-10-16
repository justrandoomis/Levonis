/**
 * THE CATALOGUE OF scripts/e2e-bambu-import-ui.mjs (the Bambu import spec §G, §K.2
 * step 7: «a Playwright local e2e on fixture data»).
 *
 * Run once, before `wrangler dev` starts, against the fresh local D1 file the
 * e2e created (every migration already applied):
 *
 *   node --import tsx scripts/lib/e2e-bambu-import-ui-seed.ts <local-d1.sqlite> <media-dir>
 *
 * It writes the live catalogue (tests/fixtures/liveCatalog.ts: the sections,
 * brands and the printers a compatibility row can link to) and two
 * IMPORTED-STYLE products built by the import's own package from the
 * committed fixtures (tests/fixtures/bambu): `buildImportPayload` gives the
 * groups (kind, Arabic and Sorani labels, the default value), the variants,
 * one image row per binding (`via_variant_id` on the representative ones),
 * the swatches, the typed specifications with their sources and states, the
 * documents and the relations — the rows the import's writer stores (spec
 * §B.2), inserted directly. Catalog-only: no price, no cost, no stock.
 *
 * Pictures are drawn locally (sharp), never fetched: each gallery file is a
 * WebP named after its source file, each swatch a 128 px colour sample. The
 * media directory receives them; the e2e puts them in the local bucket. It
 * prints one JSON line: the products, their slugs and the objects to upload.
 *
 * LOCAL ONLY: it opens the file it is given and nothing else.
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { buildImportPayload, type ImportPayload } from '../../packages/catalog/src/bambuImport/payload';
import { baseColourOf } from '../../packages/catalog/src/bambuImport/registry/colours';
import { sample, fixtureJson, type SampleHandle } from '../../tests/fixtures/bambu/load';
import { seedLiveCatalog, P } from '../../tests/fixtures/liveCatalog';

const file = process.argv[2];
const mediaDir = process.argv[3];
if (!file || !mediaDir) throw new Error('usage: e2e-bambu-import-ui-seed.ts <local-d1.sqlite> <media-dir>');
mkdirSync(mediaDir, { recursive: true });

const raw = new DatabaseSync(file);
raw.exec('PRAGMA foreign_keys = ON');
seedLiveCatalog(raw);

const sharp = createRequire(join(process.cwd(), 'package.json'))('sharp') as (input: Buffer) => { webp: (o: { quality: number }) => { toBuffer: () => Promise<Buffer> } };
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const uploads: Array<{ key: string; file: string }> = [];

const BASE_HEX: Record<string, string> = {
  black: '#1B1B1B', white: '#F2F2F2', grey: '#8A8D91', red: '#C8102E', orange: '#F28C28', yellow: '#F5D000', green: '#2E8B57',
  blue: '#1F5FBF', purple: '#6A3FA0', pink: '#E88BB5', brown: '#7B4A2E', beige: '#D8C3A5', gold: '#C9A227', silver: '#BFC4C9',
  transparent: '#DDE7EE', multicolour: '#9B59B6',
};

async function picture(key: string, svg: string): Promise<string> {
  const out = join(mediaDir, `${sha(key).slice(0, 16)}.webp`);
  writeFileSync(out, await sharp(Buffer.from(svg)).webp({ quality: 80 }).toBuffer());
  uploads.push({ key, file: out });
  return `/files/${key}`;
}

const esc = (s: string) => s.replace(/[<&>"]/g, '');

async function galleryPicture(name: string, i: number): Promise<{ url: string; key: string }> {
  const key = `products/import/gallery/${sha(`gallery:${name}`)}.webp`;
  const hues = ['#25303b', '#2f3b2c', '#3b2c36', '#3b352a', '#253b39', '#2d2d3b'];
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="1200"><rect width="1200" height="1200" fill="${hues[i % hues.length]}"/><rect x="300" y="260" width="600" height="520" rx="48" fill="#ffffff" fill-opacity="0.14"/><text x="600" y="930" font-size="64" text-anchor="middle" fill="#ffffff" font-family="sans-serif">${esc(name).slice(0, 28)}</text></svg>`;
  return { url: await picture(key, svg), key };
}

async function swatchPicture(name: string): Promise<{ url: string; key: string }> {
  const key = `products/import/swatch/${sha(`swatch:${name}`)}.webp`;
  const base = baseColourOf(name) ?? 'grey';
  const fill = BASE_HEX[base] ?? '#8A8D91';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128"><rect width="128" height="128" fill="${fill}"/><rect width="128" height="40" y="88" fill="#000000" fill-opacity="0.12"/></svg>`;
  return { url: await picture(key, svg), key };
}

const DUPLICATES: Partial<Record<SampleHandle, Record<number, number>>> = { a1: { 3: 0, 4: 1 }, h2d: { 5: 0, 6: 1, 7: 2 } };

async function seedProduct(handle: SampleHandle, slug: string, at: { category: string; sub: string; position: number }) {
  const x = sample(handle);
  const dup = DUPLICATES[handle] ?? {};
  const keyOf = new Map(x.gallery.map((g, i) => [g.resourceFileId, `k${dup[i] ?? i}`]));
  const built = buildImportPayload({
    extraction: x,
    writeMode: 'create',
    extractionSha256: sha(handle),
    targets: fixtureJson('compat-targets.json') as never,
    contentKey: (rid) => keyOf.get(rid),
    retrievedAt: '2026-10-15T00:00:00Z',
  });
  const p: ImportPayload = built.payload;
  const id = p.product_id;
  const brand = (raw.prepare("SELECT id FROM brands WHERE slug = 'bambu-lab'").get() as { id: string } | undefined)?.id ?? null;
  raw
    .prepare(
      `INSERT INTO products (id, slug, name, name_ar, name_ku, description, status, stock, selling_type, sale_types, inventory_mode,
                             category_id, sub_category_id, brand_id, spec_fields, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'active', NULL, 'pre_order', '["pre_order"]', ?, ?, ?, ?, ?, '2026-10-15T00:00:00Z')`
    )
    .run(id, slug, p.product.title_en, p.product.title_en, p.product.title_en, p.product.short_description_en || p.product.title_en,
      p.product.variant_mode, at.category, at.sub, brand, JSON.stringify(specFieldsOf(p)));
  raw.prepare('INSERT OR IGNORE INTO product_catalogs (product_id, catalog_id, position) VALUES (?, ?, ?)').run(id, at.sub, at.position);

  for (const g of p.groups) {
    raw
      .prepare(
        `INSERT INTO product_option_groups (id, product_id, name_en, name_ar, name_ckb, kind, default_value_id, sort, active)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`
      )
      .run(g.id, id, g.name_en, g.name_ar, g.name_ckb, g.kind, g.default_value_id, g.sort);
    for (const v of g.values) {
      raw
        .prepare(`INSERT INTO product_option_values (id, product_id, group_id, name_en, name_ar, name_ckb, sort, active) VALUES (?, ?, ?, ?, ?, ?, ?, 1)`)
        .run(v.id, id, g.id, v.name_en, v.name_ar || v.name_en, v.name_ckb || v.name_en, v.sort);
    }
  }
  for (const v of p.variants) {
    raw.prepare('INSERT INTO product_variants (id, product_id, combo_key, active) VALUES (?, ?, ?, 1)').run(v.id, id, v.combo_key);
  }
  const names = new Map(x.gallery.map((g) => [g.resourceFileId, (g.url.split('/').pop() ?? '').replace(/-compressed/g, '').replace(/\.[a-z]+$/i, '')]));
  const drawn = new Map<string, { url: string; key: string }>();
  let n = 0;
  for (const img of p.images) {
    const name = names.get(img.source_media_id) ?? img.source_media_id;
    let pic = drawn.get(name);
    if (!pic) {
      pic = await galleryPicture(name, n++);
      drawn.set(name, pic);
    }
    raw
      .prepare(
        `INSERT INTO product_images (id, product_id, url, r2_key, content_type, bytes, width, height, sort_order, is_primary, option_value_id, variant_id, alt_en, alt_ar, alt_ckb)
         VALUES (?, ?, ?, ?, 'image/webp', 1000, 1200, 1200, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(img.id, id, pic.url, pic.key, img.sort_order, img.is_primary ? 1 : 0, img.option_value_id, img.variant_id, img.alt_en, img.alt_ar, img.alt_ckb);
  }
  for (const r of p.source_refs) {
    raw
      .prepare(
        `INSERT OR IGNORE INTO product_option_source_refs (product_id, kind, source, source_id, levonis_id, source_label, binding_rule, via_variant_id, import_run_id)
         VALUES (?, ?, 'bambu_us', ?, ?, ?, ?, ?, 'cir_e2e')`
      )
      .run(id, r.kind, r.source_id, r.levonis_id, r.source_label, r.binding_rule, r.via_variant_id);
  }
  const valueName = new Map(p.groups.flatMap((g) => g.values.map((v) => [v.id, v.name_en] as const)));
  for (const s of p.swatches) {
    const pic = await swatchPicture(valueName.get(s.value_id) ?? s.value_id);
    raw
      .prepare(
        `INSERT INTO product_option_value_swatches (option_value_id, product_id, url, r2_key, width, height, published_hex, hex_source_ref, source_url)
         VALUES (?, ?, ?, ?, 128, 128, '', '', ?)`
      )
      .run(s.value_id, id, pic.url, pic.key, s.source_url);
  }
  for (const s of p.specs) {
    const list = s.value_list.map((v) => (v && typeof v === 'object' ? { text: v.text, qty: v.qty } : v));
    raw
      .prepare(
        `INSERT OR IGNORE INTO product_spec_values (id, product_id, canonical_key, group_key, scope_kind, scope_id, region, data_type, original_label,
           original_value, value_text, value_num, value_num_max, value_bool, value_list, unit, status, confidence, source_kind, source_ref,
           source_title, source_locator, source_excerpt, retrieved_at, test_method, test_condition, derived_from, missing_reason,
           checked_sources, visibility, conflict, sort, import_run_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '2026-10-15T00:00:00Z', ?, ?, ?, ?, ?, ?, ?, ?, 'cir_e2e')`
      )
      .run(s.id, id, s.key, s.group, s.scope_kind, s.scope_id, s.region, s.data_type, s.original_label, s.original_value, s.value_text,
        s.value_num, s.value_num_max, s.value_bool, JSON.stringify(list), s.unit, s.status, s.confidence, s.source_kind,
        s.source_kind === 'store_page' || s.source_kind === 'store_messages' ? x.canonicalUrl : (s.checked_sources[0]?.url ?? x.canonicalUrl),
        s.source_title, s.source_locator, s.source_excerpt, s.test_method, s.test_condition, s.derived_from, s.missing_reason,
        JSON.stringify(s.checked_sources), s.visibility, s.conflict, s.sort);
  }
  for (const d of p.documents) {
    raw
      .prepare(
        `INSERT OR IGNORE INTO product_documents (id, product_id, kind, title_en, title_ar, title_ckb, url, host, scope_kind, scope_id, language, sort, active, import_run_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'cir_e2e')`
      )
      .run(d.id, id, d.kind, d.title_en, d.title_ar, d.title_ckb, d.url, d.host, d.scope_kind, d.scope_id, d.language, d.sort);
  }
  for (const r of p.relations) {
    raw
      .prepare(
        `INSERT OR IGNORE INTO product_relations (id, product_id, scope_kind, scope_id, relation, target_kind, target_product_id, target_source,
           target_source_handle, target_family, target_label, state, evidence_kind, evidence_text, import_run_id)
         VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, 'cir_e2e')`
      )
      .run(r.id, id, r.scope_kind, r.scope_id, r.relation, r.target_kind, r.target_source, r.target_source_handle, r.target_family,
        r.target_label, r.state === 'resolved' ? 'pending' : r.state, r.evidence_kind, r.evidence_text);
  }
  // One compatibility link resolved to a live printer, as the import resolves its targets (§B.6).
  raw
    .prepare(
      `INSERT OR IGNORE INTO product_relations (id, product_id, relation, target_kind, target_product_id, target_label, state, evidence_kind)
       VALUES (?, ?, 'compatible_with', 'printer', ?, 'Bambu Lab A1', 'resolved', 'compat_section')`
    )
    .run(`prel_e2e_${id}`, id, P.A1);
  raw
    .prepare(
      `INSERT INTO product_source_refs (source, source_product_id, product_id, source_handle, canonical_url, source_route, match_kind,
         stock_decision, fingerprint, fetched_at, import_run_id)
       VALUES ('bambu_us', ?, ?, ?, ?, ?, 'created', 'not_configured', ?, '2026-10-15T00:00:00Z', 'cir_e2e')`
    )
    .run(x.sourceProductId, id, x.handle, x.canonicalUrl, x.route, sha(handle));
  return {
    id,
    slug,
    title: p.product.title_en,
    groups: p.groups.map((g) => ({ id: g.id, kind: g.kind, default_value_id: g.default_value_id, values: g.values.map((v) => ({ id: v.id, name_en: v.name_en })) })),
    variants: p.variants.map((v) => ({ id: v.id, combo_key: v.combo_key })),
    images: p.images.map((i) => ({ id: i.id, option_value_id: i.option_value_id, variant_id: i.variant_id, via: i.via_variant_id, url: drawn.get(names.get(i.source_media_id) ?? '')?.url ?? '' })),
    /** The swatches' owner-only source addresses: none may reach a customer's answer. */
    swatchSources: p.swatches.map((w) => w.source_url).filter(Boolean),
    documents: p.documents.length,
    specs: p.specs.length,
  };
}

/** The template mirrors the import writes for the listing, compare and the card (spec §C.6, §G.5). */
function specFieldsOf(p: ImportPayload): Record<string, string> {
  const out: Record<string, string> = {};
  const colour = p.groups.find((g) => g.kind === 'color');
  if (colour) {
    const bases = [...new Set(colour.values.map((v) => baseColourOf(v.name_en)).filter(Boolean))];
    if (bases.length) out.color_name = bases.join(' | ');
  }
  const spool = p.groups.find((g) => g.kind === 'spool');
  if (spool) out.spool_type = spool.values.map((v) => (/refill/i.test(v.name_en) ? 'Refill' : 'With spool')).join(' | ');
  for (const s of p.specs) {
    if (s.status !== 'verified' && s.status !== 'unverified') continue;
    if (s.key === 'identity.family' && s.value_text) out.product_family = s.value_text;
    if (s.key === 'material.type' && s.value_text) out.material_type = s.value_text;
    if (s.key === 'material.diameter' && s.value_num !== null) out.diameter = String(s.value_num);
    if (s.key === 'printing.build_volume' && s.value_text) out.build_volume = s.value_text;
  }
  return out;
}

const pla = await seedProduct('pla-basic-filament', 'bambu-pla-basic-e2e', { category: 'cat_materials', sub: 'cat_materials_fdm', position: 901 });
const h2d = await seedProduct('h2d', 'bambu-lab-h2d-e2e', { category: 'cat_printers', sub: 'cat_printers_fdm', position: 902 });
raw.close();
console.log(JSON.stringify({ pla, h2d, uploads }));
