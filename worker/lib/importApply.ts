/**
 * From parsed spreadsheet rows to the two payloads the product API already
 * knows how to write — mandate §10.
 *
 * WHY A RESOLVER AND NOT A SECOND WRITER. The importer must not have its own
 * idea of what a valid product is. It produces exactly the two documents the
 * admin form produces — the product doc for `validateProductDoc`, and the
 * relations payload for `planRelationsWrite` — so a rule added to the form
 * (a price ladder, a colour link that must exist, one primary image) is
 * enforced on an import for free, and no field can be writable from a
 * spreadsheet but not from the browser.
 *
 * IDS ARE REUSED, NEVER REGENERATED. An update matches an existing option
 * group by name, a value by (group, name), a colour by name and an image by
 * URL, and carries the existing row's id into the payload. That is what makes
 * a re-import a no-op instead of a wipe-and-recreate: stock and reserved units
 * live on those rows, and a new id would silently reset both and strand live
 * orders. It is also what makes the §10 round-trip hold — export, re-import,
 * same rows.
 *
 * VARIANT COMBINATIONS ARE EXPRESSIBLE, and by name. A `variant` row names
 * its selection the way a human reads it — `Printer:A1|Plug:EU|color:Black` —
 * and is matched to an existing combination by the ids those names resolve
 * to, so a re-import updates the combination that already holds the stock
 * instead of creating a second one beside it. A combination the file does not
 * mention is dropped only when the file HAS variant rows; a file with none
 * carries the stored combinations through untouched, which is what keeps an
 * older export from wiping a grid it never knew about.
 *
 * ABSENT MEANS PRESERVE. Every child collection is nullable in the parsed
 * product: null = "this sheet does not talk about warranty plans", an empty
 * array = "this product has no warranty plans". Only the second one clears
 * anything. That is what lets a narrow sheet (prices only) be re-imported
 * without erasing the labels, specs, guide steps and content blocks somebody
 * typed in the form.
 */

import { deriveSaleTypes } from './availability';
import type { AvailabilityType } from './availability';
import { normalizeHashtag } from './hashtags';
import type { ParsedMembershipRule, ParsedProduct, RowIssue } from './importCsv';
import { printerWarrantyRules, readOpsWarranty } from './warrantyPlans';
import { parseConditionDoc, type ConditionDoc } from './condition';
import { DIMENSION_FIELDS, parseDimensions } from './productModel';
import { isOwnedMediaUrl } from './mediaStorage';
import type { PendingBrand } from './template';

export interface CatalogRef {
  id: string;
  parent_id: string | null;
  slug: string;
  name_en: string;
  name_ar: string;
  template_family: string | null;
  /** The owner's flag: products filed here are printers, and only they may
   *  carry extended-warranty plans. Optional so older callers still compile;
   *  absent reads as "not a printer catalog". */
  is_printer_catalog?: boolean;
}

export interface ExistingVariant {
  id: string;
  combo_key: string;
  sku: string | null;
  active: number;
  stock: number | null;
  low_stock_threshold: number | null;
  regular_price_iqd: number | null;
  prime_price_iqd: number | null;
  pro_price_iqd: number | null;
  cost_iqd: number | null;
}

/**
 * 0075 — ONE STORED (MODEL x ORDER TYPE) CELL, verbatim, with its routes.
 *
 * Carried as the row's own columns rather than a re-typed subset: a
 * `fulfillment` sheet row states a capacity and an enabled flag and nothing
 * else, so every other column of that cell — its eight prices, its lead time
 * — has to survive the merge untouched. `parseFulfillmentPayload` reads these
 * by name, which is why the row is passed on as it was read.
 */
export interface ExistingRouteRow extends Record<string, unknown> {
  method: string;
}
export interface ExistingCellRow extends Record<string, unknown> {
  option_id: string;
  fulfillment_type: string;
  transports: ExistingRouteRow[];
}

/** The shape of a product that already exists, as far as matching cares. */
export interface ExistingShape {
  id: string;
  slug: string;
  inventory_mode: string;
  /** The stored doc, so fields the spreadsheet does not carry survive. */
  doc: Record<string, unknown>;
  groups: Array<{ id: string; name_en: string }>;
  values: Array<{ id: string; group_id: string; name_en: string }>;
  colors: Array<{ id: string; name_en: string }>;
  images: Array<{ id: string; url: string }>;
  variants: ExistingVariant[];
  /**
   * 0075 — the stored order-type cells. Optional, so a caller that does not
   * load them behaves exactly as it did before: a sheet with no `fulfillment`
   * row never reads this, and a sheet with one merges onto an empty set,
   * which is the honest answer for a product that has no cells.
   */
  fulfillments?: ExistingCellRow[];
}

/**
 * HOW ONE BRAND CELL RESOLVES, decided by the route that holds the database.
 *
 *   hit        an existing row (slug, id, or any of its three names —
 *              `matchRef`, worker/lib/templateRefs.ts, the TXT import's rule);
 *              `warning` is set when that row is deactivated
 *   pending    no row answers; the confirm will CREATE this brand, and every
 *              row naming it shares the one pending id
 *   ambiguous  a name more than one row answers to — refused, never guessed
 */
export type BrandResolution =
  | { kind: 'hit'; id: string; warning: string | null }
  | { kind: 'pending'; pending: PendingBrand }
  | { kind: 'ambiguous'; candidates: string[] }
  | { kind: 'miss' };

export interface ImportMaps {
  /** normalized brand name or slug -> brand id */
  brands: Map<string, string>;
  /**
   * The owner's «اجعل ينشئ البراند بدل أن يرفض», for the CSV/ZIP lane. When
   * present it REPLACES the `brands` map lookup: the preview route builds it
   * from every brand row (inactive included, Sorani names included) and from
   * the brands it has planned to create. A caller that does not pass it keeps
   * the old refuse-on-miss behaviour.
   */
  brandMatch?: (value: string) => BrandResolution;
  /** normalized catalog slug, English name or Arabic name -> catalog */
  catalogs: Map<string, CatalogRef>;
  /** normalized facet slug or English name -> facet id */
  facets: Map<string, string>;
  /** catalog id -> the family inherited down its branch */
  familyOf: Map<string, 'devices' | 'materials' | null>;
  /** image cell (ZIP filename or URL) -> the stored delivery URL */
  images: Map<string, string>;
  /**
   * lowercased product slug -> product id, for `condition_new_product_slug`.
   *
   * A slug rather than an id, because an id is not something a person filling
   * a sheet can be expected to know or to copy correctly — and the slug is
   * already the thing they see in the product URL.
   */
  productSlugs: Map<string, string>;
  /**
   * Normalized display names claimed by MORE than one row. Such a name is in
   * the maps too (pointing at one of them), so a resolver that ignores this
   * set files the product under an arbitrary row; the importer refuses the
   * cell instead and names the slug as the unambiguous way to write it.
   */
  ambiguous?: {
    brands: Set<string>;
    catalogs: Set<string>;
    facets: Set<string>;
  };
}

