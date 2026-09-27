/**
 * A KEY IS THE PRODUCT'S OWN — «refill-1kg» in one file never collides with
 * «refill-1kg» in another (owner, 2026-09-27: «يظهر خطأ … slug أو key استخدم
 * سابقًا في خيار أو لون … حل مشكلة الـ slug أو key للخيار واللون»).
 *
 * THE DEFECT. The TXT template lets its author name an option, a colour, a
 * combination or a picture with a readable key — `options.1.id=refill-1kg` —
 * and the relations writer used that key as the row's primary key. Those
 * primary keys are unique across the WHOLE STORE, so the second filament whose
 * file said «refill-1kg» was refused: `option value id "refill-1kg" already
 * belongs to another product`. Every product of one family is written from the
 * same keys, so the owner met it on every second product.
 *
 * THE RULE. A key another product already owns — an option group, an option,
 * a colour or a combination — is given a product-scoped id: the key, a dash,
 * and a short fixed tag of THIS product's id. Every link inside the same
 * payload follows it: a colour's options, a combination's option values and
 * colour, a picture's option, colour or combination. The other product's row
 * is never read for anything but its owner, and never touched.
 *
 * STABLE ACROSS RE-IMPORTS. The scoped id depends only on the key and the
 * product, so the same file applied to the same product again lands on the
 * same rows (an update, not a duplicate), and the export of that product —
 * which prints the scoped ids — imports back unchanged. A key the product
 * already owns is never renamed, so nothing a cart, an order or a stock alert
 * points at moves.
 *
 * Ids stay inside the cart's own limit (60 characters for an option or a
 * colour, worker/routes/cart.ts), and use only characters an id already had.
 */

/** Tables whose rows a relations payload names by id, and where each id lives in the payload. */
type Kind = 'groups' | 'values' | 'colors' | 'variants' | 'images';

/**
 * The rows a readable key names — and so the rows scoped here. A PICTURE is
 * not one of them: its row carries storage ownership, and an image id another
 * product owns stays the writer's refusal by name
 * (tests/productMediaSaveValidation.test.ts). Its links to an option, a colour
 * or a combination still follow those rows when they are scoped.
 */
const SCOPED_KINDS: readonly Kind[] = ['groups', 'values', 'colors', 'variants'];

const TABLE: Record<Kind, string> = {
  groups: 'product_option_groups',
  values: 'product_option_values',
  colors: 'product_colors',
  variants: 'product_variants',
  images: 'product_images',
};

/** The longest id the cart accepts for an option or a colour. */
export const MAX_SCOPED_ID = 60;

/** FNV-1a, 32 bits: deterministic in every runtime, no crypto needed for a tag. */
function fnv1a(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

const tag = (text: string) => fnv1a(text).toString(36).padStart(7, '0');

/**
 * The id `key` takes inside `productId` when another product already owns it.
 * Short keys keep their whole text; a long one keeps a readable prefix and a
 * tag of its own, so two long keys that share a prefix still differ.
 */
export function scopedRelationId(key: string, productId: string): string {
  const own = tag(productId);
  const whole = `${key}-${own}`;
  if (whole.length <= MAX_SCOPED_ID) return whole;
  const room = MAX_SCOPED_ID - (1 + 7 + 1 + 7);
  return `${key.slice(0, room)}-${tag(key)}-${own}`;
}

const isRow = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);
const rows = (x: unknown): Record<string, unknown>[] => (Array.isArray(x) ? x.filter(isRow) : []);
const idOf = (row: Record<string, unknown>): string | null => (typeof row.id === 'string' && row.id ? row.id : null);

/** Every id the payload gives each table, in payload order. */
export function relationIdsOf(body: Record<string, unknown>): Record<Kind, string[]> {
  const out: Record<Kind, string[]> = { groups: [], values: [], colors: [], variants: [], images: [] };
  for (const g of rows(body.groups)) {
    const gid = idOf(g);
    if (gid) out.groups.push(gid);
    for (const v of rows(g.values)) {
      const vid = idOf(v);
      if (vid) out.values.push(vid);
    }
  }
  for (const [kind, key] of [['colors', 'colors'], ['variants', 'variants'], ['images', 'images']] as const) {
    for (const r of rows(body[key])) {
      const id = idOf(r);
      if (id) out[kind].push(id);
    }
  }
  return out;
}

export type RelationIdMaps = Record<Kind, Map<string, string>>;

/**
 * The payload with every renamed id — and every link to one — rewritten.
 * Pure. Keys the payload does not carry stay absent: several of them mean
 * "preserve" to the writer, and inventing an empty list would mean "delete".
 */
