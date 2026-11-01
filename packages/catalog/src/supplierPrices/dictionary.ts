/**
 * The supplier matcher's vocabularies (docs/SMART_PRICING.md §3.5): the
 * Chinese option words of the Tmall store by group kind (0194
 * `product_option_groups.kind`), the Bambu Lab model and material tokens, the
 * pack and weight words, the listing words that are not the product itself,
 * and the English words of the electronics rule used by classification (§3.8).
 *
 * Vocabularies, never figures: no price, rate, measure or profit is here
 * (invariant I8). A word list grows with the store; a new colour, variant or
 * product needs no entry, because colours match by their 5-digit codes and
 * other options by their own names.
 *
 * Every form is written as `wordsOf` (keys.ts) leaves a text: NFKC, lower
 * case, every character other than a letter, digit, `+`, `-`, `&` or `/`
 * turned into a space.
 */

// ---------------------------------------------------------------- option groups

/** Group names that hold a colour (Tmall 颜色 / 颜色分类; English Colour). A 5-digit code counts as a colour only in such a group or in a title. */
export const COLOUR_GROUP_NAMES: readonly string[] = ['颜色', '颜色分类', '颜色名称', '色彩', '色号', '颜色款式', 'color', 'colour', 'colors', 'colours'];

/** The spool question, refill words first (无料盘 contains 料盘). A bare 料盘 (a spool sold on its own) is neither. */
export const SPOOL_WORDS: Readonly<{ refill: readonly string[]; spool: readonly string[] }> = Object.freeze({
  refill: ['不含料盘', '无料盘', '不带料盘', '无盘', '补充装', '替换装', 'refill', 'without spool', 'no spool', 'spool-free', 'spool free', 'splfree'],
  spool: ['含料盘', '带料盘', '有料盘', '有盘', 'with spool', 'filament with spool', 'spool'],
});

export type NozzleMaterial = 'hardened_steel' | 'stainless_steel' | 'tungsten_carbide' | 'brass';

/** Nozzle materials by their words. */
export const NOZZLE_MATERIALS: ReadonlyArray<{ key: NozzleMaterial; forms: readonly string[] }> = [
  { key: 'hardened_steel', forms: ['硬化钢', 'hardened steel', 'hardened'] },
  { key: 'stainless_steel', forms: ['不锈钢', 'stainless steel', 'stainless'] },
  { key: 'tungsten_carbide', forms: ['碳化钨', 'tungsten carbide', 'tungsten'] },
  { key: 'brass', forms: ['黄铜', 'brass'] },
];

/** A high-flow nozzle or hotend. Unstated means standard flow on both sides (Bambu names only the high-flow ones). */
export const HIGH_FLOW_WORDS: readonly string[] = ['高流量', '大流量', 'high flow', 'high-flow', 'highflow'];

/** Nozzle words: a diameter counts as a nozzle only in a text that names one, or in a nozzle-kind option. */
export const NOZZLE_WORDS: readonly string[] = ['喷嘴', '热端', '喷头', 'nozzle', 'hotend', 'hot end'];

export type PlateType = 'dual_pei' | 'textured_pei' | 'smooth_pei' | 'engineering' | 'cool_supertack' | 'cool' | 'high_temp' | '3d_effect';

/**
 * Plate types, most specific first (纹理+光面 before 纹理, 增稳低温 before 低温, "Cool Plate SuperTack" before "Cool Plate").
 * Tmall sells the 3D Effect Plate as a transfer plate or film (星空纹转印板, 转印膜打印板).
 */
