/**
 * THE TXT TEMPLATE'S BRIDGE INTO THE RELATIONAL TABLES.
 *
 * ---------------------------------------------------------------------------
 * The defect this closes
 * ---------------------------------------------------------------------------
 * `GET /api/admin/template/export/:productId` was taught to read the
 * relational tables, so it now exports the real options, colours and images of
 * every product built in the admin form. `POST /apply` then REFUSED that same
 * file — `TXT_CANNOT_WRITE_RELATIONS` — because the TXT path could only write
 * the `products` JSON mirror, which nothing reads once relational rows exist.
 * The store's own export was un-importable: download → edit → upload, the
 * whole point of the format, was impossible for exactly the products the owner
 * builds every day.
 *
 * Rather than teach the template a second way to write option trees, this
 * translates a parsed template's doc into the SAME wire body the admin form
 * PUTs to `/api/admin/products/:id/relations`, and the apply route hands it to
 * `planRelationsWrite` — the one writer the form and the CSV importer already
 * share. One writer means one set of rules about linked colours, duplicate
 * ids, price ladders and primary images, and no third dialect to drift.
 *
 * ---------------------------------------------------------------------------
 * Two things it must never lose
 * ---------------------------------------------------------------------------
 * 1. VARIANTS. `planRelationsWrite` replaces the variant list wholesale, and
 *    the TXT format has no key for a modelled combination. Left out, applying
 *    a text edit would silently delete every per-combination price and stock
 *    the owner set in the form. So the existing variants are read back from
 *    the database and passed through unchanged.
 * 2. FACETS. Omitting `facet_ids` means "preserve" in the writer, which is
 *    what the template wants — it has no filter keys at all.
 */

import type { ProductDoc } from './productModel';
import type { ProductRelationsView } from './productOverlay';
import { newId } from './crypto';
import { isInventoryMode, type InventoryMode } from './inventory';

/** What the bridge decided on the file's behalf — surfaced by the route as
 *  warnings, never swallowed. */
export interface BridgeDiagnostics {
  warnings: string[];
}

/**
 * WHICH LEVEL COUNTS THE STOCK — the rule the admin form applies on every
 * save (src/components/adminProducts/form/model.ts deriveInventoryMode),
 * applied here so a file lands with the same answer the form would give:
 * an explicit mode wins; otherwise a colour with a stock number means COLOR,
 * an option with one means OPTION, a product already tracking modelled
 * combinations that still has some keeps VARIANT_COMBINATION, and anything
 * else is BASE.
 */
export function deriveInventoryModeFromDoc(
  doc: ProductDoc,
  view: ProductRelationsView,
  explicit: string | undefined,
  keptVariants: number
): InventoryMode {
  if (explicit && isInventoryMode(explicit)) return explicit;
  if (view.inventory_mode === 'VARIANT_COMBINATION' && keptVariants > 0) return 'VARIANT_COMBINATION';
  if (doc.colors.some((c) => (c.stock ?? null) !== null)) return 'COLOR';
  if (doc.options.some((o) => (o.stock ?? null) !== null)) return 'OPTION';
  return 'BASE';
}

/** One option group, rebuilt from the flat `options.N.group` column. */
interface GroupOut {
  id: string;
  name_en: string;
  sort: number;
  active: boolean;
  values: Record<string, unknown>[];
}

const priceBag = (o: {
  regular_price_iqd: number | null;
  prime_price_iqd: number | null;
  pro_price_iqd: number | null;
  cost_iqd: number | null;
  regular_adjust_iqd?: number | null;
  prime_adjust_iqd?: number | null;
  pro_adjust_iqd?: number | null;
  cost_adjust_iqd?: number | null;
}) => ({
  regular_price_iqd: o.regular_price_iqd,
  prime_price_iqd: o.prime_price_iqd,
  pro_price_iqd: o.pro_price_iqd,
  cost_iqd: o.cost_iqd,
  regular_adjust_iqd: o.regular_adjust_iqd ?? null,
  prime_adjust_iqd: o.prime_adjust_iqd ?? null,
  pro_adjust_iqd: o.pro_adjust_iqd ?? null,
  cost_adjust_iqd: o.cost_adjust_iqd ?? null,
});

/**
 * Decompose a stored `combo_key` back into the selection that produced it.
 * The writer recomputes the key itself and never trusts a client-sent one, so
 * a variant can only survive a round trip by being handed back its parts.
 */
export function selectionFromComboKey(key: string): { option_value_ids: string[]; color_id: string | null } {
  const option_value_ids: string[] = [];
  let color_id: string | null = null;
  for (const part of key.split('|')) {
    if (part.startsWith('o:')) option_value_ids.push(part.slice(2));
    else if (part.startsWith('c:')) color_id = part.slice(2);
  }
  return { option_value_ids, color_id };
}

/**
 * The wire body for `planRelationsWrite`, built from a template-parsed doc.
 *
 * `view` is the product's CURRENT relational state, used only to carry the
 * variants the template cannot express. Everything else comes from the doc,
 * so a key the owner deleted from the file really is a deletion.
 */
