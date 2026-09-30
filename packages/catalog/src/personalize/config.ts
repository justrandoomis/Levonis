/**
 * THE CUSTOMER'S CONFIGURATION, NORMALISED (docs/LEVO_PROJECT_PROGRAMME.md
 * §B.1 hop 2 and «Shapes»; invariants P1, P11, P12, P15).
 *
 * `normalizeConfig` is the one gate — the studio runs it on every tap, the
 * Worker re-runs it strictly on every door. Strict by default:
 *
 *   CONFIG_INVALID {path}       unknown keys or ids, a colour outside its
 *                               list, a variant the product does not sell, a
 *                               slot option not declared, an area of another
 *                               kind — and ANY price-like key at any depth
 *                               (`PRICE_LIKE_KEYS`; fatal in lenient mode too).
 *   DESIGN_TEXT_INVALID {path}  THE TEXT RULE (below), the grapheme and entry
 *                               limits of the area, notes over 500.
 *   QR_TARGET_INVALID {path}    a QR or NFC value that is not its kind's shape.
 *   ROSTER_TOO_LARGE            more names than the blueprint's roster takes.
 *   DESIGN_TOO_LARGE            over 16 KB of canonical JSON (32 KB with a roster).
 *   BLUEPRINT_CHANGED {rev}     made against another revision (strict only).
 *
 * Lenient mode (autosave, and the migration behind BLUEPRINT_CHANGED) keeps
 * what is valid, drops the rest to its default and reports it in `errors`.
 * Decency is not here: the Worker walks `textValues` through
 * worker/lib/decency.ts at every door (DESIGN_TEXT_NOT_ALLOWED).
 *
 * THE TEXT RULE (§B.1), for what gets printed: letters — Arabic (U+0621–063A,
 * U+0641–064A, tatweel U+0640), the Kurdish ە ۆ ێ ڕ ڵ ڤ and the Persian-block
 * letters Sorani writes (پ چ ژ ک گ ی ھ, and the patch font's U+0693), Latin
 * (A–Z, a–z, the Latin-1 and Latin Extended-A letters); Latin, Arabic-Indic
 * and Extended Arabic-Indic digits; space and `. - ' & + ! ?` — with ؟ and ’,
 * the same two marks as an Arabic keyboard and iOS type them; ZWNJ/ZWJ kept.
 * Everything else — C0/C1 controls, bidi overrides and isolates, LRM/RLM/ALM,
 * emoji, other symbols, Arabic diacritics — is refused, never stripped. A
 * printed entry holds at least one letter or digit.
 */
import type { AssetChoice, Crop, DesignConfig, EngineIssue, EngineResult, IconKey, LogoMode, NfcKind, PaletteKey, PhotoMode, PublicBlueprint, PublicVariant, QrKind, RosterEntry, StyleKey, TargetChoice, TextChoice, TextSpec, ThemeKey } from './types';
import { ICON_KEYS, PAINT_KEYS, STYLES, THEMES } from './vocab';
import { canonicalJson, canonicalize, cleanLine, controlsOf, utf8Bytes, type SpecLike } from './canonical';

export const CONFIG_LIMITS = { bytes: 16384, rosterBytes: 32768, notes: 500, target: 200, nfcText: 120, rosterQty: 20, depth: 16 } as const;

/** Refused at any depth, in any case or spelling (`unitPrice` = `unit_price`); `*_iqd` is every key ending so. */
export const PRICE_LIKE_KEYS = ['price', 'prices', 'iqd', '*_iqd', 'unit', 'unit_price', 'total', 'subtotal', 'amount', 'cost', 'fee', 'fees', 'discount', 'margin'] as const;
const PRICE_WORDS = new Set(['price', 'prices', 'iqd', 'total', 'subtotal', 'amount', 'cost', 'costs', 'fee', 'fees', 'discount', 'margin']);

