/**
 * WHAT THE PRODUCT PAGE SHOWS FOR A SELECTION (Bambu import spec §G.3, §C.4, R6),
 * computed from the reviewed payload and the stored media: the browser check
 * (browser.ts) compares the live page with it, and the edge evidence records
 * the selections it checked.
 *
 * The rules are the page's own (src/lib/productChooser.ts and
 * src/lib/productGallery.ts of the storefront), stated over the payload's
 * shapes:
 *
 *   - THE OPENING SELECTION: each group's default while the defaults form a
 *     real variant, else the first group's default alone (when it fits); then
 *     every single-value group that fits.
 *   - A CLICK on a value not chosen changes that group's value and keeps
 *     every other group's (the check never clicks a chosen value: that
 *     clears it).
 *   - A value that forms no variant with the other groups' choices is NOT
 *     OFFERED: the page disables it and says so.
 *   - THE GALLERY for the WHOLE selection: drop every image the selection
 *     contradicts (bound to another value of a chosen group, to a value that
 *     forms no variant with the rest, to a variant holding such a value, or a
 *     representative whose source variant does); rank the rest with the
 *     shared `productMediaForSelection` (exact variant, then a chosen value,
 *     then the primary, then general images); de-duplicate by URL. The hero
 *     is the first of that list.
 *
 * Pure.
 */
import { productMediaForSelection, productVariantIdForSelection } from '@levonis/pricing/productSelectionMedia';
import type { ImportPayload } from '@levonis/catalog/bambuImport/payload';
import type { MediaAnswerRow } from './opsClient';

type Groups = ImportPayload['groups'];
type Variants = ImportPayload['variants'];

const optionParts = (comboKey: string): string[] =>
  comboKey
    .split('|')
    .filter((p) => p.startsWith('o:'))
    .map((p) => p.slice(2));

/** Do these values sit together in at least one variant? With no variant, any set does. */
export function formsVariant(valueIds: readonly string[], variants: Variants): boolean {
  if (variants.length === 0) return true;
  return variants.some((v) => {
    const parts = optionParts(v.combo_key);
    return valueIds.every((id) => parts.includes(id));
  });
}

/** Is `valueId` (of `groupId`) offered with the other groups' selected values? */
export function valueOffered(valueId: string, groupId: string, selected: readonly string[], groups: Groups, variants: Variants): boolean {
  const others = groups
    .filter((g) => g.id !== groupId)
    .map((g) => g.values.find((v) => selected.includes(v.id))?.id)
    .filter((id): id is string => !!id);
  return formsVariant([valueId, ...others], variants);
}

/** The page's opening selection (§G.3), in group order. */
export function pageDefaultSelection(payload: Pick<ImportPayload, 'groups' | 'variants'>): string[] {
  const { groups, variants } = payload;
  const defaults = groups
    .map((g) => (g.default_value_id && g.values.some((v) => v.id === g.default_value_id) ? { group: g.id, id: g.default_value_id } : null))
    .filter((d): d is { group: string; id: string } => d !== null);
  let chosen: Array<{ group: string; id: string }> = [];
  if (defaults.length && formsVariant(defaults.map((d) => d.id), variants)) chosen = defaults;
  else if (defaults.length && formsVariant([defaults[0].id], variants)) chosen = [defaults[0]];
  for (const g of groups) {
    if (g.values.length !== 1 || chosen.some((c) => c.group === g.id)) continue;
    const only = g.values[0].id;
    if (formsVariant([...chosen.map((c) => c.id), only], variants)) chosen.push({ group: g.id, id: only });
  }
  const order = new Map(groups.map((g, i) => [g.id, i]));
  return chosen.sort((a, b) => (order.get(a.group) ?? 0) - (order.get(b.group) ?? 0)).map((c) => c.id);
}

/** The selection once `valueId` of `groupId` is chosen: that group's value changes, every other group's stays (the page's click). */
export function withValue(selected: readonly string[], groups: Groups, groupId: string, valueId: string): string[] {
  return groups.flatMap((g) => {
    if (g.id === groupId) return [valueId];
    const kept = g.values.find((v) => selected.includes(v.id))?.id;
    return kept ? [kept] : [];
  });
}