/** The message an ambiguous cell earns, in the sheet's own language.
 *  EXPORTED because the TXT import refuses an ambiguous brand/section name for
 *  exactly the same reason, and two hand-written copies of one sentence drift. */
export const ambiguousMessage = (column: string, value: string) =>
  `${column}: أكثر من صف يحمل الاسم "${value}" — اكتب الـslug بدلًا من الاسم لتحديد المقصود`;

export interface ResolvedProduct {
  key: string;
  line: number;
  productId: string;
  action: 'create' | 'update';
  /** Body for validateProductDoc. */
  doc: Record<string, unknown>;
  /** Body for planRelationsWrite. */
  relations: Record<string, unknown>;
  catalogIds: string[];
  /**
   * §18 — the product-scoped membership discount rules the row STATES, one
   * per tier it spoke about, carried straight through from `parseImport`.
   *
   * It is deliberately NOT merged into `doc`: a membership rule is a row in
   * `membership_benefit_rules`, not a field of a product, and it has to be
   * written through `saveBenefitRule` so the version and the audit entry go
   * with it. An empty array is the ordinary case and means "the file said
   * nothing" — every stored rule survives.
   */
  membership: ParsedMembershipRule[];
  issues: RowIssue[];
}

export const normKey = (s: string): string => s.trim().toLowerCase().replace(/\s+/g, ' ');

/** A group+value pair, normalized into one map key. */
const pairKey = (group: string, value: string) => `${normKey(group)}${normKey(value)}`;

/** `o:<id>|c:<id>` -> its parts, so an existing combination survives a re-import. */
export function splitComboKey(key: string): { option_value_ids: string[]; color_id: string | null } {
  const option_value_ids: string[] = [];
  let color_id: string | null = null;
  for (const part of key.split('|')) {
    if (part.startsWith('o:')) option_value_ids.push(part.slice(2));
    else if (part.startsWith('c:')) color_id = part.slice(2);
  }
  return { option_value_ids, color_id };
}

/**
 * AN IMAGE REFERENCE MUST BE A KEY THIS SHOP OWNS — NOT A LINK TO SOMEBODY'S CDN.
 *
 * The live catalogue is the argument for this function existing. One printer
 * carries three product images whose `url` is `https://static.insales-cdn.com/…`,
 * `https://3d.nice-cdn.com/…` and `https://cdn-reichelt.de/…` with an EMPTY
 * `key` — about 1.17 MB of a supplier's PNGs, unconverted, fetched by every
 * visitor from three foreign hosts. Nothing here can keep them alive: the
 * supplier can rename the file, put a referrer check in front of it, or bill
 * for the traffic, and the shop's own product page goes blank in Baghdad with
 * no deploy and no warning. The bytes are also PNG rather than WebP, so the
 * whole «كل صورة تتحول قبل التخزين» rule was never applied to them.
 *
 * So the import refuses to write one. A cell may name a file inside the ZIP or
 * an address to FETCH — and what is fetched is converted and stored under a key
 * we own, which is what `resolveImages` produces. What may never happen is the
 * address itself being written into the product as if it were a picture.
 *
 * `/files/<key>` is the shape this shop serves. `..` is refused outright so a
 * cell can never walk out of the media namespace, and the character class
 * refuses a scheme, a host and a query string by construction — `https://…`
 * cannot pass, with or without a `/files/` prefix glued in front of it.
 */
// The rule moved to `worker/lib/mediaStorage.ts` so the ordinary admin save
// enforces it too — closing the import alone left a door open that one
// authenticated PUT could walk through. Re-exported here because this module's
// callers already name it.
export { isOwnedMediaUrl };

/** Said in all three languages, because the admin reading the preview may be
 *  reading it in any of them. */
export const EXTERNAL_IMAGE_REFUSAL =
  'رابط خارجي لا يُخزَّن كصورة منتج — الصورة تُنزَّل وتُحوَّل إلى WebP وتُحفظ عندنا / ' +
  'an external link is never stored as a product image — the picture is fetched, converted to WebP and kept on our own storage / ' +
  'بەستەری دەرەکی وەک وێنەی بەرهەم هەڵناگیرێت — وێنەکە دادەبەزێنرێت و دەکرێت بە WebP و لای خۆمان هەڵدەگیرێت';

const err = (line: number, message: string): RowIssue => ({ line, severity: 'error', message });
const warn = (line: number, message: string): RowIssue => ({ line, severity: 'warning', message });

/**
 * One parsed product -> the doc and relations payloads, with every name
 * resolved to an id. Pure: it reads the maps it is handed and writes nothing.
 */