export function isPriceLikeKey(key: string): boolean {
  const k = key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
  return k === 'unit' || k.endsWith('_iqd') || k.split(/[^a-z0-9]+/).some((w) => PRICE_WORDS.has(w));
}

// ------------------------------------------------------------ the text rule

const KURDISH = [0x67e, 0x686, 0x693, 0x695, 0x698, 0x6a4, 0x6a9, 0x6af, 0x6b5, 0x6be, 0x6c6, 0x6cc, 0x6ce, 0x6d5];
/** space . - ' & + ! ? ؟ ’ ZWNJ ZWJ tatweel — allowed, but not a letter. */
const MARKS = [0x20, 0x2e, 0x2d, 0x27, 0x26, 0x2b, 0x21, 0x3f, 0x61f, 0x2019, 0x200c, 0x200d, 0x640];

const isGlyph = (c: number): boolean =>
  (c >= 0x61 && c <= 0x7a) || (c >= 0x41 && c <= 0x5a) || (c >= 0x30 && c <= 0x39) ||
  (c >= 0xc0 && c <= 0x17f && c !== 0xd7 && c !== 0xf7) ||
  (c >= 0x621 && c <= 0x63a) || (c >= 0x641 && c <= 0x64a) ||
  (c >= 0x660 && c <= 0x669) || (c >= 0x6f0 && c <= 0x6f9) || KURDISH.includes(c);

/** May this code point be printed? (The studio may use it to filter keystrokes.) */
export const textRuleAllows = (c: number): boolean => isGlyph(c) || MARKS.includes(c);

/** THE TEXT RULE for one printed entry, after `cleanLine`. */
export function designTextOk(s: string): boolean {
  let glyphs = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (isGlyph(c)) glyphs++;
    else if (!MARKS.includes(c)) return false;
  }
  return glyphs > 0;
}

/**
 * Words a person reads but nothing prints (merchant labels and notes, the
 * customer's note, an NFC text): any character except controls (a newline
 * only when `multiline`), bidi controls and marks, invisible format characters,
 * tags, noncharacters and lone surrogates.
 */
export function plainTextOk(s: string, multiline = false): boolean {
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (c === 10 ? !multiline : c < 0x20 || (c >= 0x7f && c <= 0x9f) || c === 0xad || c === 0x61c || c === 0x180e ||
      (c >= 0x200b && c <= 0x200f && c !== 0x200c && c !== 0x200d) || (c >= 0x2028 && c <= 0x202e) || (c >= 0x2060 && c <= 0x206f) ||
      c === 0xfeff || (c >= 0xfff9 && c <= 0xfffb) || (c >= 0xd800 && c <= 0xdfff) || c === 0xfffe || c === 0xffff || (c >= 0xe0000 && c <= 0xe007f)) return false;
  }
  return true;
}

const isExtend = (c: number): boolean => c === 0x200c || c === 0x200d || (c >= 0x300 && c <= 0x36f) || (c >= 0x64b && c <= 0x65f) || c === 0x670;

/**
 * Graphemes without Intl.Segmenter — never fewer than it counts: a mark or
 * ZWNJ/ZWJ joins only a character the text rule allows (exact on the rule's
 * alphabet); anything else counts on its own.
 */
export function graphemeCountFallback(s: string): number {
  let n = 0;
  let joinable = false;
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (joinable && isExtend(c)) continue;
    n++;
    joinable = textRuleAllows(c);
  }
  return n;
}

let SEGMENTER: { segment(s: string): Iterable<unknown> } | null | undefined;

/** User-perceived characters (Intl.Segmenter when present — browsers, Workers, Node 22). */
export function graphemeCount(s: string): number {
  if (SEGMENTER === undefined) SEGMENTER = typeof Intl === 'object' && typeof Intl.Segmenter === 'function' ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null;
  return SEGMENTER ? [...SEGMENTER.segment(s)].length : graphemeCountFallback(s);
}

// ---------------------------------------------------------- QR and NFC

