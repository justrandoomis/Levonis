/**
 * Supplier price fixtures (docs/SMART_PRICING.md §10, WP2): real records,
 * copied on 2026-10-31 — see README.md in this folder for where each file
 * came from. The Levonis side is the Bambu import's own option model
 * (tests/fixtures/bambu samples through buildOptions) with the real manifest
 * row's SKU codes, so a matcher test reads what the import really writes.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from '../d1';
import { buildOptions, newProductId } from '../../../packages/catalog/src/bambuImport/options';
import { extractPage } from '../../../packages/catalog/src/bambuImport/extract';
import { parseSupplierPriceFile, type SupplierPriceFile, type SupplierPriceItem, type SupplierSource } from '../../../packages/catalog/src/supplierPrices/format';
import type { CatalogueItem, MatchIdentity } from '../../../packages/catalog/src/supplierPrices/match';
import { sample, type SampleHandle } from '../bambu/load';

export const SUPPLIER_FIXTURES = join(ROOT, 'tests', 'fixtures', 'supplierPrices');

export const fixtureText = (file: string): string => readFileSync(join(SUPPLIER_FIXTURES, file), 'utf8');
export const fixtureJson = <T = unknown>(file: string): T => JSON.parse(fixtureText(file)) as T;

/** The Tmall capture of 2026-10-31 as a v1 file (21 real items). */
export const tmallFile = (): SupplierPriceFile => parseSupplierPriceFile(fixtureText('tmall-2026-10-31.v1.json'));
/** The EU store capture of 2026-10-31 (with ?skr=yes) as a v1 file (4 real items). */
export const euFile = (): SupplierPriceFile => parseSupplierPriceFile(fixtureText('eu-2026-10-31.v1.json'));

export interface RawTmallRecord {
  item_id: string;
  title: string;
  url: string;
  hidden_price: boolean;
  skus: Array<{ sku_id: string; options: Record<string, string>; price_cny: string; price_title: string | null; quantity: number | null }>;
}
/** The raw browser captures the Tmall v1 file was built from, verbatim. */
export const tmallRecords = (): RawTmallRecord[] => fixtureJson<RawTmallRecord[]>('tmall-batch-records.json');

export interface RawEuProduct {
  handle: string;
  url: string;
  variants: Array<{ sku: string; option_values: string[]; colour_code: string | null; price_eur: number; currency: string; url: string }>;
}
/** The EU store snapshot's products, verbatim. */
export const euRecords = (): RawEuProduct[] => fixtureJson<RawEuProduct[]>('eu-store-records.json');

export interface ManifestRowFixture {
  handle: string;
  source_product_id: string;
  title: string;
  type: string;
  subtype: string;
  sku_codes: Record<string, string>;
}
/** A real row of data/bambu-import/manifest.json, by handle. */
export function manifestRow(handle: string): ManifestRowFixture {
  const row = fixtureJson<ManifestRowFixture[]>('manifest-rows.json').find((r) => r.handle === handle);
  if (!row) throw new Error(`no manifest row ${handle} in the fixture`);
  return row;
}

/** One parsed file's items as the matcher reads them. */
export function catalogueItems(file: SupplierPriceFile, keys?: readonly string[]): CatalogueItem[] {
  const pick = keys ? keys.map((k) => file.items.find((i) => i.item_key === k)!) : file.items;
  return pick.map((i) => catalogueItem(file.source, i));
}

export function catalogueItem(source: SupplierSource, i: SupplierPriceItem): CatalogueItem {
  return {
    source,
    item_key: i.item_key,
    title: i.title,
    name_en: i.name_en,
    category: i.category,
    sourcing_hint: i.sourcing,
    codes: i.codes,
    skus: i.skus.map((s) => ({ sku_key: s.sku_key, options: s.options, options_en: s.options_en, sku_code: s.sku_code, codes: s.codes, price: s.price, quantity: s.quantity })),
  };
}

/**
 * The Levonis product the import writes for a sample: its option groups (with kinds), values
 * (with colour codes), real variants with their combo keys, bambu_variant_id and, from the
 * real manifest row, bambu_sku_code.
 */
export function importedIdentity(handle: SampleHandle | 'filament-buffer', manifestHandle: string = handle): MatchIdentity {
  const x = handle === 'filament-buffer' ? extractPage(fixtureTextBambu('filament-buffer.page.html')).extraction : sample(handle);
  const m = buildOptions(x, newProductId(x.sourceProductId));
  let skuCodes: Record<string, string> = {};
  try {
    skuCodes = manifestRow(manifestHandle).sku_codes;
  } catch {
    skuCodes = {};
  }
  return {
    product_id: m.productId,
    name: x.title,
    handle: x.handle,
    groups: m.groups.map((g) => ({ id: g.id, kind: g.kind, name_en: g.sourceLabel })),
    values: m.groups.flatMap((g) => g.values.map((v) => ({ id: v.id, group_id: g.id, name_en: v.nameEn, color_code: v.colourCode }))),
    skus: m.variants.map((v) => ({
      combo_key: v.comboKey,
      value_ids: v.valueIds,
      variant_ids: [v.sourceId],
      sku_codes: skuCodes[v.sourceId] ? [skuCodes[v.sourceId]!] : [],
    })),
  };
}

function fixtureTextBambu(file: string): string {
  return readFileSync(join(ROOT, 'tests', 'fixtures', 'bambu', file), 'utf8');
}

/** A Levonis product built by hand: groups of [kind, values], every combination a SKU. */
export function handIdentity(spec: {
  name: string;
  handle?: string | null;
  groups?: Array<{ kind: string; values: Array<string | { name: string; code?: string }> }>;
  skuCodes?: Record<string, string>;
  variantIds?: Record<string, string>;
  owner_sourcing?: 'EU_STORE_EUR' | 'CHINA_CNY' | null;
  only?: (names: string[]) => boolean;
}): MatchIdentity {
  const groups = (spec.groups ?? []).map((g, gi) => ({ id: `og_${gi}`, kind: g.kind, name_en: g.kind }));
  const values = (spec.groups ?? []).flatMap((g, gi) =>
    g.values.map((v, vi) => {
      const o = typeof v === 'string' ? { name: v } : v;
      return { id: `ov_${gi}_${vi}`, group_id: `og_${gi}`, name_en: o.name, color_code: o.code ?? null };
    })
  );
  let combos: string[][] = [[]];
  for (const g of groups) combos = combos.flatMap((c) => values.filter((v) => v.group_id === g.id).map((v) => [...c, v.id]));
  const nameOf = (id: string) => values.find((v) => v.id === id)!.name_en;
  const skus = combos
    .filter((ids) => !spec.only || spec.only(ids.map(nameOf)))
    .map((ids) => {
      const key = ids.map(nameOf).join(' / ');
      return {
        combo_key: [...ids].sort().map((id) => `o:${id}`).join('|'),
        value_ids: ids,
        variant_ids: spec.variantIds?.[key] ? [spec.variantIds[key]!] : [],
        sku_codes: spec.skuCodes?.[key] ? [spec.skuCodes[key]!] : [],
      };
    });
  return { product_id: 'prod_hand', name: spec.name, handle: spec.handle ?? null, owner_sourcing: spec.owner_sourcing ?? null, groups, values, skus };
}
