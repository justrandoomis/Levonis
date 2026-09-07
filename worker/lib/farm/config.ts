/**
 * LEVO Printer Farm — THE CONFIGURATION (admin_settings key `printerFarmConfig`).
 *
 * Every number the game runs on lives here: prices, rates, probabilities,
 * rewards, deadlines, thresholds and limits, in one versioned JSON document
 * the admin edits without a deploy (docs/PRINTER_FARM.md §5). Defaults ship in
 * code and are normalised on every read, so a stored document that predates a
 * field is filled, a stray string becomes the default, and an out-of-range
 * number is clamped — the engine never sees a shape it cannot use.
 *
 * A LEAF MODULE, deliberately: worker/lib/settings.ts registers these
 * defaults and settings.ts is imported by half the worker. Importing anything
 * but the JSON reader here would risk the import cycle warrantyConfig.ts
 * describes (a constant left uninitialised at import time).
 *
 * EVERY DEFAULT BELOW IS A FIRST BALANCING GUESS. None of them is an owner
 * decision yet; docs/DECISIONS.md flags them 🟡 and the admin console is where
 * the owner's numbers land. The balancing targets the defaults are tuned to
 * are asserted by tests/farmBalance.test.ts.
 */

import { safeParse } from '../types';

export const FARM_CONFIG_SCHEMA = 1;

/** A name in the three languages the site serves. */
export interface LocalizedName {
  ar: string;
  en: string;
  ckb: string;
}

export type PrinterFamily = 'A' | 'P' | 'X' | 'H';
export type Quality = 'draft' | 'standard' | 'fine' | 'ultra';
export const QUALITIES: readonly Quality[] = ['draft', 'standard', 'fine', 'ultra'] as const;
export type CustomerTier = 'individual' | 'small_business' | 'merchant' | 'company' | 'industrial';
export const CUSTOMER_TIERS: readonly CustomerTier[] = [
  'individual', 'small_business', 'merchant', 'company', 'industrial',
] as const;
export type FailureKind = 'spaghetti' | 'clog' | 'first_layer' | 'runout' | 'ams_jam' | 'detach' | 'mechanical';
export const FAILURE_KINDS: readonly FailureKind[] = [
  'spaghetti', 'clog', 'first_layer', 'runout', 'ams_jam', 'detach', 'mechanical',
] as const;

export interface PrinterModelSpec {
  name: LocalizedName;
  family: PrinterFamily;
  /** Farm Coins. */
  price: number;
  /** mm/s; duration factor = time.reference_speed_mms / speed. */
  speed: number;
  /** Build volume [x, y, z] in mm. */
  volume_mm: [number, number, number];
  /** Material keys this model can print. */
  materials: string[];
  /** Multi-material unit → multi-colour jobs. */
  ams: boolean;
  /** 0..1, higher = fewer failures. */
  reliability: number;
  watts: number;
  /** Health points lost per operating hour. */
  wear_per_hour: number;
  min_level: number;
  sort: number;
}

export interface MaterialSpec {
  name: LocalizedName;
  /** Farm Coins per gram. */
  price_per_gram: number;
  /** 0..1 — how hard it is to print well. */
  difficulty: number;
  /** Spool quality a market purchase carries (0..1). */
  quality: number;
  min_level: number;
  /** Colour keys from `colors`. */
  colors: string[];
}

export interface ColorSpec {
  name: LocalizedName;
  hex: string;
}

export interface ProductSpec {
  name: LocalizedName;
  grams_per_part: number;
  /** GAME seconds on the reference machine at standard quality. */
  seconds_per_part: number;
  /** 0..1 */
  complexity: number;
  max_colors: number;
  /** [x, y, z] mm. */
  size_mm: [number, number, number];
  materials: string[];
  min_tier: CustomerTier;
}

export interface CustomerTierSpec {
  name: LocalizedName;
  min_reputation_bp: number;
  min_level: number;
  qty_range: [number, number];
  /** deadline = print time × factor + buffer */
  deadline_factor: number;
  reward_margin: number;
  late_penalty_bp: number;
  cancel_penalty_bp: number;
  cancel_penalty_coins: number;
  reputation_gain_bp: number;
  /** Relative frequency among unlocked tiers. */
  weight: number;
  /** Fictional customer names shown on offers. */
  names: LocalizedName[];
}

export interface QualitySpec {
  time_factor: number;
  failure_factor: number;
  reputation_factor: number;
}

export interface FailureKindSpec {
  weight: number;
  /** Share of the batch's grams that is lost (the rest returns to the spool). */
  grams_loss_factor: number;
  health_hit: number;
  /** A hard failure: the printer is `broken` until repaired. */
  breaks: boolean;
  /** Share of the batch's print time that elapsed before the failure. */
  time_loss_factor: number;
  /** Only possible on multi-colour batches. */
  ams_only: boolean;
}

export interface LocationSpec {
  name: LocalizedName;
  max_printers: number;
  storage_grams: number;
  employees: number;
  price: number;
  min_level: number;
}

export interface FarmConfig {
  schema: number;
  version: number;
  time: {
    /** Game seconds per real second. */
    time_scale: number;
    /** REAL minutes between offer refreshes. */
    offer_refresh_minutes: number;
    /** REAL minutes away before the "While you were away" summary shows. */
    away_summary_after_minutes: number;
    /** mm/s of the reference machine the product times are quoted on. */
    reference_speed_mms: number;
  };
  economy: {
    starter_coins: number;
    resale_factor: number;
    spool_sizes_g: number[];
    maintenance: { cost: number; minutes: number; health_restore: number };
    repair: { cost: number; minutes: number; health: number };
    energy: { coins_per_kwh: number };
  };
  printers: Record<string, PrinterModelSpec>;
  materials: Record<string, MaterialSpec>;
  colors: Record<string, ColorSpec>;
  products: Record<string, ProductSpec>;
  customers: Record<CustomerTier, CustomerTierSpec>;
  jobs: {
    offers_visible: number;
    /** REAL minutes an offer stays on the board. */
    offer_lifetime_minutes: number;
    /** REAL minutes after the deadline before the customer cancels. */
    late_grace_minutes: number;
    /** GAME minutes added to every deadline on top of print time × factor. */
    deadline_buffer_minutes: number;
    /** Indexed by level − 1; the last value applies to every higher level. */
    max_active_jobs: number[];
    reward_formula: {
      per_gram_factor: number;
      per_hour_coins: number;
      per_part_coins: number;
      quality_multipliers: Record<Quality, number>;
    };
  };
  quality: Record<Quality, QualitySpec>;
  failure: {
    base: number;
    weights: { health: number; reliability: number; material: number; spool: number; complexity: number };
    max: number;
    kinds: Record<FailureKind, FailureKindSpec>;
  };
  progression: {
    xp_per_job: number;
    xp_per_part: number;
    /** xp needed to reach level index+1; first entry is 0. */
    level_thresholds: number[];
    reputation_start_bp: number;
    reputation_cap_bp: number;
    failure_reputation_bp: number;
    /** Feature → level at which it unlocks. */
    unlocks: Record<string, number>;
  };
  locations: Record<string, LocationSpec>;
  starter: {
    printer_model: string;
    spool: { material: string; color: string; grams: number; quality: number };
    first_job: { product: string; qty: number; customer_tier: CustomerTier; quality: Quality; colors: string[] };
  };
  /** PRIVATE — anti-abuse. Never reaches a client. */
  limits: {
    daily_jobs_cap: number;
    daily_coins_cap: number;
    mutations_per_hour: number;
  };
  /** PRIVATE — Phase 5. `enabled` is false and NO Phase 1 code path mints. */
  rewards: {
    levonis_points: {
      enabled: boolean;
      coins_per_point: number;
      daily_cap_points: number;
      weekly_cap_points: number;
      min_level: number;
      min_reputation_bp: number;
      budget_points_per_day: number;
    };
  };
}