const digits = (s: string): string => s.replace(/[٠-٩۰-۹]/g, (d) => String(d.charCodeAt(0) & 15));

/** E.164 with its '+': `07…` (11 digits) is read as Iraqi, `00` as '+'; the Worker may re-check with libphonenumber. */
function phone(v: string): string | null {
  let s = digits(v).replace(/[\s\-().‎‏‪-‮⁦-⁩]/g, '');
  if (s.startsWith('00')) s = `+${s.slice(2)}`;
  if (/^07\d{9}$/.test(s)) s = `+964${s.slice(1)}`;
  return /^\+[1-9]\d{7,14}$/.test(s) ? s : null;
}

/** An http(s) URL on a named host (a bare `example.com/menu` gets https://), no credentials, ≤ 200 ASCII. */
function url(v: string): string | null {
  let u: URL;
  try {
    u = new URL(/^[a-z][a-z0-9+.-]*:/i.test(v) ? v : `https://${v}`);
  } catch {
    return null;
  }
  const href = u.href;
  return (u.protocol === 'https:' || u.protocol === 'http:') && !u.username && !u.password &&
    /^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z0-9-]{2,}$/i.test(u.hostname) && href.length <= CONFIG_LIMITS.target && /^[\x21-\x7e]+$/.test(href)
    ? href
    : null;
}

/**
 * A QR (or, with `nfc`, an NFC) target in its canonical form, or null: a
 * handle (lower case, no '@'), a phone (E.164), an http(s) URL, a short text
 * the shop programs by hand (NFC Wi-Fi and contact), or '' for `reorder`.
 */
export function normalizeTarget(kind: QrKind | NfcKind, raw: string, nfc = false): string | null {
  const v = raw.normalize('NFC').trim();
  if (kind === 'instagram' || kind === 'tiktok') {
    const h = v.replace(/^@/, '').toLowerCase();
    return (kind === 'instagram' ? /^[a-z0-9._]{1,30}$/ : /^[a-z0-9._]{2,24}$/).test(h) ? h : null;
  }
  if (kind === 'whatsapp' || (kind === 'contact' && !nfc)) return phone(v);
  if (kind === 'contact' || kind === 'wifi') return v && [...v].length <= CONFIG_LIMITS.nfcText && plainTextOk(v) ? v : null;
  if (kind === 'reorder') return v === '' ? '' : null;
  return url(v);
}

// --------------------------------------------------------- the configuration

/** The owner's own design asset (upload purpose `design_asset`); the Worker checks the owner. */
export const DESIGN_ASSET_KEY = /^users\/[A-Za-z0-9][A-Za-z0-9_-]{0,79}\/design-assets\/[A-Za-z0-9][A-Za-z0-9_-]{0,79}\.(?:png|jpe?g|webp|avif|gif)$/;

const EXT = /^[A-Za-z0-9_:-]{1,64}$/;
const RESERVED = ['__proto__', 'constructor', 'prototype'];
/** A database id (product, variant, option group or value, media, configuration). */
export const isExtId = (v: unknown): v is string => typeof v === 'string' && EXT.test(v) && !RESERVED.includes(v);
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const seg = (k: string): string => (k.length > 64 ? k.slice(0, 64) : k);
const cropOk = (v: unknown): v is Crop =>
  Array.isArray(v) && v.length === 4 && v.every((x) => typeof x === 'number' && Number.isFinite(x) && x >= 0 && x <= 1) &&
  v[2] > 0 && v[3] > 0 && v[0] + v[2] <= 1 + 1e-6 && v[1] + v[3] <= 1 + 1e-6;

const TOP = ['v', 'p', 'rev', 'variant', 'theme', 'colors', 'parts', 'texts', 'logo', 'photo', 'qr', 'icon', 'nfc', 'slots', 'roster', 'parent', 'notes'];
/** The refusal code a strict pass answers with: the first of these its errors carry. */
const ORDER = ['CONFIG_INVALID', 'ROSTER_TOO_LARGE', 'DESIGN_TEXT_INVALID', 'QR_TARGET_INVALID'];

