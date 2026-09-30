/**
 * THE STUDIO'S STATE — a reducer over the canonical configuration (survey
 * §5.3 «State»; docs/LEVO_PROJECT_PROGRAMME.md §B.1 hop 2 and 3, P1, P15).
 *
 * The state holds what the CUSTOMER chose (`config`, canonical) plus what the
 * screen needs to keep while they type (the raw text of each entry, the raw
 * QR / NFC target, a picture picked on this device). Every change is checked
 * against the blueprint HERE, by the engine's light helpers — a colour the
 * part may wear (`colourChoices`), a variant the product sells, a slot option
 * the slot declares, a style the area offers, text filtered by THE TEXT RULE
 * (`textRuleAllows`) and cut at the area's letters — so the configuration
 * stays valid and `canonicalize` (which trusts its input) keeps it canonical.
 * `normalizeConfig` is not run per tap (the engine budget: it is the Worker's
 * gate at every door); a configuration handed in from outside, or a blueprint
 * that changed under the studio (the builder's live preview), is carried over
 * choice by choice with the same helpers (`rebase`).
 *
 * `derive` runs on every change, synchronously: check (which prices, with the
 * price-neutral automatic fixes applied — its `config` is what will be MADE)
 * → the surface (≤ 4 tiles + 1 door) → Smart Fit per text for the drawing.
 * Measured < 2 ms (tests/personalizeUi.test.ts times it over the fixtures).
 *
 * Undo is client-only. Modes are derived, never chosen (`studioMode`):
 * preview (the merchant's draft, from the builder) · buy · view.
 * The taste functions (themes, Choose for me, Make it better, Surprise me) are
 * NOT imported here: they arrive after first paint (./taste.ts) and hand their
 * result to the `apply` action.
 */
import { useMemo, useReducer, useState } from 'react';
import type { Area, DesignConfig, IconKey, LookKey, NfcKind, PaletteKey, PublicBlueprint, QrKind, StockState, StyleKey } from '../../../packages/catalog/src/personalize/types';
import { canonicalize, cleanLine, configHash } from '../../../packages/catalog/src/personalize/canonical';
import { defaultConfig, designTextOk, graphemeCount, plainTextOk, textRuleAllows } from '../../../packages/catalog/src/personalize/config';
import { blockingCode, checkConfig, type AssetFacts, type CheckFinding, type CheckResult } from '../../../packages/catalog/src/personalize/check';
import { compileSurface, type SurfacePlan } from '../../../packages/catalog/src/personalize/surface';
import { paintTargets, priceContextFromPublic, regionShown, slotChoice, type PaintTarget } from '../../../packages/catalog/src/personalize/price';
import { colourChoices, sizeValuesInBuild, withPublic, type RulesContext } from '../../../packages/catalog/src/personalize/rules';
import { fitText, sizeSteps, type FitResult } from '../../../packages/catalog/src/personalize/fit';
import { stylesFor } from '../../../packages/catalog/src/personalize/styles';
import { PALETTE_RGB, lookStock, stockKey } from '../../../packages/catalog/src/personalize/color';
import { ICON_KEYS } from '../../../packages/catalog/src/personalize/vocab';
import type { StudioLang, StudioWords } from './strings';

export type StudioMode = 'preview' | 'buy' | 'view';
/** Derived from where the studio is mounted: the builder's preview, a read-only view (a twin, C3), else buying. */
export const studioMode = (o: { preview?: boolean; readOnly?: boolean }): StudioMode => (o.readOnly ? 'view' : o.preview ? 'preview' : 'buy');

/** A picture picked on this device (C1 previews never upload; C3 swaps in the uploaded key before minting). */
export interface LocalAsset { url: string; px_w: number; px_h: number; has_alpha?: boolean; colours?: number }

