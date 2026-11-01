/**
 * A Bambu product's estimate type (docs/SMART_PRICING.md §3.8), from the
 * first source that gives one:
 *
 *   1. the owner's choice                                   (type_source 'owner');
 *   2. the confirmed Tmall match's category, by the table   (type_source 'supplier_category') —
 *      this is how a spare part Tmall sells as an electronic part ends up EU-sourced;
 *   3. the import's type (catalog_import_items.product_type) with the reviewed manifest's subtype
 *      (type_source 'import_type'): filament with subtype `pack` is `filament_pack`; a
 *      `spare_part` whose English name names an electronic part is `electronics_part`, and an
 *      `accessory` whose name does is `electronics_device` (the EU capture's rule);
 *   4. none: the product is flagged EST_TYPE_MISSING and gets no estimate.
 *
 * The type decides sourcing and route (§4.1): EU store in EUR by land for printers, AMS units,
 * laser machines and electronic devices and parts; Tmall in CNY by sea for filament (never by
 * air); Tmall in CNY by sea or air for the rest. The I/O half — reading the owner's choice, the
 * confirmed match and the import row — is worker/lib/pricingEngine/estimate/classify.ts.
 */
import { ELECTRONIC_HEAD_WORDS, ELECTRONIC_NAME_RULES, ELECTRONIC_NAME_WORDS, GENERIC_NAME_WORDS, MECHANICAL_HEAD_WORDS } from './dictionary';

/** The seeded type keys of price_estimate_types (0218 §4.1). The owner may add more. */
export const SEEDED_TYPE_KEYS = [
  'printer',
  'ams',
  'laser_machine',
  'electronics_device',
  'electronics_part',
  'filament',
  'filament_pack',
  'spare_part',
  'hotend',
  'build_plate',
  'accessory',
  'makers_supply',
  'laser_material',
] as const;
export type SeededTypeKey = (typeof SEEDED_TYPE_KEYS)[number];

export type EstimateSourcing = 'EU_STORE_EUR' | 'CHINA_CNY';

/** Each seeded type's sourcing, as the 0218 seed writes it (EU types: land; filament: sea only). */
export const SEEDED_TYPE_SOURCING: Readonly<Record<SeededTypeKey, EstimateSourcing>> = Object.freeze({
  printer: 'EU_STORE_EUR',
  ams: 'EU_STORE_EUR',
  laser_machine: 'EU_STORE_EUR',
  electronics_device: 'EU_STORE_EUR',
  electronics_part: 'EU_STORE_EUR',
  filament: 'CHINA_CNY',
  filament_pack: 'CHINA_CNY',
  spare_part: 'CHINA_CNY',
  hotend: 'CHINA_CNY',
  build_plate: 'CHINA_CNY',
  accessory: 'CHINA_CNY',
  makers_supply: 'CHINA_CNY',
  laser_material: 'CHINA_CNY',
});

/** The Tmall capture's 16 categories (data/bambu-cn-prices/tools/enrich.mjs) → type; `other` gives none. */
export const TMALL_CATEGORY_TYPES: Readonly<Record<string, SeededTypeKey | null>> = Object.freeze({
  printer: 'printer',
  multi_material_unit: 'ams',
  laser_or_cutter_device: 'laser_machine',
  scanner: 'electronics_device',
  air_purifier: 'electronics_device',
  electronic_part: 'electronics_part',
  filament: 'filament',
  filament_bundle: 'filament_pack',
  nozzle_hotend: 'hotend',
  build_plate: 'build_plate',
  spare_part: 'spare_part',
  tool: 'accessory',
  accessory: 'accessory',
  maker_kit: 'makers_supply',
  laser_material: 'laser_material',
  other: null,
});

/**
 * The import's product types (the manifest's `type`, written to catalog_import_items.product_type)
 * → type. The registry's own names (plate, part, tool) are read too.
 */
export const IMPORT_TYPE_TYPES: Readonly<Record<string, SeededTypeKey>> = Object.freeze({
  printer: 'printer',
  ams: 'ams',
  laser_machine: 'laser_machine',
  filament: 'filament',
  hotend: 'hotend',
  build_plate: 'build_plate',
  plate: 'build_plate',
  spare_part: 'spare_part',
  part: 'spare_part',
  accessory: 'accessory',
  tool: 'accessory',
  makers_supply: 'makers_supply',
  laser_material: 'laser_material',
});

const ELECTRONIC_HEADS = new Set(ELECTRONIC_HEAD_WORDS);
const MECHANICAL_HEADS = new Set(MECHANICAL_HEAD_WORDS);
const ELECTRONIC_WORDS = new Set(ELECTRONIC_NAME_WORDS);
const GENERIC_WORDS = new Set(GENERIC_NAME_WORDS);