export const PLATE_TYPES: ReadonlyArray<{ key: PlateType; forms: readonly string[] }> = [
  { key: 'dual_pei', forms: ['纹理+光面', '纹理 光面', '双面pei', 'dual-texture', 'dual texture', 'textured + smooth'] },
  { key: 'textured_pei', forms: ['纹理 pei', '纹理pei', '纹理板', 'textured pei', 'textured'] },
  { key: 'smooth_pei', forms: ['光面 pei', '光面pei', '光面板', 'smooth pei', 'smooth'] },
  { key: 'engineering', forms: ['工程板', '工程材料打印板', '工程打印板', 'engineering'] },
  { key: 'cool_supertack', forms: ['增稳低温', 'cool plate supertack', 'supertack cool plate', 'supertack'] },
  { key: 'cool', forms: ['低温打印板', '冷打板', 'cool plate'] },
  { key: 'high_temp', forms: ['高温打印板', 'high temperature plate', 'high temp plate'] },
  { key: '3d_effect', forms: ['转印板', '转印膜', '3d effect'] },
];

/** A plate generation (一代 / 二代 纹理 PEI): stated on both sides and different refuses a pairing. */
export const PLATE_GENERATIONS: ReadonlyArray<{ gen: number; forms: readonly string[] }> = [
  { gen: 1, forms: ['一代', '1st gen', 'first generation'] },
  { gen: 2, forms: ['二代', '2nd gen', 'second generation'] },
];

// ---------------------------------------------------------------- pack and weight

/** Chinese measure words after a count that make the count the offer's units (10件装, 6卷, (20个)). */
export const PACK_MEASURE_WORDS: readonly string[] = ['件装', '件套', '卷', '个装', '只装', '片装', '支装', '块装', '盒装', '套装'];
/** Measure words inside brackets: (20个), （3块）, (1套). */
export const PACK_BRACKET_WORDS: readonly string[] = ['个', '件', '片', '块', '只', '支', '套', '卷', '张', '根', '条', 'pcs', 'pc', 'pieces', 'piece'];
/** Chinese numerals before a measure word (六件套). */
export const CN_NUMERALS: Readonly<Record<string, number>> = Object.freeze({ 一: 1, 单: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 });
/** Weight units, in grams per unit. */
export const WEIGHT_UNITS: Readonly<Record<string, number>> = Object.freeze({ kg: 1000, 公斤: 1000, 千克: 1000, g: 1, 克: 1 });

// ---------------------------------------------------------------- models and materials

export interface TokenEntry {
  /** The canonical token(s) a form names. */
  tokens: readonly string[];
  forms: readonly string[];
}

/**
 * Bambu Lab printer, AMS and machine tokens. A series token (`X1 series`) names its members for
 * a printer option (SERIES_MEMBERS); for "model tokens equal" the tokens are compared as found.
 */
export const MODEL_TOKENS: readonly TokenEntry[] = [
  { tokens: ['A1 mini'], forms: ['a1 mini', 'a1mini', 'a1-mini'] },
  { tokens: ['A1'], forms: ['a1'] },
  { tokens: ['A2L'], forms: ['a2l'] },
  { tokens: ['P1P'], forms: ['p1p'] },
  { tokens: ['P1S'], forms: ['p1s'] },
  { tokens: ['P2S'], forms: ['p2s'] },
  { tokens: ['X1C'], forms: ['x1c', 'x1 carbon', 'x1-carbon'] },
  { tokens: ['X1E'], forms: ['x1e'] },
  { tokens: ['X2D'], forms: ['x2d'] },
  { tokens: ['H2D Pro'], forms: ['h2d pro'] },
  { tokens: ['H2D'], forms: ['h2d'] },
  { tokens: ['H2S'], forms: ['h2s'] },
  { tokens: ['H2C'], forms: ['h2c'] },
  { tokens: ['H3C'], forms: ['h3c'] },
  { tokens: ['R1'], forms: ['r1'] },
  { tokens: ['A1 series'], forms: ['a1 series', 'a1系列'] },
  { tokens: ['A2 series'], forms: ['a2 series', 'a2系列'] },
  { tokens: ['P1 series'], forms: ['p1 series', 'p1系列', 'p1'] },
  { tokens: ['P2 series'], forms: ['p2 series', 'p2系列'] },
  { tokens: ['X1 series'], forms: ['x1 series', 'x1系列', 'x1'] },
  { tokens: ['X2 series'], forms: ['x2 series', 'x2系列'] },
  { tokens: ['H2 series'], forms: ['h2 series', 'h2系列', 'h2'] },
  { tokens: ['AMS 2 Pro'], forms: ['ams 2 pro', 'ams2 pro', 'ams2pro'] },
  { tokens: ['AMS HT'], forms: ['ams ht', 'amsht'] },
  { tokens: ['AMS lite'], forms: ['ams lite', 'ams-lite', 'amslite'] },
  { tokens: ['AMS'], forms: ['ams'] },
];

