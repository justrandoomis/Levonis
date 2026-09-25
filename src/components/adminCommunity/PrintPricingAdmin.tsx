/**
 * PRINT PRICING, MATERIALS AND MATCHING — the owner's console.
 *
 * NOTHING ABOUT PRINT PRICING IS COMPILED IN. Every rate, factor, threshold,
 * material and matching weight the estimator uses arrives from admin settings,
 * and this screen is the only place a human sets them. So this file carries no
 * default numbers of its own: what it cannot read from the server it reports as
 * unreadable rather than filling in, because an invented rate here would come
 * back out as a quote a customer might act on.
 *
 * FOUR KEYS, FOUR SAVES. `printPricingConfig`, `printMaterials`,
 * `printMatchWeights` and `printLinkProviders` are four settings rows and are
 * written one at a time. A single "save everything" button would let a
 * half-typed material row overwrite a margin change made minutes earlier, so
 * each section PUTs only its own key and only when that section is dirty.
 *
 * MARGIN IS A SHARE OF THE SELLING PRICE, not a markup on cost — the reading
 * the rest of the platform uses (worker/lib/priceGrid.ts). The margin group
 * says so on screen, with a worked example, because reading 35% as a markup
 * quietly delivers 26% and no screen anywhere would show the gap.
 *
 * ENCLOSURE AND ABRASIVE ARE MATCHING FACTS. They sit in the material table
 * next to prices, but they decide who is ever OFFERED the job, not what it
 * costs — so the table says that out loud rather than leaving them to read as
 * two more pricing switches.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle, Boxes, Check, Link2, Loader2, Plus, Printer, RotateCcw, Scale, Sliders, Trash2,
} from 'lucide-react';
import PrinterModelsEditor from './PrinterModelsEditor';
import { api, ApiError, formatIqd } from '../../lib/api';
import { useLanguage } from '../../LanguageContext';
import type { PrintProcess, PrintQuality } from '../../lib/printApi';

// ------------------------------------------------------------------ shapes
//
// Mirrored from worker/lib/printPricing.ts, printMatching.ts and
// externalModels.ts rather than imported, keeping the boundary
// src/lib/printApi.ts already draws: the frontend states the shapes it reads.

interface PrintPricingConfig {
  labor_iqd_per_hour: number;
  setup_minutes: number;
  handling_minutes_per_part: number;
  energy_iqd_per_kwh: number;
  machine_hour_iqd: Record<PrintProcess, number>;
  machine_watts: Record<PrintProcess, number>;
  extrusion_width_mm: number;
  wall_count: number;
  flow_efficiency: number;
  layer_overhead_s: number;
  resin_layer_exposure_s: number;
  resin_lift_s: number;
  resin_post_minutes: number;
  support_height_ratio: number;
  support_density: number;
  support_removal_min_per_cm2: number;
  purge_mm3_per_color: number;
  multicolor_setup_minutes: number;
  multicolor_time_multiplier: number;
  failure_risk_base_percent: number;
  failure_risk_per_hour_percent: number;
  failure_risk_max_percent: number;
  quality_layer_mm: Record<PrintQuality, number>;
  quality_time_multiplier: Record<PrintQuality, number>;
  complexity_uplift_percent: number;
  target_margin_percent: number;
  min_margin_percent: number;
  min_job_iqd: number;
  range_spread_percent: number;
  quantity_discount_percent: number;
  quantity_discount_cap_percent: number;
  round_to_iqd: number;
}

interface PrintMaterial {
  id: string;
  process: PrintProcess;
  name_en: string;
  name_ar: string;
  density_g_cm3: number;
  price_iqd_per_kg: number;
  /** A fraction, not a percent: 0.05 is 5%. Shown as a percent, stored raw. */
  waste_factor: number;
  support_factor: number;
  min_economic_iqd: number;
  /** 0..1 — how likely a run in this material is to fail. */
  difficulty: number;
  needs_enclosure: boolean;
  abrasive: boolean;
  active: boolean;
}

interface MatchWeights {
  capability_fit: number;
  location: number;
  availability: number;
  rating: number;
  completed_jobs: number;
  response_time: number;
  reliability: number;
  price_suitability: number;
  preference_match: number;
  pro_bonus: number;
}

interface LinkProviderConfig {
  id: string;
  hosts: string[];
  api_url: string;
  headers?: Record<string, string>;
  enabled: boolean;
}

type Tab = 'pricing' | 'materials' | 'weights' | 'providers';
type T = (ar: string, en: string) => string;

/** The settings key each tab owns. The PUT path is built from this, so a tab
 *  can never write a key that belongs to another one. */
const KEY: Record<Tab, string> = {
  pricing: 'printPricingConfig',
  materials: 'printMaterials',
  weights: 'printMatchWeights',
  providers: 'printLinkProviders',
};

/** Everything this screen edits, as last read from the server. `pricing` and
 *  `weights` are nullable because "the stored row is unreadable" is a real
 *  state that must be shown, not papered over with substitute numbers. */
interface Loaded {
  pricing: PrintPricingConfig | null;
  materials: PrintMaterial[];
  weights: MatchWeights | null;
  providers: LinkProviderConfig[];
}

const PROCESSES: PrintProcess[] = ['fdm', 'resin'];
const QUALITIES: PrintQuality[] = ['draft', 'standard', 'fine', 'ultra'];
const WEIGHT_KEYS: Array<keyof MatchWeights> = [
  'capability_fit', 'location', 'availability', 'rating', 'completed_jobs',
  'response_time', 'reliability', 'price_suitability', 'preference_match', 'pro_bonus',
];

const processLabel = (p: PrintProcess, t: T) => (p === 'fdm' ? 'FDM' : t('ريزن', 'Resin'));
const qualityLabel = (q: PrintQuality, t: T) =>
  q === 'draft' ? t('مسودة', 'Draft')
  : q === 'standard' ? t('قياسي', 'Standard')
  : q === 'fine' ? t('دقيق', 'Fine')
  : t('فائق', 'Ultra');

// ------------------------------------------------------- the pricing fields
//
// One declarative table drives the inputs, the validation and the "is this
// value readable at all" check. Adding a rate to the model means adding a row
// here — there is no second list to keep in step.

interface PriceField {
  key: string;
  ar: string;
  en: string;
  /** Unit shown beside the box, as [ar, en]. */
  unit?: [string, string];
  hint?: [string, string];
  min: number;
  max?: number;
  step: number;
  get: (c: PrintPricingConfig) => number;
  set: (c: PrintPricingConfig, v: number) => PrintPricingConfig;
}

type NumericKey = {
  [K in keyof PrintPricingConfig]: PrintPricingConfig[K] extends number ? K : never;
}[keyof PrintPricingConfig];
type ProcRecordKey = 'machine_hour_iqd' | 'machine_watts';
type QualRecordKey = 'quality_layer_mm' | 'quality_time_multiplier';

interface FieldOpts {
  unit?: [string, string];
  hint?: [string, string];
  min?: number;
  max?: number;
  step?: number;
}

const IQD: [string, string] = ['د.ع', 'IQD'];
const MIN: [string, string] = ['دقيقة', 'min'];
const SEC: [string, string] = ['ثانية', 's'];
const PCT: [string, string] = ['٪', '%'];
const MM: [string, string] = ['ملم', 'mm'];

function f(key: NumericKey, ar: string, en: string, o: FieldOpts = {}): PriceField {
  return {
    key, ar, en, unit: o.unit, hint: o.hint,
    min: o.min ?? 0, max: o.max, step: o.step ?? 1,
    get: (c) => c[key],
    set: (c, v) => {
      const next = { ...c };
      next[key] = v;
      return next;
    },
  };
}

function fProc(key: ProcRecordKey, p: PrintProcess, ar: string, en: string, o: FieldOpts = {}): PriceField {
  return {
    key: `${key}.${p}`, ar, en, unit: o.unit, hint: o.hint,
    min: o.min ?? 0, max: o.max, step: o.step ?? 1,
    get: (c) => c[key][p],
    set: (c, v) => {
      const rec = { ...c[key] };
      rec[p] = v;
      const next = { ...c };
      next[key] = rec;
      return next;
    },
  };
}

function fQual(key: QualRecordKey, q: PrintQuality, ar: string, en: string, o: FieldOpts = {}): PriceField {
  return {
    key: `${key}.${q}`, ar, en, unit: o.unit, hint: o.hint,
    min: o.min ?? 0, max: o.max, step: o.step ?? 1,
    get: (c) => c[key][q],
    set: (c, v) => {
      const rec = { ...c[key] };
      rec[q] = v;
      const next = { ...c };
      next[key] = rec;
      return next;
    },
  };
}

interface PriceGroup {
  id: string;
  ar: string;
  en: string;
  note?: [string, string];
  fields: PriceField[];
}

