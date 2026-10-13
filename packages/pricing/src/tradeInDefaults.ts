/**
 * THE SEEDED TRADE-IN RULE SETS — split from ./tradeIn.ts (DECISIONS row
 * 219). The engine module is imported by the customer's wizard for its
 * vocabulary (families, photos, the settlement); bundling the default rules
 * with it shipped the owner's valuation numbers — every factor effect, the
 * floor and cap, the resale view — as a static file anyone could download.
 * Only the Worker (worker/lib/tradeIn.ts) and the tests import this module.
 */
import type { ChecklistItem, FactorConfig, FactorId, FactorRule, TradeInFamily, TradeInRuleSet } from './tradeIn';

// ============================================================ the defaults

const item = (id: string, label_ar: string, label_en: string, effect_bp: number): ChecklistItem => ({ id, label_ar, label_en, effect_bp });
const scale = (a: number, b: number, c: number, d: number, e: number): FactorConfig => ({ kind: 'scale', effects_bp: [a, b, c, d, e] });
const choice = (partial: number, none: number): FactorConfig => ({
  kind: 'choice',
  options: [
    { id: 'all', effect_bp: 0 },
    { id: 'partial', effect_bp: partial },
    { id: 'none', effect_bp: none },
  ],
});
const on = (factor: FactorId, config: FactorConfig, weight_bp = 10_000): FactorRule => ({ factor, enabled: true, weight_bp, config });
const off = (factor: FactorId, config: FactorConfig): FactorRule => ({ factor, enabled: false, weight_bp: 10_000, config });
const hours = (...bands: Array<[number | null, number]>): FactorConfig => ({
  kind: 'hours',
  bands: bands.map(([up_to, effect_bp]) => ({ up_to, effect_bp })),
});

const COMMON_PARTS: ChecklistItem[] = [
  item('mainboard', 'اللوحة الأم', 'Mainboard', -600),
  item('screen', 'الشاشة', 'Screen', -300),
  item('fan', 'مروحة', 'Fan', -100),
  item('power_supply', 'مزود الطاقة', 'Power supply', -300),
];

/**
 * THE SEEDED DEFAULTS — «قيم افتراضية» the owner is expected to tune.
 *
 * They are a reasonable first position, not a market study: a year-old FDM
 * printer in good condition lands at roughly 60–65% of what was paid, a resin
 * machine a little lower (its screen is a consumable), an AMS on the same
 * curve as its printer, a loose accessory well below. Every one is marked
 * `is_default` so the admin editor can say so in words until someone saves a
 * version of their own. Migration 0143 seeds EXACTLY these rows, and
 * tests/tradeIn.test.ts holds the two together.
 */