/** What a signed-in player may see: everything but limits and reward budgets. */
export type PublicFarmConfig = Omit<FarmConfig, 'limits' | 'rewards'>;

export type FarmConfigSection = Exclude<keyof FarmConfig, 'schema' | 'version'>;
export const FARM_CONFIG_SECTIONS: readonly FarmConfigSection[] = [
  'time', 'economy', 'printers', 'materials', 'colors', 'products', 'customers', 'jobs',
  'quality', 'failure', 'progression', 'locations', 'starter', 'limits', 'rewards',
] as const;

const n3 = (ar: string, en: string, ckb: string): LocalizedName => ({ ar, en, ckb });

const ALL_MATERIALS = ['PLA', 'PETG', 'TPU', 'ABS', 'ASA', 'PA', 'PC', 'PLA-CF', 'PETG-CF'];
const OPEN_FRAME = ['PLA', 'PETG', 'TPU'];
const ENCLOSED_P = ['PLA', 'PETG', 'TPU', 'ABS', 'ASA'];
const ENCLOSED_P2 = ['PLA', 'PETG', 'TPU', 'ABS', 'ASA', 'PA', 'PLA-CF', 'PETG-CF'];

function printer(
  name: string, family: PrinterFamily, price: number, speed: number, volume: [number, number, number],
  materials: string[], ams: boolean, reliability: number, watts: number, wear: number, minLevel: number, sort: number
): PrinterModelSpec {
  return {
    name: n3(name, name, name), family, price, speed, volume_mm: volume, materials, ams,
    reliability, watts, wear_per_hour: wear, min_level: minLevel, sort,
  };
}

function product(
  name: LocalizedName, grams: number, seconds: number, complexity: number, maxColors: number,
  size: [number, number, number], materials: string[], minTier: CustomerTier
): ProductSpec {
  return { name, grams_per_part: grams, seconds_per_part: seconds, complexity, max_colors: maxColors, size_mm: size, materials, min_tier: minTier };
}