const PRICING_GROUPS: PriceGroup[] = [
  {
    id: 'basics',
    ar: 'التكاليف الأساسية',
    en: 'Base costs',
    fields: [
      f('labor_iqd_per_hour', 'أجرة العمل للساعة', 'Labour per hour', { unit: IQD, step: 500 }),
      f('setup_minutes', 'تحضير الطبعة', 'Job setup', {
        unit: MIN,
        hint: ['مرة واحدة لكل طلب، مهما بلغ عدد القطع', 'Once per job, however many parts it has'],
      }),
      f('handling_minutes_per_part', 'مناولة القطعة', 'Handling per part', {
        unit: MIN,
        hint: ['نزع القطعة وفحصها وتغليفها — لكل قطعة', 'Removing, checking and packing ONE part'],
        step: 0.5,
      }),
      f('energy_iqd_per_kwh', 'سعر الكيلوواط/ساعة', 'Electricity per kWh', { unit: IQD, step: 10 }),
    ],
  },
  {
    id: 'machine',
    ar: 'الماكينة',
    en: 'The machine',
    note: [
      'كلفة الساعة إهلاك وصيانة: الماكينة كلفة حتى وهي تعمل وحدها بلا إنسان. أما الواط فتُضرب بسعر الكهرباء أعلاه.',
      'The machine hour is depreciation and maintenance — a machine costs money even while it runs unattended. The watts are multiplied by the electricity price above.',
    ],
    fields: [
      fProc('machine_hour_iqd', 'fdm', 'ساعة ماكينة FDM', 'FDM machine hour', { unit: IQD, step: 100 }),
      fProc('machine_hour_iqd', 'resin', 'ساعة ماكينة الريزن', 'Resin machine hour', { unit: IQD, step: 100 }),
      fProc('machine_watts', 'fdm', 'استهلاك FDM', 'FDM power draw', { unit: ['واط', 'W'], step: 5 }),
      fProc('machine_watts', 'resin', 'استهلاك الريزن', 'Resin power draw', { unit: ['واط', 'W'], step: 5 }),
    ],
  },
  {
    id: 'fdm',
    ar: 'FDM',
    en: 'FDM',
    note: [
      'في FDM يتبع الزمنُ حجمَ البلاستيك المدفوع عبر الفوهة.',
      'On FDM, time follows the VOLUME of plastic pushed through the nozzle.',
    ],
    fields: [
      f('extrusion_width_mm', 'عرض الخيط المبثوق', 'Extrusion width', { unit: MM, step: 0.01, max: 5 }),
      f('wall_count', 'عدد الجدران', 'Wall count', { step: 1, max: 20 }),
      f('flow_efficiency', 'كفاءة التدفق', 'Flow efficiency', {
        step: 0.01,
        max: 1,
        hint: [
          '٠٫٤٥ تعني أن الشريحة تحقق ٤٥٪ فقط من التدفق النظري بعد التسارع والانعطاف والتنقّل',
          '0.45 means a slicer realises only 45% of the nozzle’s paper throughput once acceleration, corners and travel are paid for',
        ],
      }),
      f('layer_overhead_s', 'ضياع لكل طبقة', 'Overhead per layer', { unit: SEC, step: 0.1 }),
    ],
  },
  {
    id: 'resin',
    ar: 'الريزن',
    en: 'Resin (MSLA)',
    note: [
      'في الريزن تتصلّب الطبقة كاملةً دفعة واحدة، فالزمن يتبع الارتفاع ولا يكاد يلاحظ الحجم. تسعير الاثنين بمعادلة واحدة أشهر طريقة يخسر بها المشغّل ماله.',
      'On MSLA a whole layer cures at once, so time follows HEIGHT and barely notices volume. Pricing both machines with one formula is the commonest way a print shop loses money.',
    ],
    fields: [
      f('resin_layer_exposure_s', 'تعريض الطبقة', 'Layer exposure', { unit: SEC, step: 0.1 }),
      f('resin_lift_s', 'رفع المنصة لكل طبقة', 'Lift per layer', { unit: SEC, step: 0.1 }),
      f('resin_post_minutes', 'الغسل والتجفيف', 'Wash and cure', { unit: MIN, step: 1 }),
    ],
  },
  {
    id: 'supports',
    ar: 'الدعامات',
    en: 'Supports',
    fields: [
      f('support_height_ratio', 'نسبة ارتفاع الدعامة', 'Support height ratio', {
        step: 0.05,
        max: 1,
        hint: ['كم من ارتفاع القطعة تتسلقه الدعامة وسطيًا', 'How much of the part’s height support has to climb, on average'],
      }),
      f('support_density', 'كثافة الدعامة', 'Support density', { step: 0.01, max: 1 }),
      f('support_removal_min_per_cm2', 'دقائق الإزالة لكل سم²', 'Removal minutes per cm²', { unit: MIN, step: 0.05 }),
    ],
  },
  {
    id: 'multicolor',
    ar: 'الألوان المتعددة',
    en: 'Multi-colour',
    fields: [
      f('purge_mm3_per_color', 'تنظيف الفوهة لكل لون', 'Purge per colour', { unit: ['ملم³', 'mm³'], step: 50 }),
      f('multicolor_setup_minutes', 'تحضير إضافي', 'Extra setup', { unit: MIN, step: 1 }),
      f('multicolor_time_multiplier', 'مضاعف الزمن', 'Time multiplier', {
        step: 0.05,
        min: 1,
        hint: ['تبديل الألوان يُبطئ الطباعة نفسها، لا التحضير وحده', 'Tool changes make the print itself slower, not just the setup'],
      }),
    ],
  },
  {
    id: 'risk',
    ar: 'مخاطر الفشل',
    en: 'Failure risk',
    note: [
      'الطبعة الفاشلة تُدفع مرتين: مادةً ووقتًا. هذا مخصّص تكلفة حقيقي، وليس هامشًا إضافيًا مموّهًا.',
      'A failed run is paid for twice, in material and in hours. This is a real cost provision, not a markup in disguise.',
    ],
    fields: [
      f('failure_risk_base_percent', 'مخاطرة أساسية', 'Base risk', { unit: PCT, max: 100, step: 0.5 }),
      f('failure_risk_per_hour_percent', 'زيادة لكل ساعة', 'Added per hour', { unit: PCT, max: 100, step: 0.1 }),
      f('failure_risk_max_percent', 'السقف', 'Cap', { unit: PCT, max: 100, step: 1 }),
    ],
  },
  {
    id: 'quality',
    ar: 'الجودة',
    en: 'Quality tiers',
    note: [
      'ارتفاع الطبقة يحدد عدد الطبقات، ومضاعف الزمن يحدد بطء الحركة. الاثنان معًا يصنعان فرق السعر بين المسودة والفائق.',
      'Layer height sets how many layers there are; the multiplier sets how slowly the machine moves. Together they are the whole price difference between Draft and Ultra.',
    ],
    fields: [
      ...QUALITIES.map((q) =>
        fQual('quality_layer_mm', q, `ارتفاع الطبقة — ${qualityLabel(q, (ar) => ar)}`, `Layer height — ${qualityLabel(q, (_ar, en) => en)}`, {
          unit: MM, step: 0.01, max: 2,
        })
      ),
      ...QUALITIES.map((q) =>
        fQual('quality_time_multiplier', q, `مضاعف الزمن — ${qualityLabel(q, (ar) => ar)}`, `Time multiplier — ${qualityLabel(q, (_ar, en) => en)}`, {
          step: 0.05, min: 0.1, max: 10,
        })
      ),
    ],
  },
  {
    id: 'margin',
    ar: 'الربح والحدود',
    en: 'Margin and limits',
    fields: [
      f('complexity_uplift_percent', 'زيادة التعقيد', 'Complexity uplift', { unit: PCT, max: 200, step: 1 }),
      f('target_margin_percent', 'الهامش المستهدف', 'Target margin', { unit: PCT, max: 95, step: 1 }),
      f('min_margin_percent', 'الحد الأدنى للهامش', 'MINIMUM margin', {
        unit: PCT,
        max: 95,
        step: 1,
        hint: ['أرضية لا يعبرها التسعير مهما قالت بقية الأرقام', 'A floor the arithmetic may never cross, whatever else the numbers say'],
      }),
      f('min_job_iqd', 'أقل قيمة لأي طلب', 'Minimum job', { unit: IQD, step: 500 }),
      f('range_spread_percent', 'اتساع النطاق ±', 'Range spread ±', { unit: PCT, max: 100, step: 1 }),
      f('quantity_discount_percent', 'خصم الكمية', 'Quantity discount', { unit: PCT, max: 100, step: 0.5 }),
      f('quantity_discount_cap_percent', 'سقف خصم الكمية', 'Discount cap', { unit: PCT, max: 100, step: 1 }),
      f('round_to_iqd', 'التقريب إلى', 'Round to', {
        unit: IQD,
        step: 50,
        hint: ['٠ يعني بلا تقريب', '0 means no rounding at all'],
      }),
    ],
  },
];