/** Lower-case words split at spaces and '/', without the punctuation at their ends. */
const nameWords = (text: string): string[] =>
  text
    .split(/[\s/]+/)
    .map((w) => w.replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, ''))
    .filter(Boolean);

/** One part of a name ("filament sensor"): its head noun decides, else an electronic word anywhere in the name. */
function partIsElectronic(part: string, name: string): boolean {
  const head = nameWords(part.split(/\s+(?:for|with|of)\s+/)[0] ?? '').filter((w) => !GENERIC_WORDS.has(w) && !/\d/.test(w));
  const last = head[head.length - 1];
  if (last && MECHANICAL_HEADS.has(last)) return false;
  if (last && ELECTRONIC_HEADS.has(last)) return true;
  return nameWords(name).some((w) => ELECTRONIC_WORDS.has(w));
}

/**
 * Whether a spare part's or accessory's English name names an electronic part or device, by the
 * owner's rule as the EU capture applies it (dictionary.ts): boards, motors, fans, cables,
 * sensors, heaters, cameras, screens, switches, buttons, sockets, ports, antennas, LEDs and
 * lights, the filament buffer, laser and cutting modules, purifiers — and not what only houses,
 * carries or cools one (a board cover, a sensor base, a heatsink for an MC board).
 */
export function isElectronicsName(name: string): boolean {
  // The name without " - <model>" and the like, lower case, in the capture's order (partCore): every dash
  // (U+2010 to U+2015, U+2212) made '-', spaces collapsed and trimmed, then U+2122 and U+00AE dropped.
  const core = String(name ?? '')
    .replace(/[\u2010-\u2015\u2212]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[\u2122\u00ae]/g, '')
    .split(/\s+-\s*/)[0]!
    .toLowerCase();
  const bare = core.replace(/\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim();
  for (const [re, electronic] of ELECTRONIC_NAME_RULES) if (re.test(bare)) return electronic;
  // "Ceramic Heater & Thermistor", "Dual Extruder Idlers and Filament Sensor": each part on its own.
  return bare.split(/\s+(?:and|&|\+)\s+/).some((part) => partIsElectronic(part, core));
}

export type TypeSource = 'owner' | 'supplier_category' | 'import_type';

export interface ClassifyInput {
  /** product_price_estimates.type_key when its type_source is 'owner'. */
  owner_type?: string | null;
  /** The category of the item of the product's CONFIRMED tmall_cn match. */
  supplier_category?: string | null;
  /** catalog_import_items.product_type of the product's COMPLETE item. */
  import_type?: string | null;
  /** The reviewed manifest's subtype (manifest.bySourceId). */
  import_subtype?: string | null;
  /** products.name (English). */
  name_en?: string | null;
  /** The keys price_estimate_types holds (seeded and the owner's); a key outside it is passed over. */
  known_types?: readonly string[] | null;
}

export interface ClassifyResult {
  type_key: string | null;
  type_source: TypeSource | '';
  /** ['EST_TYPE_MISSING'] when no source gives a type. */
  flags: Array<'EST_TYPE_MISSING'>;
}

/** A type key as the 0218 CHECK allows it: 2–40 characters of a–z and _. */
const TYPE_KEY = /^[a-z_]{2,40}$/;

/** The product's estimate type: owner > Tmall category > import type (+ pack subtype, electronics name) > missing. */
export function classifyEstimateType(input: ClassifyInput): ClassifyResult {
  const known = input.known_types ? new Set(input.known_types) : null;
  const usable = (k: string | null | undefined): k is string => !!k && TYPE_KEY.test(k) && (!known || known.has(k));

  const owner = String(input.owner_type ?? '').trim();
  if (usable(owner)) return { type_key: owner, type_source: 'owner', flags: [] };

  const category = String(input.supplier_category ?? '').trim();
  const fromCategory = Object.prototype.hasOwnProperty.call(TMALL_CATEGORY_TYPES, category) ? TMALL_CATEGORY_TYPES[category] : null;
  if (usable(fromCategory)) return { type_key: fromCategory, type_source: 'supplier_category', flags: [] };

  const importType = String(input.import_type ?? '').trim();
  let fromImport: string | null = Object.prototype.hasOwnProperty.call(IMPORT_TYPE_TYPES, importType) ? IMPORT_TYPE_TYPES[importType]! : null;
  const subtype = String(input.import_subtype ?? '').trim();
  if (fromImport === 'filament' && subtype === 'pack') fromImport = 'filament_pack';
  const name = String(input.name_en ?? '');
  if (fromImport === 'spare_part' && isElectronicsName(name)) fromImport = 'electronics_part';
  else if (fromImport === 'accessory' && isElectronicsName(name)) fromImport = 'electronics_device';
  if (usable(fromImport)) return { type_key: fromImport, type_source: 'import_type', flags: [] };

  return { type_key: null, type_source: '', flags: ['EST_TYPE_MISSING'] };
}