function priceKeyPaths(v: unknown, path: string, out: string[], depth: number): void {
  if (depth > CONFIG_LIMITS.depth) out.push(path);
  else if (Array.isArray(v)) v.forEach((x, i) => priceKeyPaths(x, path ? `${path}.${i}` : String(i), out, depth + 1));
  else if (isObj(v)) {
    for (const [k, x] of Object.entries(v)) {
      const p = path ? `${path}.${seg(k)}` : seg(k);
      if (isPriceLikeKey(k)) out.push(p);
      priceKeyPaths(x, p, out, depth + 1);
    }
  }
}

const isPublic = (spec: SpecLike): spec is PublicBlueprint => 'product' in spec;

/** The variant a fresh design starts on: the recommended size, in stock first. */
function pickVariant(spec: SpecLike, variants: ReadonlyArray<Partial<PublicVariant> & { id: string }> | undefined): string | null {
  if (!variants?.length) return null;
  const size = spec.axes.size;
  const rec = size && Object.keys(size.values).find((id) => size.values[id].recommended);
  const pool = rec ? variants.filter((x) => x.values?.[size.group] === rec) : [];
  const list = pool.length ? pool : variants;
  return (list.find((x) => x.in_stock !== false) ?? list[0]).id;
}

export interface NormalizeConfigOptions {
  /** Autosave and migration: keep what is valid, report the rest. */
  lenient?: boolean;
  /** The product's variants when `spec` is a BlueprintSpec — a PublicBlueprint carries its own. Without either, a variant id is checked by shape only. */
  variants?: ReadonlyArray<Partial<PublicVariant> & { id: string }>;
}