/** What a series token covers for a printer option. */
export const SERIES_MEMBERS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  'A1 series': ['A1', 'A1 mini'],
  'A2 series': ['A2L'],
  'P1 series': ['P1P', 'P1S'],
  'P2 series': ['P2S'],
  'X1 series': ['X1C', 'X1E'],
  'X2 series': ['X2D'],
  'H2 series': ['H2D', 'H2D Pro', 'H2S', 'H2C'],
});

/** Bambu Lab filament lines, longest forms first at match time; Chinese aliases where Tmall writes one. */
export const MATERIAL_TOKENS: readonly TokenEntry[] = [
  { tokens: ['PLA Basic Gradient'], forms: ['pla basic gradient', 'pla basic双色渐变', 'pla basic 双色渐变', 'pla basic渐变'] },
  { tokens: ['PLA Basic'], forms: ['pla basic'] },
  { tokens: ['PLA Matte'], forms: ['pla matte'] },
  { tokens: ['PLA Silk Multi-Color'], forms: ['pla silk multi-color', 'pla silk multi color', 'pla silk 多色', 'pla silk多色'] },
  { tokens: ['PLA Silk+'], forms: ['pla silk+', 'pla silk plus'] },
  { tokens: ['PLA Silk'], forms: ['pla silk'] },
  { tokens: ['PLA Lite'], forms: ['pla lite'] },
  { tokens: ['PLA Tough+'], forms: ['pla tough+', 'pla tough plus', 'pla超韧', 'pla 超韧', 'tough+'] },
  { tokens: ['PLA Tough'], forms: ['pla tough'] },
  { tokens: ['PLA Metal'], forms: ['pla metal'] },
  { tokens: ['PLA Marble'], forms: ['pla marble'] },
  { tokens: ['PLA Sparkle'], forms: ['pla sparkle'] },
  { tokens: ['PLA Galaxy'], forms: ['pla galaxy', 'pla 星河', 'pla星河'] },
  { tokens: ['PLA Wood'], forms: ['pla wood'] },
  { tokens: ['PLA Translucent'], forms: ['pla translucent'] },
  { tokens: ['PLA Glow'], forms: ['pla glow'] },
  { tokens: ['PLA Aero'], forms: ['pla aero'] },
  { tokens: ['PLA Pure'], forms: ['pla pure'] },
  { tokens: ['PLA Dynamic'], forms: ['pla dynamic'] },
  { tokens: ['PLA-CF'], forms: ['pla-cf', 'pla cf'] },
  { tokens: ['PETG HF'], forms: ['petg hf', 'petg-hf'] },
  { tokens: ['PETG Basic'], forms: ['petg basic', '基础petg', '基础 petg'] },
  { tokens: ['PETG Translucent'], forms: ['petg translucent'] },
  { tokens: ['PETG Matte'], forms: ['petg matte'] },
  { tokens: ['PETG-CF'], forms: ['petg-cf', 'petg cf'] },
  { tokens: ['PET-CF'], forms: ['pet-cf', 'pet cf'] },
  { tokens: ['ABS-GF'], forms: ['abs-gf', 'abs gf'] },
  { tokens: ['ASA Aero'], forms: ['asa aero'] },
  { tokens: ['ASA-CF'], forms: ['asa-cf', 'asa cf'] },
  { tokens: ['TPU 95A HF'], forms: ['tpu 95a hf', 'tpu95a hf'] },
  { tokens: ['TPU 85A', 'TPU 90A'], forms: ['tpu 85a&90a', 'tpu 85a & 90a', 'tpu 85a/90a'] },
  { tokens: ['TPU 90A'], forms: ['tpu 90a', 'tpu90a'] },
  { tokens: ['TPU 85A'], forms: ['tpu 85a', 'tpu85a'] },
  { tokens: ['TPU 75A'], forms: ['tpu 75a', 'tpu75a'] },
  { tokens: ['TPU for AMS'], forms: ['tpu for ams'] },
  { tokens: ['PC FR'], forms: ['pc fr'] },
  { tokens: ['PA6-CF'], forms: ['pa6-cf', 'pa6 cf'] },
  { tokens: ['PA6-GF'], forms: ['pa6-gf', 'pa6 gf'] },
  { tokens: ['PAHT-CF'], forms: ['paht-cf', 'paht cf'] },
  { tokens: ['PPA-CF'], forms: ['ppa-cf', 'ppa cf'] },
  { tokens: ['PPS-CF'], forms: ['pps-cf', 'pps cf'] },
  { tokens: ['Support for PLA/PETG'], forms: ['support for pla/petg'] },
  { tokens: ['Support for PA/PET'], forms: ['support for pa/pet'] },
  { tokens: ['Support for PLA'], forms: ['support for pla'] },
  { tokens: ['Support for ABS'], forms: ['support for abs'] },
  { tokens: ['PVA'], forms: ['pva'] },
  { tokens: ['ABS'], forms: ['abs'] },
  { tokens: ['ASA'], forms: ['asa'] },
  { tokens: ['PETG'], forms: ['petg'] },
  { tokens: ['TPU'], forms: ['tpu'] },
  { tokens: ['PC'], forms: ['pc'] },
  { tokens: ['PLA'], forms: ['pla'] },
];

