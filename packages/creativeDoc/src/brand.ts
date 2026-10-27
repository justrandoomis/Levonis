/**
 * THE BRAND KIT — Levonis's visual rules as data, versioned (spec §5, §6).
 *
 * Two kinds of rule live here and are kept apart on purpose:
 *   - BINDING rules are enforced by code everywhere (the editor, the
 *     normaliser, the ops, the export, the quality checks): no stretched
 *     product, prices only from bindings, the logo only from an approved
 *     asset, only registered fonts, essentials inside the safe area. The kit
 *     lists them for the owner to read; it cannot switch them off.
 *   - PREFERENCES are numbers and choices the layout balances: colours, type
 *     scale, spacing, density, tone.
 *
 * Saving a kit creates a NEW version; documents keep the version they were
 * made with, so an approved design never changes under its approver.
 *
 * `defaultBrandKit()` is the starting kit before the owner has approved one.
 * It is marked pending and uses only what the repository really has: the
 * site's own logo (served by `src/lib/siteLogo.ts`, never redrawn), the two
 * registered fonts, and a charcoal background per the brief. Nothing in it
 * claims to match a reference nobody has seen.
 */
import { cleanText } from './text';
import {
  isFontFamily, isHexColor, type Corner, type FontFamilyId, type FontWeight, type FormatId, type SafeArea,
} from './schema';
import type { CurrencyLabel, DigitStyle } from './text';

export const BRAND_SCHEMA_VERSION = 1 as const;

export type TypeRole = 'headline' | 'subhead' | 'body' | 'feature' | 'product_name' | 'price' | 'price_note' | 'cta' | 'badge' | 'note';
export const TYPE_ROLES: readonly TypeRole[] = ['headline', 'subhead', 'body', 'feature', 'product_name', 'price', 'price_note', 'cta', 'badge', 'note'];

export interface TypeStyle {
  /** Size at 1080 px width; other widths scale proportionally. */
  size: number;
  /** The readable floor for this role at 1080 px width. */
  min: number;
  weight: FontWeight;
  lineHeight: number;
  /** Which of the kit's two families: the text face or the display face. */
  face: 'primary' | 'display';
}

export interface BackgroundPreset {
  id: string;
  label: string;
  /** A flat colour, or an approved uploaded asset reused exactly as stored (spec §5: never regenerated). */
  kind: 'solid' | 'asset';
  color: string;
  asset_id: string | null;
}

export interface BrandKit {
  schema_version: typeof BRAND_SCHEMA_VERSION;
  name: string;
  colors: {
    background: string;
    surface: string;
    text: string;
    text_muted: string;
    /** The one accent (a CTA chip, a thin rule) — used sparingly. */
    accent: string;
    accent_text: string;
    price: string;
    /** Extra colours a person or Claude may choose. Anything else is refused. */
    palette: string[];
  };
  fonts: { primary: FontFamilyId; display: FontFamilyId };
  type: Record<TypeRole, TypeStyle>;
  /** Base spacing unit and the three gaps the templates use, at 1080 px width. */
  spacing: { unit: number; small: number; medium: number; large: number };
  /** Margins per format (spec §5: adjustable by size and display context). */
  safe_area: Record<Exclude<FormatId, 'custom'>, SafeArea>;
  backgrounds: BackgroundPreset[];
  default_background: string;
  logo: {
    /** `site` = the site's own master logo (src/lib/siteLogo.ts); otherwise an approved creative asset id. */
    asset: string;
    corner: Corner;
    /** Width at 1080 px document width. */
    width: number;
    show_by_default: boolean;
  };
  shadow: { enabled: boolean; opacity: number; blur: number; width_ratio: number; height_ratio: number };
  density: { max_text_layers: number; max_features: number };
  tone: { register: 'fusha' | 'iraqi_light'; notes: string[] };
  digits: DigitStyle;
  currency_label: CurrencyLabel;
  /** The brief's default "avoid" list, shown to Claude as negative guidance. */
  avoid: string[];
  /** Preferences the owner wrote as words (shown to Claude, never executed). */
  notes: string[];
}