export const FARM_CONFIG_DEFAULTS: FarmConfig = {
  schema: FARM_CONFIG_SCHEMA,
  version: 0,
  time: {
    time_scale: 20,
    offer_refresh_minutes: 10,
    away_summary_after_minutes: 20,
    reference_speed_mms: 250,
  },
  economy: {
    starter_coins: 1500,
    resale_factor: 0.55,
    spool_sizes_g: [250, 500, 1000],
    maintenance: { cost: 150, minutes: 30, health_restore: 100 },
    repair: { cost: 900, minutes: 120, health: 85 },
    energy: { coins_per_kwh: 20 },
  },
  printers: {
    a1_mini: printer('A1 mini', 'A', 6000, 250, [180, 180, 180], OPEN_FRAME, false, 0.9, 95, 1.5, 1, 10),
    a1_mini_combo: printer('A1 mini Combo', 'A', 9500, 250, [180, 180, 180], OPEN_FRAME, true, 0.88, 110, 1.6, 2, 20),
    a1: printer('A1', 'A', 9000, 270, [256, 256, 256], OPEN_FRAME, false, 0.9, 120, 1.5, 2, 30),
    a1_combo: printer('A1 Combo', 'A', 13500, 270, [256, 256, 256], OPEN_FRAME, true, 0.88, 135, 1.6, 3, 40),
    a2l: printer('A2L', 'A', 12000, 300, [300, 300, 300], OPEN_FRAME, false, 0.9, 140, 1.4, 3, 50),
    a2l_combo: printer('A2L Combo', 'A', 17000, 300, [300, 300, 300], OPEN_FRAME, true, 0.88, 155, 1.5, 4, 60),
    p1p: printer('P1P', 'P', 16000, 320, [256, 256, 256], ['PLA', 'PETG', 'TPU', 'ABS'], false, 0.91, 160, 1.3, 4, 70),
    p1s: printer('P1S', 'P', 19000, 340, [256, 256, 256], ENCLOSED_P, true, 0.92, 170, 1.2, 5, 80),
    p2s: printer('P2S', 'P', 24000, 380, [256, 256, 256], ENCLOSED_P2, true, 0.93, 180, 1.1, 6, 90),
    x1c: printer('X1C', 'X', 32000, 400, [256, 256, 256], ALL_MATERIALS, true, 0.95, 200, 1.0, 7, 100),
    x2d: printer('X2D', 'X', 42000, 480, [300, 300, 300], ALL_MATERIALS, true, 0.96, 260, 0.9, 8, 110),
    h2s: printer('H2S', 'H', 48000, 520, [350, 320, 325], ALL_MATERIALS, true, 0.96, 320, 0.8, 9, 120),
    h2d: printer('H2D', 'H', 60000, 560, [350, 320, 325], ALL_MATERIALS, true, 0.97, 380, 0.7, 10, 130),
    h2c: printer('H2C', 'H', 75000, 600, [350, 320, 325], ALL_MATERIALS, true, 0.97, 420, 0.6, 11, 140),
  },
  materials: {
    PLA: { name: n3('PLA', 'PLA', 'PLA'), price_per_gram: 2, difficulty: 0.05, quality: 0.9, min_level: 1, colors: ['black', 'white', 'grey', 'red', 'blue', 'green', 'yellow', 'orange'] },
    PETG: { name: n3('PETG', 'PETG', 'PETG'), price_per_gram: 3, difficulty: 0.25, quality: 0.9, min_level: 2, colors: ['black', 'white', 'clear', 'blue', 'red'] },
    TPU: { name: n3('TPU', 'TPU', 'TPU'), price_per_gram: 5, difficulty: 0.55, quality: 0.85, min_level: 3, colors: ['black', 'white', 'red'] },
    ABS: { name: n3('ABS', 'ABS', 'ABS'), price_per_gram: 3, difficulty: 0.45, quality: 0.9, min_level: 4, colors: ['black', 'white', 'grey'] },
    ASA: { name: n3('ASA', 'ASA', 'ASA'), price_per_gram: 4, difficulty: 0.5, quality: 0.9, min_level: 5, colors: ['black', 'white'] },
    PA: { name: n3('نايلون PA', 'PA (Nylon)', 'نایلۆن PA'), price_per_gram: 8, difficulty: 0.7, quality: 0.9, min_level: 6, colors: ['black', 'natural'] },
    PC: { name: n3('بولي كاربونيت PC', 'PC (Polycarbonate)', 'پۆلیکاربۆنات PC'), price_per_gram: 9, difficulty: 0.75, quality: 0.9, min_level: 7, colors: ['black', 'clear'] },
    'PLA-CF': { name: n3('PLA ألياف كربون', 'PLA-CF', 'PLA کاربۆن'), price_per_gram: 6, difficulty: 0.4, quality: 0.9, min_level: 5, colors: ['black'] },
    'PETG-CF': { name: n3('PETG ألياف كربون', 'PETG-CF', 'PETG کاربۆن'), price_per_gram: 7, difficulty: 0.5, quality: 0.9, min_level: 6, colors: ['black'] },
  },
  colors: {
    black: { name: n3('أسود', 'Black', 'ڕەش'), hex: '#111827' },
    white: { name: n3('أبيض', 'White', 'سپی'), hex: '#F5F5F4' },
    grey: { name: n3('رصاصي', 'Grey', 'خۆڵەمێشی'), hex: '#9CA3AF' },
    red: { name: n3('أحمر', 'Red', 'سوور'), hex: '#DC2626' },
    blue: { name: n3('أزرق', 'Blue', 'شین'), hex: '#2563EB' },
    green: { name: n3('أخضر', 'Green', 'سەوز'), hex: '#16A34A' },
    yellow: { name: n3('أصفر', 'Yellow', 'زەرد'), hex: '#FACC15' },
    orange: { name: n3('برتقالي', 'Orange', 'پرتەقاڵی'), hex: '#F97316' },
    clear: { name: n3('شفاف', 'Clear', 'ڕوون'), hex: '#E0F2FE' },
    natural: { name: n3('طبيعي', 'Natural', 'سروشتی'), hex: '#E7D8B0' },
  },
  products: {
    keychain: product(n3('ميدالية مفاتيح', 'Keychain', 'کلیلدان'), 12, 1500, 0.1, 3, [60, 30, 5], ['PLA', 'PETG'], 'individual'),
    phone_stand: product(n3('حامل هاتف', 'Phone stand', 'ڕاگری مۆبایل'), 45, 4800, 0.2, 2, [90, 80, 100], ['PLA', 'PETG'], 'individual'),
    cable_clip: product(n3('مشبك كيبلات', 'Cable clip', 'گیرەی کەیبڵ'), 6, 600, 0.1, 1, [30, 20, 15], ['PLA', 'PETG', 'TPU'], 'individual'),
    lithophane: product(n3('ليثوفان (صورة ضوئية)', 'Lithophane', 'لیسۆفان'), 40, 9000, 0.55, 1, [120, 90, 4], ['PLA'], 'individual'),
    planter: product(n3('أصيص نبات', 'Planter', 'گوڵدان'), 180, 18000, 0.3, 2, [150, 150, 140], ['PLA', 'PETG'], 'small_business'),
    articulated_dragon: product(n3('تنين مفصلي', 'Articulated dragon', 'درەگۆنی جوملە'), 120, 21600, 0.65, 4, [240, 80, 60], ['PLA'], 'small_business'),
    phone_case: product(n3('غطاء هاتف', 'Phone case', 'کەیسی مۆبایل'), 28, 3600, 0.35, 2, [160, 80, 12], ['TPU'], 'small_business'),
    bracket: product(n3('قاعدة تثبيت', 'Bracket', 'براکێت'), 60, 5400, 0.35, 1, [120, 60, 40], ['PETG', 'ABS', 'ASA', 'PA', 'PLA-CF', 'PETG-CF'], 'small_business'),
    spool_holder: product(n3('حامل بكرات', 'Spool holder', 'ڕاگری بۆبین'), 220, 25200, 0.3, 2, [220, 100, 120], ['PLA', 'PETG'], 'small_business'),
    enclosure_part: product(n3('قطعة حاوية', 'Enclosure part', 'پارچەی قاپ'), 150, 16200, 0.45, 1, [200, 150, 80], ['PETG', 'ABS', 'ASA'], 'small_business'),
    gear: product(n3('ترس', 'Gear', 'گێڕ'), 30, 3600, 0.5, 1, [80, 80, 20], ['PETG', 'PA', 'PLA-CF', 'PETG-CF'], 'merchant'),
    camera_mount: product(n3('حامل كاميرا', 'Camera mount', 'ڕاگری کامێرا'), 35, 4200, 0.45, 1, [70, 50, 60], ['PETG', 'ABS', 'PA', 'PC', 'PETG-CF'], 'merchant'),
    tool_organiser: product(n3('منظّم أدوات', 'Tool organiser', 'ڕێکخەری ئامراز'), 260, 28800, 0.35, 2, [250, 180, 90], ['PLA', 'PETG'], 'merchant'),
    drone_frame: product(n3('هيكل درون', 'Drone frame', 'چوارچێوەی درۆن'), 90, 10800, 0.7, 1, [220, 220, 40], ['PA', 'PC', 'PLA-CF', 'PETG-CF'], 'company'),
    jig_fixture: product(n3('قالب تثبيت صناعي', 'Jig / fixture', 'جیگ / فیکسچەر'), 320, 32400, 0.6, 1, [280, 200, 60], ['PETG', 'ABS', 'PA', 'PC', 'PETG-CF'], 'company'),
    housing_batch: product(n3('علب أجهزة (دفعة)', 'Device housings (batch)', 'قاپی ئامێر (کۆمەڵ)'), 400, 43200, 0.55, 2, [300, 250, 120], ['ABS', 'ASA', 'PC'], 'industrial'),
  },
  customers: {
    individual: {
      name: n3('أفراد', 'Individuals', 'تاکەکان'),
      min_reputation_bp: 0, min_level: 1, qty_range: [1, 4], deadline_factor: 3.0, reward_margin: 1.3,
      late_penalty_bp: 80, cancel_penalty_bp: 150, cancel_penalty_coins: 0, reputation_gain_bp: 40, weight: 60,
      names: [n3('أحمد', 'Ahmed', 'ئەحمەد'), n3('سارة', 'Sara', 'سارا'), n3('علي', 'Ali', 'عەلی'), n3('نور', 'Noor', 'نوور'), n3('كاروان', 'Karwan', 'کاروان'), n3('هدى', 'Huda', 'هودا')],
    },
    small_business: {
      name: n3('أعمال صغيرة', 'Small businesses', 'بازرگانی بچووک'),
      min_reputation_bp: 400, min_level: 2, qty_range: [3, 10], deadline_factor: 2.6, reward_margin: 1.4,
      late_penalty_bp: 120, cancel_penalty_bp: 220, cancel_penalty_coins: 0, reputation_gain_bp: 55, weight: 25,
      names: [n3('مقهى الرافدين', 'Rafidain Café', 'کافێی ڕافیدەین'), n3('مكتبة النور', 'Al-Noor Bookshop', 'کتێبخانەی نوور'), n3('صالون زين', 'Zain Salon', 'سالۆنی زەین'), n3('متجر هدايا بابل', 'Babylon Gifts', 'دیاری بابل')],
    },
    merchant: {
      name: n3('تجّار', 'Merchants', 'بازرگانان'),
      min_reputation_bp: 1200, min_level: 4, qty_range: [6, 20], deadline_factor: 2.3, reward_margin: 1.5,
      late_penalty_bp: 160, cancel_penalty_bp: 300, cancel_penalty_coins: 0, reputation_gain_bp: 70, weight: 10,
      names: [n3('سوق الشورجة', 'Shorja Market', 'بازاڕی شۆرجە'), n3('تجهيزات أربيل', 'Erbil Supplies', 'پێداویستی هەولێر'), n3('متجر البصرة للإلكترونيات', 'Basra Electronics', 'ئەلیکترۆنیاتی بەسرە')],
    },
    company: {
      name: n3('شركات', 'Companies', 'کۆمپانیاکان'),
      min_reputation_bp: 2200, min_level: 6, qty_range: [10, 40], deadline_factor: 2.0, reward_margin: 1.65,
      late_penalty_bp: 220, cancel_penalty_bp: 400, cancel_penalty_coins: 0, reputation_gain_bp: 90, weight: 4,
      names: [n3('شركة دجلة للتقنية', 'Tigris Tech', 'دیجلە تەک'), n3('مجموعة الفرات', 'Euphrates Group', 'گرووپی فورات'), n3('روبوتات كردستان', 'Kurdistan Robotics', 'ڕۆبۆتی کوردستان')],
    },
    industrial: {
      name: n3('صناعي', 'Industrial', 'پیشەسازی'),
      min_reputation_bp: 3200, min_level: 9, qty_range: [20, 80], deadline_factor: 1.8, reward_margin: 1.8,
      late_penalty_bp: 300, cancel_penalty_bp: 500, cancel_penalty_coins: 0, reputation_gain_bp: 120, weight: 1,
      names: [n3('مصنع بغداد للأجهزة', 'Baghdad Devices Plant', 'کارگەی ئامێری بەغدا'), n3('الصناعات الوطنية', 'National Industries', 'پیشەسازی نیشتمانی')],
    },
  },
  jobs: {
    offers_visible: 3,
    offer_lifetime_minutes: 45,
    late_grace_minutes: 60,
    deadline_buffer_minutes: 600,
    max_active_jobs: [2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 8, 8],
    reward_formula: {
      per_gram_factor: 1.5,
      per_hour_coins: 130,
      per_part_coins: 20,
      quality_multipliers: { draft: 0.85, standard: 1, fine: 1.2, ultra: 1.45 },
    },
  },
  quality: {
    draft: { time_factor: 0.7, failure_factor: 0.9, reputation_factor: 0.8 },
    standard: { time_factor: 1, failure_factor: 1, reputation_factor: 1 },
    fine: { time_factor: 1.4, failure_factor: 1.15, reputation_factor: 1.15 },
    ultra: { time_factor: 1.9, failure_factor: 1.35, reputation_factor: 1.3 },
  },
  failure: {
    base: 0.02,
    weights: { health: 0.35, reliability: 0.15, material: 0.15, spool: 0.1, complexity: 0.1 },
    max: 0.9,
    kinds: {
      spaghetti: { weight: 30, grams_loss_factor: 0.6, health_hit: 1, breaks: false, time_loss_factor: 0.6, ams_only: false },
      clog: { weight: 15, grams_loss_factor: 0.3, health_hit: 4, breaks: false, time_loss_factor: 0.4, ams_only: false },
      first_layer: { weight: 25, grams_loss_factor: 0.1, health_hit: 0.5, breaks: false, time_loss_factor: 0.1, ams_only: false },
      runout: { weight: 8, grams_loss_factor: 0.8, health_hit: 0, breaks: false, time_loss_factor: 0.8, ams_only: false },
      ams_jam: { weight: 8, grams_loss_factor: 0.4, health_hit: 3, breaks: false, time_loss_factor: 0.5, ams_only: true },
      detach: { weight: 10, grams_loss_factor: 0.5, health_hit: 1, breaks: false, time_loss_factor: 0.5, ams_only: false },
      mechanical: { weight: 4, grams_loss_factor: 0.5, health_hit: 15, breaks: true, time_loss_factor: 0.5, ams_only: false },
    },
  },
  progression: {
    xp_per_job: 40,
    xp_per_part: 5,
    level_thresholds: [0, 100, 250, 500, 900, 1400, 2100, 3000, 4200, 5600, 7500, 10000],
    reputation_start_bp: 0,
    reputation_cap_bp: 5000,
    failure_reputation_bp: 5,
    unlocks: { market: 1, inventory: 1, maintenance: 2, store: 3, upgrades: 4, locations: 5, employees: 6, contracts: 7, loans: 8 },
  },
  locations: {
    tiny_room: { name: n3('غرفة صغيرة', 'Tiny room', 'ژووری بچووک'), max_printers: 2, storage_grams: 3000, employees: 0, price: 0, min_level: 1 },
    garage: { name: n3('كراج', 'Garage', 'گەراج'), max_printers: 6, storage_grams: 12000, employees: 1, price: 15000, min_level: 4 },
    small_workshop: { name: n3('ورشة صغيرة', 'Small workshop', 'وۆرکشۆپی بچووک'), max_printers: 14, storage_grams: 40000, employees: 3, price: 60000, min_level: 7 },
    print_farm: { name: n3('مزرعة طباعة', 'Print farm', 'کێڵگەی چاپ'), max_printers: 40, storage_grams: 150000, employees: 8, price: 250000, min_level: 10 },
    industrial_farm: { name: n3('مزرعة صناعية', 'Industrial farm', 'کێڵگەی پیشەسازی'), max_printers: 120, storage_grams: 600000, employees: 20, price: 1000000, min_level: 12 },
  },
  starter: {
    printer_model: 'a1_mini',
    spool: { material: 'PLA', color: 'black', grams: 500, quality: 1 },
    first_job: { product: 'keychain', qty: 2, customer_tier: 'individual', quality: 'standard', colors: ['black'] },
  },
  limits: {
    daily_jobs_cap: 200,
    daily_coins_cap: 250000,
    mutations_per_hour: 120,
  },
  rewards: {
    levonis_points: {
      enabled: false,
      coins_per_point: 100,
      daily_cap_points: 0,
      weekly_cap_points: 0,
      min_level: 5,
      min_reputation_bp: 2000,
      budget_points_per_day: 0,
    },
  },
};