// ------------------------------------------------------------- reading them
//
// The server answers with the stored JSON, and a row written by an older
// deploy can be a shape short. Every reader below either returns something
// this screen can edit safely or says NO — none of them substitutes a number
// for a missing one, because a substituted rate looks exactly like a chosen
// one once it is saved back.

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** 0 stands for UNSET in the material table, never for a real price: the
 *  section refuses to save while a material still has a zero density or a
 *  zero price per kilo. */
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

function readPricing(raw: unknown): PrintPricingConfig | null {
  if (!isRecord(raw)) return null;
  const c = raw as unknown as PrintPricingConfig;
  if (!isRecord(c.machine_hour_iqd) || !isRecord(c.machine_watts)) return null;
  if (!isRecord(c.quality_layer_mm) || !isRecord(c.quality_time_multiplier)) return null;
  for (const g of PRICING_GROUPS) {
    for (const field of g.fields) {
      if (!Number.isFinite(field.get(c))) return null;
    }
  }
  return c;
}

function readMaterials(raw: unknown): PrintMaterial[] {
  if (!Array.isArray(raw)) return [];
  const out: PrintMaterial[] = [];
  for (const row of raw) {
    if (!isRecord(row) || typeof row.id !== 'string' || !row.id) continue;
    out.push({
      id: row.id,
      process: row.process === 'resin' ? 'resin' : 'fdm',
      name_en: typeof row.name_en === 'string' ? row.name_en : '',
      name_ar: typeof row.name_ar === 'string' ? row.name_ar : '',
      density_g_cm3: num(row.density_g_cm3),
      price_iqd_per_kg: num(row.price_iqd_per_kg),
      waste_factor: num(row.waste_factor),
      support_factor: num(row.support_factor),
      min_economic_iqd: num(row.min_economic_iqd),
      difficulty: num(row.difficulty),
      needs_enclosure: row.needs_enclosure === true,
      abrasive: row.abrasive === true,
      // Absent reads as active: a catalogue row written before the flag
      // existed is one the shops are already quoting from.
      active: row.active !== false,
    });
  }
  return out;
}

function readWeights(raw: unknown): MatchWeights | null {
  if (!isRecord(raw)) return null;
  const out = {} as MatchWeights;
  for (const k of WEIGHT_KEYS) {
    const v = raw[k];
    if (typeof v !== 'number' || !Number.isFinite(v)) return null;
    out[k] = v;
  }
  return out;
}

function readProviders(raw: unknown): LinkProviderConfig[] {
  if (!Array.isArray(raw)) return [];
  const out: LinkProviderConfig[] = [];
  for (const row of raw) {
    if (!isRecord(row) || typeof row.id !== 'string' || !row.id) continue;
    const hosts = Array.isArray(row.hosts) ? row.hosts.filter((h): h is string => typeof h === 'string') : [];
    // `headers` is carried through untouched. This screen does not edit it,
    // and dropping a field it merely failed to render would delete the
    // owner's configuration on the next save.
    const headers = isRecord(row.headers)
      ? Object.fromEntries(Object.entries(row.headers).filter(([, v]) => typeof v === 'string').map(([k, v]) => [k, String(v)]))
      : undefined;
    out.push({
      id: row.id,
      hosts,
      api_url: typeof row.api_url === 'string' ? row.api_url : '',
      headers,
      enabled: row.enabled !== false,
    });
  }
  return out;
}

const errText = (e: unknown, t: T): string =>
  e instanceof ApiError ? e.message : t('تعذّر الاتصال بالخادم', 'Could not reach the server');

/** What a tab sends as the settings value. `null` means "not editable right
 *  now", which is also what blocks its save button. */
function sectionValue(d: Loaded | null, tab: Tab): unknown {
  if (!d) return null;
  if (tab === 'pricing') return d.pricing;
  if (tab === 'materials') return d.materials;
  if (tab === 'weights') return d.weights;
  return d.providers;
}

// -------------------------------------------------------------- the screen

/**
 * `dir` is optional so this can be mounted either way: the admin sections are
 * handed the direction by their host (AdminCommunity does), and anything that
 * mounts it bare falls back to the language context.
 */
export default function PrintPricingAdmin({ dir }: { dir?: 'ltr' | 'rtl' }) {
  const { dir: ctxDir } = useLanguage();
  const rtl = (dir ?? ctxDir) === 'rtl';
  const t = useCallback<T>((ar: string, en: string) => (rtl ? ar : en), [rtl]);

  // 'printers' is not a settings key: the model cards are rows of their own,
  // written one model at a time by an audited route, so the tab sits outside
  // the four-keys save machinery below.
  const [tab, setTab] = useState<Tab | 'printers'>('pricing');
  const [loading, setLoading] = useState(true);
  const [loadErr, setLoadErr] = useState('');
  /** The last state read from the server — the yardstick the dirty flag uses. */
  const [saved, setSaved] = useState<Loaded | null>(null);
  const [draft, setDraft] = useState<Loaded | null>(null);
  const [savingTab, setSavingTab] = useState<Tab | ''>('');
  const [toast, setToast] = useState<{ ok: boolean; text: string } | null>(null);

  const load = useCallback(async (only?: Tab) => {
    const res = await api.get<{ settings: Record<string, unknown> }>('/api/admin/settings');
    const next: Loaded = {
      pricing: readPricing(res.settings.printPricingConfig),
      materials: readMaterials(res.settings.printMaterials),
      weights: readWeights(res.settings.printMatchWeights),
      providers: readProviders(res.settings.printLinkProviders),
    };
    setSaved(next);
    // A section reset must not throw away edits parked in the other three,
    // so a targeted refetch replaces one slice and leaves the rest alone.
    setDraft((cur) => {
      if (!cur || !only) return next;
      if (only === 'pricing') return { ...cur, pricing: next.pricing };
      if (only === 'materials') return { ...cur, materials: next.materials };
      if (only === 'weights') return { ...cur, weights: next.weights };
      return { ...cur, providers: next.providers };
    });
  }, []);

  useEffect(() => {
    load()
      .catch((e: unknown) => setLoadErr(errText(e, t)))
      .finally(() => setLoading(false));
    // `t` only re-reads the error language; refetching on a language switch
    // would discard unsaved edits, so it is deliberately not a dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load]);

  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(null), 4500);
    return () => clearTimeout(id);
  }, [toast]);

  const dirty = useCallback(
    (which: Tab) => JSON.stringify(sectionValue(draft, which)) !== JSON.stringify(sectionValue(saved, which)),
    [draft, saved]
  );

  const save = useCallback(
    async (which: Tab) => {
      const value = sectionValue(draft, which);
      if (value === null || value === undefined) return;
      setSavingTab(which);
      try {
        await api.put(`/api/admin/settings/${KEY[which]}`, { value });
        // Only the saved slice moves to the yardstick — the other sections
        // stay dirty, because they were not written.
        setSaved((cur) => {
          if (!cur || !draft) return cur;
          if (which === 'pricing') return { ...cur, pricing: draft.pricing };
          if (which === 'materials') return { ...cur, materials: draft.materials };
          if (which === 'weights') return { ...cur, weights: draft.weights };
          return { ...cur, providers: draft.providers };
        });
        setToast({ ok: true, text: t('تم الحفظ', 'Saved') });
      } catch (e) {
        setToast({ ok: false, text: errText(e, t) });
      } finally {
        setSavingTab('');
      }
    },
    [draft, t]
  );

  const reset = useCallback(
    async (which: Tab) => {
      try {
        await load(which);
        setToast({ ok: true, text: t('أُعيد تحميل القسم من الخادم', 'Section reloaded from the server') });
      } catch (e) {
        setToast({ ok: false, text: errText(e, t) });
      }
    },
    [load, t]
  );

  const TABS: Array<{ id: Tab | 'printers'; label: string; icon: React.ElementType }> = [
    { id: 'pricing', label: t('التسعير', 'Pricing'), icon: Sliders },
    { id: 'printers', label: t('الطابعات', 'Printers'), icon: Printer },
    { id: 'materials', label: t('المواد', 'Materials'), icon: Boxes },
    { id: 'weights', label: t('أوزان المطابقة', 'Match weights'), icon: Scale },
    { id: 'providers', label: t('مواقع الموديلات', 'Model sites'), icon: Link2 },
  ];

  if (loading) return <Spin />;
  if (loadErr) return <Err text={loadErr} />;
  if (!draft) return <Err text={t('لا توجد إعدادات', 'No settings returned')} />;

  const bar = (which: Tab) => ({
    t,
    section: which,
    dirty: dirty(which),
    saving: savingTab === which,
    onSave: () => void save(which),
    onReset: () => void reset(which),
  });

  return (
    <div className="text-white">
      <div className="flex gap-1.5 overflow-x-auto hide-scrollbar mb-5 pb-1">
        {TABS.map((s) => (
          <button
            key={s.id}
            data-print-admin-tab={s.id}
            onClick={() => setTab(s.id)}
            className={`shrink-0 flex items-center gap-2 px-4 min-h-[42px] rounded-2xl text-[13px] font-semibold border transition-colors ${
              tab === s.id
                ? 'bg-olive text-snow border-olive'
                : 'bg-zinc-800/40 text-zinc-400 border-zinc-700/50'
            }`}
          >
            <s.icon className="w-4 h-4" />
            {s.label}
            {s.id !== 'printers' && dirty(s.id) && <span className="w-1.5 h-1.5 rounded-full bg-gold" aria-hidden="true" />}
          </button>
        ))}
      </div>

      {tab === 'pricing' && (
        <PricingPanel
          t={t}
          value={draft.pricing}
          onChange={(v) => setDraft({ ...draft, pricing: v })}
          bar={bar('pricing')}
        />
      )}
      {tab === 'printers' && <PrinterModelsEditor t={t} />}
      {tab === 'materials' && (
        <MaterialsPanel
          t={t}
          value={draft.materials}
          onChange={(v) => setDraft({ ...draft, materials: v })}
          bar={bar('materials')}
        />
      )}
      {tab === 'weights' && (
        <WeightsPanel
          t={t}
          value={draft.weights}
          onChange={(v) => setDraft({ ...draft, weights: v })}
          bar={bar('weights')}
        />
      )}
      {tab === 'providers' && (
        <ProvidersPanel
          t={t}
          value={draft.providers}
          onChange={(v) => setDraft({ ...draft, providers: v })}
          bar={bar('providers')}
        />
      )}

      {toast && (
        <div className="fixed bottom-4 inset-x-4 flex justify-center pointer-events-none z-50">
          <div
            role="status"
            className={`pointer-events-auto flex items-center gap-2 px-4 min-h-[44px] rounded-2xl border text-[12.5px] font-semibold shadow-xl ${
              toast.ok
                ? 'bg-emerald-500/15 border-emerald-500/30 text-emerald-300'
                : 'bg-red-500/15 border-red-500/30 text-red-300'
            }`}
          >
            {toast.ok ? <Check className="w-4 h-4 shrink-0" /> : <AlertTriangle className="w-4 h-4 shrink-0" />}
            <span className="min-w-0">{toast.text}</span>
          </div>
        </div>
      )}
    </div>
  );
}