/** The binding rules, as the owner reads them. Enforced in code, listed here for the brand page. */
export const BINDING_RULES: ReadonlyArray<{ code: string; ar: string; en: string; ckb: string }> = [
  { code: 'product_uniform_scale', ar: 'صورة المنتج تُحجَّم بنسبة واحدة فقط، بلا تمديد أو انحراف أو قلب', en: 'Product images scale uniformly only — no stretch, skew or flip', ckb: 'وێنەی بەرهەم تەنها بە یەک ڕێژە گەورە و بچووک دەکرێت، بەبێ کێشان و لاربوونەوە و هەڵگەڕانەوە' },
  { code: 'price_binding', ar: 'السعر يأتي من بيانات المتجر الموثقة فقط، ولا يُكتب يدوياً أو من الذكاء الاصطناعي', en: 'Prices come only from verified store data — never typed or written by AI', ckb: 'نرخ تەنها لە داتای پشتڕاستکراوەی فرۆشگاوە دێت، هەرگیز بە دەست یان لەلایەن AI نانووسرێت' },
  { code: 'logo_origin', ar: 'الشعار من الأصل المعتمد فقط ولا يُعاد رسمه', en: 'The logo comes only from the approved asset and is never redrawn', ckb: 'لۆگۆ تەنها لە سەرچاوەی پەسەندکراوەوە دێت و دووبارە ناکێشرێتەوە' },
  { code: 'approved_fonts', ar: 'الخطوط المسجلة فقط، والخط المفقود يظهر كمشكلة', en: 'Only registered fonts; a missing font shows as a problem', ckb: 'تەنها فۆنتە تۆمارکراوەکان؛ فۆنتی ونبوو وەک کێشە پیشان دەدرێت' },
  { code: 'safe_area', ar: 'العنوان والمنتج والسعر والدعوة داخل منطقة الأمان', en: 'Headline, product, price and call to action stay inside the safe area', ckb: 'سەردێڕ و بەرهەم و نرخ و بانگەواز لەناو ناوچەی پارێزراودا دەمێننەوە' },
];

export const DEFAULT_AVOID: readonly string[] = [
  'neon', 'strong glow', 'random corner light spots', 'stage podiums under the product', 'fake floors',
  'exaggerated reflections', 'gold and generic ornaments', 'many cards and badges', 'purposeless floating shapes',
];

const SA = (top: number, side: number, bottom: number): SafeArea => ({ top, right: side, bottom, left: side });

export function defaultBrandKit(): BrandKit {
  return {
    schema_version: BRAND_SCHEMA_VERSION,
    name: 'Levonis',
    colors: {
      background: '#111214',
      surface: '#1b1d20',
      text: '#f4f4f1',
      text_muted: '#a9aca6',
      accent: '#e9e6dc',
      accent_text: '#111214',
      price: '#f4f4f1',
      palette: ['#111214', '#1b1d20', '#2a2d31', '#f4f4f1', '#a9aca6', '#e9e6dc', '#c9cdc4'],
    },
    fonts: { primary: 'plex-arabic', display: 'plex-arabic' },
    type: {
      headline: { size: 76, min: 48, weight: 700, lineHeight: 1.25, face: 'display' },
      subhead: { size: 40, min: 28, weight: 400, lineHeight: 1.45, face: 'primary' },
      body: { size: 34, min: 26, weight: 400, lineHeight: 1.5, face: 'primary' },
      feature: { size: 34, min: 26, weight: 600, lineHeight: 1.4, face: 'primary' },
      product_name: { size: 40, min: 28, weight: 600, lineHeight: 1.35, face: 'primary' },
      price: { size: 60, min: 40, weight: 700, lineHeight: 1.2, face: 'display' },
      price_note: { size: 28, min: 22, weight: 400, lineHeight: 1.4, face: 'primary' },
      cta: { size: 32, min: 26, weight: 600, lineHeight: 1.3, face: 'primary' },
      badge: { size: 26, min: 22, weight: 600, lineHeight: 1.3, face: 'primary' },
      note: { size: 24, min: 22, weight: 400, lineHeight: 1.4, face: 'primary' },
    },
    spacing: { unit: 8, small: 16, medium: 32, large: 56 },
    safe_area: { square: SA(72, 72, 72), portrait: SA(88, 72, 96), story: SA(220, 72, 260) },
    backgrounds: [{ id: 'charcoal', label: 'Charcoal matte', kind: 'solid', color: '#111214', asset_id: null }],
    default_background: 'charcoal',
    logo: { asset: 'site', corner: 'top_end', width: 96, show_by_default: true },
    shadow: { enabled: true, opacity: 0.45, blur: 28, width_ratio: 0.7, height_ratio: 0.06 },
    density: { max_text_layers: 7, max_features: 3 },
    tone: { register: 'fusha', notes: [] },
    digits: 'latn',
    currency_label: 'د.ع',
    avoid: [...DEFAULT_AVOID],
    notes: [],
  };
}