// ---------------------------------------------------------------- listings

export type ListingFlag = 'refurbished' | 'placeholder' | 'promo_link' | 'flash_sale' | 'members_only' | 'subsidy_listing' | 'business_listing';

/**
 * Listing words that are not the product (the capture's own rules, data/bambu-cn-prices/tools/enrich.mjs):
 * a refurbished unit is another product; a placeholder is no product; a promotion, flash-sale,
 * members-only or subsidy listing shows a price that is not the regular one.
 */
export const LISTING_FLAG_RULES: ReadonlyArray<readonly [ListingFlag, RegExp]> = [
  ['refurbished', /官方翻新|翻新机|\brefurbished\b/i],
  ['placeholder', /勿上架|占坑/],
  ['promo_link', /单件\s*\d+(?:\.\d+)?\s*折/],
  ['flash_sale', /秒杀|淘秒/],
  ['members_only', /会员专享/],
  ['subsidy_listing', /百补|百亿补贴/],
  ['business_listing', /非国补|对公用户/],
];

/** Listings whose price is not the regular price: never confirmed automatically. */
export const PROMO_LISTING_FLAGS: ReadonlySet<ListingFlag> = new Set(['promo_link', 'flash_sale', 'members_only', 'subsidy_listing']);

/** A SKU the page lists but does not sell ("restock date unknown, do not buy this, it is not shipped"). */
export const PLACEHOLDER_SKU = /勿拍|不发货|补货时间|仅提醒|勿上架|占坑/;

/** A SKU that is another product offered beside the item (【推荐加购】 or 【推荐选购】 glue beside a plate, a silicone sock beside a nozzle). */
export const ADDON_SKU = /推荐加购|推荐选购|【\s*加购\s*】|【\s*赠品\s*】|^\s*赠品/;

// ---------------------------------------------------------------- classification (§3.8)

/*
 * The owner's electronics rule for spare parts and accessories, word for word as the EU store
 * capture applies it (data/bambu-eu-prices/README.md, `judgeElectronic` in its
 * tools/assemble-snapshot.mjs). The head noun decides: the last word of the name before
 * " - <model>", "(…)", " for …", " with …" and " of …", generic words and words with a digit
 * skipped. When the head is neither electronic nor mechanical, an electronic word anywhere in
 * the name (brackets included) decides. A change here must also be made there.
 */

