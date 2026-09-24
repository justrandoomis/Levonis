/**
 * A PRODUCT AS A VISITOR MAY SEE IT — the variant picker's data, the ordered
 * media and the 3D-printing attributes (W2-F), for the public storefront
 * (worker/routes/storefront.ts).
 *
 * WHAT IS NEVER SENT: a stock count (a variant is `in_stock` or not — the
 * wave-1 rule for products), an inactive variant, a SKU, a low-stock line,
 * or a value no active variant uses (a choice that leads nowhere).
 */
import type { PublicGroup, PublicVariant } from '@levonis/catalog/variants';
import type { Attributes } from '@levonis/catalog/attributes';
import { attributesOf } from './product';
import { isSchemaMissing } from '../membershipBenefits';

export interface PublicProductExtras {
  option_groups: PublicGroup[];
  variants: PublicVariant[];
  media: Array<{ kind: 'image' | 'video'; url: string; alt: string; alt_ar: string }>;
  attributes: Attributes;
}

/**
 * Never an error page for a database a migration behind (a Worker deployed
 * before 0126 ran): the product is then simply shown without variants.
 */
export async function publicProductExtras(db: D1Database, p: Record<string, unknown>): Promise<PublicProductExtras> {
  try {
    return await readExtras(db, p);
  } catch (e) {
    if (!isSchemaMissing(e)) throw e;
    return { option_groups: [], variants: [], media: [], attributes: attributesOf(p) };
  }
}

async function readExtras(db: D1Database, p: Record<string, unknown>): Promise<PublicProductExtras> {
  const productId = String(p.id);
  const basePrice = Math.max(0, Math.trunc(Number(p.price_iqd) || 0));
  const tracked = !!Number(p.track_stock);
  const isVariants = p.variant_mode === 'variants';
  const [groups, values, variants, media] = await Promise.all([
    db.prepare('SELECT id, name, name_ar, kind FROM community_product_options WHERE product_id = ? ORDER BY position, id').bind(productId).all(),
    db.prepare('SELECT id, option_id, name, name_ar, swatch FROM community_product_option_values WHERE product_id = ? ORDER BY position, id').bind(productId).all(),
    db.prepare(
      `SELECT id, value1_id, value2_id, value3_id, price_iqd, compare_at_iqd, stock, image_key
         FROM community_product_variants WHERE product_id = ? AND active = 1 ORDER BY position, id`
    ).bind(productId).all(),
    db.prepare('SELECT kind, media_key, alt, alt_ar FROM community_product_media WHERE product_id = ? ORDER BY position, id').bind(productId).all(),
  ]);
  const vs: PublicVariant[] = isVariants
    ? (variants.results as Array<Record<string, unknown>>).map((v) => ({
        id: String(v.id),
        value_ids: [v.value1_id, v.value2_id, v.value3_id].filter((x): x is string => typeof x === 'string' && !!x),
        price_iqd: v.price_iqd === null ? basePrice : Math.max(0, Math.trunc(Number(v.price_iqd))),
        compare_at_iqd: v.compare_at_iqd === null ? null : Number(v.compare_at_iqd),
        in_stock: !tracked || Number(v.stock) > 0,
        image: v.image_key ? `/files/${String(v.image_key)}` : null,
      }))
    : [];
  const used = new Set(vs.flatMap((v) => v.value_ids));
  const vals = values.results as Array<Record<string, unknown>>;
  const og: PublicGroup[] = isVariants
    ? (groups.results as Array<Record<string, unknown>>).map((g) => ({
        id: String(g.id),
        name: String(g.name),
        name_ar: String(g.name_ar ?? ''),
        kind: g.kind === 'color' ? 'color' : 'choice',
        values: vals
          .filter((x) => x.option_id === g.id && used.has(String(x.id)))
          .map((x) => ({ id: String(x.id), name: String(x.name), name_ar: String(x.name_ar ?? ''), swatch: String(x.swatch ?? '') })),
      }))
    : [];
  const mediaRows = media.results as Array<Record<string, unknown>>;
  return {
    option_groups: og,
    variants: vs,
    // Rows when the product has them; otherwise its `images` (a store-less
    // legacy product, or one written before 0127 ran).
    media: mediaRows.length
      ? mediaRows.map((m) => ({
          kind: m.kind === 'video' ? 'video' : 'image',
          url: `/files/${String(m.media_key)}`,
          alt: String(m.alt ?? ''),
          alt_ar: String(m.alt_ar ?? ''),
        }))
      : [],
    attributes: attributesOf(p),
  };
}