// ---------------------------------------------------------------- normaliser

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

function num(v: unknown, def: number, min = -Infinity, max = Infinity): number {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
}
function intN(v: unknown, def: number, min = -Infinity, max = Infinity): number {
  const n = num(v, def, min, max);
  return Math.round(n);
}
function bool(v: unknown, def: boolean): boolean {
  return typeof v === 'boolean' ? v : def;
}
function text(v: unknown, def: string, max = 80): string {
  return typeof v === 'string' ? v.trim().slice(0, max) : def;
}
function localized(v: unknown, def: LocalizedName): LocalizedName {
  if (typeof v === 'string') {
    const s = v.trim().slice(0, 80);
    return { ar: s, en: s, ckb: s };
  }
  if (!isObj(v)) return { ...def };
  return { ar: text(v.ar, def.ar), en: text(v.en, def.en), ckb: text(v.ckb, def.ckb) };
}
function keyList(v: unknown, def: string[], max = 40): string[] {
  if (!Array.isArray(v)) return [...def];
  const out: string[] = [];
  for (const x of v) {
    if (typeof x !== 'string') continue;
    const s = x.trim().slice(0, 40);
    if (s && !out.includes(s)) out.push(s);
    if (out.length >= max) break;
  }
  return out;
}
function triple(v: unknown, def: [number, number, number], min: number, max: number): [number, number, number] {
  if (!Array.isArray(v) || v.length < 3) return [...def];
  return [num(v[0], def[0], min, max), num(v[1], def[1], min, max), num(v[2], def[2], min, max)];
}
function pair(v: unknown, def: [number, number], min: number, max: number): [number, number] {
  if (!Array.isArray(v) || v.length < 2) return [...def];
  const a = intN(v[0], def[0], min, max);
  const b = intN(v[1], def[1], min, max);
  return a <= b ? [a, b] : [b, a];
}
function numList(v: unknown, def: number[], min: number, max: number, maxItems = 40): number[] {
  if (!Array.isArray(v) || v.length === 0) return [...def];
  const out: number[] = [];
  for (const x of v.slice(0, maxItems)) {
    const n = typeof x === 'string' && x.trim() !== '' ? Number(x) : x;
    if (typeof n === 'number' && Number.isFinite(n)) out.push(Math.min(max, Math.max(min, Math.round(n))));
  }
  return out.length ? out : [...def];
}
const KEY_RE = /^[A-Za-z0-9_-]{1,40}$/;
/** Catalog records the admin may add to or remove from. Missing fields of an
 *  entry come from the default entry with the same key, else from a template. */