interface BarProps {
  t: T;
  section: Tab;
  dirty: boolean;
  saving: boolean;
  onSave: () => void;
  onReset: () => void;
}

// -------------------------------------------------------------- 1. pricing

/** Range violations, worded so the owner knows which box to fix. These block
 *  the save; the softer contradictions below only warn. */
function fieldProblems(c: PrintPricingConfig, t: T): string[] {
  const out: string[] = [];
  for (const g of PRICING_GROUPS) {
    for (const field of g.fields) {
      const v = field.get(c);
      const label = t(field.ar, field.en);
      if (!Number.isFinite(v)) out.push(t(`${label}: قيمة غير صالحة`, `${label}: not a number`));
      else if (v < field.min) out.push(t(`${label}: لا يقل عن ${field.min}`, `${label}: cannot be below ${field.min}`));
      else if (field.max !== undefined && v > field.max) {
        out.push(t(`${label}: لا يزيد عن ${field.max}`, `${label}: cannot be above ${field.max}`));
      }
    }
  }
  return out;
}

/** Numbers that are each legal but disagree with one another. Never blocking:
 *  the owner may know something the arithmetic does not. */
function crossWarnings(c: PrintPricingConfig, t: T): Array<{ group: string; text: string }> {
  const out: Array<{ group: string; text: string }> = [];
  if (c.min_margin_percent > c.target_margin_percent) {
    out.push({
      group: 'margin',
      text: t(
        'الحد الأدنى للهامش أعلى من المستهدف، فالأرضية هي التي ستحكم كل تسعيرة والمستهدف بلا أثر.',
        'The minimum margin is above the target, so the floor decides every quote and the target never applies.'
      ),
    });
  }
  if (c.failure_risk_max_percent < c.failure_risk_base_percent) {
    out.push({
      group: 'risk',
      text: t(
        'السقف أقل من المخاطرة الأساسية، فكل طبعة ستُقصّ عند السقف من أول ساعة.',
        'The cap is below the base risk, so every job is clipped to the cap from its first hour.'
      ),
    });
  }
  if (c.quantity_discount_cap_percent < c.quantity_discount_percent) {
    out.push({
      group: 'margin',
      text: t(
        'سقف خصم الكمية أقل من خصم الكمية نفسه: مضاعفة القطع لن تنقص السعر أكثر من السقف.',
        'The discount cap is below the per-doubling discount, so doubling the quantity stops helping immediately.'
      ),
    });
  }
  if (c.min_job_iqd > 0 && c.round_to_iqd > c.min_job_iqd) {
    out.push({
      group: 'margin',
      text: t(
        'خطوة التقريب أكبر من أقل قيمة طلب، فأصغر طبعة ستقفز فوق حدها الأدنى.',
        'The rounding step is larger than the minimum job, so the smallest print jumps past its own floor.'
      ),
    });
  }
  return out;
}

function PricingPanel({
  t, value, onChange, bar,
}: {
  t: T;
  value: PrintPricingConfig | null;
  onChange: (v: PrintPricingConfig) => void;
  bar: BarProps;
}) {
  const problems = useMemo(() => (value ? fieldProblems(value, t) : []), [value, t]);
  const warnings = useMemo(() => (value ? crossWarnings(value, t) : []), [value, t]);

  if (!value) {
    return (
      <div data-print-admin="pricing" className="space-y-3">
        <Err
          text={t(
            'القيمة المحفوظة في printPricingConfig ناقصة أو غير مقروءة. لن تُعرض أرقام بديلة هنا — أعد التحميل من الخادم، وإن بقيت المشكلة فالصف بحاجة إلى إصلاح قبل التحرير.',
            'The stored printPricingConfig is incomplete or unreadable. No substitute numbers are shown — reload it from the server, and if it stays broken the row needs fixing before it can be edited.'
          )}
        />
        <button
          onClick={bar.onReset}
          className="min-h-[44px] px-4 rounded-2xl border border-zinc-700/50 bg-zinc-800/40 text-zinc-300 text-[12.5px] font-semibold flex items-center gap-2"
        >
          <RotateCcw className="w-4 h-4" />
          {t('إعادة التحميل من الخادم', 'Reload from the server')}
        </button>
      </div>
    );
  }

  return (
    <div data-print-admin="pricing" className="space-y-4">
      <SaveBar {...bar} errors={problems} />

      {PRICING_GROUPS.map((g) => (
        <Section key={g.id} title={t(g.ar, g.en)}>
          {g.note && <Note text={t(g.note[0], g.note[1])} />}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {g.fields.map((field) => (
              <NumField
                key={field.key}
                label={t(field.ar, field.en)}
                hint={field.hint ? t(field.hint[0], field.hint[1]) : undefined}
                unit={field.unit ? t(field.unit[0], field.unit[1]) : undefined}
                value={field.get(value)}
                min={field.min}
                max={field.max}
                step={field.step}
                onChange={(v) => onChange(field.set(value, v))}
                dataField={field.key}
              />
            ))}
          </div>

          {g.id === 'margin' && <MarginNote t={t} c={value} />}

          {warnings
            .filter((w) => w.group === g.id)
            .map((w) => (
              <Warn key={w.text} text={w.text} />
            ))}
        </Section>
      ))}
    </div>
  );
}

/**
 * The one distinction on this screen that decides real money. It is spelled
 * out AND worked through on live numbers, because the mistake it prevents —
 * reading a margin as a markup — produces a plausible-looking price that is
 * short by a quarter, and nothing downstream ever flags it.
 */