export function resolveProduct(
  p: ParsedProduct,
  existing: ExistingShape | null,
  maps: ImportMaps,
  opts: { newId: (prefix: string) => string; money: boolean; specFieldIds?: string[] }
): ResolvedProduct {
  const issues: RowIssue[] = [];
  const productId = existing?.id ?? opts.newId('prd');

  /**
   * EVERY IMAGE CELL IN THIS PRODUCT GOES THROUGH HERE — options, colours, the
   * gallery, the content blocks and the guide steps alike.
   *
   * Five call sites each wrote `maps.images.get(cell) ?? ''`, so a rule about
   * what an image URL may be would have had to be repeated five times and
   * would have been missed on the sixth. One function is the rule, and a cell
   * that resolved to anything other than a key we own is refused by LINE, so
   * the admin sees which row of their sheet to fix rather than a product that
   * failed for no stated reason.
   */
  const imageUrl = (cell: string, line: number): string => {
    if (!cell) return '';
    const url = maps.images.get(cell) ?? '';
    if (!url) return '';
    if (!isOwnedMediaUrl(url)) {
      issues.push(err(line, `image: "${cell}" — ${EXTERNAL_IMAGE_REFUSAL}`));
      return '';
    }
    return url;
  };

  // ---- brand -------------------------------------------------------------
  let brandId: string | null = (existing?.doc.brand_id as string | null) ?? null;
  const brandMatched = p.brand && maps.brandMatch ? maps.brandMatch(p.brand) : null;
  if (brandMatched) {
    if (brandMatched.kind === 'hit') {
      brandId = brandMatched.id;
      if (brandMatched.warning) issues.push(warn(p.line, brandMatched.warning));
    } else if (brandMatched.kind === 'pending') {
      // Not an error: the confirm creates it (once, however many rows name
      // it). Said on the row so the owner reads «سيُنشأ» before confirming.
      brandId = brandMatched.pending.id;
      issues.push(
        warn(p.line, `brand: سيُنشأ براند جديد "${brandMatched.pending.name}" ← ${brandMatched.pending.slug} / a new brand will be created`)
      );
    } else if (brandMatched.kind === 'ambiguous') {
      issues.push(err(p.line, `${ambiguousMessage('brand', p.brand)} — ${brandMatched.candidates.join('، ')}`));
    } else {
      issues.push(err(p.line, `brand: لا توجد علامة تجارية باسم "${p.brand}" — أضفها أولًا من إدارة العلامات`));
    }
  } else if (p.brand) {
    const found = maps.brands.get(normKey(p.brand));
    if (!found) {
      // §4 takes the brand from a managed list. Inventing one from a
      // spreadsheet cell is how a catalogue ends up with "Bambu", "bambu lab"
      // and "BambuLab" as three separate brands.
      issues.push(err(p.line, `brand: لا توجد علامة تجارية باسم "${p.brand}" — أضفها أولًا من إدارة العلامات`));
    } else if (maps.ambiguous?.brands.has(normKey(p.brand))) {
      issues.push(err(p.line, ambiguousMessage('brand', p.brand)));
    } else {
      brandId = found;
    }
  }

  // ---- section and sub-section -------------------------------------------
  let categoryId: string | null = (existing?.doc.category_id as string | null) ?? null;
  let subCategoryId: string | null = (existing?.doc.sub_category_id as string | null) ?? null;
  // Whether the product lands in a printer catalog — read off the SAME refs
  // the sections resolve to, so the CSV preview can refuse a warranty row on
  // a filament without a query (the confirm re-checks against the database).
  let isPrinter = false;
  if (p.category) {
    const cat = maps.catalogs.get(normKey(p.category));
    if (!cat) issues.push(err(p.line, `category: لا يوجد قسم باسم "${p.category}"`));
    else if (maps.ambiguous?.catalogs.has(normKey(p.category))) {
      issues.push(err(p.line, ambiguousMessage('category', p.category)));
    } else {
      categoryId = cat.id;
      if (cat.is_printer_catalog) isPrinter = true;
    }
  }
  if (p.sub_category) {
    const sub = maps.catalogs.get(normKey(p.sub_category));
    if (!sub) {
      issues.push(err(p.line, `sub_category: لا يوجد قسم فرعي باسم "${p.sub_category}"`));
    } else if (maps.ambiguous?.catalogs.has(normKey(p.sub_category))) {
      issues.push(err(p.line, ambiguousMessage('sub_category', p.sub_category)));
    } else if (categoryId && sub.parent_id !== categoryId) {
      // §4: the sub-section is limited to the children of the main section.
      issues.push(err(p.line, `sub_category: "${p.sub_category}" ليس قسمًا فرعيًا من "${p.category}"`));
    } else {
      subCategoryId = sub.id;
      if (sub.is_printer_catalog) isPrinter = true;
    }
  }
  if (!categoryId) issues.push(err(p.line, 'category: القسم الرئيسي مطلوب'));
  // A sheet that names no section keeps the stored one — and its flag.
  if (!p.category && !p.sub_category) {
    for (const ref of maps.catalogs.values()) {
      if ((ref.id === categoryId || ref.id === subCategoryId) && ref.is_printer_catalog) isPrinter = true;
    }
  }

  const family =
    (subCategoryId ? maps.familyOf.get(subCategoryId) : null) ??
    (categoryId ? maps.familyOf.get(categoryId) : null) ??
    null;

  // ---- option groups and values, ids reused where they exist -------------
  const groupIdByName = new Map(existing?.groups.map((g) => [normKey(g.name_en), g.id]) ?? []);
  const valueIdByName = new Map(
    existing?.values.map((v) => [`${v.group_id}${normKey(v.name_en)}`, v.id]) ?? []
  );

  interface GroupOut {
    id: string;
    name_en: string;
    sort: number;
    active: boolean;
    values: Array<Record<string, unknown>>;
  }
  const groups: GroupOut[] = [];
  const groupByName = new Map<string, GroupOut>();
  /** pairKey(group, value) -> option value id, for colour links and bindings. */
  const valueIdByPair = new Map<string, string>();

  for (const o of p.options) {
    const gk = normKey(o.group);
    let g = groupByName.get(gk);
    if (!g) {
      g = {
        id: groupIdByName.get(gk) ?? opts.newId('og'),
        name_en: o.group,
        sort: groups.length,
        active: true,
        values: [],
      };
      groups.push(g);
      groupByName.set(gk, g);
    }
    if (valueIdByPair.has(pairKey(o.group, o.value))) {
      issues.push(err(o.line, `option: القيمة "${o.value}" مكررة داخل المجموعة "${o.group}"`));
      continue;
    }
    const id = valueIdByName.get(`${g.id}${normKey(o.value)}`) ?? opts.newId('ov');
    valueIdByPair.set(pairKey(o.group, o.value), id);
    if (o.image && !maps.images.has(o.image)) {
      issues.push(err(o.line, `image: تعذّر إيجاد "${o.image}"`));
    }
    g.values.push({
      id,
      name_en: o.value,
      sku_part: o.sku_part,
      image: imageUrl(o.image, o.line),
      sort: g.values.length,
      active: o.active,
      stock: o.stock,
      low_stock_threshold: o.low_stock_threshold,
      regular_price_iqd: o.price_iqd,
      prime_price_iqd: o.prime_price_iqd,
      pro_price_iqd: o.pro_price_iqd,
      cost_iqd: opts.money ? o.cost_iqd : null,
      // 0044 — carried through so a CSV round trip does not silently convert
      // an adjustment back into nothing.
      regular_adjust_iqd: o.regular_adjust_iqd,
      prime_adjust_iqd: o.prime_adjust_iqd,
      pro_adjust_iqd: o.pro_adjust_iqd,
      cost_adjust_iqd: opts.money ? o.cost_adjust_iqd : null,
      // 0043 — how THIS option is fulfilled, and which variant it belongs to.
      // parseImport reads these columns and serializeProducts writes them, so
      // dropping them here made a re-import of the store's OWN export reset
      // every option to 'inherit', wipe its lead time and re-derive
      // variant_key from the option name. planRelationsWrite normalises a
      // missing value to '' and writes it, so silence is not "leave alone".
      availability_type: o.availability_type,
      lead_time_text: o.lead_time_text,
      lead_time_min_days: o.lead_time_min_days,
      lead_time_max_days: o.lead_time_max_days,
      variant_key: o.variant_key,
      variant_label: o.variant_label,
    });
  }

  // ---- colours and their links -------------------------------------------
  const colorIdByName = new Map(existing?.colors.map((col) => [normKey(col.name_en), col.id]) ?? []);
  const colorIdByCsvName = new Map<string, string>();
  const colors = p.colors.map((col, i) => {
    const id = colorIdByName.get(normKey(col.name)) ?? opts.newId('pc');
    colorIdByCsvName.set(normKey(col.name), id);
    const linked: string[] = [];
    for (const l of col.links) {
      // parseImport already reported a pair with no option row; this maps only.
      const vid = valueIdByPair.get(pairKey(l.group, l.value));
      if (vid) linked.push(vid);
    }
    if (col.image && !maps.images.has(col.image)) {
      issues.push(err(col.line, `image: تعذّر إيجاد "${col.image}"`));
    }
    return {
      id,
      name_en: col.name,
      hex: col.hex,
      image: imageUrl(col.image, col.line),
      sku_part: col.sku_part,
      sort: i,
      active: col.active,
      stock: col.stock,
      low_stock_threshold: col.low_stock_threshold,
      regular_price_iqd: col.price_iqd,
      prime_price_iqd: col.prime_price_iqd,
      pro_price_iqd: col.pro_price_iqd,
      cost_iqd: opts.money ? col.cost_iqd : null,
      regular_adjust_iqd: col.regular_adjust_iqd,
      prime_adjust_iqd: col.prime_adjust_iqd,
      pro_adjust_iqd: col.pro_adjust_iqd,
      cost_adjust_iqd: opts.money ? col.cost_adjust_iqd : null,
      option_value_ids: linked,
    };
  });

  // ---- images ------------------------------------------------------------
  const imageIdByUrl = new Map(existing?.images.map((im) => [im.url, im.id]) ?? []);
  const images = p.images.map((im, i) => {
    const url = imageUrl(im.image, im.line);
    if (!url) issues.push(err(im.line, `image: تعذّر إيجاد "${im.image}"`));
    let optionValueId: string | null = null;
    let colorId: string | null = null;
    if (im.bind) {
      const idx = im.bind.indexOf(':');
      const kind = idx > 0 ? im.bind.slice(0, idx).trim().toLowerCase() : '';
      const rest = idx > 0 ? im.bind.slice(idx + 1).trim() : '';
      if (kind === 'color') {
        colorId = colorIdByCsvName.get(normKey(rest)) ?? null;
        if (!colorId) issues.push(err(im.line, `links: لا يوجد لون باسم "${rest}"`));
      } else if (kind === 'option') {
        const j = rest.indexOf(':');
        const vid = j > 0 ? valueIdByPair.get(pairKey(rest.slice(0, j), rest.slice(j + 1))) : undefined;
        optionValueId = vid ?? null;
        if (!optionValueId) issues.push(err(im.line, `links: لا يوجد خيار باسم "${rest}"`));
      } else {
        issues.push(err(im.line, 'links: الربط يُكتب color:Name أو option:Group:Value'));
      }
    }
    return {
      id: imageIdByUrl.get(url) ?? opts.newId('pi'),
      url,
      alt_en: im.alt,
      sort_order: i,
      is_primary: im.primary,
      option_value_id: optionValueId,
      color_id: colorId,
      variant_id: null,
    };
  });

  // ---- inventory mode ----------------------------------------------------
  let mode = p.inventory_mode.toUpperCase();
  if (!['BASE', 'OPTION', 'COLOR', 'VARIANT_COMBINATION'].includes(mode)) {
    issues.push(err(p.line, `inventory_mode: "${p.inventory_mode}" غير معروف`));
    mode = 'BASE';
  }
  const keptValueIds = new Set(groups.flatMap((g) => g.values.map((v) => v.id as string)));
  const keptColorIds = new Set(colors.map((col) => col.id));

  // A stored combination, keyed by the ids it selects, so a sheet row that
  // names the same selection lands on the SAME row — with its stock and its
  // reserved units — instead of creating a twin beside it.
  const comboSig = (valueIds: string[], colorId: string | null) =>
    [...valueIds].sort().join('|') + `#${colorId ?? ''}`;
  const existingByCombo = new Map<string, ExistingVariant>();
  for (const v of existing?.variants ?? []) {
    const sel = splitComboKey(v.combo_key);
    existingByCombo.set(comboSig(sel.option_value_ids, sel.color_id), v);
  }

  interface VariantOut {
    id: string;
    option_value_ids: string[];
    color_id: string | null;
    sku: string;
    active: boolean;
    stock: number | null;
    low_stock_threshold: number | null;
    regular_price_iqd: number | null;
    prime_price_iqd: number | null;
    pro_price_iqd: number | null;
    cost_iqd: number | null;
  }

  let variants: VariantOut[];
  if (p.variants.length > 0) {
    // The file talks about combinations, so the file decides which exist.
    variants = [];
    for (const v of p.variants) {
      const valueIds: string[] = [];
      let bad = false;
      for (const l of v.selection) {
        const vid = valueIdByPair.get(pairKey(l.group, l.value));
        if (!vid) {
          // parseImport already reported the missing option row by name; this
          // pass only refuses to build a combination out of nothing.
          bad = true;
          continue;
        }
        valueIds.push(vid);
      }
      const colorId = v.color ? (colorIdByCsvName.get(normKey(v.color)) ?? null) : null;
      if (v.color && !colorId) bad = true;
      if (bad) continue;
      const prev = existingByCombo.get(comboSig(valueIds, colorId));
      variants.push({
        id: prev?.id ?? opts.newId('pv'),
        option_value_ids: valueIds,
        color_id: colorId,
        sku: v.sku_part,
        active: v.active,
        stock: v.stock,
        low_stock_threshold: v.low_stock_threshold,
        regular_price_iqd: v.price_iqd,
        prime_price_iqd: v.prime_price_iqd,
        pro_price_iqd: v.pro_price_iqd,
        cost_iqd: opts.money ? v.cost_iqd : (prev?.cost_iqd ?? null),
      });
    }
    const dropped = (existing?.variants.length ?? 0) - variants.filter((v) => existingByCombo.has(comboSig(v.option_value_ids, v.color_id))).length;
    if (dropped > 0) {
      issues.push(warn(p.line, `سيُحذف ${dropped} من تركيبات المخزون لأن الملف لم يذكرها`));
    }
  } else {
    // The file says nothing about combinations, so the stored ones are carried
    // through — minus any that pointed at an option or colour the file removed.
    variants = (existing?.variants ?? [])
      .map((v) => {
        const sel = splitComboKey(v.combo_key);
        const alive =
          sel.option_value_ids.every((id) => keptValueIds.has(id)) &&
          (!sel.color_id || keptColorIds.has(sel.color_id));
        return alive
          ? {
              id: v.id,
              option_value_ids: sel.option_value_ids,
              color_id: sel.color_id,
              sku: v.sku ?? '',
              active: v.active === 1,
              stock: v.stock,
              low_stock_threshold: v.low_stock_threshold,
              regular_price_iqd: v.regular_price_iqd,
              prime_price_iqd: v.prime_price_iqd,
              pro_price_iqd: v.pro_price_iqd,
              cost_iqd: opts.money ? v.cost_iqd : null,
            }
          : null;
      })
      .filter((v): v is VariantOut => v !== null);
    if (variants.length < (existing?.variants.length ?? 0)) {
      issues.push(warn(p.line, 'حُذفت تركيبات مخزون كانت تشير إلى خيار أو لون لم يعد موجودًا في الملف'));
    }
  }
  if (mode === 'VARIANT_COMBINATION' && variants.length === 0) {
    issues.push(
      err(
        p.line,
        'inventory_mode=VARIANT_COMBINATION بلا توليفات — أضف أسطر variant أو غيّر مصدر المخزون'
      )
    );
  }

  // ---- the product document ----------------------------------------------
  //
  // Built ON TOP of the stored doc, never from scratch: labels, warranty
  // plans, content blocks and the rest are not in the template, and rebuilding
  // the doc from the CSV alone would erase them on every re-import.
  // §2 — THE SELLING TYPE IS DERIVED, NOT DECLARED.
  //
  // Two separate bugs used to live on this one line. First, an empty cell
  // meant 'direct_sale', so a narrow "prices only" sheet with no sale_types
  // column silently converted every pre-order product — the exact opposite of
  // this file's ABSENT MEANS PRESERVE rule. Second, the sheet's own word won
  // over the options, so a file could ship a product whose options say
  // pre-order and whose stages, cart shipping type and transports say direct
  // sale. deriveSaleTypes settles it the same way the form and the relations
  // writer do: options decide when any of them declares, otherwise the
  // declared (or stored) value stands, and 'bundle' survives either way.
  const declaredSaleTypes = p.sale_types.length
    ? p.sale_types
    : ((existing?.doc.sale_types as string[] | undefined) ?? ['direct_sale']);
  const saleTypes = deriveSaleTypes(
    groups.flatMap((g) => g.values as Array<{ availability_type?: AvailabilityType; active?: boolean }>),
    declaredSaleTypes
  );

  // SPEC FIELDS MERGE, THEY DO NOT REPLACE. A sheet only carries the columns
  // its section declares, so overwriting the whole map would silently erase a
  // value that was set while the product sat in a different section, or by a
  // field added to the family after this file was downloaded. Declared fields
  // follow the sheet exactly (a cleared cell clears the value); everything
  // else is left alone.
  const declared = new Set(opts.specFieldIds ?? Object.keys(p.spec_fields));
  const specFields: Record<string, string> = {};
  const storedSpecs = (existing?.doc.spec_fields as Record<string, string> | undefined) ?? {};
  for (const [k, v] of Object.entries(storedSpecs)) {
    if (!declared.has(k)) specFields[k] = v;
  }
  for (const [k, v] of Object.entries(p.spec_fields)) specFields[k] = v;
  // ---- the collections the child rows own ---------------------------------
  //
  // Each one is written ONLY when the file carried rows of that type; null
  // means "the sheet is silent", and silence preserves. Ids are reused by the
  // natural key a human would use (a plan's title, a spec's group+label) so a
  // re-import edits the row that exists instead of replacing it, which is what
  // keeps translation state and ordering stable.
  const idFor = (
    stored: Array<Record<string, unknown>> | undefined,
    match: (row: Record<string, unknown>) => boolean,
    prefix: string
  ): string => {
    const hit = (stored ?? []).find(match);
    return typeof hit?.id === 'string' && hit.id ? hit.id : opts.newId(prefix);
  };
  const storedGroups = (existing?.doc.spec_groups as Array<Record<string, unknown>> | undefined) ?? [];
  const storedLabels = (existing?.doc.labels as Array<Record<string, unknown>> | undefined) ?? [];
  const storedPlans = (existing?.doc.warranty_plans as Array<Record<string, unknown>> | undefined) ?? [];
  const storedBlocks = (existing?.doc.content_blocks as Array<Record<string, unknown>> | undefined) ?? [];
  const eq = (a: unknown, b: string) => typeof a === 'string' && normKey(a) === normKey(b);

  let specGroups: unknown = existing?.doc.spec_groups ?? [];
  if (p.specs !== null) {
    // Rows are grouped by their `group` cell, in first-appearance order; an
    // empty group cell collects into one untitled group rather than one group
    // per row, which is what a spreadsheet user expects.
    const order: string[] = [];
    const byGroup = new Map<string, typeof p.specs>();
    for (const row of p.specs) {
      const k = normKey(row.group);
      if (!byGroup.has(k)) {
        byGroup.set(k, []);
        order.push(k);
      }
      byGroup.get(k)!.push(row);
    }
    specGroups = order.map((k, gi) => {
      const rows = byGroup.get(k)!;
      const title = rows[0].group;
      const storedGroup = storedGroups.find((g) => eq(g.title_en, title) || eq(g.title_ar, title));
      const storedRows = (storedGroup?.rows as Array<Record<string, unknown>> | undefined) ?? [];
      return {
        id: typeof storedGroup?.id === 'string' && storedGroup.id ? storedGroup.id : opts.newId('sg'),
        title_en: title,
        title_ar: title,
        title_ckb: title,
        order: gi,
        rows: rows.map((row, ri) => ({
          id: idFor(storedRows, (x) => eq(x.label_en, row.label), 'sr'),
          label_en: row.label,
          label_ar: row.label,
          label_ckb: row.label,
          value_en: row.value,
          value_ar: row.value,
          value_ckb: row.value,
          unit: row.unit,
          order: ri,
        })),
      };
    });
  }

  let labels: unknown = existing?.doc.labels ?? [];
  if (p.labels !== null) {
    labels = p.labels.map((l, i) => ({
      id: idFor(storedLabels, (x) => (l.key ? x.key === l.key : eq(x.text_en, l.text)), 'lbl'),
      key: l.key,
      text_en: l.text,
      text_ar: l.text,
      text_ckb: l.text,
      icon: l.icon,
      order: i,
      visible: l.visible,
    }));
  }

  let warrantyPlans: unknown = existing?.doc.warranty_plans ?? [];
  if (p.warranty_plans !== null) {
    warrantyPlans = p.warranty_plans.map((w, i) => ({
      id: idFor(storedPlans, (x) => eq(x.title_en, w.title), 'wp'),
      title_en: w.title,
      title_ar: w.title,
      title_ckb: w.title,
      terms_en: w.terms,
      terms_ar: w.terms,
      terms_ckb: w.terms,
      duration_months: w.duration_months,
      duration_kind: w.duration_kind,
      fee_iqd: w.fee_iqd ?? 0,
      fee_percent: w.fee_percent,
      order: i,
      active: w.active,
    }));
  }

  // Device coverage: the sheet's cell when it says something, else what is
  // stored (an empty cell never un-configures a printer from a spreadsheet).
  // The rest of ops_policy rides along untouched, as every other stored field.
  const storedOps = readOpsWarranty(existing?.doc.ops_policy ?? {});
  const coverage = {
    warranty_base_months: p.warranty_base_months ?? storedOps.warranty_base_months,
    serialized: p.serialized ?? storedOps.serialized,
  };
  // Extended warranty is for printers only (owner mandate). The rules and the
  // printer defaults (serialized, 12-month base) are applied here so the
  // PREVIEW refuses a warranty row on a non-printer with its line number; the
  // confirm re-checks against the catalog table.
  /**
   * OPEN BOX / USED / REFURBISHED, from the sheet or from what is stored.
   *
   * `undefined` is a sheet with no condition columns — every sheet written
   * before the feature — and keeps the stored document. `null` is an explicit
   * empty `condition_kind`, which DOES clear a grade, so a listing can be
   * returned to new from a sheet on purpose.
   *
   * The block is re-parsed through the same `parseConditionDoc` the admin form
   * and the database go through, so a sheet cannot introduce a kind, a grade or
   * an unbounded hour count the rest of the system would refuse. An unknown
   * `condition_kind` parses to null (= new) and is reported rather than stored.
   */
  // `existing.doc` is a Record<string, unknown>, so the stored value is
  // re-parsed rather than cast — the same validation a fresh sheet goes
  // through, applied to what is already in the column.
  let condition: ConditionDoc | null = parseConditionDoc(existing?.doc.condition);
  if (p.condition !== undefined) {
    if (p.condition === null) {
      condition = null;
    } else {
      const resolvedNewId = p.condition.new_product_slug
        ? (maps.productSlugs.get(p.condition.new_product_slug.toLowerCase()) ?? null)
        : null;
      if (p.condition.new_product_slug && !resolvedNewId) {
        issues.push(
          err(p.line, `condition_new_product_slug: no product with slug "${p.condition.new_product_slug}" — the new-price comparison would be blank`)
        );
      }
      condition = parseConditionDoc({ ...p.condition, new_product_id: resolvedNewId });
      if (!condition) {
        issues.push(
          err(p.line, `condition_kind: "${p.condition.kind}" is not one of open_box, used, refurbished`)
        );
      }
    }
  }

  const guard = {
    warranty_plans: (Array.isArray(warrantyPlans) ? warrantyPlans : []) as Array<{
      id: string; duration_months: number; duration_kind: 'total' | 'extension'; fee_iqd: number; fee_percent?: number | null; active: boolean;
    }>,
    serialized: coverage.serialized,
    warranty_base_months: coverage.warranty_base_months,
    // So the PREVIEW refuses an extension on a used unit with its line number,
    // and so a graded listing gets the owner's 1-or-12 base rather than the
    // printer default.
    condition,
  };
  for (const message of printerWarrantyRules(guard, isPrinter)) {
    issues.push(err(p.warranty_plans?.[0]?.line ?? p.line, message));
  }
  coverage.serialized = guard.serialized;
  coverage.warranty_base_months = guard.warranty_base_months;

  let contentBlocks: unknown = existing?.doc.content_blocks ?? [];
  if (p.content_blocks !== null) {
    contentBlocks = p.content_blocks.map((b, i) => {
      /*
       * A CONTENT BLOCK HAS ONE `url` FIELD AND TWO THINGS WANT IT.
       *
       * The column is a LINK when the row has no image (a vendor page, a
       * video — the live A1 carries `https://us.store.bambulab.com/...` on
       * five text blocks) and it is the PICTURE when the row names an image
       * cell. So when a cell is named it wins, and the author's link is not
       * kept: there is nowhere to keep it.
       *
       * What changed is the `?? b.url` fallback that used to sit on the end.
       * With it, an image cell that FAILED to resolve fell back to the block's
       * own link, and a vendor page URL quietly became the block's image.
       */
      const url = b.image ? imageUrl(b.image, b.line) : b.url;
      if (b.image && !maps.images.has(b.image)) {
        issues.push(err(b.line, `image: تعذّر إيجاد "${b.image}"`));
      }
      return {
        id: idFor(storedBlocks, (x) => x.kind === b.kind && eq(x.body_en, b.body), 'cb'),
        kind: b.kind,
        order: i,
        body_en: b.body,
        body_ar: b.body,
        body_ckb: b.body,
        caption_en: b.caption,
        caption_ar: b.caption,
        caption_ckb: b.caption,
        alt_en: b.alt,
        alt_ar: b.alt,
        alt_ckb: b.alt,
        url,
        media_key: '',
      };
    });
  }

  let usageGuide: unknown =
    existing?.doc.usage_guide ?? { official_url: '', steps: [] };
  if (p.guide_steps !== null || p.usage_url !== null) {
    const storedGuide = (existing?.doc.usage_guide as { official_url?: string; steps?: unknown[] } | undefined) ?? {};
    const storedSteps = (storedGuide.steps as Array<Record<string, unknown>> | undefined) ?? [];
    usageGuide = {
      official_url: p.usage_url !== null ? p.usage_url : (storedGuide.official_url ?? ''),
      steps:
        p.guide_steps === null
          ? storedSteps
          : p.guide_steps.map((step, i) => {
              const urls: string[] = [];
              for (const cell of step.images) {
                const resolved = imageUrl(cell, step.line);
                if (!resolved) issues.push(err(step.line, `image: تعذّر إيجاد "${cell}"`));
                else urls.push(resolved);
              }
              return {
                id: idFor(storedSteps, (x) => eq(x.title, step.title), 'gs'),
                kind: step.kind,
                title: step.title,
                body: step.body,
                images: urls,
                video_url: step.video_url,
                link_url: step.link_url,
                order: i,
              };
            }),
    };
  }

  let transports: unknown = existing?.doc.preorder_transports ?? [];
  if (p.transports !== null) {
    transports = p.transports.map((tr) => ({
      method: tr.method,
      commission_iqd: tr.commission_iqd,
      active: tr.active,
    }));
  }

  const doc: Record<string, unknown> = {
    ...(existing?.doc ?? {}),
    id: productId,
    // The SKU column wins when the sheet carries one; otherwise the row key is
    // the SKU, which is what it was before the column existed.
    sku: p.sku || p.key,
    name_en: p.name,
    // §3: the NAME is never translated. The Arabic and Kurdish slots carry the
    // English text verbatim so every interface reads the same string.
    name_ar: p.name,
    name_ckb: p.name,
    description_en: p.description,
    status: ['draft', 'active', 'hidden'].includes(p.status) ? p.status : 'draft',
    display_order: p.display_order ?? 0,
    price_iqd: p.price_iqd ?? 0,
    prime_price_iqd: p.prime_price_iqd,
    pro_price_iqd: p.pro_price_iqd,
    product_cost_iqd: opts.money ? p.cost_iqd : ((existing?.doc.product_cost_iqd as number | null) ?? null),
    stock: p.stock,
    low_stock_threshold: p.low_stock_threshold,
    direct_surcharge_iqd: p.direct_surcharge_iqd,
    sale_types: saleTypes,
    selling_type: saleTypes[0],
    is_featured: p.is_featured === null ? (existing?.doc.is_featured ?? false) : p.is_featured,
    payment_options:
      p.payment_options === null
        ? ((existing?.doc.payment_options as string[] | undefined) ?? [])
        : p.payment_options,
    how_to_use: p.how_to_use === null ? ((existing?.doc.how_to_use as string | undefined) ?? '') : p.how_to_use,
    /**
     * «رابط المنتج في تطبيق جني» — 0104's instalments link, and until this
     * line the one column of the sheet that was parsed, labelled, exported and
     * then dropped on the floor. Every other side of the pipeline was already
     * complete (importCsv.ts declares it, reads it and writes it into every
     * export), so the owner could export 200 products, paste in the Gini
     * links, re-upload, be told every row succeeded — and have nothing saved:
     * an UPDATE kept the stored value through the `existing.doc` spread above,
     * so the cell was an inert no-op, and a CREATE was written with '' because
     * `safeLink(undefined)` is ''. No RowIssue, no preview error, nothing to
     * diagnose; the «تريدها أقساط؟» note simply never appeared.
     *
     * Same null-means-preserve rule as `how_to_use` directly above: `null` is
     * "the sheet has no such column" (an older export must not strip a link
     * it never carried) and '' is "the cell is blank", which clears it.
     */
    gini_url: p.gini_url === null ? ((existing?.doc.gini_url as string | undefined) ?? '') : p.gini_url,
    preorder_transports: transports,
    spec_groups: specGroups,
    labels,
    warranty_plans: warrantyPlans,
    warranty_base_months: coverage.warranty_base_months,
    serialized: coverage.serialized,
    /**
     * OPEN BOX / USED / REFURBISHED. Resolved above (the slug of the new
     * product it is a copy of is looked up, the kind is validated, and the
     * warranty guard is already run against it) — and then, until this line,
     * left out of the document, so the sheet's grade was parsed, validated,
     * reported on, and thrown away. Worse than ignoring the columns: a row
     * could be REFUSED for a bad `condition_kind` whose good value would have
     * been discarded anyway.
     *
     * `null` clears a grade, which is why this is written unconditionally
     * rather than only when truthy: the spread of `existing.doc` above would
     * otherwise make a listing impossible to un-grade from a sheet.
     */
    condition,
    /**
     * «الأبعاد والوزن», MERGED PER KEY rather than replaced wholesale.
     *
     * A sheet written before these columns existed carries eight nulls, and
     * overwriting a measured product with them would quietly wipe every
     * dimension on the shop's catalogue the first time the owner re-imported
     * an old file. So a null keeps what is stored and only a stated number
     * changes anything — the same rule `delivery_options` below follows, and
     * for the same reason.
     *
     * Clearing a measurement is therefore not expressible in a sheet, which is
     * the right trade: a mis-measured box is corrected by measuring it again,
     * and there is no reason to un-know a weight.
     */
    dimensions: (() => {
      const stored = parseDimensions(
        (existing?.doc.dimensions as Record<string, unknown> | undefined) ?? undefined
      );
      const out = { ...stored };
      for (const k of DIMENSION_FIELDS) if (p.dimensions[k] !== null) out[k] = p.dimensions[k];
      return out;
    })(),
    delivery_options:
      p.delivery_options === null
        ? (existing?.doc.delivery_options ?? undefined)
        : p.delivery_options,
    ops_policy: storedOps.policy,
    content_blocks: contentBlocks,
    usage_guide: usageGuide,
    brand_id: brandId,
    category_id: categoryId,
    sub_category_id: subCategoryId,
    template_family: family,
    spec_fields: specFields,
    // Hashtags are free text: a sheet may carry a tag the vocabulary has not
    // seen, and confirm registers it. A sheet WITHOUT the column keeps the
    // stored tags, so an older export does not strip them on re-import.
    hashtags:
      p.hashtags === null
        ? ((existing?.doc.hashtags as string[] | undefined) ?? [])
        : p.hashtags.map(normalizeHashtag).filter(Boolean),
    // The legacy JSON mirrors carry the SAME ids as the relational rows, so a
    // reader that has not moved to the relational tables sees one structure.
    // The v2 shape names the field `regular_price_iqd` (worker/lib/pricing.ts
    // PriceFields). Writing `price_iqd` here — as this mirror used to — meant
    // every mirrored option and colour price read back as null, so any reader
    // still on the JSON columns showed the base price for every option.
    options: groups.flatMap((g) =>
      g.values.map((v) => ({
        id: v.id,
        name_en: `${g.name_en}: ${v.name_en as string}`,
        name_ar: `${g.name_en}: ${v.name_en as string}`,
        image: v.image,
        regular_price_iqd: v.regular_price_iqd,
        prime_price_iqd: v.prime_price_iqd,
        pro_price_iqd: v.pro_price_iqd,
        cost_iqd: v.cost_iqd,
        regular_adjust_iqd: v.regular_adjust_iqd,
        prime_adjust_iqd: v.prime_adjust_iqd,
        pro_adjust_iqd: v.pro_adjust_iqd,
        cost_adjust_iqd: v.cost_adjust_iqd,
        active: v.active,
        // Mirrored too: deriveSaleTypes reads the JSON options for a product
        // that has no relational rows, so an availability written only to the
        // relational side would be invisible to it.
        availability_type: v.availability_type,
        lead_time_text: v.lead_time_text,
        lead_time_min_days: v.lead_time_min_days,
        lead_time_max_days: v.lead_time_max_days,
        variant_key: v.variant_key,
        variant_label: v.variant_label,
      }))
    ),
    colors: colors.map((col) => ({
      id: col.id,
      name_en: col.name_en,
      name_ar: col.name_en,
      hex: col.hex,
      image: col.image,
      option_id: col.option_value_ids.length === 1 ? col.option_value_ids[0] : null,
      regular_price_iqd: col.regular_price_iqd,
      prime_price_iqd: col.prime_price_iqd,
      pro_price_iqd: col.pro_price_iqd,
      cost_iqd: col.cost_iqd,
      regular_adjust_iqd: col.regular_adjust_iqd,
      prime_adjust_iqd: col.prime_adjust_iqd,
      pro_adjust_iqd: col.pro_adjust_iqd,
      cost_adjust_iqd: col.cost_adjust_iqd,
      active: col.active,
    })),
    media: images.map((im) => ({
      id: im.id,
      url: im.url,
      alt_en: im.alt_en,
      order: im.sort_order,
      primary: im.is_primary,
    })),
  };

  /**
   * 0075 — THE ORDER-TYPE CELLS, ONLY WHEN THE SHEET SPEAKS ABOUT THEM.
   *
   * `p.fulfillments === null` means the file carries no `fulfillment` row, so
   * nothing is attached and the writer leaves every stored cell exactly as it
   * is — which is every sheet written before 0075 and every narrowed-down
   * price sheet. That silence is the whole back-compat story.
   *
   * When the file DOES speak, the payload must be COMPLETE: the writer
   * replaces the product's whole set, so the merge starts from the stored
   * cells (all their prices and lead times intact) and the sheet only moves
   * `capacity` and `enabled`. Every value then carries a `fulfillments` array
   * — an empty one included — because a value that carries none would have
   * its cells dropped instead of kept.
   */
  if (p.fulfillments !== null) {
    type Cell = ExistingCellRow;
    const cellsByOption = new Map<string, Map<string, Cell>>();
    const liveValueIds = new Set(groups.flatMap((g) => g.values.map((v) => String(v.id))));
    for (const stored of existing?.fulfillments ?? []) {
      // A cell whose model is not in this file is dropped rather than sent:
      // the structure write is about to remove that option row, and naming it
      // here would be refused as UNKNOWN_OPTION.
      if (!liveValueIds.has(stored.option_id)) continue;
      const byType = cellsByOption.get(stored.option_id) ?? new Map<string, Cell>();
      byType.set(stored.fulfillment_type, {
        ...stored,
        transports: (stored.transports ?? []).map((t) => ({ ...t })),
      });
      cellsByOption.set(stored.option_id, byType);
    }

    for (const fl of p.fulfillments) {
      const optionId = valueIdByPair.get(pairKey(fl.group, fl.value));
      if (!optionId) {
        // parseImport already refused a row naming a model the file does not
        // declare; this is the case where the model is stored but the file
        // renamed or dropped it, and there is nothing to hang the cell on.
        issues.push(err(fl.line, `fulfillment: لا يوجد موديل باسم "${fl.group}:${fl.value}"`));
        continue;
      }
      const byType = cellsByOption.get(optionId) ?? new Map<string, Cell>();
      cellsByOption.set(optionId, byType);
      const cell: Cell = byType.get(fl.fulfillment_type) ?? {
        option_id: optionId,
        fulfillment_type: fl.fulfillment_type,
        transports: [],
      };
      cell.option_id = optionId;
      if (fl.method) {
        // A ROUTE ROW. Its `enabled` and `capacity` belong to the route, never
        // to the cell — and an absent capacity leaves the route drawing on the
        // cell's shared pool, which is what `null` already means.
        const routes = cell.transports;
        let route = routes.find((t) => t.method === fl.method);
        if (!route) {
          route = { method: fl.method };
          routes.push(route);
        }
        // Both cells are "absent means preserve": a row that states only a
        // quota must not also flip a route the owner switched off back on.
        if (fl.enabled !== undefined) route.enabled = fl.enabled;
        if (fl.capacity !== undefined) route.capacity = fl.capacity;
      } else {
        if (fl.enabled !== undefined) cell.enabled = fl.enabled;
        // `undefined` is "the cell was blank": keep the stored number. Only a
        // stated value — a number, or __NULL__/__CLEAR__ for untracked —
        // moves it. Nothing here touches `capacity_reserved`, which the
        // writer carries across the replace on its own.
        if (fl.capacity !== undefined) cell.capacity = fl.capacity;
      }
      byType.set(fl.fulfillment_type, cell);
    }

    for (const g of groups) {
      for (const v of g.values) {
        v.fulfillments = [...(cellsByOption.get(String(v.id))?.values() ?? [])];
      }
    }
  }

  const relations: Record<string, unknown> = {
    inventory_mode: mode,
    groups: groups.map((g) => ({ id: g.id, name_en: g.name_en, sort: g.sort, active: g.active, values: g.values })),
    colors,
    variants,
    images,
    // No `facet_ids`: the sheet has no filters column any more, and an absent
    // key means PRESERVE in planRelationsWrite — a re-import must not clear
    // filters an admin set before the picker was removed.
  };

  return {
    key: p.key,
    line: p.line,
    productId,
    action: existing ? 'update' : 'create',
    doc,
    relations,
    catalogIds: [...new Set([categoryId, subCategoryId].filter((x): x is string => !!x))],
    membership: p.membership_rules,
    issues,
  };
}