export function normalizeConfig(raw: unknown, spec: SpecLike, opts: NormalizeConfigOptions = {}): EngineResult<DesignConfig> {
  const fail = (code: string, path: string, errors: EngineIssue[] = [{ path, code }]): EngineResult<DesignConfig> => ({ ok: false, code, path, errors });
  if (!isObj(raw)) return fail('CONFIG_INVALID', '');
  let size: number;
  try {
    size = utf8Bytes(JSON.stringify(raw));
  } catch {
    return fail('CONFIG_INVALID', '');
  }
  if (size > 2 * CONFIG_LIMITS.rosterBytes) return fail('DESIGN_TOO_LARGE', '');
  const priced: string[] = [];
  priceKeyPaths(raw, '', priced, 0);
  if (priced.length) return fail('CONFIG_INVALID', priced[0], priced.map((path) => ({ path, code: 'CONFIG_INVALID' })));

  const pub = isPublic(spec) ? spec : null;
  if (raw.v !== 1) return fail('CONFIG_INVALID', 'v');
  if (!isExtId(raw.p) || (pub && raw.p !== pub.product.id)) return fail('CONFIG_INVALID', 'p');
  const lenient = !!opts.lenient;
  const errs: EngineIssue[] = [];
  const bad = (path: string, code = 'CONFIG_INVALID'): void => void errs.push({ path, code });
  let rev = raw.rev as number;
  if (!Number.isSafeInteger(rev) || rev < 1) {
    if (!lenient || !pub) return fail('CONFIG_INVALID', 'rev');
    bad('rev');
    rev = pub.rev;
  } else if (pub && rev !== pub.rev) {
    if (!lenient) return fail('BLUEPRINT_CHANGED', 'rev');
    bad('rev', 'BLUEPRINT_CHANGED');
    rev = pub.rev;
  }
  for (const k of Object.keys(raw)) if (!TOP.includes(k)) bad(seg(k));

  const c = controlsOf(spec);
  const entries = (v: unknown, path: string): Array<[string, unknown]> => {
    if (v === undefined) return [];
    if (isObj(v)) return Object.entries(v);
    bad(path);
    return [];
  };
  /** A plain object; each key it should not have is reported (and ignored). */
  const shape = (v: unknown, path: string, keys: string[]): v is Record<string, unknown> => {
    if (!isObj(v)) {
      bad(path);
      return false;
    }
    for (const k of Object.keys(v)) if (!keys.includes(k)) bad(`${path}.${seg(k)}`);
    return true;
  };
  const paintOk = (id: string, v: unknown): v is PaletteKey => {
    const allowed = c.paint.get(id)?.allowed;
    return !!allowed && (PAINT_KEYS as readonly unknown[]).includes(v) && (!Array.isArray(allowed) || allowed.includes(v as PaletteKey));
  };
  const lines = (v: unknown, t: TextSpec, path: string): string[] => {
    if (v === undefined) return [];
    if (!Array.isArray(v)) {
      bad(path);
      return [];
    }
    const out: string[] = [];
    v.forEach((s, i) => {
      if (typeof s !== 'string') return bad(`${path}.${i}`);
      const line = cleanLine(s);
      if (!line) return;
      if (!designTextOk(line) || graphemeCount(line) > t.max) return bad(`${path}.${i}`, 'DESIGN_TEXT_INVALID');
      out.push(line);
    });
    const bound = t.count > 1 ? t.count : t.lines;
    if (out.length > bound) bad(path, 'DESIGN_TEXT_INVALID');
    return out.slice(0, bound);
  };

  const variants = pub ? pub.variants : opts.variants;
  let variant: string | null = raw.variant === undefined ? null : (raw.variant as string | null);
  if (variant === null ? !!variants?.length : !isExtId(variant) || (variants && !variants.some((x) => x.id === variant))) {
    bad('variant');
    variant = pickVariant(spec, variants);
  }

  let theme: ThemeKey | null = null;
  if (raw.theme != null) {
    const t = raw.theme as ThemeKey;
    if (THEMES.includes(t) && (spec.themes === 'all' || spec.themes.includes(t))) theme = t;
    else bad('theme');
  }

  const colors: Record<string, PaletteKey> = {};
  for (const [id, v] of entries(raw.colors, 'colors')) {
    if (paintOk(id, v)) colors[id] = v;
    else bad(`colors.${seg(id)}`);
  }

  const parts: Record<string, boolean> = {};
  for (const [id, v] of entries(raw.parts, 'parts')) {
    if (c.optional.has(id) && typeof v === 'boolean') parts[id] = v;
    else bad(`parts.${seg(id)}`);
  }

  const texts: Record<string, TextChoice> = {};
  for (const [id, v] of entries(raw.texts, 'texts')) {
    const t = c.texts.get(id);
    const p = `texts.${seg(id)}`;
    if (!t) bad(p);
    else if (shape(v, p, ['value', 'style'])) {
      let style = (v.style ?? t.default_style) as StyleKey;
      if (!STYLES.includes(style) || (t.styles !== 'all' && !t.styles.includes(style))) {
        bad(`${p}.style`);
        style = t.default_style;
      }
      texts[id] = { value: lines(v.value, t, `${p}.value`), style };
    }
  }

  const assets = <M extends string>(v: unknown, kind: 'logo' | 'photo'): Record<string, AssetChoice<M>> => {
    const out: Record<string, AssetChoice<M>> = {};
    for (const [id, a] of entries(v, kind)) {
      const area = c.areas.get(id);
      const p = `${kind}.${seg(id)}`;
      const modes: readonly string[] = (kind === 'logo' ? area?.logo?.modes : area?.photo?.modes) ?? [];
      if (area?.kind !== kind) bad(p);
      else if (shape(a, p, ['key', 'crop', 'mode'])) {
        const crop = a.crop ?? [0, 0, 1, 1];
        const mode = a.mode ?? modes[0];
        const n = errs.length;
        if (typeof a.key !== 'string' || !DESIGN_ASSET_KEY.test(a.key)) bad(`${p}.key`);
        if (!cropOk(crop)) bad(`${p}.crop`);
        if (typeof mode !== 'string' || !modes.includes(mode)) bad(`${p}.mode`);
        if (errs.length === n) out[id] = { key: a.key as string, crop: crop as Crop, mode: mode as M };
      }
    }
    return out;
  };

  const qr: Record<string, TargetChoice<QrKind>> = {};
  for (const [id, q] of entries(raw.qr, 'qr')) {
    const kinds = c.areas.get(id)?.qr?.kinds;
    const p = `qr.${seg(id)}`;
    if (!kinds) bad(p);
    else if (shape(q, p, ['kind', 'value'])) {
      const kind = q.kind as QrKind;
      const value = typeof q.value === 'string' ? normalizeTarget(kind, q.value) : null;
      if (!kinds.includes(kind)) bad(`${p}.kind`);
      else if (value === null) bad(`${p}.value`, 'QR_TARGET_INVALID');
      else qr[id] = { kind, value };
    }
  }

  const icon: Record<string, IconKey> = {};
  for (const [id, k] of entries(raw.icon, 'icon')) {
    const keys = c.areas.get(id)?.icon?.keys;
    if (keys && ICON_KEYS.includes(k as IconKey) && (keys === 'all' || keys.includes(k as IconKey))) icon[id] = k as IconKey;
    else bad(`icon.${seg(id)}`);
  }

  let nfc: TargetChoice<NfcKind> | null = null;
  const rawNfc = raw.nfc;
  if (rawNfc != null) {
    const x = spec.extras.nfc;
    if (!x) bad('nfc');
    else if (shape(rawNfc, 'nfc', ['kind', 'value'])) {
      const kind = rawNfc.kind as NfcKind;
      const value = typeof rawNfc.value === 'string' ? normalizeTarget(kind, rawNfc.value, true) : null;
      if (!x.kinds.includes(kind)) bad('nfc.kind');
      else if (value === null) bad('nfc.value', 'QR_TARGET_INVALID');
      else nfc = { kind, value };
    }
  }

  const slots: Record<string, { option: string | null }> = {};
  for (const [id, s] of entries(raw.slots, 'slots')) {
    const slot = c.slots.get(id);
    const p = `slots.${seg(id)}`;
    if (!slot) bad(p);
    else if (shape(s, p, ['option'])) {
      const o = s.option;
      if (o === null || (typeof o === 'string' && slot.options.some((x) => x.key === o))) slots[id] = { option: o as string | null };
      else bad(`${p}.option`);
    }
  }

  let roster: RosterEntry[] | null = null;
  const rawRoster = raw.roster;
  if (rawRoster != null) {
    const x = spec.extras.roster;
    if (!x || !Array.isArray(rawRoster) || !rawRoster.length) bad('roster');
    else {
      if (rawRoster.length > x.max) bad('roster', 'ROSTER_TOO_LARGE');
      roster = [];
      rawRoster.slice(0, x.max).forEach((r, i) => {
        const p = `roster.${i}`;
        if (!shape(r, p, ['n', 'texts', 'colors'])) return;
        const n = r.n ?? 1;
        if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 1 || n > CONFIG_LIMITS.rosterQty) return bad(`${p}.n`);
        const entry: RosterEntry = { n, texts: {}, colors: {} };
        for (const [id, v] of entries(r.texts, `${p}.texts`)) {
          const t = c.texts.get(id);
          if (!t || !x.vary.includes(id)) bad(`${p}.texts.${seg(id)}`);
          else entry.texts![id] = lines(v, t, `${p}.texts.${seg(id)}`);
        }
        for (const [id, v] of entries(r.colors, `${p}.colors`)) {
          if (x.vary.includes(id) && paintOk(id, v)) entry.colors![id] = v;
          else bad(`${p}.colors.${seg(id)}`);
        }
        roster!.push(entry);
      });
    }
  }

  let parent: string | null = null;
  if (raw.parent != null) {
    if (isExtId(raw.parent)) parent = raw.parent;
    else bad('parent');
  }

  let notes = '';
  if (raw.notes !== undefined) {
    const n = typeof raw.notes === 'string' ? raw.notes.normalize('NFC') : null;
    if (n === null) bad('notes');
    else if ([...n].length > CONFIG_LIMITS.notes || !plainTextOk(n, true)) bad('notes', 'DESIGN_TEXT_INVALID');
    else notes = n;
  }

  const logo = assets<LogoMode>(raw.logo, 'logo');
  const photo = assets<PhotoMode>(raw.photo, 'photo');
  const config = canonicalize(
    { v: 1, p: raw.p, rev, variant, theme, colors, parts, texts, logo, photo, qr, icon, nfc, slots, roster, parent, notes } as DesignConfig,
    spec
  );
  if (utf8Bytes(canonicalJson(config)) > (config.roster ? CONFIG_LIMITS.rosterBytes : CONFIG_LIMITS.bytes)) return fail('DESIGN_TOO_LARGE', '');
  if (!errs.length) return { ok: true, value: config };
  if (lenient) return { ok: true, value: config, errors: errs };
  const code = ORDER.find((k) => errs.some((e) => e.code === k)) ?? errs[0].code;
  return fail(code, errs.find((e) => e.code === code)!.path, errs);
}

