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
export function relationsBodyFromDoc(doc: ProductDoc, view: ProductRelationsView): Record<string, unknown> {
  // ---- groups, rebuilt from the flat rows --------------------------------
  // Rows that name the same group belong together, in first-appearance order.
  // A row that names none joins the first group, so a file written before this
  // key existed still produces exactly one group, as it always did.
  const groups: GroupOut[] = [];
  const byName = new Map<string, GroupOut>();
  const existingGroupIdByName = new Map(view.groups.map((g) => [g.name_en.trim().toLowerCase(), g.id]));
  const groupFor = (rawName: string): GroupOut => {
    const name = rawName.trim();
    const key = name.toLowerCase();
    const found = byName.get(key);
    if (found) return found;
    if (!name && groups.length > 0) return groups[0];
    const label = name || view.groups[0]?.name_en || 'Options';
    const reuse = existingGroupIdByName.get(label.trim().toLowerCase());
    const made: GroupOut = {
      // Keeping the EXISTING group's id when the name matches means editing a
      // value does not orphan every image and variant bound through it.
      id: reuse ?? newId('og'),
      name_en: label,
      sort: groups.length,
      active: true,
      values: [],
    };
    groups.push(made);
    byName.set(key, made);
    if (!name) byName.set(label.trim().toLowerCase(), made);
    return made;
  };

  doc.options.forEach((o, i) => {
    groupFor(o.group_en ?? '').values.push({
      id: o.id,
      name_en: o.name_en || o.name_ar,
      sku_part: o.sku_part ?? '',
      image: o.image ?? '',
      sort: typeof o.order === 'number' ? o.order : i,
      active: o.active !== false,
      stock: o.stock ?? null,
      low_stock_threshold: o.low_stock_threshold ?? null,
      availability_type: o.availability_type ?? '',
      lead_time_text: o.lead_time_text ?? '',
      lead_time_min_days: o.lead_time_min_days ?? null,
      lead_time_max_days: o.lead_time_max_days ?? null,
      variant_key: o.variant_key ?? '',
      variant_label: o.variant_label ?? '',
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
    return {
      id: c.id,
      name_en: c.name_en || c.name_ar,
      hex: c.hex,
      image: c.image ?? '',
      sort: typeof c.order === 'number' ? c.order : i,
      active: c.active !== false,
      stock: c.stock ?? null,
      low_stock_threshold: c.low_stock_threshold ?? null,
      option_value_ids: declared,
      ...priceBag(c),
    };
  });

  // ---- images ------------------------------------------------------------
  const colorIds = new Set(doc.colors.map((c) => c.id));
  const images = doc.media.map((m, i) => {
    // A binding to a row this file does not contain would be refused by the
    // writer; dropping it turns the picture back into a gallery image, which
    // is what the owner sees on the page anyway.
    const ov = m.option_value_id && valueIds.has(m.option_value_id) ? m.option_value_id : null;
    const col = !ov && m.color_id && colorIds.has(m.color_id) ? m.color_id : null;
    const va = !ov && !col && m.variant_id && view.variants.some((v) => v.id === m.variant_id) ? m.variant_id : null;
    return {
      id: m.id,
      url: m.url,
      alt_en: m.alt_en,
      alt_ar: m.alt_ar,
      alt_ckb: m.alt_ckb,
      r2_key: m.key,
      source_url: m.source_url,
      sort_order: typeof m.order === 'number' ? m.order : i,
      is_primary: m.primary === true,
      option_value_id: ov,
      color_id: col,
      variant_id: va,
      width: m.width,
      height: m.height,
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

  return { groups, colors, images, variants };
}
