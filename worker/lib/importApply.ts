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
 * WHAT THE SPREADSHEET DELIBERATELY CANNOT EXPRESS. Variant combinations
 * (`inventory_mode = VARIANT_COMBINATION`) are generated from options x colours
 * in the form, where the admin can see the grid. A CSV row cannot name one
 * unambiguously, so existing combinations are carried through untouched and a
 * NEW product may not claim that mode. Saying so is better than accepting the
 * column and quietly producing a product nothing can be sold from.
 */

import type { ParsedProduct, RowIssue } from './importCsv';

export interface CatalogRef {
  id: string;
  parent_id: string | null;
  slug: string;
  name_en: string;
  name_ar: string;
  template_family: string | null;
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
}

export interface ImportMaps {
  /** normalized brand name or slug -> brand id */
  brands: Map<string, string>;
  /** normalized catalog slug, English name or Arabic name -> catalog */
  catalogs: Map<string, CatalogRef>;
  /** normalized facet slug or English name -> facet id */
  facets: Map<string, string>;
  /** catalog id -> the family inherited down its branch */
  familyOf: Map<string, 'devices' | 'materials' | null>;
  /** image cell (ZIP filename or URL) -> the stored delivery URL */
  images: Map<string, string>;
}

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

  // ---- brand -------------------------------------------------------------
  let brandId: string | null = (existing?.doc.brand_id as string | null) ?? null;
  if (p.brand) {
    const found = maps.brands.get(normKey(p.brand));
    if (!found) {
      // §4 takes the brand from a managed list. Inventing one from a
      // spreadsheet cell is how a catalogue ends up with "Bambu", "bambu lab"
      // and "BambuLab" as three separate brands.
      issues.push(err(p.line, `brand: لا توجد علامة تجارية باسم "${p.brand}" — أضفها أولًا من إدارة العلامات`));
    } else {
      brandId = found;
    }
  }

  // ---- section and sub-section -------------------------------------------
  let categoryId: string | null = (existing?.doc.category_id as string | null) ?? null;
  let subCategoryId: string | null = (existing?.doc.sub_category_id as string | null) ?? null;
  if (p.category) {
    const cat = maps.catalogs.get(normKey(p.category));
    if (!cat) issues.push(err(p.line, `category: لا يوجد قسم باسم "${p.category}"`));
    else categoryId = cat.id;
  }
  if (p.sub_category) {
    const sub = maps.catalogs.get(normKey(p.sub_category));
    if (!sub) {
      issues.push(err(p.line, `sub_category: لا يوجد قسم فرعي باسم "${p.sub_category}"`));
    } else if (categoryId && sub.parent_id !== categoryId) {
      // §4: the sub-section is limited to the children of the main section.
      issues.push(err(p.line, `sub_category: "${p.sub_category}" ليس قسمًا فرعيًا من "${p.category}"`));
    } else {
      subCategoryId = sub.id;
    }
  }
  if (!categoryId) issues.push(err(p.line, 'category: القسم الرئيسي مطلوب'));

  const family =
    (subCategoryId ? maps.familyOf.get(subCategoryId) : null) ??
    (categoryId ? maps.familyOf.get(categoryId) : null) ??
    null;

  // ---- facets ------------------------------------------------------------
  const facetIds: string[] = [];
  for (const f of p.facets) {
    const id = maps.facets.get(normKey(f));
    if (!id) issues.push(err(p.line, `facets: لا يوجد فلتر باسم "${f}"`));
    else facetIds.push(id);
  }

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
      image: o.image ? (maps.images.get(o.image) ?? '') : '',
      sort: g.values.length,
      active: o.active,
      stock: o.stock,
      low_stock_threshold: o.low_stock_threshold,
      regular_price_iqd: o.price_iqd,
      prime_price_iqd: o.prime_price_iqd,
      pro_price_iqd: o.pro_price_iqd,
      cost_iqd: opts.money ? o.cost_iqd : null,
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
      image: col.image ? (maps.images.get(col.image) ?? '') : '',
      sku_part: col.sku_part,
      sort: i,
      active: col.active,
      stock: col.stock,
      low_stock_threshold: col.low_stock_threshold,
      regular_price_iqd: col.price_iqd,
      prime_price_iqd: col.prime_price_iqd,
      pro_price_iqd: col.pro_price_iqd,
      cost_iqd: opts.money ? col.cost_iqd : null,
      option_value_ids: linked,
    };
  });

  // ---- images ------------------------------------------------------------
  const imageIdByUrl = new Map(existing?.images.map((im) => [im.url, im.id]) ?? []);
  const images = p.images.map((im, i) => {
    const url = maps.images.get(im.image) ?? '';
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
  // Combinations are preserved, never invented: a new product asking for the
  // mode has nothing to preserve, and a silent BASE fallback would sell stock
  // the admin thinks is tracked per combination.
  const keptValueIds = new Set(groups.flatMap((g) => g.values.map((v) => v.id as string)));
  const keptColorIds = new Set(colors.map((col) => col.id));
  const variants = (existing?.variants ?? [])
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
    .filter((v): v is NonNullable<typeof v> => v !== null);
  if (variants.length < (existing?.variants.length ?? 0)) {
    issues.push(warn(p.line, 'حُذفت تركيبات مخزون كانت تشير إلى خيار أو لون لم يعد موجودًا في الملف'));
  }
  if (mode === 'VARIANT_COMBINATION' && variants.length === 0) {
    issues.push(
      err(
        p.line,
        'inventory_mode=VARIANT_COMBINATION لا يمكن إنشاؤه من ملف — ركّب التوليفات من نموذج المنتج ثم صدّر'
      )
    );
  }

  // ---- the product document ----------------------------------------------
  //
  // Built ON TOP of the stored doc, never from scratch: labels, warranty
  // plans, content blocks and the rest are not in the template, and rebuilding
  // the doc from the CSV alone would erase them on every re-import.
  const saleTypes = p.sale_types.length ? p.sale_types : ['direct_sale'];

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
  const doc: Record<string, unknown> = {
    ...(existing?.doc ?? {}),
    id: productId,
    sku: p.key,
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
    sale_types: saleTypes,
    selling_type: saleTypes[0],
    brand_id: brandId,
    category_id: categoryId,
    sub_category_id: subCategoryId,
    template_family: family,
    spec_fields: specFields,
    // The legacy JSON mirrors carry the SAME ids as the relational rows, so a
    // reader that has not moved to the relational tables sees one structure.
    options: groups.flatMap((g) =>
      g.values.map((v) => ({
        id: v.id,
        name_en: `${g.name_en}: ${v.name_en as string}`,
        name_ar: `${g.name_en}: ${v.name_en as string}`,
        image: v.image,
        price_iqd: v.regular_price_iqd,
        prime_price_iqd: v.prime_price_iqd,
        pro_price_iqd: v.pro_price_iqd,
        cost_iqd: v.cost_iqd,
        active: v.active,
      }))
    ),
    colors: colors.map((col) => ({
      id: col.id,
      name_en: col.name_en,
      name_ar: col.name_en,
      hex: col.hex,
      image: col.image,
      option_id: col.option_value_ids.length === 1 ? col.option_value_ids[0] : null,
      price_iqd: col.regular_price_iqd,
      prime_price_iqd: col.prime_price_iqd,
      pro_price_iqd: col.pro_price_iqd,
      cost_iqd: col.cost_iqd,
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

  const relations: Record<string, unknown> = {
    inventory_mode: mode,
    groups: groups.map((g) => ({ id: g.id, name_en: g.name_en, sort: g.sort, active: g.active, values: g.values })),
    colors,
    variants,
    images,
    facet_ids: facetIds,
  };

  return {
    key: p.key,
    line: p.line,
    productId,
    action: existing ? 'update' : 'create',
    doc,
    relations,
    catalogIds: [...new Set([categoryId, subCategoryId].filter((x): x is string => !!x))],
    issues,
  };
}