export interface StudioState {
  /** What the customer chose — canonical, never a price. */
  config: DesignConfig;
  /** The text of each entry as typed (spaces kept while typing). */
  drafts: Record<string, string[]>;
  /** A QR target or the NFC tag (`nfc`) as typed, with its kind. */
  targets: Record<string, { kind: string; raw: string }>;
  assets: Record<string, LocalAsset>;
  undo: DesignConfig[];
  seeds: { choose: number; surprise: number };
  /** The customer changed something since the studio opened (contextual chips wait for it). */
  changed: boolean;
  /** A one-tap change just made (a fix, a theme, a suggestion) — the line offers Undo. */
  applied: string | null;
  /** The last action's key, so typing in one field is one undo step. */
  last: string;
}

export type StudioAction =
  | { type: 'text'; area: string; index: number; raw: string }
  | { type: 'style'; area: string; style: StyleKey }
  | { type: 'colour'; target: string; key: PaletteKey }
  | { type: 'piece'; region: string; on: boolean }
  | { type: 'variant'; variant: string }
  | { type: 'slot'; slot: string; option: string | null }
  | { type: 'icon'; area: string; key: IconKey | null }
  /** A QR target, or the tag's (`area` 'nfc'): as typed, and the engine's canonical value (config.ts `normalizeTarget`; null = not one yet). */
  | { type: 'target'; area: string; kind: string; raw: string; value: string | null }
  | { type: 'clearTarget'; area: string }
  | { type: 'asset'; area: string; asset: LocalAsset | null }
  | { type: 'mode'; area: string; mode: string }
  | { type: 'notes'; text: string }
  | { type: 'apply'; config: DesignConfig; why: string; seed?: 'choose' | 'surprise' }
  | { type: 'undo' }
  | { type: 'reset' }
  | { type: 'rebase' };

/** The rules context the colour helpers read (they never price). */
export const rulesOf = (pub: PublicBlueprint): RulesContext => withPublic(pub, { price: { base_iqd: 0, parts: {} } });

const SEGMENTER = typeof Intl !== 'undefined' && 'Segmenter' in Intl ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null;

/** Typing filtered by THE TEXT RULE and cut at `max` letters; `dropped` when something was refused. */
export function cleanTyping(raw: string, max: number): { text: string; dropped: boolean } {
  let text = '';
  let dropped = false;
  for (const ch of raw) {
    if (textRuleAllows(ch.codePointAt(0) ?? 0)) text += ch;
    else dropped = true;
  }
  if (graphemeCount(text) > max) text = (SEGMENTER ? [...SEGMENTER.segment(text)].map((g) => g.segment) : [...text]).slice(0, max).join('');
  return { text, dropped };
}

const textArea = (pub: PublicBlueprint, id: string): Area | undefined => pub.areas.find((a) => a.id === id && a.kind === 'text' && a.text);
const entriesOf = (drafts: readonly string[]): string[] => drafts.map(cleanLine).filter(designTextOk);
const allowedIcons = (a: Area): readonly string[] => (a.icon?.keys === 'all' ? ICON_KEYS : a.icon?.keys ?? []);

/** A carried-over target keeps its shape only; the Worker re-reads it strictly at every door (config.ts `normalizeTarget`). */
const targetShaped = (v: unknown): boolean => typeof v === 'string' && v.length <= 200 && plainTextOk(v);

/** The raw fields of a configuration (after undo, a one-tap change, a reset). */
function fieldsOf(config: DesignConfig): Pick<StudioState, 'drafts' | 'targets'> {
  const targets: StudioState['targets'] = {};
  for (const [id, q] of Object.entries(config.qr)) targets[id] = { kind: q.kind, raw: q.value };
  if (config.nfc) targets.nfc = { kind: config.nfc.kind, raw: config.nfc.value };
  return { drafts: Object.fromEntries(Object.entries(config.texts).map(([id, t]) => [id, [...t.value]])), targets };
}

/**
 * `config` carried onto `pub`, choice by choice, with the same checks as a
 * tap: what the blueprint still offers is kept, the rest starts at its default.
 */
