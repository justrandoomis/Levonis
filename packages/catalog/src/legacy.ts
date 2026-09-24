/**
 * THE OLD `options` / `colors` JSON, READ AS A VARIANT MODEL WHEN IT CAN BE.
 *
 * Before migration 0126 a community product carried two schemaless JSON lists
 * a merchant could fill through the API: `options` and `colors`, each entry a
 * string or an object `{id|value, name_ar|name|label|title|value}`. A cart
 * line named one entry of each by id (`option_id`, `color_id`), the price was
 * the product's, and the stock was the PRODUCT's — shared by every choice.
 *
 * `convertLegacyOptions` turns that into option groups, values and variants
 * (one per combination) exactly when nothing has to be INVENTED to do it:
 *
 *   · every entry has an id a cart line can name and a name to show, ids and
 *     names are unique in their list, the lists fit the variant caps;
 *   · the stock can be carried over: the product does not track stock (so no
 *     variant needs a count), or there is exactly ONE combination (so it takes
 *     the product's whole count). Several combinations over one tracked count
 *     cannot be split without inventing numbers, so such a product stays on
 *     the legacy path — sellable exactly as before — and the merchant converts
 *     it in the editor, where THEY give each variant its stock.
 *
 * Ids and names are read with the same rules the add door has always used
 * (worker/lib/storeOrderOps.ts `merchantEntryLabel`), so a cart line that named
 * an entry before the conversion names the same value after it.
 */
import { cleanName, MAX_VALUES_PER_GROUP, MAX_VARIANTS, allCombinations, type VariantModel } from './variants';
import { SWATCHES, SWATCH_NAMES, type Swatch } from './palette';

export interface LegacyEntry {
  /** What a cart line's option_id / color_id names. */
  ref: string;
  /** The display label the order snapshot has always used. */
  label: string;
  name: string;
  name_ar: string;
}

export type LegacyVerdict =
  | { ok: true; entries: LegacyEntry[] }
  | { ok: false; reason: 'not_a_list' | 'entry_without_id' | 'entry_without_name' | 'duplicate_id' | 'duplicate_name' | 'too_many' };

function parse(json: unknown): unknown {
  if (Array.isArray(json)) return json;
  if (typeof json !== 'string') return null;
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

/** One legacy list, read entry by entry. Invalid JSON is an empty list (it never offered a choice). */
export function readLegacyList(json: unknown): LegacyVerdict {
  const list = parse(json);
  if (list === null || list === undefined) return { ok: true, entries: [] };
  if (!Array.isArray(list)) return { ok: false, reason: 'not_a_list' };
  if (list.length > MAX_VALUES_PER_GROUP) return { ok: false, reason: 'too_many' };
  const entries: LegacyEntry[] = [];
  const refs = new Set<string>();
  const names = new Set<string>();
  for (const entry of list) {
    let ref = '';
    let label = '';
    let name = '';
    let nameAr = '';
    if (typeof entry === 'string') {
      ref = entry;
      label = entry;
      name = cleanName(entry);
    } else if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
      const e = entry as Record<string, unknown>;
      const rawId = e.id ?? e.value;
      if (typeof rawId === 'string' || (typeof rawId === 'number' && Number.isFinite(rawId))) ref = String(rawId);
      label = ref;
      for (const key of ['name_ar', 'name', 'label', 'title', 'value']) {
        const v = e[key];
        if (typeof v === 'string' && v.trim() && v !== ref) {
          label = v.trim();
          break;
        }
      }
      for (const key of ['name', 'label', 'title', 'value', 'name_ar']) {
        const v = e[key];
        if (typeof v === 'string' && v.trim()) {
          name = cleanName(v);
          break;
        }
      }
      if (!name) name = cleanName(ref);
      nameAr = typeof e.name_ar === 'string' ? cleanName(e.name_ar) : '';
    } else {
      return { ok: false, reason: 'entry_without_id' };
    }
    if (!ref || ref.length > 60) return { ok: false, reason: 'entry_without_id' };
    if (!name) return { ok: false, reason: 'entry_without_name' };
    if (refs.has(ref)) return { ok: false, reason: 'duplicate_id' };
    const folded = name.toLocaleLowerCase('en-US');
    if (names.has(folded)) return { ok: false, reason: 'duplicate_name' };
    refs.add(ref);
    names.add(folded);
    entries.push({ ref, label, name, name_ar: nameAr });
  }
  return { ok: true, entries };
}

