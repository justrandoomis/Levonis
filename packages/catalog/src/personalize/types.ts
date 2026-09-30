/**
 * THE SHAPES OF THE ONE PERSONALIZATION ENGINE (Programme C, phase C1;
 * docs/LEVO_PROJECT_PROGRAMME.md §B.1 «Shapes», §0 rows 3–5, 24 and 39).
 *
 *   BlueprintSpec v1   what the MERCHANT defines for one product revision —
 *                      normalised by spec.ts (`normalizeBlueprint`), stored as
 *                      canonical JSON in `product_blueprints.spec`.
 *   PublicBlueprint    the guest projection of a LIVE revision: `publicSpecOf`
 *                      (no `private`, no hidden fixed parts, no `accepts`) plus
 *                      what the Worker joins in — the product, its variants,
 *                      the mesh, the look card, photo URLs, stock, part prices.
 *   DesignConfig v1    what the CUSTOMER chose — ids, palette keys, short
 *                      texts, the owner's own asset keys; NEVER a price.
 *                      normalised by config.ts, canonicalised by canonical.ts.
 *
 * Size, look and quality are the product's OWN variant groups (0126), which the
 * blueprint only annotates (`axes`); the configuration names the variant id.
 * Gift is order-level (§0 row 22) and is not here. Every id inside a spec
 * (regions, areas, slots, rules) shares ONE namespace: `colors` is keyed by
 * region ids AND text-area ids (a text's own colour), and `shown_by` may name
 * a slot or an icon area.
 *
 * Types only — nothing here exists at run time.
 */
import type { PaletteKey, RegionRole, Tone, LookKey, StyleKey, ThemeKey, ContentKind, AreaRole, QrKind, NfcKind, PhotoMode, LogoMode, IconKey, Tier, Licence, FamilyKey, SayCode, CheckCode, SlotEffect } from './vocab';
import type { PartKind, PartAccepts } from './parts';

export type { PaletteKey, RegionRole, Tone, LookKey, StyleKey, ThemeKey, ContentKind, AreaRole, QrKind, NfcKind, PhotoMode, LogoMode, IconKey, Tier, Licence, FamilyKey, SayCode, CheckCode, SlotEffect, PartKind, PartAccepts };

export type Lang = 'ar' | 'en' | 'ckb';
/** A merchant-written label in the three languages. */
export interface Text3 { ar: string; en: string; ckb: string }
/** Millimetres in the centred LVM1 frame. */
export type Vec3 = [number, number, number];
/** A point on a picture, normalised 0..1. */
export type Point = [number, number];
export type Quad = [Point, Point, Point, Point];
/** `[x, y, w, h]` of the owner's picture, normalised 0..1. */
export type Crop = [number, number, number, number];

// ------------------------------------------------------------ the blueprint

/** `stocked` = the shop's shelf for the chosen look (checked at run time, never here); `all` = any paintable key. */
export type PaintAllowed = 'stocked' | 'all' | PaletteKey[];
export interface Paint {
  allowed: PaintAllowed;
  default: PaletteKey;
  /** Extra IQD for a premium colour («gold +1,000»). */
  premium?: Partial<Record<PaletteKey, number>>;
}

export interface Region {
  id: string;
  role: RegionRole;
  /** LVR1 part indices (contiguous triangle ranges of the public mesh); `[]` in a photo-only blueprint. */
  parts: number[];
  tone: Tone;
  paint: Paint;
  /** An optional piece the customer may add (`on` = its default). */
  optional: { on: boolean; fee_iqd: number } | null;
  /** `slotId` (shown while that slot has any option), `slotId:optionKey`, or `iconAreaId:iconKey`. */
  shown_by: string | null;
}

/** An area's frame: origin, normal and up in millimetres; `w × h` its size. */
export interface Frame { o: Vec3; n: Vec3; u: Vec3; w: number; h: number }
/** A photo-only blueprint draws its area on one of `photos`. */
export interface PhotoFrame { media_id: string; quad: Quad }

export interface TextSpec {
  lines: number;
  /** Graphemes per entry. */
  max: number;
  /** Names (entries) when > 1 — «ALI + SARA»; with 1, the entries are lines. */
  count: number;
  styles: 'all' | StyleKey[];
  default_style: StyleKey;
  min_cap_mm: number;
  paint: Paint;
  /** The placeholder the studio shows — never copied into a configuration. */
  sample: Text3;
}
export interface LogoSpec { max_colors: number; modes: LogoMode[] }
export interface PhotoSpec { modes: PhotoMode[]; min_px_per_mm: number }
export interface QrSpec { kinds: QrKind[]; min_module_mm: number }
export interface IconSpec { keys: 'all' | IconKey[] }