export function rebase(pub: PublicBlueprint, config: DesignConfig | null | undefined): DesignConfig {
  const fresh = defaultConfig(pub);
  if (!config) return fresh;
  let c: DesignConfig = { ...fresh, theme: config.theme, notes: plainTextOk(config.notes ?? '', true) ? String(config.notes ?? '').slice(0, 500) : '' };
  if (pub.variants.some((v) => v.id === config.variant)) c.variant = config.variant;
  for (const a of pub.areas) {
    const t = config.texts?.[a.id];
    if (a.text && t) {
      const value = entriesOf(t.value.slice(0, a.text.count).map((v) => cleanTyping(v, a.text!.max).text));
      c.texts = { ...c.texts, [a.id]: { value, style: stylesFor(a).includes(t.style) ? t.style : a.text.default_style } };
    }
    const icon = config.icon?.[a.id];
    if (a.icon && icon && allowedIcons(a).includes(icon)) c.icon = { ...c.icon, [a.id]: icon };
    const q = config.qr?.[a.id];
    if (a.qr && q && (a.qr.kinds as readonly string[]).includes(q.kind) && targetShaped(q.value)) c.qr = { ...c.qr, [a.id]: q };
  }
  for (const r of pub.regions) if (r.optional && typeof config.parts?.[r.id] === 'boolean') c.parts = { ...c.parts, [r.id]: config.parts[r.id] };
  for (const s of pub.slots) {
    const o = config.slots?.[s.id]?.option;
    if (s.choice === 'customer' && o !== undefined && (o === null ? !s.required : s.options.some((x) => x.key === o))) c.slots = { ...c.slots, [s.id]: { option: o } };
  }
  const n = config.nfc;
  if (pub.extras.nfc && n && (pub.extras.nfc.kinds as readonly string[]).includes(n.kind) && targetShaped(n.value)) c.nfc = n;
  c = canonicalize(c, pub);
  const cx = rulesOf(pub);
  const colors = { ...c.colors };
  for (const [id, key] of Object.entries(config.colors ?? {})) if (id in colors && colourChoices(pub, c, cx, id).includes(key)) colors[id] = key;
  return canonicalize({ ...c, colors }, pub);
}

export function initState(pub: PublicBlueprint, initial?: DesignConfig | null): StudioState {
  const config = rebase(pub, initial && initial.p === pub.product.id ? initial : null);
  return { config, ...fieldsOf(config), assets: {}, undo: [], seeds: { choose: 0, surprise: 0 }, changed: false, applied: null, last: '' };
}