/** A word list written a few words a line. */
const words = (text: string): readonly string[] => text.trim().split(/\s+/);

/** Head nouns of electronic parts (EU store, by land). */
export const ELECTRONIC_HEAD_WORDS: readonly string[] = words(`
  board boards mainboard pcb
  motor motors servo actuator pump
  fan fans exhaust
  cable cables cord harness fpc wiring
  sensor sensors lidar encoder thermistor thermistors
  heater heaters heating heatbed
  camera cameras screen touchscreen display
  socket switch button buttons antenna coil
  led leds light lights lighting lamp indicator
  port supply protector protecter drive
  buffer purifier
`);

/** Head nouns that make a part mechanical even after an electronic word ("AC Board Cover", "Filament Sensor Base"). */
export const MECHANICAL_HEAD_WORDS: readonly string[] = words(`
  cover covers housing housings shell lid panel panels frame
  bracket brackets mount mounting base baseplate holder stand
  duct window glass door handle cap clamp seal ring hinge
  magnet wiper pad sponge brush wipes
  belt belts pulley pulleys idler idlers gear gears wheel shaft
  rod rods rail tensioner chain roller spring strut cam lever
  latch carriage block support claw stopper blocker guide
  coupler connector adapter tube tubes hose pipe plug
  nozzle lens mirror heatsink
  screw screws nut nuts pin pins feet foot footpad
  plate tray funnel chute curtain slat slats marker platform
  organizer filter desiccant scraper blade cutter tool lining sock
  box mat spool enclosure grease oil glue stick swatches
`);

/** Words that make a part electronic anywhere in its name when its head says neither ("AMS Feeder Unit (Hall)"). */
export const ELECTRONIC_NAME_WORDS: readonly string[] = words(`
  hall heating heater heatbed power rfid usb wifi led lidar
  camera sensor motor fan cable board mainboard screen display
  thermistor antenna coil encoder button piezo fpc laser electric
  electronic
`);

/** Words skipped when looking for the head noun. */
export const GENERIC_NAME_WORDS: readonly string[] = words(`
  unit units assembly assemblyn kit kits pack set module combo
  bundle pcs pc piece pieces series pro max plus mini lite
  ii iii left right upper lower front rear top bottom middle
  bambu lab and its
`);

/** Names the word rules would place wrongly, tested first on the name without its brackets: [pattern, electronic]. */
export const ELECTRONIC_NAME_RULES: ReadonlyArray<readonly [RegExp, boolean]> = [
  [/\bvision encoder\b/, false], // a printed calibration plate read by the camera
  [/\bams hub\b/, true],
  [/^(?:\S+ )*laser tube(?: assembly)?$/, true],
  [/\b(?:laser|cutting) (?:module|upgrade kit)\b/, true],
  [/\bvortek\b/, true], // the induction hotend system
  [/\bpower (?:adapter|filter)\b/, true],
  [/\bheat press\b/, true],
  [/\bsoldering iron\b/, true],
  [/\bflash drive\b/, true],
  [/\bconveyor feeder\b/, true],
  [/\bfire extinguishing system\b/, true],
];

// ---------------------------------------------------------------- names

/** Words that say nothing about which product it is (dropped before the name Jaccard and the name index). */
export const NAME_STOPWORDS: ReadonlySet<string> = new Set([
  'bambu',
  'lab',
  'bambulab',
  'the',
  'a',
  'an',
  'and',
  'or',
  'for',
  'with',
  'of',
  'to',
  'in',
  'on',
  'by',
  'incl',
  'only',
  'new',
  'official',
  'version',
  'edition',
  'china',
  'mainland',
  'series',
  '3d',
  'listing',
  'pcs',
  'pc',
  'set',
  'pack',
  'kit',
  'x',
]);