export interface BrandIssue {
  path: string;
  code: 'invalid_value' | 'unknown_key' | 'clamped' | 'not_an_object' | 'unsupported_schema_version';
  fatal: boolean;
}

const clampNum = (v: unknown, min: number, max: number, fallback: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback;

/**
 * The one gate for a kit (on save and on read). Unknown keys are dropped,
 * numbers clamped, invalid colours and fonts replaced by the default's —
 * each with an issue. Never throws, always returns a complete kit.
 */
export function normalizeBrandKit(input: unknown): { kit: BrandKit; issues: BrandIssue[]; ok: boolean } {
  const issues: BrandIssue[] = [];
  const def = defaultBrandKit();
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { kit: def, issues: [{ path: '', code: 'not_an_object', fatal: true }], ok: false };
  }
  const src = input as Record<string, unknown>;
  if (src.schema_version !== undefined && src.schema_version !== BRAND_SCHEMA_VERSION) {
    return { kit: def, issues: [{ path: 'schema_version', code: 'unsupported_schema_version', fatal: true }], ok: false };
  }
  const color = (path: string, v: unknown, fallback: string) => {
    if (isHexColor(v)) return v.toLowerCase();
    if (v !== undefined) issues.push({ path, code: 'invalid_value', fatal: false });
    return fallback;
  };
  const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

  const c = obj(src.colors);
  const palette = Array.isArray(c.palette) ? c.palette.filter(isHexColor).map((x) => x.toLowerCase()).slice(0, 16) : def.colors.palette;
  const colors: BrandKit['colors'] = {
    background: color('colors.background', c.background, def.colors.background),
    surface: color('colors.surface', c.surface, def.colors.surface),
    text: color('colors.text', c.text, def.colors.text),
    text_muted: color('colors.text_muted', c.text_muted, def.colors.text_muted),
    accent: color('colors.accent', c.accent, def.colors.accent),
    accent_text: color('colors.accent_text', c.accent_text, def.colors.accent_text),
    price: color('colors.price', c.price, def.colors.price),
    palette: [],
  };
  // Every named colour is also a palette colour, so a choice the kit itself makes is never "outside the palette".
  colors.palette = [...new Set([...palette, colors.background, colors.surface, colors.text, colors.text_muted, colors.accent, colors.accent_text, colors.price])];

  const f = obj(src.fonts);
  const fonts = {
    primary: isFontFamily(f.primary) ? f.primary : def.fonts.primary,
    display: isFontFamily(f.display) ? f.display : def.fonts.display,
  };
  if (f.primary !== undefined && !isFontFamily(f.primary)) issues.push({ path: 'fonts.primary', code: 'invalid_value', fatal: false });
  if (f.display !== undefined && !isFontFamily(f.display)) issues.push({ path: 'fonts.display', code: 'invalid_value', fatal: false });

  const t = obj(src.type);
  const type = {} as Record<TypeRole, TypeStyle>;
  for (const role of TYPE_ROLES) {
    const r = obj(t[role]);
    const d = def.type[role];
    const weight = [400, 500, 600, 700, 800].includes(r.weight as number) ? (r.weight as FontWeight) : d.weight;
    const size = clampNum(r.size, 16, 200, d.size);
    // The floor never drops below 20 px at 1080 width: below that nothing on a phone feed is readable.
    const min = Math.min(size, clampNum(r.min, 20, 200, d.min));
    type[role] = { size, min, weight, lineHeight: clampNum(r.lineHeight, 1, 2.2, d.lineHeight), face: r.face === 'display' || r.face === 'primary' ? r.face : d.face };
  }

  const sp = obj(src.spacing);
  const spacing = {
    unit: clampNum(sp.unit, 2, 32, def.spacing.unit),
    small: clampNum(sp.small, 4, 120, def.spacing.small),
    medium: clampNum(sp.medium, 8, 200, def.spacing.medium),
    large: clampNum(sp.large, 16, 320, def.spacing.large),
  };

  const sa = obj(src.safe_area);
  const safeOf = (k: 'square' | 'portrait' | 'story'): SafeArea => {
    const s = obj(sa[k]);
    const d = def.safe_area[k];
    return { top: clampNum(s.top, 0, 600, d.top), right: clampNum(s.right, 0, 400, d.right), bottom: clampNum(s.bottom, 0, 600, d.bottom), left: clampNum(s.left, 0, 400, d.left) };
  };

  const backgrounds: BackgroundPreset[] = [];
  for (const b of Array.isArray(src.backgrounds) ? src.backgrounds.slice(0, 24) : def.backgrounds) {
    const o = obj(b);
    const id = typeof o.id === 'string' && /^[a-z][a-z0-9_-]{0,39}$/.test(o.id) ? o.id : null;
    if (!id || backgrounds.some((x) => x.id === id)) continue;
    const kind = o.kind === 'asset' ? 'asset' : 'solid';
    const assetId = typeof o.asset_id === 'string' && /^[A-Za-z0-9_-]{6,64}$/.test(o.asset_id) ? o.asset_id : null;
    if (kind === 'asset' && !assetId) continue;
    backgrounds.push({ id, label: cleanText(o.label, 60).value || id, kind, color: isHexColor(o.color) ? o.color.toLowerCase() : colors.background, asset_id: kind === 'asset' ? assetId : null });
  }
  if (!backgrounds.length) backgrounds.push(...def.backgrounds);
  const default_background = typeof src.default_background === 'string' && backgrounds.some((b) => b.id === src.default_background) ? src.default_background : backgrounds[0].id;

  const lg = obj(src.logo);
  const corners: Corner[] = ['top_start', 'top_end', 'bottom_start', 'bottom_end'];
  const logo = {
    asset: lg.asset === 'site' || (typeof lg.asset === 'string' && /^[A-Za-z0-9_-]{6,64}$/.test(lg.asset)) ? (lg.asset as string) : def.logo.asset,
    corner: corners.includes(lg.corner as Corner) ? (lg.corner as Corner) : def.logo.corner,
    width: clampNum(lg.width, 40, 400, def.logo.width),
    show_by_default: typeof lg.show_by_default === 'boolean' ? lg.show_by_default : def.logo.show_by_default,
  };

  const sh = obj(src.shadow);
  const shadow = {
    enabled: typeof sh.enabled === 'boolean' ? sh.enabled : def.shadow.enabled,
    opacity: clampNum(sh.opacity, 0, 0.9, def.shadow.opacity),
    blur: clampNum(sh.blur, 0, 120, def.shadow.blur),
    width_ratio: clampNum(sh.width_ratio, 0.2, 1.2, def.shadow.width_ratio),
    height_ratio: clampNum(sh.height_ratio, 0.01, 0.3, def.shadow.height_ratio),
  };
  const dn = obj(src.density);
  const density = { max_text_layers: Math.round(clampNum(dn.max_text_layers, 2, 16, def.density.max_text_layers)), max_features: Math.round(clampNum(dn.max_features, 0, 8, def.density.max_features)) };
  const tn = obj(src.tone);
  const tone = {
    register: tn.register === 'iraqi_light' ? ('iraqi_light' as const) : ('fusha' as const),
    notes: Array.isArray(tn.notes) ? tn.notes.map((n) => cleanText(n, 200).value).filter(Boolean).slice(0, 12) : [],
  };
  const strings = (v: unknown, max: number, n: number) => (Array.isArray(v) ? v.map((x) => cleanText(x, max).value).filter(Boolean).slice(0, n) : null);

  const known = new Set(['schema_version', 'name', 'colors', 'fonts', 'type', 'spacing', 'safe_area', 'backgrounds', 'default_background', 'logo', 'shadow', 'density', 'tone', 'digits', 'currency_label', 'avoid', 'notes']);
  for (const k of Object.keys(src)) if (!known.has(k)) issues.push({ path: k, code: 'unknown_key', fatal: false });

  const kit: BrandKit = {
    schema_version: BRAND_SCHEMA_VERSION,
    name: cleanText(src.name, 60).value || def.name,
    colors,
    fonts,
    type,
    spacing,
    safe_area: { square: safeOf('square'), portrait: safeOf('portrait'), story: safeOf('story') },
    backgrounds,
    default_background,
    logo,
    shadow,
    density,
    tone,
    digits: src.digits === 'arab' ? 'arab' : 'latn',
    currency_label: src.currency_label === 'IQD' ? 'IQD' : 'د.ع',
    avoid: strings(src.avoid, 80, 24) ?? [...DEFAULT_AVOID],
    notes: strings(src.notes, 300, 24) ?? [],
  };
  return { kit, issues, ok: !issues.some((i) => i.fatal) };
}