/**
 * A fresh design: the recommended size (in stock first) unless `variantId` is
 * given, every colour at its default, optional pieces at their default, every
 * text empty in its default style (the sample is a placeholder, never copied —
 * a required text stays empty and `requiredMissing` names it), required and
 * fixed slots on their default option. `ids` names the product and revision
 * when `spec` is a BlueprintSpec.
 */
export function defaultConfig(spec: SpecLike, variantId?: string | null, ids?: { p: string; rev: number }): DesignConfig {
  const pub = isPublic(spec) ? spec : null;
  const base = {
    v: 1, p: pub ? pub.product.id : ids?.p ?? '', rev: pub ? pub.rev : ids?.rev ?? 1,
    variant: variantId !== undefined ? variantId : pickVariant(spec, pub?.variants),
    theme: null, colors: {}, parts: {}, texts: {}, logo: {}, photo: {}, qr: {}, icon: {}, nfc: null, slots: {}, roster: null, parent: null, notes: '',
  } as const;
  return canonicalize(base as unknown as DesignConfig, spec);
}

/** Paths of required content the design still lacks (`texts.name`, `logo.logo`, `slots.magnet`) — check.ts blocks the door on them. */
export function requiredMissing(config: DesignConfig, spec: SpecLike): string[] {
  const out: string[] = [];
  for (const a of spec.areas) {
    if (!a.required || config.parts[a.region] === false) continue;
    const filled = a.kind === 'text' ? !!config.texts[a.id]?.value.length : !!config[a.kind][a.id];
    if (!filled) out.push(`${a.kind === 'text' ? 'texts' : a.kind}.${a.id}`);
  }
  for (const s of spec.slots) if (s.required && s.choice === 'customer' && !config.slots[s.id]?.option) out.push(`slots.${s.id}`);
  return out;
}

/** Every printed text with its path — the doors run each through the decency filter. */
export function textValues(config: DesignConfig): Array<{ path: string; value: string }> {
  const out: Array<{ path: string; value: string }> = [];
  for (const [id, t] of Object.entries(config.texts)) t.value.forEach((value, i) => out.push({ path: `texts.${id}.value.${i}`, value }));
  config.roster?.forEach((r, i) => {
    for (const [id, vs] of Object.entries(r.texts ?? {})) vs.forEach((value, j) => out.push({ path: `roster.${i}.texts.${id}.${j}`, value }));
  });
  return out;
}