/**
 * 0075 — THE MODELS A RELATIONS BODY CARRIES, flattened to (id, cells).
 *
 * `resolveProduct` hangs a value's order-type cells off the value itself, and
 * `planRelationsWriteFrom` carries the same key through to
 * `RelationsPlan.requested.values`. Both shapes are read here so the PREVIEW
 * (which has the resolved body) and the CONFIRM (which has the planned rows)
 * ask about exactly the same cells — a preview answering about a different set
 * from the one the write moves is worse than either answer alone.
 */
export function relationValues(
  relations: Record<string, unknown>
): Array<{ id: string; fulfillments?: unknown }> {
  const groups = Array.isArray(relations.groups) ? (relations.groups as Array<Record<string, unknown>>) : [];
  const out: Array<{ id: string; fulfillments?: unknown }> = [];
  for (const g of groups) {
    const values = Array.isArray(g?.values) ? (g.values as Array<Record<string, unknown>>) : [];
    for (const v of values) out.push({ id: String(v?.id ?? ''), fulfillments: v?.fulfillments });
  }
  return out;
}

/**
 * 0075 — THE ONE PAYLOAD `parseFulfillmentPayload` READS, built from those
 * models, or `null` when the sheet said nothing about order types.
 *
 * `null` is not an empty payload and the difference is the whole
 * back-compatibility story: a sheet with no `fulfillment` row must leave every
 * stored cell exactly as it is, while a sheet that HAS one replaces the
 * product's whole set (`resolveProduct` merges the stored cells in first, so
 * "replace" loses nothing the file did not speak about). An empty
 * `{ fulfillments: [] }` would delete them all.
 *
 * The option id is stamped on from the model that carries the cell rather than
 * trusted from the row, exactly as `planProductSave` does it — a cell can only
 * ever name the model it hangs off.
 */
export function fulfillmentPayloadFrom(
  values: readonly { id: string; fulfillments?: unknown }[]
): { fulfillments: unknown[] } | null {
  if (!values.some((v) => Array.isArray(v.fulfillments))) return null;
  const fulfillments: unknown[] = [];
  for (const v of values) {
    if (!Array.isArray(v.fulfillments)) continue;
    for (const raw of v.fulfillments) {
      fulfillments.push({ ...(raw as Record<string, unknown>), option_id: v.id });
    }
  }
  return { fulfillments };
}