export interface Area {
  id: string;
  kind: ContentKind;
  /** `name` | `text` for a text area; the kind itself for every other kind. */
  role: AreaRole;
  region: string;
  /** Required on a model blueprint. */
  frame?: Frame;
  /** Required on a photo-only blueprint. */
  photo_frame?: PhotoFrame;
  text?: TextSpec;
  logo?: LogoSpec;
  photo?: PhotoSpec;
  qr?: QrSpec;
  icon?: IconSpec;
  required: boolean;
  /** Charged when the area is filled. */
  fee_iqd: number;
}

export interface SizeValue { dims_mm: Vec3; scale: number; recommended?: true }
export interface LookValue { look: LookKey; material_id: string }
export interface TierValue { tier: Tier }
/** A product option group (0126) and its value ids, annotated. */
export interface Axis<V> { group: string; values: Record<string, V> }
export interface Axes { size?: Axis<SizeValue>; look?: Axis<LookValue>; tier?: Axis<TierValue> }

/** A store part product (and variant). `src: 'levonis'` names a Levonis item — accepted by the shape, gated by the Worker (E13). */
export interface PartRef { p: string; v: string | null; src?: 'levonis' }
/** `{key, kit}` (a C13 kit) is refused in C1. */
export interface SlotOption { key: string; part: PartRef }
export interface SlotShow { effect: SlotEffect; part?: number; anchor?: Frame }
export interface Slot {
  id: string;
  kind: PartKind;
  label?: Text3;
  qty: number;
  required: boolean;
  choice: 'customer' | 'fixed';
  pricing: 'add' | 'included';
  options: SlotOption[];
  default?: string;
  show?: SlotShow;
  /** What a part must be to fill the slot — `fitsSlot` (parts.ts) reads it. Merchant-only. */
  accepts?: PartAccepts;
}
export type PublicSlot = Omit<Slot, 'accepts'>;
/** Always used, price included; `show: false` = a hidden production material (merchant-only). */
export interface FixedPart { part: PartRef; qty: number; show: boolean }

/** When — exactly one of the four. `longer_than` counts graphemes of the longest entry. */
export type RuleIf =
  | { text: string; longer_than: number }
  | { slot: string; is: string }
  | { qr: string }
  | { value: string };
/** Then — exactly one key. `only_colors.target` is a colour id (region or text area). */
export type RuleThen =
  | { size_at_least: string }
  | { requires: { slot: string; is: string } }
  | { excludes: { slot: string; is: string } }
  | { only_colors: { target: string; keys: PaletteKey[] } }
  | { max_colors: number };
export interface Rule { id: string; if: RuleIf; then: RuleThen; fix: 'auto' | 'suggest'; say: SayCode }

export interface Extras {
  nfc: { kinds: NfcKind[]; fee_iqd: number } | null;
  /** `vary` ⊆ text-area ids ∪ colour ids. */
  roster: { vary: string[]; max: number } | null;
}

/** The product's own picture (`community_product_media.id`) for one axis value and/or colour. */
export interface SpecPhoto { media_id: string; value_id?: string; colour?: PaletteKey }

export interface BlueprintSpec {
  v: 1;
  family: FamilyKey;
  /** `occ:<occasion>`, `for:<recipient>`, `biz`. */
  tags: string[];
  sell: { cart: boolean; request: boolean };
  regions: Region[];
  areas: Area[];
  axes: Axes;
  /** Distinct colours: `included` in the price, each extra `per_extra_iqd`, at most `max`. */
  colors: { included: number; per_extra_iqd: number; max: number };
  themes: 'all' | ThemeKey[];
  slots: Slot[];
  fixed: FixedPart[];
  rules: Rule[];
  extras: Extras;
  photos: SpecPhoto[];
  licence: Licence;
  warranty_days: number;
  prep_days_add: { tier_best?: number; size?: Record<string, number> };
  /** Merchant-only; never public. */
  private: { quality_notes?: Partial<Record<Tier, string>>; notes?: string };
}

/** What `publicSpecOf` returns: no `private`, no hidden fixed parts, no `accepts`. */
export interface PublicSpec extends Omit<BlueprintSpec, 'private' | 'slots'> { slots: PublicSlot[] }

export interface PublicPhoto extends SpecPhoto { url: string }
export interface PublicVariant { id: string; values: Record<string, string>; price_iqd: number; in_stock: boolean }
export interface PublicSlotOption { key: string; product_id: string; variant_id: string | null; name: string; image: string | null; unit_iqd: number; in_stock: boolean }
export type StockState = 'in' | 'out' | `sub:${PaletteKey}`;