export function reduce(pub: PublicBlueprint, s: StudioState, a: StudioAction): StudioState {
  const c = s.config;
  const area = 'area' in a ? pub.areas.find((x) => x.id === a.area) : undefined;
  /** A change the customer made: canonical, one undo step (typing in one field coalesces). */
  const to = (config: DesignConfig, more: Partial<StudioState> = {}, key: string = a.type): StudioState => ({
    ...s,
    ...more,
    config: canonicalize(config, pub),
    undo: key.startsWith('text') && key === s.last ? s.undo : [...s.undo, c].slice(-40),
    changed: true,
    applied: null,
    last: key,
  });
  switch (a.type) {
    case 'text': {
      const t = textArea(pub, a.area)?.text;
      if (!t || a.index < 0 || a.index >= t.count) return s;
      const drafts = [...(s.drafts[a.area] ?? [])];
      drafts[a.index] = cleanTyping(a.raw, t.max).text;
      const style = c.texts[a.area]?.style ?? t.default_style;
      return to({ ...c, texts: { ...c.texts, [a.area]: { value: entriesOf(drafts), style } } }, { drafts: { ...s.drafts, [a.area]: drafts } }, `text:${a.area}`);
    }
    case 'style': {
      const t = textArea(pub, a.area);
      if (!t || !stylesFor(t).includes(a.style)) return s;
      return to({ ...c, texts: { ...c.texts, [a.area]: { value: c.texts[a.area]?.value ?? [], style: a.style } } });
    }
    case 'colour':
      if (!colourChoices(pub, c, rulesOf(pub), a.target).includes(a.key)) return s;
      return to({ ...c, theme: null, colors: { ...c.colors, [a.target]: a.key } });
    case 'piece':
      if (!pub.regions.some((r) => r.id === a.region && r.optional)) return s;
      return to({ ...c, parts: { ...c.parts, [a.region]: a.on } });
    case 'variant':
      if (!pub.variants.some((v) => v.id === a.variant)) return s;
      return to({ ...c, variant: a.variant });
    case 'slot': {
      const slot = pub.slots.find((x) => x.id === a.slot && x.choice === 'customer');
      if (!slot || (a.option === null ? slot.required : !slot.options.some((o) => o.key === a.option))) return s;
      return to({ ...c, slots: { ...c.slots, [a.slot]: { option: a.option } } });
    }
    case 'icon': {
      if (!area?.icon || (a.key === null ? area.required : !allowedIcons(area).includes(a.key))) return s;
      const icon = { ...c.icon };
      if (a.key) icon[a.area] = a.key;
      else delete icon[a.area];
      return to({ ...c, icon });
    }
    case 'target': {
      const nfc = a.area === 'nfc';
      const kinds: readonly string[] = nfc ? pub.extras.nfc?.kinds ?? [] : area?.qr?.kinds ?? [];
      if (!kinds.includes(a.kind)) return s;
      const value = a.value !== null && a.value.length <= 200 ? a.value : null;
      const targets = { ...s.targets, [a.area]: { kind: a.kind, raw: a.raw } };
      if (nfc) return to({ ...c, nfc: value === null ? null : { kind: a.kind as NfcKind, value } }, { targets }, `text:nfc`);
      const qr = { ...c.qr };
      if (value === null) delete qr[a.area];
      else qr[a.area] = { kind: a.kind as QrKind, value };
      return to({ ...c, qr }, { targets }, `text:${a.area}`);
    }
    case 'clearTarget': {
      const targets = { ...s.targets };
      delete targets[a.area];
      if (a.area === 'nfc') return to({ ...c, nfc: null }, { targets });
      const qr = { ...c.qr };
      delete qr[a.area];
      return to({ ...c, qr }, { targets });
    }
    case 'asset': {
      const kind = area?.logo ? 'logo' : area?.photo ? 'photo' : null;
      if (!kind || !area) return s;
      const assets = { ...s.assets };
      const rec = { ...c[kind] } as Record<string, unknown>;
      if (a.asset) {
        assets[a.area] = a.asset;
        rec[a.area] = { key: `local:${a.area}`, crop: [0, 0, 1, 1], mode: c[kind][a.area]?.mode ?? (kind === 'logo' ? area.logo!.modes[0] : area.photo!.modes[0]) };
      } else {
        delete assets[a.area];
        delete rec[a.area];
      }
      return to({ ...c, [kind]: rec } as DesignConfig, { assets });
    }
    case 'mode': {
      const kind = area?.logo ? 'logo' : area?.photo ? 'photo' : null;
      const modes: readonly string[] = area?.logo?.modes ?? area?.photo?.modes ?? [];
      const cur = kind ? c[kind][a.area] : undefined;
      if (!kind || !cur || !modes.includes(a.mode)) return s;
      return to({ ...c, [kind]: { ...c[kind], [a.area]: { ...cur, mode: a.mode } } } as DesignConfig);
    }
    case 'notes':
      if (a.text.length > 500 || !plainTextOk(a.text, true)) return s;
      return to({ ...c, notes: a.text }, {}, 'text:notes');
    case 'apply': {
      const config = canonicalize(a.config, pub);
      const seeds = a.seed ? { ...s.seeds, [a.seed]: s.seeds[a.seed] + 1 } : s.seeds;
      return { ...s, ...fieldsOf(config), config, undo: [...s.undo, c].slice(-40), seeds, changed: true, applied: a.why, last: 'apply' };
    }
    case 'undo': {
      const prev = s.undo[s.undo.length - 1];
      if (!prev) return s;
      return { ...s, ...fieldsOf(prev), config: prev, undo: s.undo.slice(0, -1), applied: null, last: 'undo' };
    }
    case 'reset': {
      const config = defaultConfig(pub);
      return { ...s, ...fieldsOf(config), config, assets: {}, undo: [...s.undo, c].slice(-40), applied: null, last: 'reset' };
    }
    case 'rebase': {
      const config = rebase(pub, c);
      return config === c ? s : { ...s, ...fieldsOf(config), config };
    }
  }
}