export function relationsBodyFromDoc(
  doc: ProductDoc,
  view: ProductRelationsView,
  opts: { inventoryMode?: string; diag?: BridgeDiagnostics } = {}
): Record<string, unknown> {
  const warn = (msg: string) => opts.diag?.warnings.push(msg);
  // ---- groups, rebuilt from the flat rows --------------------------------
  // Rows that name the same group belong together, in first-appearance order.
  // A row that names none joins the first group, so a file written before this
  // key existed still produces exactly one group, as it always did.
  const groups: GroupOut[] = [];
  const byKey = new Map<string, GroupOut>();
  const existingGroupIdByName = new Map(view.groups.map((g) => [g.name_en.trim().toLowerCase(), g.id]));
  const existingGroupById = new Map(view.groups.map((g) => [g.id, g]));
  // Where each option value sits TODAY. This is what lets a file that never
  // heard of the `group` key leave the groups exactly as they were.
  const groupIdOfValue = new Map(view.values.map((v) => [v.id, v.group_id]));

  const groupOut = (id: string, name: string): GroupOut => {
    const key = `id:${id}`;
    const found = byKey.get(key);
    if (found) return found;
    const made: GroupOut = { id, name_en: name, sort: groups.length, active: true, values: [] };
    groups.push(made);
    byKey.set(key, made);
    byKey.set(`name:${name.trim().toLowerCase()}`, made);
    return made;
  };

  /**
   * Which group an option row belongs to.
   *
   * Three cases, in order, and the order is what keeps old files safe:
   *
   *  1. The row NAMES a group. A name that matches an existing group reuses
   *     that group's id — a rename would otherwise delete the group row, and
   *     `ON DELETE CASCADE` on product_option_values would take its values
   *     with it and re-insert them with their reserved units zeroed. So a
   *     renamed group is matched by the id its values still carry.
   *  2. The row names nothing but ALREADY EXISTS. It stays in the group it is
   *     in. This is every row of a file exported before the `group` key
   *     existed: without it they all collapsed into the first group, deleting
   *     every other group in the product.
   *  3. The row names nothing and is new. It joins the first group — the only
   *     defensible guess, and correct for the single-group products that are
   *     the common case.
   */
  const groupFor = (o: { id: string; group_en?: string }): GroupOut => {
    const name = (o.group_en ?? '').trim();
    if (name) {
      const byName = byKey.get(`name:${name.toLowerCase()}`);
      if (byName) return byName;
      const existingId = existingGroupIdByName.get(name.toLowerCase());
      if (existingId) return groupOut(existingId, name);
      // A rename: this row's own group still exists under its old name, and
      // reusing its id renames it in place instead of deleting it.
      const currentId = groupIdOfValue.get(o.id);
      const current = currentId ? existingGroupById.get(currentId) : undefined;
      if (current && !byKey.has(`id:${current.id}`)) return groupOut(current.id, name);
      return groupOut(newId('og'), name);
    }
    const currentId = groupIdOfValue.get(o.id);
    const current = currentId ? existingGroupById.get(currentId) : undefined;
    if (current) return groupOut(current.id, current.name_en);
    if (groups.length > 0) return groups[0];
    const first = view.groups[0];
    return first ? groupOut(first.id, first.name_en) : groupOut(newId('og'), 'Options');
  };

  doc.options.forEach((o) => {
    const target = groupFor(o);
    target.values.push({
      id: o.id,
      name_en: o.name_en || o.name_ar,
      // 0055 — the authored names reach the row. An empty string is an
      // honest "none" the overlay displays as the English name.
      name_ar: o.name_ar ?? '',
      name_ckb: o.name_ckb ?? '',
      sku_part: o.sku_part ?? '',
      image: o.image ?? '',
      // Position WITHIN the group, exactly as the form numbers it: the doc's
      // `order` is the position in the whole file, and writing that as the
      // per-group sort renumbered every value on each round trip
      // (docs/TXT_IMPORT_PARITY.md, root cause 13).
      sort: target.values.length,
      active: o.active !== false,
      stock: o.stock ?? null,
      low_stock_threshold: o.low_stock_threshold ?? null,
      availability_type: o.availability_type ?? '',
      lead_time_text: o.lead_time_text ?? '',
      // 0079. Carried explicitly, because the writer treats an ABSENT key as
      // "preserve": a file that states an Arabic lead time must be able to
      // state it, and one that clears it must be able to clear it.
      lead_time_text_ar: o.lead_time_text_ar ?? '',
      lead_time_text_ckb: o.lead_time_text_ckb ?? '',
      lead_time_min_days: o.lead_time_min_days ?? null,
      lead_time_max_days: o.lead_time_max_days ?? null,
      variant_key: o.variant_key ?? '',
      variant_label: o.variant_label ?? '',
      // 0073. The model's order types, when the FILE carried them. Absent
      // means the file said nothing, and the writer then leaves whatever the
      // product already has — the same omission rule as every other field.
      ...(o.fulfillments ? { fulfillments: o.fulfillments } : {}),
      ...priceBag(o),
    });
  });

  // ---- colours -----------------------------------------------------------
  const valueIds = new Set(doc.options.map((o) => o.id));
  const colors = doc.colors.map((c, i) => {
    // option_ids is the full link set; option_id is the single-link legacy
    // field. The list wins, and a link to an option this file no longer
    // contains is dropped rather than sent to be rejected.
    const declared = (c.option_ids && c.option_ids.length > 0 ? c.option_ids : c.option_id ? [c.option_id] : []).filter(
      (id) => valueIds.has(id)
    );
    const wanted = c.option_ids && c.option_ids.length > 0 ? c.option_ids : c.option_id ? [c.option_id] : [];
    const missing = wanted.filter((id) => !valueIds.has(id));
    if (missing.length) {
      warn(`colors.${i + 1} (${c.name_en || c.name_ar}): link(s) to option ${missing.join(', ')} dropped — not in this file`);
    }
    return {
      id: c.id,
      name_en: c.name_en || c.name_ar,
      name_ar: c.name_ar ?? '',
      name_ckb: c.name_ckb ?? '',
      hex: c.hex,
      image: c.image ?? '',
      sort: i,
      active: c.active !== false,
      stock: c.stock ?? null,
      low_stock_threshold: c.low_stock_threshold ?? null,
      // The writer's ON CONFLICT sets sku_part from what it is given, so an
      // absent one is an ERASURE: every SKU built from this colour would
      // silently lose its fragment on an ordinary text edit.
      sku_part: c.sku_part ?? '',
      option_value_ids: declared,
      ...priceBag(c),
    };
  });

  // ---- images ------------------------------------------------------------
  const colorIds = new Set(doc.colors.map((c) => c.id));
  const existingImageById = new Map(view.images.map((i) => [i.id, i]));
  const images = doc.media.map((m, i) => {
    // A binding to a row this file does not contain would be refused by the
    // writer; dropping it turns the picture back into a gallery image, which
    // is what the owner sees on the page anyway.
    const ov = m.option_value_id && valueIds.has(m.option_value_id) ? m.option_value_id : null;
    const col = !ov && m.color_id && colorIds.has(m.color_id) ? m.color_id : null;
    const va = !ov && !col && m.variant_id && view.variants.some((v) => v.id === m.variant_id) ? m.variant_id : null;
    if (m.option_value_id && !ov) warn(`images.${i + 1}: option_value_id=${m.option_value_id} is not in this file — the picture is a gallery image`);
    if (m.color_id && !col && !ov) warn(`images.${i + 1}: color_id=${m.color_id} is not in this file — the picture is a gallery image`);
    if (m.variant_id && !va && !ov && !col) warn(`images.${i + 1}: variant_id=${m.variant_id} is not a combination of this product — the picture is a gallery image`);
    return {
      id: m.id,
      url: m.url,
      alt_en: m.alt_en,
      // 0048 — written AS THE FILE SAYS, '' included: the writer takes an
      // explicit value as a write and only an absent one as "preserve", so
      // `images.N.alt_ar=__CLEAR__` finally clears (root cause 7). An Arabic
      // alt equal to the English one is what the file says it is.
      alt_ar: m.alt_ar ?? '',
      alt_ckb: m.alt_ckb ?? '',
      r2_key: m.key ?? '',
      source_url: m.source_url ?? '',
      sort_order: i,
      is_primary: m.primary === true,
      option_value_id: ov,
      color_id: col,
      variant_id: va,
      width: m.width,
      height: m.height,
      // Carried for the same reason as sku_part above: the upsert writes both
      // columns unconditionally, so omitting them clears what the uploader
      // recorded about the file.
      content_type: existingImageById.get(m.id)?.content_type ?? '',
      bytes: existingImageById.get(m.id)?.bytes ?? null,
    };
  });

  // ---- variants: carried, never rebuilt ----------------------------------
  const variants = view.variants
    .map((v) => {
      const sel = selectionFromComboKey(v.combo_key);
      return {
        id: v.id,
        option_value_ids: sel.option_value_ids,
        color_id: sel.color_id,
        sku: v.sku,
        active: v.active === 1,
        stock: v.stock,
        low_stock_threshold: v.low_stock_threshold,
        ...priceBag(v),
      };
    })
    // A combination whose option or colour the file just deleted cannot be
    // written back — the writer would refuse the whole save for it.
    .filter(
      (v) =>
        v.option_value_ids.every((id) => valueIds.has(id)) && (!v.color_id || colorIds.has(v.color_id))
    );
  if (view.variants.length > 0) {
    const dropped = view.variants.length - variants.length;
    warn(
      dropped > 0
        ? `${dropped} من التركيبات المسعّرة حُذفت لأن خيارها أو لونها لم يعد موجودًا في الملف` +
            (variants.length > 0 ? `، و${variants.length} نُقلت كما هي.` : '.')
        : `التركيبات المسعّرة (${variants.length}) لا يعبّر عنها قالب TXT، فقد نُقلت كما هي دون تغيير.`
    );
  }

  const inventory_mode = deriveInventoryModeFromDoc(doc, view, opts.inventoryMode, variants.length);

  return { inventory_mode, groups, colors, images, variants };
}