export interface ExpectedGallery {
  /** The gallery's URLs (`/files/…`), de-duplicated, in the order the page shows them. */
  order: string[];
  /** Every URL that may lead: the images tied at the best rank (the page's stable order picks one of them). */
  hero: Set<string>;
  /** URLs of images the selection contradicts that no other kept image carries: never on the page. */
  forbidden: Set<string>;
}

/**
 * The gallery the page shows for `selection` (§G.3, R6). `images` are the rows as WRITTEN (gallery.ts: after the
 * Worker's content-duplicate collapse), never the payload's pre-collapse list.
 */
export function expectedGallery(
  payload: { groups: Groups; variants: Variants; images: readonly ImportPayload['images'][number][] },
  media: ReadonlyMap<string, MediaAnswerRow>,
  selection: readonly string[]
): ExpectedGallery {
  const urlOf = (id: string) => {
    const m = media.get(id);
    return m && m.status === 'stored' && m.r2_key ? `/files/${m.r2_key}` : '';
  };
  // Stored order: the primary first, then sort_order (mediaInStoredOrder) — one entry per image row.
  const rows = payload.images
    .map((i, index) => ({ i, index, url: urlOf(i.source_media_id) }))
    .filter((r) => r.url)
    .sort((a, b) => (a.i.is_primary !== b.i.is_primary ? (a.i.is_primary ? -1 : 1) : a.i.sort_order - b.i.sort_order || a.index - b.index));
  const dedupe = (urls: string[]) => [...new Set(urls)];
  if (selection.length === 0) {
    const order = dedupe(rows.map((r) => r.url));
    return { order, hero: new Set(order.slice(0, 1)), forbidden: new Set() };
  }
  const groupOf = new Map<string, string>();
  for (const g of payload.groups) for (const v of g.values) groupOf.set(v.id, g.id);
  const chosen = new Map<string, string>();
  for (const id of selection) {
    const g = groupOf.get(id);
    if (g) chosen.set(g, id);
  }
  const variantParts = new Map(payload.variants.map((v) => [v.id, optionParts(v.combo_key)]));
  const combos = [...variantParts.values()];
  const clashes = (valueId: string) => {
    const g = groupOf.get(valueId);
    return !!g && chosen.has(g) && chosen.get(g) !== valueId;
  };
  const variantClashes = (variantId: string) => (variantParts.get(variantId) ?? []).some(clashes);
  const contradicts = (i: ImportPayload['images'][number]): boolean => {
    if (i.variant_id) return variantClashes(i.variant_id);
    if (i.via_variant_id && variantClashes(i.via_variant_id)) return true;
    if (i.option_value_id) {
      if (clashes(i.option_value_id)) return true;
      if (combos.length && groupOf.has(i.option_value_id)) {
        const own = groupOf.get(i.option_value_id);
        const others = [...chosen.entries()].filter(([g]) => g !== own).map(([, id]) => id);
        if (!combos.some((parts) => parts.includes(i.option_value_id!) && others.every((o) => parts.includes(o)))) return true;
      }
    }
    return false;
  };
  const kept = rows.filter((r) => !contradicts(r.i));
  const pool = kept.length ? kept : rows;
  const variantId = productVariantIdForSelection(payload.variants, { optionValueIds: selection });
  const shape = pool.map((r) => ({ r, url: r.url, primary: r.i.is_primary, option_value_id: r.i.option_value_id, variant_id: r.i.variant_id, color_id: null }));
  const ranked = productMediaForSelection(shape, { optionValueIds: selection, variantId });
  const order = dedupe(ranked.map((x) => x.url));
  // The rank the page gave the leader, and every image tied with it (the order among them is the stored order).
  const rankOf = (x: (typeof shape)[number]) =>
    variantId && x.variant_id === variantId ? 0 : x.option_value_id && selection.includes(x.option_value_id) ? 200 : x.primary ? 300 : !x.variant_id && !x.option_value_id ? 400 : 500;
  const best = ranked.length ? rankOf(ranked[0]) : 0;
  const hero = new Set(ranked.filter((x) => rankOf(x) === best).map((x) => x.url));
  const keptUrls = new Set(pool.map((r) => r.url));
  const forbidden = new Set(rows.filter((r) => pool !== rows && contradicts(r.i) && !keptUrls.has(r.url)).map((r) => r.url));
  return { order, hero, forbidden };
}