function record<T>(v: unknown, def: Record<string, T>, template: T, one: (x: unknown, d: T) => T, max = 200): Record<string, T> {
  const src = isObj(v) ? v : def;
  const out: Record<string, T> = {};
  let count = 0;
  for (const [k, x] of Object.entries(src)) {
    if (!KEY_RE.test(k)) continue;
    if (count++ >= max) break;
    out[k] = one(x, def[k] ?? template);
  }
  return out;
}
function fixedRecord<K extends string, T>(v: unknown, keys: readonly K[], def: Record<K, T>, one: (x: unknown, d: T) => T): Record<K, T> {
  const src = isObj(v) ? v : {};
  const out = {} as Record<K, T>;
  for (const k of keys) out[k] = one(src[k], def[k]);
  return out;
}
const FAMILIES: readonly PrinterFamily[] = ['A', 'P', 'X', 'H'];
const isQuality = (v: unknown): v is Quality => typeof v === 'string' && (QUALITIES as readonly string[]).includes(v);
const isTier = (v: unknown): v is CustomerTier => typeof v === 'string' && (CUSTOMER_TIERS as readonly string[]).includes(v);

const D = FARM_CONFIG_DEFAULTS;

function normPrinter(x: unknown, d: PrinterModelSpec): PrinterModelSpec {
  const o = isObj(x) ? x : {};
  const fam = typeof o.family === 'string' && (FAMILIES as readonly string[]).includes(o.family) ? (o.family as PrinterFamily) : d.family;
  return {
    name: localized(o.name, d.name),
    family: fam,
    price: intN(o.price, d.price, 0, 100_000_000),
    speed: num(o.speed, d.speed, 1, 5000),
    volume_mm: triple(o.volume_mm, d.volume_mm, 1, 5000),
    materials: keyList(o.materials, d.materials),
    ams: bool(o.ams, d.ams),
    reliability: num(o.reliability, d.reliability, 0, 1),
    watts: num(o.watts, d.watts, 0, 10000),
    wear_per_hour: num(o.wear_per_hour, d.wear_per_hour, 0, 100),
    min_level: intN(o.min_level, d.min_level, 1, 200),
    sort: intN(o.sort, d.sort, 0, 100000),
  };
}
function normMaterial(x: unknown, d: MaterialSpec): MaterialSpec {
  const o = isObj(x) ? x : {};
  return {
    name: localized(o.name, d.name),
    price_per_gram: num(o.price_per_gram, d.price_per_gram, 0, 100000),
    difficulty: num(o.difficulty, d.difficulty, 0, 1),
    quality: num(o.quality, d.quality, 0, 1),
    min_level: intN(o.min_level, d.min_level, 1, 200),
    colors: keyList(o.colors, d.colors),
  };
}
function normColor(x: unknown, d: ColorSpec): ColorSpec {
  const o = isObj(x) ? x : {};
  const hex = typeof o.hex === 'string' && /^#[0-9a-fA-F]{6}$/.test(o.hex.trim()) ? o.hex.trim().toUpperCase() : d.hex;
  return { name: localized(o.name, d.name), hex };
}
function normProduct(x: unknown, d: ProductSpec): ProductSpec {
  const o = isObj(x) ? x : {};
  return {
    name: localized(o.name, d.name),
    grams_per_part: num(o.grams_per_part, d.grams_per_part, 0.1, 100000),
    seconds_per_part: intN(o.seconds_per_part, d.seconds_per_part, 1, 10_000_000),
    complexity: num(o.complexity, d.complexity, 0, 1),
    max_colors: intN(o.max_colors, d.max_colors, 1, 16),
    size_mm: triple(o.size_mm, d.size_mm, 1, 5000),
    materials: keyList(o.materials, d.materials),
    min_tier: isTier(o.min_tier) ? o.min_tier : d.min_tier,
  };
}
function normTier(x: unknown, d: CustomerTierSpec): CustomerTierSpec {
  const o = isObj(x) ? x : {};
  const names = Array.isArray(o.names) && o.names.length
    ? o.names.slice(0, 40).map((nm, i) => localized(nm, d.names[i % d.names.length]))
    : d.names.map((nm) => ({ ...nm }));
  return {
    name: localized(o.name, d.name),
    min_reputation_bp: intN(o.min_reputation_bp, d.min_reputation_bp, 0, 5000),
    min_level: intN(o.min_level, d.min_level, 1, 200),
    qty_range: pair(o.qty_range, d.qty_range, 1, 1000),
    deadline_factor: num(o.deadline_factor, d.deadline_factor, 1, 100),
    reward_margin: num(o.reward_margin, d.reward_margin, 0, 100),
    late_penalty_bp: intN(o.late_penalty_bp, d.late_penalty_bp, 0, 5000),
    cancel_penalty_bp: intN(o.cancel_penalty_bp, d.cancel_penalty_bp, 0, 5000),
    cancel_penalty_coins: intN(o.cancel_penalty_coins, d.cancel_penalty_coins, 0, 100_000_000),
    reputation_gain_bp: intN(o.reputation_gain_bp, d.reputation_gain_bp, 0, 5000),
    weight: num(o.weight, d.weight, 0, 100000),
    names,
  };
}
function normQuality(x: unknown, d: QualitySpec): QualitySpec {
  const o = isObj(x) ? x : {};
  return {
    time_factor: num(o.time_factor, d.time_factor, 0.05, 20),
    failure_factor: num(o.failure_factor, d.failure_factor, 0, 20),
    reputation_factor: num(o.reputation_factor, d.reputation_factor, 0, 20),
  };
}
function normKind(x: unknown, d: FailureKindSpec): FailureKindSpec {
  const o = isObj(x) ? x : {};
  return {
    weight: num(o.weight, d.weight, 0, 100000),
    grams_loss_factor: num(o.grams_loss_factor, d.grams_loss_factor, 0, 1),
    health_hit: num(o.health_hit, d.health_hit, 0, 100),
    breaks: bool(o.breaks, d.breaks),
    time_loss_factor: num(o.time_loss_factor, d.time_loss_factor, 0, 1),
    ams_only: bool(o.ams_only, d.ams_only),
  };
}
function normLocation(x: unknown, d: LocationSpec): LocationSpec {
  const o = isObj(x) ? x : {};
  return {
    name: localized(o.name, d.name),
    max_printers: intN(o.max_printers, d.max_printers, 1, 10000),
    storage_grams: intN(o.storage_grams, d.storage_grams, 1, 100_000_000),
    employees: intN(o.employees, d.employees, 0, 10000),
    price: intN(o.price, d.price, 0, 1_000_000_000),
    min_level: intN(o.min_level, d.min_level, 1, 200),
  };
}