function MarginNote({ t, c }: { t: T; c: PrintPricingConfig }) {
  const cost = 10000;
  const priceAt = (percent: number) => {
    const m = Math.min(Math.max(percent, 0), 95) / 100;
    return m <= 0 ? cost : Math.round(cost / (1 - m));
  };
  return (
    <div className="mt-4 rounded-2xl border border-gold/25 bg-gold/[0.06] p-3">
      <p className="text-gold text-[12.5px] font-bold mb-1.5">
        {t('الهامش حصة من سعر البيع، لا زيادة على الكلفة', 'Margin is a share of the SELLING price, not a markup on cost')}
      </p>
      <p className="text-zinc-300 text-[11.5px] leading-relaxed">
        {t(
          'هامش ٣٥٪ يعني ٣٥ دينارًا من كل ١٠٠ دينار يقبضها المشغّل — أي أن السعر = الكلفة ÷ (١ − ٠٫٣٥). من يقرأها زيادةً على الكلفة يبيع بهامش ٢٦٪ وهو يظن أنه ٣٥٪.',
          'A 35% margin means 35 dinars out of every 100 taken — price = cost ÷ (1 − 0.35). Read as a markup on cost it delivers 26% while looking like 35%.'
        )}
      </p>
      <div className="mt-2.5 grid grid-cols-1 sm:grid-cols-2 gap-2">
        <div className="rounded-xl border border-zinc-700/50 bg-zinc-900/40 px-3 py-2">
          <p className="text-zinc-500 text-[10.5px] mb-0.5">
            {t(`كلفة ${formatIqd(cost)} بالهامش المستهدف`, `${formatIqd(cost)} of cost at the target margin`)}
          </p>
          <p className="text-white font-bold text-[14px]" dir="ltr">{formatIqd(priceAt(c.target_margin_percent))}</p>
        </div>
        <div className="rounded-xl border border-zinc-700/50 bg-zinc-900/40 px-3 py-2">
          <p className="text-zinc-500 text-[10.5px] mb-0.5">
            {t('الأرضية عند الحد الأدنى', 'The floor at the minimum margin')}
          </p>
          <p className="text-white font-bold text-[14px]" dir="ltr">{formatIqd(priceAt(c.min_margin_percent))}</p>
        </div>
      </div>
      <p className="text-zinc-500 text-[10.5px] mt-2 leading-relaxed">
        {t(
          'الخادم يقصّ أي هامش فوق ٩٥٪، لأن ١٠٠٪ تعني قسمة على صفر.',
          'The server clamps any margin above 95% — 100% would be a division by zero.'
        )}
      </p>
    </div>
  );
}

// ------------------------------------------------------------ 2. materials

const asPercent = (fraction: number) => Math.round(fraction * 1000) / 10;

function materialProblems(list: PrintMaterial[], t: T): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of list) {
    const who = m.name_ar || m.name_en || m.id;
    if (seen.has(m.id)) out.push(t(`المعرّف ${m.id} مكرر`, `Duplicate id ${m.id}`));
    seen.add(m.id);
    if (!m.name_ar.trim() || !m.name_en.trim()) {
      out.push(t(`${who}: الاسم العربي والإنجليزي مطلوبان`, `${who}: both the Arabic and English names are required`));
    }
    if (m.density_g_cm3 <= 0) out.push(t(`${who}: الكثافة يجب أن تزيد عن صفر`, `${who}: density must be greater than zero`));
    if (m.price_iqd_per_kg <= 0) out.push(t(`${who}: سعر الكيلو مطلوب`, `${who}: price per kg is required`));
    if (m.waste_factor < 0 || m.waste_factor > 1) out.push(t(`${who}: الهدر بين ٠٪ و ١٠٠٪`, `${who}: waste must be between 0% and 100%`));
    if (m.support_factor <= 0) out.push(t(`${who}: معامل الدعم يجب أن يزيد عن صفر`, `${who}: support factor must be greater than zero`));
    if (m.difficulty < 0 || m.difficulty > 1) out.push(t(`${who}: الصعوبة بين ٠ و ١`, `${who}: difficulty must be between 0 and 1`));
    if (m.min_economic_iqd < 0) out.push(t(`${who}: أقل قيمة لا تكون سالبة`, `${who}: minimum job cannot be negative`));
  }
  return out;
}