// ------------------------------------------------------------------ derive

export interface StudioDerived {
  check: CheckResult;
  plan: SurfacePlan;
  /** What will be made: the configuration after the price-neutral automatic fixes. */
  made: DesignConfig;
  /** Smart Fit of each filled text on `made`, at its size — what is drawn. */
  fits: Record<string, FitResult>;
  /** The issue the disabled door names. */
  blocking: CheckFinding | undefined;
  unit: number | null;
  ms: number;
}

export interface Community { open?: boolean; takes_requests?: boolean }

const facts = (assets: Record<string, LocalAsset>): Record<string, AssetFacts> =>
  Object.fromEntries(Object.entries(assets).map(([id, a]) => [id, { px_w: a.px_w, px_h: a.px_h, ...(a.has_alpha !== undefined ? { has_alpha: a.has_alpha } : {}), ...(a.colours !== undefined ? { colours: a.colours } : {}) }]));

const now = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());

export function derive(pub: PublicBlueprint, config: DesignConfig, assets: Record<string, LocalAsset>, community: Community = {}): StudioDerived {
  const t0 = now();
  let check: CheckResult;
  try {
    check = checkConfig(pub, config, { price: priceContextFromPublic(pub, config.variant), assets: facts(assets) });
  } catch {
    // A variant the product no longer sells: nothing can be priced or bought as it stands.
    check = { verdict: 'blocked', issues: [], config, price: null };
  }
  const fix = blockingCode(check.issues);
  const plan = compileSurface(pub, { verdict: check.verdict, fix, community_open: community.open, takes_requests: community.takes_requests });
  const made = check.config;
  const z = sizeSteps(pub, made.variant);
  const fits: Record<string, FitResult> = {};
  for (const a of pub.areas) {
    const t = made.texts[a.id];
    if (a.text && t?.value.length && regionShown(pub, made, a.region)) fits[a.id] = fitText(t.value, a, { style: t.style, scale: z.scale, dims_mm: z.dims_mm });
  }
  return { check, plan, made, fits, blocking: fix ? check.issues.find((i) => i.code === fix) : undefined, unit: check.price?.unit_iqd ?? null, ms: now() - t0 };
}

// ------------------------------------------------------- shared read helpers

/** The chosen look's stock map (null: the shop tracks nothing). */
export const stockOf = (pub: PublicBlueprint, config: DesignConfig) => lookStock(pub, config.variant);

/** What prints for a key under the stock map: itself, the shop's matched colour, or itself when nothing is tracked. */
export function printedKey(pub: PublicBlueprint, config: DesignConfig, key: PaletteKey): PaletteKey {
  return stockKey(stockOf(pub, config), key) ?? key;
}

/** 0–255 RGB a key shows as: the shop's own filament when it has one, else the palette's. */
export function rgbOf(pub: PublicBlueprint, config: DesignConfig, key: PaletteKey): readonly [number, number, number] {
  const k = printedKey(pub, config, key);
  return pub.stock_rgb[k] ?? PALETTE_RGB[k] ?? PALETTE_RGB.gray;
}

export interface Swatch { key: PaletteKey; state: StockState; matched?: PaletteKey }
/**
 * The colours a target is offered: what it may wear now (`colourChoices`),
 * minus what the shop is out of («out = not offered») — the current one kept
 * so the screen never hides the customer's own choice; a `sub:` colour shows
 * the colour that will print (`matched`).
 */
export function swatchesFor(pub: PublicBlueprint, config: DesignConfig, target: string): Swatch[] {
  const map = stockOf(pub, config);
  const current = config.colors[target];
  const out: Swatch[] = [];
  for (const key of colourChoices(pub, config, rulesOf(pub), target)) {
    const state: StockState = map ? map[key] ?? 'out' : 'in';
    if (state === 'out' && key !== current) continue;
    out.push(state.startsWith('sub:') ? { key, state, matched: state.slice(4) as PaletteKey } : { key, state });
  }
  return out;
}

