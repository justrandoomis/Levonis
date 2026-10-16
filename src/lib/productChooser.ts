/**
 * THE OPTION CHOOSER'S RULES FOR AN IMPORTED PRODUCT (the Bambu import spec
 * §G.3; the 0194 group columns `kind`, `name_ar`, `name_ckb`,
 * `default_value_id` and the value `swatch`, carried by the page body's
 * relations).
 *
 *   - DEFAULT SELECTION. With no `initial_selection` from the server (always
 *     the case for an unpriced product), each group's `default_value_id` is
 *     preselected — but only while those defaults form a real variant;
 *     otherwise the first group's default alone.
 *   - A SINGLE-VALUE GROUP is auto-selected.
 *   - IMPOSSIBLE COMBINATIONS: a value that forms no active variant with the
 *     rest of the selection says so («غير متاح مع هذا الاختيار», never «نفد»),
 *     from `variants[].combo_key` — and STAYS PRESSABLE: pressing it selects
 *     it and lets go of the other groups' values that clash with it
 *     (`chooseValue`). A disabled value was a dead end: the H2D opens on
 *     «H2D AMS Combo + Standard», and its two other versions could only be
 *     reached by first un-pressing «Standard», which nothing on the page said.
 *
 * NOTHING NEW FOR AN EXISTING PRODUCT. All three apply only to a product whose
 * groups carry the import's data (`importedChooser`): every product before the
 * import renders and selects exactly as it did (spec §K.2 step 7 «nothing new
 * renders until data exists»).
 *
 * Pure.
 */
export interface ChooserValue {
  id: string;
  swatch?: { url?: string; published_hex?: string } | null;
}

export interface ChooserGroup {
  id: string;
  kind?: string;
  default_value_id?: string;
  name_ar?: string;
  name_ckb?: string;
  values: readonly ChooserValue[];
}

export interface ChooserVariant {
  id: string;
  combo_key: string;
  active?: boolean | number | null;
}

/** «غير متاح مع هذا الاختيار» — never «نفد»: the choice is not offered, not sold out. */
export const NOT_OFFERED = {
  ar: 'غير متاح مع هذا الاختيار',
  en: 'Not offered with this choice',
  ckb: 'لەگەڵ ئەم هەڵبژاردنە بەردەست نییە',
} as const;

/** Does this product's chooser carry the import's data (a kind, a default, a swatch)? */
export function importedChooser(groups: readonly ChooserGroup[]): boolean {
  return groups.some(
    (g) => (g.kind ?? '') !== '' || (g.default_value_id ?? '') !== '' || g.values.some((v) => !!v.swatch && (!!v.swatch.url || !!v.swatch.published_hex))
  );
}

const optionParts = (v: ChooserVariant): string[] =>
  v.combo_key
    .split('|')
    .filter((p) => p.startsWith('o:'))
    .map((p) => p.slice(2));

const activeVariants = (variants: readonly ChooserVariant[]) => variants.filter((v) => v.active !== false && v.active !== 0);

/** Do these values sit together in at least one active variant? With no published variant, any set does. */
export function formsVariant(valueIds: readonly string[], variants: readonly ChooserVariant[]): boolean {
  const live = activeVariants(variants);
  if (live.length === 0) return true;
  return live.some((v) => {
    const parts = optionParts(v);
    return valueIds.every((id) => parts.includes(id));
  });
}

/**
 * Is `valueId` (of `groupId`) offered with the rest of the selection? The
 * value is tested with the selected values of every OTHER group.
 */
export function valueOffered(
  valueId: string,
  groupId: string,
  selected: readonly string[],
  groups: readonly ChooserGroup[],
  variants: readonly ChooserVariant[]
): boolean {
  const others = groups
    .filter((g) => g.id !== groupId)
    .map((g) => g.values.find((v) => selected.includes(v.id))?.id)
    .filter((id): id is string => !!id);
  return formsVariant([valueId, ...others], variants);
}

/**
 * The selection after pressing `valueId` of `groupId` on an imported
 * product's chooser. Pressing the selected value un-presses it (as every
 * chooser does). Otherwise the group takes the value, and every other group
 * keeps its value while the whole still forms an active variant — in group
 * order; a value that clashes is let go, and its group takes the one value
 * that still fits when there is exactly one (H2D: «H2D» brings its own
 * «standard») — then each single-value group that fits is selected again.
 * In group order.
 */
export function chooseValue(
  valueId: string,
  groupId: string,
  selected: readonly string[],
  groups: readonly ChooserGroup[],
  variants: readonly ChooserVariant[]
): string[] {
  const pressedGroup = groups.find((g) => g.id === groupId);
  const current = (g: ChooserGroup) => g.values.find((v) => selected.includes(v.id))?.id;
  if (pressedGroup && current(pressedGroup) === valueId) {
    return groups.flatMap((g) => (g.id === groupId ? [] : current(g) ? [current(g) as string] : []));
  }
  const chosen = new Map<string, string>([[groupId, valueId]]);
  const ids = () => [...chosen.values()];
  const dropped = new Set<string>();
  for (const g of groups) {
    const kept = g.id === groupId ? undefined : current(g);
    if (!kept) continue;
    if (formsVariant([...ids(), kept], variants)) chosen.set(g.id, kept);
    else dropped.add(g.id);
  }
  for (const g of groups) {
    if (chosen.has(g.id) || (g.values.length !== 1 && !dropped.has(g.id))) continue;
    const fits = g.values.filter((v) => formsVariant([...ids(), v.id], variants));
    if (fits.length === 1) chosen.set(g.id, fits[0].id);
  }
  return groups.flatMap((g) => (chosen.has(g.id) ? [chosen.get(g.id) as string] : []));
}

/**
 * The opening selection (§G.3), in group order: the defaults while they form
 * a real variant, else the first group's default alone; then every
 * single-value group that fits with it. Empty for a product without the
 * import's data.
 */
export function defaultSelection(groups: readonly ChooserGroup[], variants: readonly ChooserVariant[]): string[] {
  if (!importedChooser(groups)) return [];
  const defaults = groups
    .map((g) => {
      const id = g.default_value_id ?? '';
      return id && g.values.some((v) => v.id === id) ? { group: g.id, id } : null;
    })
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

/** A group's name in the reader's language: the 0194 Arabic / Sorani label, else the English name. */
export function groupName(g: ChooserGroup & { name_en: string }, lang: 'ar' | 'en' | 'ckb'): string {
  if (lang === 'ar') return (g.name_ar ?? '').trim() || g.name_en;
  if (lang === 'ckb') return (g.name_ckb ?? '').trim() || g.name_en;
  return g.name_en;
}