function MaterialsPanel({
  t, value, onChange, bar,
}: {
  t: T;
  value: PrintMaterial[];
  onChange: (v: PrintMaterial[]) => void;
  bar: BarProps;
}) {
  const [filter, setFilter] = useState<'all' | PrintProcess>('all');
  const [newId, setNewId] = useState('');
  const [newProcess, setNewProcess] = useState<PrintProcess>('fdm');
  const [newAr, setNewAr] = useState('');
  const [newEn, setNewEn] = useState('');
  const [addErr, setAddErr] = useState('');
  const [confirmDel, setConfirmDel] = useState('');

  const problems = useMemo(() => materialProblems(value, t), [value, t]);
  const shown = filter === 'all' ? value : value.filter((m) => m.process === filter);
  const activeCount = value.filter((m) => m.active).length;

  const patch = (id: string, fields: Partial<PrintMaterial>) =>
    onChange(value.map((m) => (m.id === id ? { ...m, ...fields } : m)));

  function add() {
    const id = newId.trim().toLowerCase();
    if (!id) {
      setAddErr(t('المعرّف مطلوب', 'An id is required'));
      return;
    }
    if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) {
      setAddErr(t('المعرّف بحروف لاتينية صغيرة وأرقام وشرطات فقط', 'The id may only use lowercase letters, digits and dashes'));
      return;
    }
    // Refused here, not at the server: two rows with one id make the second
    // invisible to every lookup while still sitting in the table looking edited.
    if (value.some((m) => m.id === id)) {
      setAddErr(t(`المعرّف ${id} مستخدم بالفعل في هذا الجدول`, `The id ${id} is already used in this table`));
      return;
    }
    if (!newAr.trim() || !newEn.trim()) {
      setAddErr(t('الاسم العربي والإنجليزي مطلوبان', 'Both the Arabic and English names are required'));
      return;
    }
    setAddErr('');
    onChange([
      ...value,
      {
        id,
        process: newProcess,
        name_ar: newAr.trim(),
        name_en: newEn.trim(),
        // Zero is UNSET, and the save stays blocked until the owner types the
        // real density and the real price. `support_factor` starts at 1
        // because 1 is the identity — "the same support as anything else" —
        // not a guess about this material.
        density_g_cm3: 0,
        price_iqd_per_kg: 0,
        waste_factor: 0,
        support_factor: 1,
        min_economic_iqd: 0,
        difficulty: 0,
        needs_enclosure: false,
        abrasive: false,
        active: true,
      },
    ]);
    setNewId('');
    setNewAr('');
    setNewEn('');
  }

  return (
    <div data-print-admin="materials" className="space-y-4">
      <SaveBar {...bar} errors={problems} />

      <div className="rounded-2xl border border-gold/25 bg-gold/[0.06] p-3">
        <p className="text-gold text-[12.5px] font-bold mb-1.5">
          {t('ما الذي يغيّره كل عمود', 'What each column actually changes')}
        </p>
        <p className="text-zinc-300 text-[11.5px] leading-relaxed">
          {t(
            'الكثافة والسعر والهدر ومعامل الدعم تدخل في الكلفة. أما «يحتاج غرفة مغلقة» و«كاشط» فهما شرطا مطابقة قبل أن يكونا سعرًا: الورشة التي لا تملك غرفة مغلقة أو فوهة مقوّاة لا يصلها الطلب أصلًا، مهما كان تقييمها.',
            'Density, price, waste and support factor feed the cost. Enclosure and abrasive are MATCHING facts before they are pricing ones: a shop without the chamber or the hardened nozzle is never offered the job at all, whatever its rating.'
          )}
        </p>
        <p className="text-zinc-400 text-[11.5px] leading-relaxed mt-1.5">
          {t(
            '«الصعوبة» (٠ إلى ١) تغذّي مخصّص الفشل، و«أقل قيمة» تمنع تسعير طبعة لا تستحق تغيير البكرة.',
            'Difficulty (0 to 1) feeds the failure provision, and the minimum job stops a print being quoted that is not worth the spool change.'
          )}
        </p>
      </div>

      <div className="flex items-center gap-1.5 flex-wrap">
        {(['all', 'fdm', 'resin'] as const).map((k) => (
          <button
            key={k}
            onClick={() => setFilter(k)}
            className={`min-h-[34px] px-3 rounded-xl border text-[12px] font-semibold ${
              filter === k ? 'bg-olive text-snow border-olive' : 'bg-zinc-800/40 text-zinc-400 border-zinc-700/50'
            }`}
          >
            {k === 'all' ? t('الكل', 'All') : processLabel(k, t)}
          </button>
        ))}
        <span className="text-zinc-500 text-[11px] ms-auto">
          {t(`${value.length} مادة · ${activeCount} فعّالة`, `${value.length} materials · ${activeCount} active`)}
        </span>
      </div>

      <div className="space-y-3">
        {shown.map((m) => (
          <div
            key={m.id}
            data-material-row={m.id}
            className={`rounded-2xl border p-3 ${
              m.active ? 'border-zinc-700/50 bg-zinc-800/30' : 'border-zinc-800 bg-zinc-900/40 opacity-70'
            }`}
          >
            <div className="flex items-center gap-2 mb-3 flex-wrap">
              <span className="font-mono text-[11px] text-zinc-500 truncate max-w-[45%]" dir="ltr">{m.id}</span>
              <select
                data-print-field="process"
                value={m.process}
                onChange={(e) => patch(m.id, { process: e.target.value === 'resin' ? 'resin' : 'fdm' })}
                aria-label={t('التقنية', 'Process')}
                className="min-h-[34px] rounded-xl bg-zinc-800/60 border border-zinc-700/50 px-2 text-zinc-200 text-[11.5px] font-semibold outline-none focus:border-gold/40"
              >
                {PROCESSES.map((p) => (
                  <option key={p} value={p}>{processLabel(p, t)}</option>
                ))}
              </select>
              <div className="ms-auto flex items-center gap-1.5">
                <Toggle
                  label={t('فعّالة', 'Active')}
                  on={m.active}
                  onClick={() => patch(m.id, { active: !m.active })}
                  dataField="active"
                />
                {confirmDel === m.id ? (
                  <>
                    <button
                      data-material-delete-confirm={m.id}
                      onClick={() => {
                        onChange(value.filter((x) => x.id !== m.id));
                        setConfirmDel('');
                      }}
                      className="min-h-[34px] px-2.5 rounded-xl border border-red-500/30 bg-red-500/10 text-red-300 text-[11.5px] font-semibold"
                    >
                      {t('تأكيد الحذف', 'Confirm')}
                    </button>
                    <button
                      onClick={() => setConfirmDel('')}
                      className="min-h-[34px] px-2.5 rounded-xl border border-zinc-700/50 bg-zinc-800/40 text-zinc-400 text-[11.5px] font-semibold"
                    >
                      {t('إلغاء', 'Cancel')}
                    </button>
                  </>
                ) : (
                  <button
                    data-material-delete={m.id}
                    onClick={() => setConfirmDel(m.id)}
                    aria-label={t('حذف المادة', 'Delete material')}
                    className="w-9 h-9 rounded-xl border border-zinc-700/50 bg-zinc-800/40 text-zinc-400 flex items-center justify-center"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                )}
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
              <TextField
                label={t('الاسم بالعربية', 'Arabic name')}
                value={m.name_ar}
                onChange={(v) => patch(m.id, { name_ar: v })}
                dataField="name_ar"
              />
              <TextField
                label={t('الاسم بالإنجليزية', 'English name')}
                value={m.name_en}
                onChange={(v) => patch(m.id, { name_en: v })}
                ltr
                dataField="name_en"
              />
            </div>

            <div className="grid grid-cols-2 lg:grid-cols-3 gap-2.5 mt-2.5">
              <NumField
                label={t('الكثافة', 'Density')}
                unit="g/cm³"
                value={m.density_g_cm3}
                min={0}
                max={30}
                step={0.01}
                onChange={(v) => patch(m.id, { density_g_cm3: v })}
                dataField="density"
              />
              <NumField
                label={t('سعر الكيلو', 'Price per kg')}
                unit={t('د.ع', 'IQD')}
                value={m.price_iqd_per_kg}
                min={0}
                step={500}
                onChange={(v) => patch(m.id, { price_iqd_per_kg: v })}
                dataField="price_iqd_per_kg"
              />
              <NumField
                label={t('الهدر', 'Waste')}
                unit={t('٪', '%')}
                value={asPercent(m.waste_factor)}
                min={0}
                max={100}
                step={0.5}
                onChange={(v) => patch(m.id, { waste_factor: v / 100 })}
                dataField="waste_percent"
              />
              <NumField
                label={t('معامل الدعم', 'Support factor')}
                unit="×"
                value={m.support_factor}
                min={0}
                max={5}
                step={0.05}
                onChange={(v) => patch(m.id, { support_factor: v })}
                dataField="support_factor"
              />
              <NumField
                label={t('أقل قيمة', 'Minimum job')}
                unit={t('د.ع', 'IQD')}
                value={m.min_economic_iqd}
                min={0}
                step={500}
                onChange={(v) => patch(m.id, { min_economic_iqd: v })}
                dataField="min_economic_iqd"
              />
              <NumField
                label={t('الصعوبة', 'Difficulty')}
                unit="0–1"
                value={m.difficulty}
                min={0}
                max={1}
                step={0.05}
                onChange={(v) => patch(m.id, { difficulty: v })}
                dataField="difficulty"
              />
            </div>

            <div className="flex items-center gap-1.5 mt-2.5 flex-wrap">
              <Toggle
                label={t('يحتاج غرفة مغلقة', 'Needs enclosure')}
                on={m.needs_enclosure}
                onClick={() => patch(m.id, { needs_enclosure: !m.needs_enclosure })}
                tone="match"
                dataField="needs_enclosure"
              />
              <Toggle
                label={t('كاشط (فوهة مقوّاة)', 'Abrasive (hardened nozzle)')}
                on={m.abrasive}
                onClick={() => patch(m.id, { abrasive: !m.abrasive })}
                tone="match"
                dataField="abrasive"
              />
            </div>
          </div>
        ))}
        {shown.length === 0 && (
          <p className="py-10 text-center text-zinc-500 text-[13px]">{t('لا مواد في هذا التصنيف', 'No materials in this filter')}</p>
        )}
      </div>

      <div className="rounded-2xl border border-dashed border-zinc-700/60 bg-zinc-800/20 p-3">
        <h4 className="text-gold font-bold text-[12.5px] mb-2.5">{t('إضافة مادة', 'Add a material')}</h4>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
          <TextField
            label={t('المعرّف (لا يتغير لاحقًا)', 'Id (permanent)')}
            value={newId}
            onChange={setNewId}
            ltr
            placeholder="pla-hf"
            dataField="new_id"
          />
          <div>
            <label className="block text-zinc-400 text-[12px] font-semibold mb-1.5">{t('التقنية', 'Process')}</label>
            <select
              data-material-field="new_process"
              value={newProcess}
              onChange={(e) => setNewProcess(e.target.value === 'resin' ? 'resin' : 'fdm')}
              className="w-full min-h-[44px] rounded-2xl bg-zinc-800/40 border border-zinc-700/50 px-3 text-white text-[13px] outline-none focus:border-gold/40"
            >
              {PROCESSES.map((p) => (
                <option key={p} value={p}>{processLabel(p, t)}</option>
              ))}
            </select>
          </div>
          <TextField
            label={t('الاسم بالعربية', 'Arabic name')}
            value={newAr}
            onChange={setNewAr}
            dataField="new_name_ar"
          />
          <TextField
            label={t('الاسم بالإنجليزية', 'English name')}
            value={newEn}
            onChange={setNewEn}
            ltr
            dataField="new_name_en"
          />
        </div>
        {addErr && <p className="text-red-300 text-[11.5px] mt-2">{addErr}</p>}
        <button
          data-material-add
          onClick={add}
          className="mt-3 min-h-[44px] px-4 rounded-2xl bg-zinc-800/60 border border-zinc-700/50 text-white text-[12.5px] font-semibold flex items-center gap-2"
        >
          <Plus className="w-4 h-4" />
          {t('إضافة إلى الجدول', 'Add to the table')}
        </button>
        <p className="text-zinc-500 text-[11px] mt-2.5 leading-relaxed">
          {t(
            'المادة الجديدة تبدأ بكثافة وسعر صفر، والحفظ يبقى ممنوعًا حتى تُكتب الأرقام الحقيقية — لا تُخترع أرقام هنا. ولإيقاف مادة قديمة أطفئ «فعّالة» بدل حذفها: الحذف لا يمس الطلبات السابقة، لكنه يفقد اسمها في أي شاشة تقرأ الجدول.',
            'A new material starts at zero density and zero price and the save stays blocked until real numbers replace them — nothing is invented here. To retire an old material switch “Active” off rather than deleting it: deleting touches no past request, but every screen that reads the table loses its name.'
          )}
        </p>
      </div>
    </div>
  );
}

// -------------------------------------------------------------- 3. weights

const WEIGHT_META: Record<keyof MatchWeights, { ar: string; en: string; bar: string }> = {
  capability_fit: { ar: 'مطابقة القدرة', en: 'Capability fit', bar: 'bg-gold' },
  location: { ar: 'الموقع', en: 'Location', bar: 'bg-emerald-500' },
  availability: { ar: 'التفرّغ', en: 'Availability', bar: 'bg-sky-500' },
  rating: { ar: 'التقييم', en: 'Rating', bar: 'bg-violet-500' },
  completed_jobs: { ar: 'الأعمال المنجزة', en: 'Completed jobs', bar: 'bg-amber-500' },
  response_time: { ar: 'سرعة الرد', en: 'Response time', bar: 'bg-rose-500' },
  reliability: { ar: 'الالتزام', en: 'Reliability', bar: 'bg-teal-500' },
  price_suitability: { ar: 'ملاءمة السعر', en: 'Price fit', bar: 'bg-indigo-500' },
  preference_match: { ar: 'تفضيلات الورشة', en: 'Preference match', bar: 'bg-lime-500' },
  pro_bonus: { ar: 'أفضلية PRO', en: 'PRO bonus', bar: 'bg-fuchsia-500' },
};