/** The colour targets the customer paints (Look's parts rows), in spec order. */
export const paintRows = (pub: PublicBlueprint, made: DesignConfig): PaintTarget[] => paintTargets(pub, made).filter((t) => t.choice);

/** The size values the shop makes, smallest first, each with the variant it would be now (same look and quality). */
export function sizeRows(pub: PublicBlueprint, config: DesignConfig): Array<{ value: string; variant: PublicBlueprint['variants'][number] | undefined }> {
  const ax = pub.axes.size;
  if (!ax) return [];
  const cur = pub.variants.find((v) => v.id === config.variant);
  return sizeValuesInBuild(pub, pub.printer).map((value) => ({
    value,
    variant: pub.variants.find((v) => v.values[ax.group] === value && Object.keys(cur?.values ?? {}).every((g) => g === ax.group || v.values[g] === cur!.values[g])),
  }));
}

/** The variant with axis `axis` moved to `value`, the other axes kept (null when the product does not sell it). */
export function variantWith(pub: PublicBlueprint, config: DesignConfig, axis: 'size' | 'look' | 'tier', value: string): string | null {
  const ax = pub.axes[axis];
  const cur = pub.variants.find((v) => v.id === config.variant);
  if (!ax) return null;
  return pub.variants.find((v) => v.values[ax.group] === value && Object.keys(cur?.values ?? {}).every((g) => g === ax.group || v.values[g] === cur!.values[g]))?.id ?? null;
}

/** The chosen value of an axis. */
export function axisOf(pub: PublicBlueprint, config: DesignConfig, axis: 'size' | 'look' | 'tier'): string | undefined {
  const ax = pub.axes[axis];
  return ax ? pub.variants.find((v) => v.id === config.variant)?.values[ax.group] : undefined;
}

/** The look of the chosen variant (the finish the live model shows). */
export function lookOf(pub: PublicBlueprint, config: DesignConfig): LookKey | null {
  const v = axisOf(pub, config, 'look');
  return v ? pub.axes.look?.values[v]?.look ?? null : null;
}

/** Which size word a size takes among `n` (smallest first): 3 → Small · Medium · Large; -1 past five (the centimetres say it). */
export function sizeWordIndex(rank: number, n: number): number {
  return [[2], [1, 3], [1, 2, 3], [1, 2, 3, 4], [0, 1, 2, 3, 4]][n - 1]?.[rank] ?? -1;
}

/** The effective colours, `id:key` sorted — `data-colors`. */
export const colorsAttr = (made: DesignConfig): string =>
  Object.keys(made.colors)
    .sort()
    .map((k) => `${k}:${made.colors[k]}`)
    .join(',');

export { configHash, slotChoice, regionShown };

// ------------------------------------------------------------------ the hook

export interface UseStudio {
  state: StudioState;
  derived: StudioDerived;
  dispatch: (a: StudioAction) => void;
}

/** The studio's state for `pub`; a new `pub` (the builder's live preview) carries the choices over. */
export function useStudio(pub: PublicBlueprint, initial: DesignConfig | null | undefined, community: Community): UseStudio {
  const [state, dispatch] = useReducer((s: StudioState, a: StudioAction) => reduce(pub, s, a), undefined, () => initState(pub, initial));
  const [seen, setSeen] = useState(pub);
  if (seen !== pub) {
    setSeen(pub);
    dispatch({ type: 'rebase' });
  }
  const { open, takes_requests } = community;
  const derived = useMemo(() => derive(pub, state.config, state.assets, { open, takes_requests }), [pub, state.config, state.assets, open, takes_requests]);
  return { state, derived, dispatch };
}

/** What every panel reads: the blueprint, the state and its derivation, the words. */
export interface Kit {
  pub: PublicBlueprint;
  state: StudioState;
  derived: StudioDerived;
  dispatch: (a: StudioAction) => void;
  lang: StudioLang;
  t: StudioWords;
  mode: StudioMode;
}