export const DEFAULT_RULE_SETS: Record<TradeInFamily, TradeInRuleSet> = {
  fdm: {
    family: 'fdm',
    version: 1,
    floor_bp: 1000,
    cap_bp: 8500,
    rounding_iqd: 1000,
    min_base_iqd: 100_000,
    ams_reference_iqd: 0,
    is_default: true,
    factors: [
      on('usage_age', { kind: 'age', per_month_bp: 150, max_bp: 4500, grace_months: 0 }),
      on('warranty_remaining', { kind: 'warranty', per_month_bp: 60, max_bp: 800 }),
      on('operating_hours', hours([300, 0], [800, -300], [1500, -700], [3000, -1300], [null, -2000])),
      on('cleanliness', scale(-800, -400, -150, 0, 0)),
      on('exterior', scale(-1200, -600, -250, 0, 100)),
      on('scratches', scale(-800, -400, -150, 0, 0)),
      on('faults', {
        kind: 'checklist',
        max_total_bp: -6000,
        items: [
          item('nozzle_clog', 'انسداد النوزل', 'Clogged nozzle', -300),
          item('extruder_skip', 'تقطيع أو انزلاق في الإكسترودر', 'Extruder skipping', -500),
          item('bed_leveling', 'مشكلة في معايرة السطح', 'Bed-levelling problem', -500),
          item('heating_error', 'خطأ في التسخين', 'Heating error', -800),
          item('motor_noise', 'صوت غير طبيعي في المحركات', 'Abnormal motor noise', -400),
          item('belt_wear', 'تآكل الأحزمة', 'Worn belts', -300),
          item('camera_lidar', 'عطل الكاميرا أو الليدار', 'Camera or lidar fault', -400),
          item('screen_touch', 'عطل الشاشة أو اللمس', 'Screen or touch fault', -700),
          item('wifi', 'مشكلة في الاتصال (واي فاي)', 'Connectivity (Wi-Fi) problem', -300),
          item('fan_noise', 'مروحة عالية الصوت أو معطلة', 'Loud or dead fan', -200),
          item('filament_sensor', 'عطل حساس الفلمنت', 'Filament sensor fault', -300),
          item('mainboard', 'عطل في اللوحة الأم', 'Mainboard fault', -2000),
        ],
      }),
      on('repairs', { kind: 'count', per_item_bp: 300, max_bp: 1200 }),
      on('replaced_parts', {
        kind: 'checklist',
        max_total_bp: -1500,
        items: [
          item('hotend', 'رأس الطباعة (Hotend)', 'Hotend', -100),
          item('nozzle', 'النوزل', 'Nozzle', 0),
          item('build_plate', 'سطح الطباعة', 'Build plate', -100),
          item('belts', 'الأحزمة', 'Belts', -100),
          item('extruder', 'الإكسترودر', 'Extruder', -200),
          ...COMMON_PARTS,
        ],
      }),
      on('accessory_condition', scale(-400, -200, -100, 0, 0)),
      on('original_accessories', choice(-300, -700)),
      on('market', { kind: 'market', resale_bp: -1000, product_overrides: [] }),
      on('product_type', { kind: 'flat', effect_bp: 0 }),
    ],
  },
  resin: {
    family: 'resin',
    version: 1,
    floor_bp: 1000,
    cap_bp: 8000,
    rounding_iqd: 1000,
    min_base_iqd: 100_000,
    ams_reference_iqd: 0,
    is_default: true,
    factors: [
      on('usage_age', { kind: 'age', per_month_bp: 200, max_bp: 5000, grace_months: 0 }),
      on('warranty_remaining', { kind: 'warranty', per_month_bp: 60, max_bp: 800 }),
      on('operating_hours', hours([200, 0], [500, -400], [1000, -900], [2000, -1600], [null, -2500])),
      on('cleanliness', scale(-1200, -600, -200, 0, 0)),
      on('exterior', scale(-1200, -600, -250, 0, 100)),
      on('scratches', scale(-800, -400, -150, 0, 0)),
      on('faults', {
        kind: 'checklist',
        max_total_bp: -6000,
        items: [
          item('lcd_screen', 'تلف شاشة LCD', 'Damaged LCD screen', -2500),
          item('fep_film', 'فيلم FEP مستهلك', 'Worn FEP film', -200),
          item('vat_leak', 'تسريب في الحوض', 'Leaking vat', -600),
          item('uv_light', 'ضعف ضوء UV', 'Weak UV light', -1500),
          item('z_axis', 'اهتزاز أو خلل في محور Z', 'Z-axis wobble or fault', -800),
          item('plate_adhesion', 'ضعف الالتصاق بالمنصة', 'Poor plate adhesion', -300),
          item('touch_screen', 'عطل شاشة اللمس', 'Touch-screen fault', -700),
          item('resin_inside', 'تسرب ريزن داخل الجهاز', 'Resin spilled inside', -1500),
        ],
      }),
      on('repairs', { kind: 'count', per_item_bp: 300, max_bp: 1200 }),
      on('replaced_parts', {
        kind: 'checklist',
        max_total_bp: -1500,
        items: [
          item('lcd', 'شاشة LCD', 'LCD screen', -200),
          item('fep', 'فيلم FEP', 'FEP film', 0),
          item('vat', 'الحوض', 'Vat', -100),
          item('build_platform', 'منصة الطباعة', 'Build platform', -100),
          item('uv_module', 'وحدة UV', 'UV module', -300),
          ...COMMON_PARTS,
        ],
      }),
      on('accessory_condition', scale(-400, -200, -100, 0, 0)),
      on('original_accessories', choice(-300, -700)),
      on('market', { kind: 'market', resale_bp: -1500, product_overrides: [] }),
      on('product_type', { kind: 'flat', effect_bp: -500 }),
    ],
  },
  laser: {
    family: 'laser',
    version: 1,
    floor_bp: 1000,
    cap_bp: 8000,
    rounding_iqd: 1000,
    min_base_iqd: 100_000,
    ams_reference_iqd: 0,
    is_default: true,
    factors: [
      on('usage_age', { kind: 'age', per_month_bp: 150, max_bp: 4500, grace_months: 0 }),
      on('warranty_remaining', { kind: 'warranty', per_month_bp: 60, max_bp: 800 }),
      on('operating_hours', hours([300, 0], [800, -400], [1500, -900], [3000, -1600], [null, -2500])),
      on('cleanliness', scale(-1000, -500, -200, 0, 0)),
      on('exterior', scale(-1200, -600, -250, 0, 100)),
      on('scratches', scale(-800, -400, -150, 0, 0)),
      on('faults', {
        kind: 'checklist',
        max_total_bp: -6000,
        items: [
          item('lens', 'اتساخ أو خدش العدسة', 'Dirty or scratched lens', -500),
          item('module_power', 'ضعف قوة الليزر', 'Laser power loss', -2500),
          item('air_assist', 'عطل نفخ الهواء', 'Air-assist fault', -300),
          item('homing', 'خطأ في العودة للصفر', 'Homing error', -500),
          item('fan_noise', 'مروحة عالية الصوت أو معطلة', 'Loud or dead fan', -200),
          item('camera', 'عطل الكاميرا', 'Camera fault', -400),
          item('safety_sensor', 'عطل حساس الأمان', 'Safety-sensor fault', -600),
        ],
      }),
      on('repairs', { kind: 'count', per_item_bp: 300, max_bp: 1200 }),
      on('replaced_parts', {
        kind: 'checklist',
        max_total_bp: -1500,
        items: [
          item('lens', 'العدسة', 'Lens', 0),
          item('laser_module', 'وحدة الليزر', 'Laser module', -300),
          item('belts', 'الأحزمة', 'Belts', -100),
          ...COMMON_PARTS,
        ],
      }),
      on('accessory_condition', scale(-400, -200, -100, 0, 0)),
      on('original_accessories', choice(-300, -700)),
      on('market', { kind: 'market', resale_bp: -1200, product_overrides: [] }),
      on('product_type', { kind: 'flat', effect_bp: -300 }),
    ],
  },
  ams: {
    family: 'ams',
    version: 1,
    floor_bp: 1000,
    cap_bp: 8000,
    rounding_iqd: 1000,
    min_base_iqd: 50_000,
    ams_reference_iqd: 0,
    is_default: true,
    factors: [
      on('usage_age', { kind: 'age', per_month_bp: 120, max_bp: 4000, grace_months: 0 }),
      on('warranty_remaining', { kind: 'warranty', per_month_bp: 50, max_bp: 600 }),
      off('operating_hours', hours([null, 0])),
      on('cleanliness', scale(-800, -400, -150, 0, 0)),
      on('exterior', scale(-1000, -500, -200, 0, 100)),
      on('scratches', scale(-600, -300, -100, 0, 0)),
      on('faults', {
        kind: 'checklist',
        max_total_bp: -5000,
        items: [
          item('feed_error', 'أخطاء في سحب الفلمنت', 'Filament feed errors', -700),
          item('rfid', 'عطل قارئ RFID', 'RFID reader fault', -300),
          item('buffer', 'مشكلة في الـ Buffer', 'Buffer problem', -400),
          item('motor_noise', 'صوت غير طبيعي في المحركات', 'Abnormal motor noise', -400),
          item('humidity_sensor', 'عطل حساس الرطوبة', 'Humidity-sensor fault', -200),
          item('cutter', 'مشكلة في القاطع', 'Cutter problem', -500),
          item('ptfe_tubes', 'أنابيب PTFE مستهلكة', 'Worn PTFE tubes', -100),
        ],
      }),
      on('repairs', { kind: 'count', per_item_bp: 300, max_bp: 1200 }),
      on('replaced_parts', {
        kind: 'checklist',
        max_total_bp: -1200,
        items: [
          item('feeder', 'وحدة السحب (Feeder)', 'Feeder unit', -200),
          item('ptfe', 'أنابيب PTFE', 'PTFE tubes', 0),
          item('mainboard', 'اللوحة الأم', 'Mainboard', -600),
        ],
      }),
      on('accessory_condition', scale(-300, -150, -50, 0, 0)),
      on('original_accessories', choice(-300, -600)),
      on('market', { kind: 'market', resale_bp: -1000, product_overrides: [] }),
      on('product_type', { kind: 'flat', effect_bp: 0 }),
    ],
  },
  accessory: {
    family: 'accessory',
    version: 1,
    floor_bp: 500,
    cap_bp: 7000,
    rounding_iqd: 1000,
    min_base_iqd: 50_000,
    ams_reference_iqd: 0,
    is_default: true,
    factors: [
      on('usage_age', { kind: 'age', per_month_bp: 200, max_bp: 6000, grace_months: 0 }),
      on('warranty_remaining', { kind: 'warranty', per_month_bp: 50, max_bp: 500 }),
      off('operating_hours', hours([null, 0])),
      on('cleanliness', scale(-800, -400, -150, 0, 0)),
      on('exterior', scale(-1200, -600, -250, 0, 0)),
      on('scratches', scale(-800, -400, -150, 0, 0)),
      on('faults', {
        kind: 'checklist',
        max_total_bp: -7000,
        items: [
          item('not_working', 'لا يعمل', 'Does not work', -6000),
          item('partial', 'يعمل جزئياً', 'Works partly', -2500),
          item('missing_parts', 'قطع ناقصة', 'Missing parts', -1500),
        ],
      }),
      on('repairs', { kind: 'count', per_item_bp: 500, max_bp: 1500 }),
      off('replaced_parts', { kind: 'checklist', max_total_bp: 0, items: [] }),
      off('accessory_condition', scale(0, 0, 0, 0, 0)),
      on('original_accessories', choice(-500, -1000)),
      on('market', { kind: 'market', resale_bp: -2000, product_overrides: [] }),
      on('product_type', { kind: 'flat', effect_bp: -1000 }),
    ],
  },
};