function WeightsPanel({
  t, value, onChange, bar,
}: {
  t: T;
  value: MatchWeights | null;
  onChange: (v: MatchWeights) => void;
  bar: BarProps;
}) {
  const total = useMemo(
    () => (value ? WEIGHT_KEYS.reduce((sum, k) => sum + value[k], 0) : 0),
    [value]
  );
  const problems = useMemo(() => {
    if (!value) return [];
    const out: string[] = [];
    for (const k of WEIGHT_KEYS) {
      if (value[k] < 0) out.push(t(`${WEIGHT_META[k].ar}: لا يكون سالبًا`, `${WEIGHT_META[k].en}: cannot be negative`));
    }
    if (total <= 0) out.push(t('مجموع الأوزان صفر: لن يبقى أي ترتيب بين الورش', 'The weights add up to zero, which leaves no ranking at all'));
    return out;
  }, [value, total, t]);

  if (!value) {
    return (
      <div data-print-admin="weights" className="space-y-3">
        <Err
          text={t(
            'القيمة المحفوظة في printMatchWeights ناقصة أو غير مقروءة، ولن تُعرض أوزان بديلة.',
            'The stored printMatchWeights is incomplete or unreadable, and no substitute weights are shown.'
          )}
        />
        <button
          onClick={bar.onReset}
          className="min-h-[44px] px-4 rounded-2xl border border-zinc-700/50 bg-zinc-800/40 text-zinc-300 text-[12.5px] font-semibold flex items-center gap-2"
        >
          <RotateCcw className="w-4 h-4" />
          {t('إعادة التحميل من الخادم', 'Reload from the server')}
        </button>
      </div>
    );
  }

  const others = WEIGHT_KEYS.filter((k) => k !== 'pro_bonus').map((k) => value[k]);
  const smallestOther = others.length ? Math.min(...others) : 0;
  const proTooBig = value.pro_bonus > smallestOther;
  const share = (v: number) => (total > 0 ? (v / total) * 100 : 0);

  return (
    <div data-print-admin="weights" className="space-y-4">
      <SaveBar {...bar} errors={problems} />

      <Section title={t('التوازن الحالي', 'The current balance')}>
        <div className="flex h-3 w-full rounded-full overflow-hidden bg-zinc-900/60 border border-zinc-700/50">
          {WEIGHT_KEYS.map((k) => (
            <div
              key={k}
              className={WEIGHT_META[k].bar}
              style={{ width: `${share(value[k])}%` }}
              title={`${t(WEIGHT_META[k].ar, WEIGHT_META[k].en)} · ${share(value[k]).toFixed(1)}%`}
            />
          ))}
        </div>
        <p className="text-zinc-500 text-[11px] mt-2" dir="ltr">
          {t('المجموع', 'Total')}: {total}
        </p>
        <Note
          text={t(
            'الأوزان تعيد ترتيب الورش المؤهّلة فقط. لا يستطيع أي وزن أن يجعل ورشة غير قادرة مؤهّلة: الأهلية — الماكينة والمادة والحجم — تُحسم قبل أن تُحسب أي نقطة.',
            'These weights only re-rank shops that already qualify. No weight can make an incapable shop eligible: eligibility — machine, material, size — is decided before a single point is scored.'
          )}
        />
      </Section>

      <Section title={t('الأوزان', 'The weights')}>
        <div className="space-y-2.5">
          {WEIGHT_KEYS.map((k) => (
            <div key={k} className="flex items-center gap-3">
              <div className="min-w-0 flex-1">
                <label className="block text-zinc-300 text-[12.5px] font-semibold mb-1 truncate">
                  {t(WEIGHT_META[k].ar, WEIGHT_META[k].en)}
                </label>
                <div className="h-1.5 rounded-full bg-zinc-900/60 overflow-hidden">
                  <div className={`h-full ${WEIGHT_META[k].bar}`} style={{ width: `${share(value[k])}%` }} />
                </div>
              </div>
              <span className="text-zinc-500 text-[11px] w-12 text-end tabular-nums shrink-0" dir="ltr">
                {share(value[k]).toFixed(1)}%
              </span>
              <NumInput
                dataWeight={k}
                ariaLabel={t(WEIGHT_META[k].ar, WEIGHT_META[k].en)}
                value={value[k]}
                min={0}
                step={1}
                invalid={value[k] < 0}
                onChange={(n) => onChange({ ...value, [k]: n })}
                className="w-20 shrink-0 text-center"
              />
            </div>
          ))}
        </div>
      </Section>

      {proTooBig && (
        <Warn
          text={t(
            `أفضلية PRO (${value.pro_bonus}) أكبر من أصغر وزن آخر (${smallestOther}). الاشتراك يجب أن يرجّح بين متساويين، لا أن يتفوق على القدرة أو على سجل الالتزام.`,
            `The PRO bonus (${value.pro_bonus}) is larger than the smallest other weight (${smallestOther}). A subscription should reorder equals, not outrank capability or a record of delivering.`
          )}
        />
      )}
    </div>
  );
}

// ------------------------------------------------------------ 4. providers

function ProvidersPanel({
  t, value, onChange, bar,
}: {
  t: T;
  value: LinkProviderConfig[];
  onChange: (v: LinkProviderConfig[]) => void;
  bar: BarProps;
}) {
  const problems = useMemo(() => {
    const out: string[] = [];
    for (const p of value) {
      const url = p.api_url.trim();
      if (url && !/^https?:\/\//i.test(url)) {
        out.push(t(`${p.id}: الرابط يجب أن يبدأ بـ https://`, `${p.id}: the API URL must start with https://`));
      }
    }
    return out;
  }, [value, t]);

  const patch = (id: string, fields: Partial<LinkProviderConfig>) =>
    onChange(value.map((p) => (p.id === id ? { ...p, ...fields } : p)));

  return (
    <div data-print-admin="providers" className="space-y-4">
      <SaveBar {...bar} errors={problems} />

      <div className="rounded-2xl border border-gold/25 bg-gold/[0.06] p-3">
        <p className="text-gold text-[12.5px] font-bold mb-1.5">
          {t('Levonis لا يكشط الصفحات', 'Levonis never scrapes a page')}
        </p>
        <p className="text-zinc-300 text-[11.5px] leading-relaxed">
          {t(
            'بدون رابط API يظل Levonis يفهم الرابط نفسه — يعرف الموقع ويستخرج معرّف الموديل — لكنه لا يقرأ تفاصيل التصميم: لا أبعاد ولا حجم ولا صور. مع رابط API يسأل الموقع سؤالًا مباشرًا عبر واجهته المعلنة، ولا يفتح صفحة العرض ليقرأها.',
            'With no API URL Levonis still understands the link itself — it knows the site and pulls out the model id — but it cannot read the design’s details: no dimensions, no volume, no images. With an API URL it asks that site a direct question through its published interface; it never opens the listing page to read it.'
          )}
        </p>
        <p className="text-zinc-400 text-[11.5px] leading-relaxed mt-1.5">
          {t(
            '{id} داخل الرابط يُستبدل بمعرّف الموديل المستخرج. الإعدادات يقرأها كل مشرف، فلا يوضع أي مفتاح سري هنا.',
            '{id} inside the URL is replaced with the extracted model id. Settings are readable by every admin, so no secret key belongs here.'
          )}
        </p>
      </div>

      <div className="space-y-3">
        {value.map((p) => (
          <div key={p.id} className="rounded-2xl border border-zinc-700/50 bg-zinc-800/30 p-3">
            <div className="flex items-center gap-2 mb-2.5 flex-wrap">
              <span className="text-white font-bold text-[13px]" dir="ltr">{p.id}</span>
              {p.hosts.map((h) => (
                <span key={h} className="text-[10.5px] text-zinc-400 bg-zinc-900/60 border border-zinc-700/50 rounded-full px-2 py-0.5" dir="ltr">
                  {h}
                </span>
              ))}
              <div className="ms-auto">
                <Toggle
                  label={p.enabled ? t('مفعّل', 'Enabled') : t('موقوف', 'Disabled')}
                  on={p.enabled}
                  onClick={() => patch(p.id, { enabled: !p.enabled })}
                  dataField="enabled"
                />
              </div>
            </div>
            <TextField
              label={t('رابط API (اختياري)', 'API URL (optional)')}
              value={p.api_url}
              onChange={(v) => patch(p.id, { api_url: v })}
              ltr
              placeholder="https://api.example.com/models/{id}"
              dataField="api_url"
            />
            {p.api_url.trim() !== '' && !p.api_url.includes('{id}') && (
              <p className="text-amber-300/90 text-[11px] mt-1.5 leading-relaxed">
                {t(
                  'الرابط لا يحوي {id}، فسيُطلب العنوان نفسه لكل موديل ولن يصل معرّف التصميم إلى الموقع.',
                  'This URL has no {id}, so the same address is requested for every model and the design’s id never reaches the site.'
                )}
              </p>
            )}
            {p.headers && Object.keys(p.headers).length > 0 && (
              <p className="text-zinc-500 text-[11px] mt-1.5" dir="ltr">
                {t('رؤوس محفوظة', 'Stored headers')}: {Object.keys(p.headers).join(', ')}
              </p>
            )}
          </div>
        ))}
      </div>

      <p className="text-zinc-500 text-[11px] leading-relaxed">
        {t(
          'لا تُضاف مواقع جديدة من هنا: Levonis يحتاج أولًا أن يعرف شكل روابط الموقع ليستخرج معرّف الموديل منها، وذلك يُضاف في الكود لا في الإعدادات.',
          'New sites are not added here: Levonis must first know the shape of that site’s links to pull a model id out of them, and that lives in code rather than in a setting.'
        )}
      </p>
    </div>
  );
}