export interface PublicBlueprint extends PublicSpec {
  product: { id: string; slug: string; store_slug: string; name: string; price_iqd: number; prep_days: number };
  /** The product's variants, `values` keyed by option-group id. */
  variants: PublicVariant[];
  mesh: { url: string; hash: string; bytes: number; triangles: number; dims_mm: Vec3 } | null;
  look: { poster_url: string; w: number; h: number; idmap: string; quads: Record<string, Quad>; camera: number[] } | null;
  photos: PublicPhoto[];
  /** Per look (or `default`): palette key → in stock, out, or the substitute. `null` = the shop tracks nothing. */
  stock: Partial<Record<LookKey | 'default', Partial<Record<PaletteKey, StockState>>>> | null;
  stock_rgb: Partial<Record<PaletteKey, [number, number, number]>>;
  stock_names: Partial<Record<PaletteKey, string>>;
  slot_options: Record<string, PublicSlotOption[]>;
  printer: { max_mm: Vec3 } | null;
  from_iqd: number;
  rev: number;
}

// ------------------------------------------------------- the configuration

export interface TextChoice { value: string[]; style: StyleKey }
export interface AssetChoice<M extends string> { key: string; crop: Crop; mode: M }
export interface TargetChoice<K extends string> { kind: K; value: string }
export interface RosterEntry { n: number; texts?: Record<string, string[]>; colors?: Record<string, PaletteKey> }

/**
 * Canonical form (canonical.ts): keys sorted; `colors`, `parts`, `texts` and
 * `slots` carry EVERY declared control; `logo`, `photo`, `qr`, `icon` only the
 * filled areas; strings NFC.
 */
export interface DesignConfig {
  v: 1;
  /** The product id. */
  p: string;
  /** The blueprint revision it was made against. */
  rev: number;
  /** The product variant id (the size / look / quality combination); null for a product without variants. */
  variant: string | null;
  theme: ThemeKey | null;
  colors: Record<string, PaletteKey>;
  parts: Record<string, boolean>;
  texts: Record<string, TextChoice>;
  logo: Record<string, AssetChoice<LogoMode>>;
  photo: Record<string, AssetChoice<PhotoMode>>;
  qr: Record<string, TargetChoice<QrKind>>;
  icon: Record<string, IconKey>;
  nfc: TargetChoice<NfcKind> | null;
  /** Customer-choice slots only; `null` = none chosen. */
  slots: Record<string, { option: string | null }>;
  roster: RosterEntry[] | null;
  /** The configuration this one was made from (remix, duplicate). */
  parent: string | null;
  notes: string;
}

// --------------------------------------------------------- engine results

export interface EngineIssue { path: string; code: string }
/** An ok result may carry `errors` — what a lenient pass dropped. */
export type EngineResult<T> =
  | { ok: true; value: T; errors?: EngineIssue[] }
  | { ok: false; code: string; path?: string; errors?: EngineIssue[] };

// -------------------------------------- shared with price / check / surface

export type Verdict = 'ready' | 'adjusted' | 'review' | 'blocked';
export interface CheckIssue {
  code: CheckCode;
  path?: string;
  /** `auto` fixes are price-neutral (P15); a priced fix is a `suggest` carrying its delta. */
  fix?: { kind: 'auto' | 'suggest'; delta_iqd?: number; config?: DesignConfig };
}
export interface CheckReport { verdict: Verdict; issues: CheckIssue[]; config: DesignConfig }
export interface PriceBreakdown { unit_iqd: number; base_iqd: number; adds: Array<{ key: string; iqd: number; qty?: number }> }

/** Content tiles carry `ref` = the area id they edit. */
export type TileId = 'name' | 'text' | 'photo' | 'logo' | 'qr' | 'icon' | 'look' | 'size' | 'addons' | 'more';
export type MorePage = 'look' | 'tier' | 'text' | 'photo' | 'logo' | 'qr' | 'icon' | 'nfc' | 'addons' | 'notes' | 'ask';
export interface SurfaceItem<K extends string> { id: K; ref?: string }
export interface Door { kind: 'add_to_cart' | 'request' | 'ask' | 'disabled'; fix?: string }
/** ≤ 4 tiles (the More tile included) + 1 door; `more` lists More's pages. */
export interface Surface { tiles: SurfaceItem<TileId>[]; door: Door; more: SurfaceItem<MorePage>[] }