/**
 * Fills every missing field from the defaults, clamps ranges, forces `schema`
 * and PRESERVES `version` (the admin route is what bumps it). Accepts the raw
 * stored value — an object, a JSON string, or garbage.
 */
export function normalizeFarmConfig(raw: unknown): FarmConfig {
  const parsed = typeof raw === 'string' ? safeParse<unknown>(raw, {}) : raw;
  const r: Obj = isObj(parsed) ? parsed : {};
  const time = isObj(r.time) ? r.time : {};
  const eco = isObj(r.economy) ? r.economy : {};
  const maint = isObj(eco.maintenance) ? eco.maintenance : {};
  const rep = isObj(eco.repair) ? eco.repair : {};
  const energy = isObj(eco.energy) ? eco.energy : {};
  const jobs = isObj(r.jobs) ? r.jobs : {};
  const rf = isObj(jobs.reward_formula) ? jobs.reward_formula : {};
  const qm = isObj(rf.quality_multipliers) ? rf.quality_multipliers : {};
  const fail = isObj(r.failure) ? r.failure : {};
  const fw = isObj(fail.weights) ? fail.weights : {};
  const prog = isObj(r.progression) ? r.progression : {};
  const unl = isObj(prog.unlocks) ? prog.unlocks : {};
  const starter = isObj(r.starter) ? r.starter : {};
  const sSpool = isObj(starter.spool) ? starter.spool : {};
  const sJob = isObj(starter.first_job) ? starter.first_job : {};
  const limits = isObj(r.limits) ? r.limits : {};
  const rewards = isObj(r.rewards) ? r.rewards : {};
  const lp = isObj(rewards.levonis_points) ? rewards.levonis_points : {};

  const unlocks: Record<string, number> = {};
  for (const [k, v] of Object.entries({ ...D.progression.unlocks, ...unl })) {
    if (KEY_RE.test(k)) unlocks[k] = intN(v, D.progression.unlocks[k] ?? 1, 1, 200);
  }
  const thresholds = numList(prog.level_thresholds, D.progression.level_thresholds, 0, 1_000_000_000, 200)
    .sort((a, b) => a - b);
  thresholds[0] = 0;
  const qualityMultipliers = {} as Record<Quality, number>;
  for (const q of QUALITIES) qualityMultipliers[q] = num(qm[q], D.jobs.reward_formula.quality_multipliers[q], 0, 20);

  return {
    schema: FARM_CONFIG_SCHEMA,
    version: intN(r.version, 0, 0, 1_000_000_000),
    time: {
      time_scale: num(time.time_scale, D.time.time_scale, 1, 3600),
      offer_refresh_minutes: num(time.offer_refresh_minutes, D.time.offer_refresh_minutes, 0.1, 10080),
      away_summary_after_minutes: num(time.away_summary_after_minutes, D.time.away_summary_after_minutes, 0, 10080),
      reference_speed_mms: num(time.reference_speed_mms, D.time.reference_speed_mms, 1, 5000),
    },
    economy: {
      starter_coins: intN(eco.starter_coins, D.economy.starter_coins, 0, 1_000_000_000),
      resale_factor: num(eco.resale_factor, D.economy.resale_factor, 0, 1),
      spool_sizes_g: numList(eco.spool_sizes_g, D.economy.spool_sizes_g, 1, 100000, 10),
      maintenance: {
        cost: intN(maint.cost, D.economy.maintenance.cost, 0, 100_000_000),
        minutes: num(maint.minutes, D.economy.maintenance.minutes, 0, 100000),
        health_restore: num(maint.health_restore, D.economy.maintenance.health_restore, 0, 100),
      },
      repair: {
        cost: intN(rep.cost, D.economy.repair.cost, 0, 100_000_000),
        minutes: num(rep.minutes, D.economy.repair.minutes, 0, 100000),
        health: num(rep.health, D.economy.repair.health, 1, 100),
      },
      energy: { coins_per_kwh: num(energy.coins_per_kwh, D.economy.energy.coins_per_kwh, 0, 100000) },
    },
    printers: record(r.printers, D.printers, D.printers.a1_mini, normPrinter),
    materials: record(r.materials, D.materials, D.materials.PLA, normMaterial),
    colors: record(r.colors, D.colors, D.colors.black, normColor),
    products: record(r.products, D.products, D.products.keychain, normProduct),
    customers: fixedRecord(r.customers, CUSTOMER_TIERS, D.customers, normTier),
    jobs: {
      offers_visible: intN(jobs.offers_visible, D.jobs.offers_visible, 1, 20),
      offer_lifetime_minutes: num(jobs.offer_lifetime_minutes, D.jobs.offer_lifetime_minutes, 1, 10080),
      late_grace_minutes: num(jobs.late_grace_minutes, D.jobs.late_grace_minutes, 0, 10080),
      deadline_buffer_minutes: num(jobs.deadline_buffer_minutes, D.jobs.deadline_buffer_minutes, 0, 1_000_000),
      max_active_jobs: numList(jobs.max_active_jobs, D.jobs.max_active_jobs, 1, 1000, 200),
      reward_formula: {
        per_gram_factor: num(rf.per_gram_factor, D.jobs.reward_formula.per_gram_factor, 0, 100),
        per_hour_coins: num(rf.per_hour_coins, D.jobs.reward_formula.per_hour_coins, 0, 1_000_000),
        per_part_coins: num(rf.per_part_coins, D.jobs.reward_formula.per_part_coins, 0, 1_000_000),
        quality_multipliers: qualityMultipliers,
      },
    },
    quality: fixedRecord(r.quality, QUALITIES, D.quality, normQuality),
    failure: {
      base: num(fail.base, D.failure.base, 0, 1),
      weights: {
        health: num(fw.health, D.failure.weights.health, 0, 1),
        reliability: num(fw.reliability, D.failure.weights.reliability, 0, 1),
        material: num(fw.material, D.failure.weights.material, 0, 1),
        spool: num(fw.spool, D.failure.weights.spool, 0, 1),
        complexity: num(fw.complexity, D.failure.weights.complexity, 0, 1),
      },
      max: num(fail.max, D.failure.max, 0, 1),
      kinds: fixedRecord(fail.kinds, FAILURE_KINDS, D.failure.kinds, normKind),
    },
    progression: {
      xp_per_job: intN(prog.xp_per_job, D.progression.xp_per_job, 0, 1_000_000),
      xp_per_part: intN(prog.xp_per_part, D.progression.xp_per_part, 0, 1_000_000),
      level_thresholds: thresholds,
      reputation_start_bp: intN(prog.reputation_start_bp, D.progression.reputation_start_bp, 0, 5000),
      reputation_cap_bp: intN(prog.reputation_cap_bp, D.progression.reputation_cap_bp, 1, 5000),
      failure_reputation_bp: intN(prog.failure_reputation_bp, D.progression.failure_reputation_bp, 0, 5000),
      unlocks,
    },
    locations: record(r.locations, D.locations, D.locations.tiny_room, normLocation),
    starter: {
      printer_model: text(starter.printer_model, D.starter.printer_model, 40),
      spool: {
        material: text(sSpool.material, D.starter.spool.material, 40),
        color: text(sSpool.color, D.starter.spool.color, 40),
        grams: intN(sSpool.grams, D.starter.spool.grams, 1, 100000),
        quality: num(sSpool.quality, D.starter.spool.quality, 0, 1),
      },
      first_job: {
        product: text(sJob.product, D.starter.first_job.product, 40),
        qty: intN(sJob.qty, D.starter.first_job.qty, 1, 1000),
        customer_tier: isTier(sJob.customer_tier) ? sJob.customer_tier : D.starter.first_job.customer_tier,
        quality: isQuality(sJob.quality) ? sJob.quality : D.starter.first_job.quality,
        colors: keyList(sJob.colors, D.starter.first_job.colors, 16),
      },
    },
    limits: {
      daily_jobs_cap: intN(limits.daily_jobs_cap, D.limits.daily_jobs_cap, 1, 1_000_000),
      daily_coins_cap: intN(limits.daily_coins_cap, D.limits.daily_coins_cap, 1, 1_000_000_000),
      mutations_per_hour: intN(limits.mutations_per_hour, D.limits.mutations_per_hour, 1, 100000),
    },
    rewards: {
      levonis_points: {
        enabled: bool(lp.enabled, false),
        coins_per_point: intN(lp.coins_per_point, D.rewards.levonis_points.coins_per_point, 1, 1_000_000_000),
        daily_cap_points: intN(lp.daily_cap_points, D.rewards.levonis_points.daily_cap_points, 0, 1_000_000_000),
        weekly_cap_points: intN(lp.weekly_cap_points, D.rewards.levonis_points.weekly_cap_points, 0, 1_000_000_000),
        min_level: intN(lp.min_level, D.rewards.levonis_points.min_level, 1, 200),
        min_reputation_bp: intN(lp.min_reputation_bp, D.rewards.levonis_points.min_reputation_bp, 0, 5000),
        budget_points_per_day: intN(lp.budget_points_per_day, D.rewards.levonis_points.budget_points_per_day, 0, 1_000_000_000),
      },
    },
  };
}