// ------------------------------------------------------------------- bits

function SaveBar({ t, section, dirty, saving, errors, onSave, onReset }: BarProps & { errors: string[] }) {
  const blocked = errors.length > 0;
  return (
    <div className="sticky top-0 z-10 -mx-1 px-1 py-2 bg-zinc-900/95 backdrop-blur-sm">
      {blocked && (
        <ul className="mb-2 rounded-2xl border border-red-500/30 bg-red-500/10 px-3 py-2 space-y-0.5 max-h-40 overflow-y-auto">
          {errors.map((e, i) => (
            <li key={`${i}-${e}`} className="text-red-300 text-[11.5px] leading-relaxed">{e}</li>
          ))}
        </ul>
      )}
      <div className="flex items-center gap-2">
        <button
          data-print-admin-save={section}
          onClick={onSave}
          disabled={!dirty || saving || blocked}
          className="flex-1 min-h-[46px] rounded-2xl bg-olive text-snow font-bold text-[13.5px] flex items-center justify-center gap-2 disabled:opacity-40"
        >
          {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
          {dirty ? t('حفظ هذا القسم', 'Save this section') : t('لا تغييرات', 'No changes')}
        </button>
        <button
          onClick={onReset}
          disabled={saving}
          aria-label={t('إعادة التحميل من الخادم', 'Reload from the server')}
          className="w-12 min-h-[46px] rounded-2xl border border-zinc-700/50 bg-zinc-800/40 text-zinc-300 flex items-center justify-center disabled:opacity-40"
        >
          <RotateCcw className="w-4 h-4" />
        </button>
      </div>
      <p className="text-zinc-500 text-[10.5px] mt-1.5 leading-relaxed">
        {t(
          'الحفظ يكتب هذا المفتاح وحده. زر الإرجاع يعيد قراءة القيم من الخادم ويتخلى عن أي تعديل غير محفوظ — وهي القيم الافتراضية ما لم تُحفظ من قبل.',
          'Saving writes this key alone. The reload button re-reads the values from the server and drops any unsaved edit — and those are the defaults until something has been saved.'
        )}
      </p>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-2xl border border-zinc-700/50 bg-zinc-800/30 p-4">
      <h3 className="text-gold font-bold text-[13px] mb-3">{title}</h3>
      {children}
    </div>
  );
}

function Note({ text }: { text: string }) {
  return <p className="text-zinc-500 text-[11.5px] leading-relaxed mb-3">{text}</p>;
}

function Warn({ text }: { text: string }) {
  return (
    <div className="mt-3 flex items-start gap-2 rounded-2xl border border-amber-500/30 bg-amber-500/10 px-3 py-2">
      <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
      <p className="text-amber-200/90 text-[11.5px] leading-relaxed">{text}</p>
    </div>
  );
}

function Err({ text }: { text: string }) {
  return (
    <div className="rounded-2xl border border-red-500/30 bg-red-500/10 px-4 py-3">
      <p className="text-red-300 text-[12.5px] leading-relaxed">{text}</p>
    </div>
  );
}

function Spin() {
  return (
    <div className="py-12 flex justify-center">
      <Loader2 className="w-5 h-5 text-gold animate-spin" />
    </div>
  );
}

/**
 * A number box that lets a decimal be TYPED.
 *
 * The value upstream is a number, but "0." and "" are states a keyboard passes
 * through on the way to one. Re-deriving the text from the number on every
 * keystroke deletes the half-typed decimal point under the cursor and makes an
 * empty box impossible to reach, so the box keeps its own text while it has
 * focus and re-syncs from the number on blur.
 */
function NumInput({
  value, onChange, min, max, step, invalid, className = '', dataField, dataWeight, ariaLabel,
}: {
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
  invalid?: boolean;
  className?: string;
  dataField?: string;
  dataWeight?: string;
  ariaLabel?: string;
}) {
  const [text, setText] = useState(() => String(value));
  const [focused, setFocused] = useState(false);

  useEffect(() => {
    if (!focused) setText(String(value));
  }, [value, focused]);

  return (
    <input
      data-print-field={dataField}
      data-weight={dataWeight}
      aria-label={ariaLabel}
      type="number"
      inputMode="decimal"
      min={min}
      max={max}
      step={step}
      value={text}
      onFocus={() => setFocused(true)}
      onBlur={() => {
        setFocused(false);
        setText(String(value));
      }}
      onChange={(e) => {
        setText(e.target.value);
        const n = Number(e.target.value);
        if (e.target.value !== '' && Number.isFinite(n)) onChange(n);
      }}
      dir="ltr"
      className={`min-h-[44px] rounded-2xl bg-zinc-800/40 border px-3 text-white text-[13px] outline-none focus:border-gold/40 ${
        invalid ? 'border-red-500/50' : 'border-zinc-700/50'
      } ${className}`}
    />
  );
}

function NumField({
  label, value, onChange, min, max, step, unit, hint, dataField,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  hint?: string;
  dataField?: string;
}) {
  const invalid =
    !Number.isFinite(value) ||
    (min !== undefined && value < min) ||
    (max !== undefined && value > max);

  return (
    <div>
      <label className="block text-zinc-400 text-[12px] font-semibold mb-1.5">{label}</label>
      <div className="flex items-center gap-2">
        <NumInput
          value={value}
          onChange={onChange}
          min={min}
          max={max}
          step={step}
          invalid={invalid}
          dataField={dataField}
          ariaLabel={label}
          className="min-w-0 flex-1"
        />
        {unit && <span className="text-zinc-500 text-[11.5px] shrink-0 min-w-[2.2rem]">{unit}</span>}
      </div>
      {hint && <p className="text-zinc-600 text-[10.5px] mt-1 leading-relaxed">{hint}</p>}
    </div>
  );
}

function TextField({
  label, value, onChange, ltr, placeholder, dataField,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  ltr?: boolean;
  placeholder?: string;
  dataField?: string;
}) {
  return (
    <div>
      <label className="block text-zinc-400 text-[12px] font-semibold mb-1.5">{label}</label>
      <input
        data-print-field={dataField}
        type="text"
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        dir={ltr ? 'ltr' : undefined}
        className="w-full min-h-[44px] rounded-2xl bg-zinc-800/40 border border-zinc-700/50 px-3 text-white text-[13px] outline-none focus:border-gold/40 placeholder:text-zinc-600"
      />
    </div>
  );
}

/**
 * `tone="match"` marks the two flags that decide who is OFFERED a job rather
 * than what it costs, so they do not read as two more pricing switches.
 */
function Toggle({
  label, on, onClick, tone = 'default', dataField,
}: {
  label: string;
  on: boolean;
  onClick: () => void;
  tone?: 'default' | 'match';
  dataField?: string;
}) {
  const lit =
    tone === 'match'
      ? 'bg-sky-500/15 border-sky-500/40 text-sky-300'
      : 'bg-olive border-olive text-snow';
  return (
    <button
      type="button"
      data-print-field={dataField}
      aria-pressed={on}
      onClick={onClick}
      className={`min-h-[34px] px-3 rounded-xl border text-[11.5px] font-semibold transition-colors ${
        on ? lit : 'bg-zinc-800/40 border-zinc-700/50 text-zinc-500'
      }`}
    >
      {label}
    </button>
  );
}