/** A colour name the palette knows, in Arabic or English, as its swatch key. */
export function swatchForName(...names: string[]): Swatch | '' {
  for (const raw of names) {
    const n = raw.trim().toLocaleLowerCase('en-US');
    if (!n) continue;
    for (const k of SWATCHES) {
      if (SWATCH_NAMES[k].ar === raw.trim() || SWATCH_NAMES[k].en.toLocaleLowerCase('en-US') === n || k === n) return k;
    }
  }
  return '';
}

export type LegacyConversion =
  | {
      ok: true;
      model: VariantModel;
      /** Per variant (same order as model.variants): the legacy (option_id, color_id) that named it. */
      legacyKeys: Array<{ option_id: string; color_id: string }>;
    }
  | { ok: false; reason: string };

/**
 * The variant model for a legacy product, or why it stays legacy. An empty
 * pair of lists is not a conversion (`reason: 'empty'`): the product is simple.
 */
export function convertLegacyOptions(
  optionsJson: unknown,
  colorsJson: unknown,
  product: { track_stock: boolean; stock: number }
): LegacyConversion {
  const options = readLegacyList(optionsJson);
  if (options.ok === false) return { ok: false, reason: `options_${options.reason}` };
  const colors = readLegacyList(colorsJson);
  if (colors.ok === false) return { ok: false, reason: `colors_${colors.reason}` };
  if (!options.entries.length && !colors.entries.length) return { ok: false, reason: 'empty' };

  const groups: VariantModel['groups'] = [];
  const sources: Array<'option' | 'color'> = [];
  if (options.entries.length) {
    sources.push('option');
    groups.push({
      ref: 'lg_option',
      name: 'Option',
      name_ar: 'الخيار',
      kind: 'choice',
      values: options.entries.map((e, i) => ({ ref: `lo_${i}`, name: e.name, name_ar: e.name_ar, swatch: '' })),
    });
  }
  if (colors.entries.length) {
    sources.push('color');
    groups.push({
      ref: 'lg_color',
      name: 'Colour',
      name_ar: 'اللون',
      kind: 'color',
      values: colors.entries.map((e, i) => ({ ref: `lc_${i}`, name: e.name, name_ar: e.name_ar, swatch: swatchForName(e.name_ar, e.name) })),
    });
  }
  const combos = allCombinations(groups);
  if (combos.length > MAX_VARIANTS) return { ok: false, reason: 'too_many_combinations' };
  if (product.track_stock && combos.length > 1) return { ok: false, reason: 'shared_stock' };

  const entryOf = (ref: string) =>
    ref.startsWith('lo_') ? options.entries[Number(ref.slice(3))] : colors.entries[Number(ref.slice(3))];
  const legacyKeys = combos.map((refs) => {
    const key = { option_id: '', color_id: '' };
    refs.forEach((r, i) => {
      key[sources[i] === 'option' ? 'option_id' : 'color_id'] = entryOf(r).ref;
    });
    return key;
  });
  return {
    ok: true,
    model: {
      groups,
      variants: combos.map((refs) => ({
        values: refs,
        price_iqd: null,
        compare_at_iqd: null,
        stock: combos.length === 1 ? Math.max(0, Math.trunc(product.stock)) : 0,
        sku: '',
        active: true,
        image_key: null,
        low_stock_threshold: null,
      })),
    },
    legacyKeys,
  };
}