/** The smallest font size a document stores (normalizeDocument's floor): a scaled style never goes under it. */
export const MIN_FONT_PX = 8;

/**
 * How much a kit written for 1080 px scales on a document: by its SHORTER
 * side. The three post formats are 1080 wide, so nothing changes for them; a
 * landscape custom size (a 1200×628 link ad, a 1584×396 banner) scales by its
 * height, so its type, logo, gaps and margins still fit its height instead of
 * swallowing it.
 */
export function kitScale(docWidth: number, docHeight: number = docWidth): number {
  return Math.min(docWidth, docHeight) / 1080;
}

/** A type style scaled to a document (the kit is written for 1080 px), never under the stored floor. */
export function scaledType(kit: BrandKit, role: TypeRole, docWidth: number, docHeight?: number): TypeStyle & { family: FontFamilyId } {
  const s = kit.type[role];
  const k = kitScale(docWidth, docHeight);
  const size = Math.max(MIN_FONT_PX, Math.round(s.size * k));
  return { ...s, size, min: Math.max(MIN_FONT_PX, Math.min(size, Math.max(Math.round(s.min * k), 12))), family: s.face === 'display' ? kit.fonts.display : kit.fonts.primary };
}

export function scaledSpacing(kit: BrandKit, docWidth: number, docHeight?: number): BrandKit['spacing'] {
  const k = kitScale(docWidth, docHeight);
  return { unit: kit.spacing.unit * k, small: kit.spacing.small * k, medium: kit.spacing.medium * k, large: kit.spacing.large * k };
}

/** The safe area for any format (custom sizes take the nearest preset's margins, scaled by the shorter side). */
export function safeAreaFor(kit: BrandKit, format: { id: FormatId; width: number; height: number }): SafeArea {
  if (format.id !== 'custom') return { ...kit.safe_area[format.id] };
  const ratio = format.height / format.width;
  const base = ratio >= 1.6 ? kit.safe_area.story : ratio >= 1.15 ? kit.safe_area.portrait : kit.safe_area.square;
  const k = kitScale(format.width, format.height);
  return { top: base.top * k, right: base.right * k, bottom: base.bottom * k, left: base.left * k };
}

export function inPalette(kit: BrandKit, color: string): boolean {
  return kit.colors.palette.includes(color.toLowerCase());
}