/** The subset a signed-in player may see. Limits and reward budgets stay private. */
export function publicFarmConfig(cfg: FarmConfig): PublicFarmConfig {
  // Named, not spread-and-deleted: a future private section added to
  // FarmConfig will fail to compile here instead of leaking silently.
  return {
    schema: cfg.schema,
    version: cfg.version,
    time: cfg.time,
    economy: cfg.economy,
    printers: cfg.printers,
    materials: cfg.materials,
    colors: cfg.colors,
    products: cfg.products,
    customers: cfg.customers,
    jobs: cfg.jobs,
    quality: cfg.quality,
    failure: cfg.failure,
    progression: cfg.progression,
    locations: cfg.locations,
    starter: cfg.starter,
  };
}

/**
 * Blocking rules a normalised document must satisfy before it is stored:
 * every reference resolves, every catalog price is positive, every
 * probability sits in [0, 1], and no switch promises what the code cannot do.
 */
export function farmConfigProblems(cfg: FarmConfig): string[] {
  const problems: string[] = [];
  const materialKeys = Object.keys(cfg.materials);
  if (materialKeys.length === 0) problems.push('materials: at least one material is required');
  if (Object.keys(cfg.printers).length === 0) problems.push('printers: at least one printer model is required');
  if (Object.keys(cfg.products).length === 0) problems.push('products: at least one product is required');

  for (const [k, m] of Object.entries(cfg.materials)) {
    if (!(m.price_per_gram > 0)) problems.push(`materials.${k}.price_per_gram must be > 0`);
    if (m.colors.length === 0) problems.push(`materials.${k}.colors must list at least one colour`);
    for (const c of m.colors) if (!cfg.colors[c]) problems.push(`materials.${k}.colors references unknown colour "${c}"`);
  }
  for (const [k, p] of Object.entries(cfg.printers)) {
    if (!(p.price > 0)) problems.push(`printers.${k}.price must be > 0`);
    const supported = p.materials.filter((m) => cfg.materials[m]);
    if (supported.length === 0) problems.push(`printers.${k}.materials must include at least one existing material`);
  }
  for (const [k, p] of Object.entries(cfg.products)) {
    const known = p.materials.filter((m) => cfg.materials[m]);
    if (known.length === 0) problems.push(`products.${k}.materials must include at least one existing material`);
    for (const m of p.materials) if (!cfg.materials[m]) problems.push(`products.${k}.materials references unknown material "${m}"`);
  }
  for (const [k, l] of Object.entries(cfg.locations)) {
    if (!(l.max_printers >= 1)) problems.push(`locations.${k}.max_printers must be >= 1`);
  }
  if (!cfg.locations.tiny_room) problems.push('locations.tiny_room is required (every new farm starts there)');
  if (cfg.economy.spool_sizes_g.some((g) => !(g > 0))) problems.push('economy.spool_sizes_g must all be > 0');

  const s = cfg.starter;
  const starterPrinter = cfg.printers[s.printer_model];
  if (!starterPrinter) problems.push(`starter.printer_model "${s.printer_model}" is not in printers`);
  const starterMaterial = cfg.materials[s.spool.material];
  if (!starterMaterial) problems.push(`starter.spool.material "${s.spool.material}" is not in materials`);
  else if (!starterMaterial.colors.includes(s.spool.color)) problems.push(`starter.spool.color "${s.spool.color}" is not a colour of ${s.spool.material}`);
  if (starterPrinter && starterMaterial && !starterPrinter.materials.includes(s.spool.material)) {
    problems.push(`starter printer ${s.printer_model} cannot print the starter spool material ${s.spool.material}`);
  }
  const firstProduct = cfg.products[s.first_job.product];
  if (!firstProduct) problems.push(`starter.first_job.product "${s.first_job.product}" is not in products`);
  else {
    if (!firstProduct.materials.includes(s.spool.material)) problems.push(`starter.first_job.product ${s.first_job.product} does not accept the starter spool material ${s.spool.material}`);
    if (s.first_job.colors.length > firstProduct.max_colors) problems.push('starter.first_job.colors exceeds the product max_colors');
    if (starterPrinter && !starterPrinter.ams && s.first_job.colors.length > 1) problems.push('starter.first_job asks for multi-colour but the starter printer has no AMS');
    if (starterPrinter && firstProduct.grams_per_part * s.first_job.qty > s.spool.grams) problems.push('starter.first_job needs more grams than the starter spool holds');
    for (const c of s.first_job.colors) if (starterMaterial && !starterMaterial.colors.includes(c)) problems.push(`starter.first_job colour "${c}" is not a colour of ${s.spool.material}`);
  }

  const probs: Array<[string, number]> = [
    ['failure.base', cfg.failure.base], ['failure.max', cfg.failure.max],
    ['failure.weights.health', cfg.failure.weights.health], ['failure.weights.reliability', cfg.failure.weights.reliability],
    ['failure.weights.material', cfg.failure.weights.material], ['failure.weights.spool', cfg.failure.weights.spool],
    ['failure.weights.complexity', cfg.failure.weights.complexity], ['economy.resale_factor', cfg.economy.resale_factor],
  ];
  for (const [k, p] of Object.entries(cfg.printers)) probs.push([`printers.${k}.reliability`, p.reliability]);
  for (const [k, m] of Object.entries(cfg.materials)) probs.push([`materials.${k}.difficulty`, m.difficulty], [`materials.${k}.quality`, m.quality]);
  for (const [k, f] of Object.entries(cfg.failure.kinds)) probs.push([`failure.kinds.${k}.grams_loss_factor`, f.grams_loss_factor], [`failure.kinds.${k}.time_loss_factor`, f.time_loss_factor]);
  for (const [name, p] of probs) if (!(p >= 0 && p <= 1)) problems.push(`${name} must be within [0, 1]`);
  if (Object.values(cfg.failure.kinds).every((k) => k.weight <= 0)) problems.push('failure.kinds: at least one kind needs a positive weight');

  const th = cfg.progression.level_thresholds;
  if (th.length < 2 || th[0] !== 0) problems.push('progression.level_thresholds must start at 0 and have at least two levels');
  for (let i = 1; i < th.length; i++) if (!(th[i] > th[i - 1])) problems.push('progression.level_thresholds must be strictly increasing');
  if (cfg.progression.reputation_start_bp > cfg.progression.reputation_cap_bp) problems.push('progression.reputation_start_bp exceeds reputation_cap_bp');
  if (Object.values(cfg.customers).every((t) => t.weight <= 0)) problems.push('customers: at least one tier needs a positive weight');
  if (!(cfg.time.time_scale > 0)) problems.push('time.time_scale must be > 0');

  // Phase 1 mints no Levonis Points and has no conversion path; a switch that
  // says otherwise would promise players something the code cannot do.
  if (cfg.rewards.levonis_points.enabled) {
    problems.push('rewards.levonis_points.enabled cannot be true: Farm Coins → Levonis Points conversion is not implemented in this phase');
  }
  return problems;
}