export function remapRelationIds(body: Record<string, unknown>, maps: RelationIdMaps): Record<string, unknown> {
  const swap = (map: Map<string, string>, id: unknown) => (typeof id === 'string' && map.has(id) ? map.get(id)! : id);
  const swapAll = (map: Map<string, string>, ids: unknown) => (Array.isArray(ids) ? ids.map((id) => swap(map, id)) : ids);
  const out: Record<string, unknown> = { ...body };
  if (Array.isArray(body.groups)) {
    out.groups = body.groups.map((g) =>
      isRow(g)
        ? {
            ...g,
            id: swap(maps.groups, g.id),
            ...(Array.isArray(g.values)
              ? { values: g.values.map((v) => (isRow(v) ? { ...v, id: swap(maps.values, v.id) } : v)) }
              : {}),
          }
        : g
    );
  }
  if (Array.isArray(body.colors)) {
    out.colors = body.colors.map((c) =>
      isRow(c)
        ? {
            ...c,
            id: swap(maps.colors, c.id),
            ...('option_value_ids' in c ? { option_value_ids: swapAll(maps.values, c.option_value_ids) } : {}),
          }
        : c
    );
  }
  if (Array.isArray(body.variants)) {
    out.variants = body.variants.map((v) =>
      isRow(v)
        ? {
            ...v,
            id: swap(maps.variants, v.id),
            ...('option_value_ids' in v ? { option_value_ids: swapAll(maps.values, v.option_value_ids) } : {}),
            ...('color_id' in v ? { color_id: swap(maps.colors, v.color_id) } : {}),
          }
        : v
    );
  }
  if (Array.isArray(body.images)) {
    out.images = body.images.map((i) =>
      isRow(i)
        ? {
            ...i,
            id: swap(maps.images, i.id),
            ...('option_value_id' in i ? { option_value_id: swap(maps.values, i.option_value_id) } : {}),
            ...('color_id' in i ? { color_id: swap(maps.colors, i.color_id) } : {}),
            ...('variant_id' in i ? { variant_id: swap(maps.variants, i.variant_id) } : {}),
          }
        : i
    );
  }
  return out;
}

/** Who owns each of these ids today, one bound JSON list per table (D1's parameter limit). */
async function ownersOf(db: D1Database, kind: Kind, ids: string[]): Promise<Map<string, string>> {
  const owners = new Map<string, string>();
  if (ids.length === 0) return owners;
  const { results } = await db
    .prepare(`SELECT id, product_id FROM ${TABLE[kind]} WHERE id IN (SELECT value FROM json_each(?))`)
    .bind(JSON.stringify([...new Set(ids)]))
    .all<{ id: string; product_id: string }>();
  for (const r of results) owners.set(r.id, r.product_id);
  return owners;
}

/**
 * The payload as `productId` may write it: each id another product owns is
 * scoped to this one (`scopedRelationId`), with every link following it.
 * `renamed` lists what moved, for a caller that wants to say so.
 */
export async function scopeForeignRelationIds(
  db: D1Database,
  productId: string,
  body: Record<string, unknown>
): Promise<{ body: Record<string, unknown>; renamed: Array<{ kind: Kind; from: string; to: string }> }> {
  const ids = relationIdsOf(body);
  const maps: RelationIdMaps = { groups: new Map(), values: new Map(), colors: new Map(), variants: new Map(), images: new Map() };
  const renamed: Array<{ kind: Kind; from: string; to: string }> = [];
  for (const kind of SCOPED_KINDS) {
    const owners = await ownersOf(db, kind, ids[kind]);
    const foreign = ids[kind].filter((id) => owners.has(id) && owners.get(id) !== productId);
    if (foreign.length === 0) continue;
    const candidates = new Map(foreign.map((id) => [id, scopedRelationId(id, productId)]));
    // A scoped id is this product's by construction; one another product
    // somehow holds is left alone, and the writer's own ownership check then
    // refuses it by name rather than re-parenting anything.
    const scopedOwners = await ownersOf(db, kind, [...candidates.values()]);
    const inPayload = new Set(ids[kind]);
    for (const [from, to] of candidates) {
      const owner = scopedOwners.get(to);
      if (owner && owner !== productId) continue;
      // The payload already names the scoped id for another row: renaming
      // would merge two rows, so the writer's duplicate check speaks instead.
      if (inPayload.has(to)) continue;
      maps[kind].set(from, to);
      renamed.push({ kind, from, to });
    }
  }
  if (renamed.length === 0) return { body, renamed };
  return { body: remapRelationIds(body, maps), renamed };
}
