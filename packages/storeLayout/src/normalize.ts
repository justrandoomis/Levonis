/**
 * normalizeLayout — THE ONE GATE every layout passes, everywhere.
 *
 * The same function runs in the Worker (authoritative: on every write, and
 * again on every read before a layout is served), in the store builder (for
 * instant feedback), and in the storefront before a single block renders.
 * It never throws and never returns anything but a complete, valid layout:
 *
 *   - UNKNOWN is STRIPPED. An unknown block type, setting, token or key is
 *     dropped with an issue; nothing input-shaped is ever copied through, so
 *     `__proto__`, `constructor` and friends are just more unknown keys.
 *   - OUT OF BOUNDS is CLAMPED. Numbers into range, text to its cap, lists to
 *     their length, enums to their default — each with an issue.
 *   - DANGEROUS is REFUSED. A link with any scheme but https, a media value
 *     that is not a key this store's owner was issued, a future schema, an
 *     oversize layout: the offending value is removed AND the issue is
 *     `fatal`, which the write routes turn into a refusal. (The read path
 *     renders what survived — a stored layout never takes a page down.)
 *
 * It is idempotent: normalising its own output changes nothing and reports
 * nothing (tests/storeLayoutSchema.test.ts).
 */
import { BLOCKS, blockMax, isBlockType, type BlockDef, type BlockType, type FieldSpec } from './blocks';
import { isSocialProvider, linkTarget, mediaKey, own, refId, socialHandle, type SocialItem } from './refs';
import { cleanText, EMPTY_TEXT, isBlank, type LocalizedText } from './text';
import { isThemeName, THEME_PRESETS, TOKEN_KEYS, TOKEN_VALUES, type ThemeName, type ThemeTokens } from './tokens';
import {
  FOOTER_VARIANTS, HEADER_VARIANTS, MAX_BLOCKS, MAX_LAYOUT_BYTES, SCHEMA_VERSION,
  type FooterVariant, type HeaderVariant, type StoreBlock, type StoreLayout, type Visibility,
} from './schema';

export type IssueCode =
  // fatal — refused on write
  | 'not_an_object'
  | 'unsupported_schema_version'
  | 'payload_too_large'
  | 'unsafe_link'
  | 'invalid_media'
  | 'foreign_media'
  // cleaned — reported, never refused
  | 'missing_schema_version'
  | 'unknown_key'
  | 'unknown_block_type'
  | 'invalid_block'
  | 'invalid_value'
  | 'invalid_ref'
  | 'clamped'
  | 'truncated'
  | 'too_many'
  | 'duplicate_id'
  | 'dropped_item'
  // server write path (worker/lib/storeLayout.ts)
  | 'unknown_ref'
  | 'media_not_found';

const FATAL: ReadonlySet<IssueCode> = new Set<IssueCode>([
  'not_an_object', 'unsupported_schema_version', 'payload_too_large', 'unsafe_link', 'invalid_media', 'foreign_media',
]);

export function isFatal(code: IssueCode): boolean {
  return FATAL.has(code);
}

export interface LayoutIssue {
  /** Where, e.g. `blocks[2].settings.link`. '' is the layout itself. */
  path: string;
  code: IssueCode;
  fatal: boolean;
}

export interface NormalizeOptions {
  /**
   * The store owner's user id; every media key must live under it. `null`
   * checks shape only, for RENDERING a layout the server already verified —
   * never for accepting one. `''` matches nothing.
   */
  ownerUserId: string | null;
}

export interface NormalizeResult {
  layout: StoreLayout;
  issues: LayoutIssue[];
  /** No fatal issue: the layout may be stored as it came. */
  ok: boolean;
}

interface Ctx {
  owner: string | null;
  issues: LayoutIssue[];
  /** A fatal issue was found — kept apart from the list, which is capped. */
  fatal: boolean;
}

/**
 * Issues kept per call. Enough for every problem a real editor makes; a
 * hostile payload (sixty thousand unknown keys) cannot grow the list. A fatal
 * issue is always listed, even past the cap.
 */
export const MAX_ISSUES = 200;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function report(ctx: Ctx, path: string, code: IssueCode) {
  const fatal = FATAL.has(code);
  if (ctx.issues.length < MAX_ISSUES) ctx.issues.push({ path, code, fatal });
  else if (fatal && !ctx.fatal) ctx.issues[MAX_ISSUES - 1] = { path, code, fatal };
  if (fatal) ctx.fatal = true;
}

function reportUnknownKeys(ctx: Ctx, obj: Record<string, unknown>, allowed: readonly string[], path: string) {
  for (const k of Object.keys(obj)) if (!allowed.includes(k)) report(ctx, join(path, k), 'unknown_key');
}

const join = (path: string, key: string) => (path ? `${path}.${key}` : key);

const MIN_DATE = Date.UTC(2020, 0, 1);
const MAX_DATE = Date.UTC(2100, 0, 1);
const BLOCK_ID = /^[a-z0-9][a-z0-9_-]{0,31}$/;

// ------------------------------------------------------------------ fields

function normalizeText(spec: { max: number; multiline?: boolean }, v: unknown, path: string, ctx: Ctx): LocalizedText {
  if (v === undefined || v === null) return { ...EMPTY_TEXT };
  if (!isObject(v)) {
    report(ctx, path, 'invalid_value');
    return { ...EMPTY_TEXT };
  }
  const out: LocalizedText = { ar: '', en: '', ckb: '' };
  for (const lang of ['ar', 'en', 'ckb'] as const) {
    const raw = own(v, lang);
    if (raw !== undefined && typeof raw !== 'string') report(ctx, join(path, lang), 'invalid_value');
    const c = cleanText(raw, spec.max, !!spec.multiline);
    if (c.truncated) report(ctx, join(path, lang), 'truncated');
    out[lang] = c.value;
  }
  reportUnknownKeys(ctx, v, ['ar', 'en', 'ckb'], path);
  return out;
}

function normalizeField(spec: FieldSpec, v: unknown, path: string, ctx: Ctx): unknown {
  switch (spec.t) {
    case 'bool':
      if (v === undefined) return spec.d;
      if (typeof v === 'boolean') return v;
      report(ctx, path, 'invalid_value');
      return spec.d;
    case 'enum':
      if (v === undefined) return spec.d;
      if (typeof v === 'string' && spec.values.includes(v)) return v;
      report(ctx, path, 'invalid_value');
      return spec.d;
    case 'int': {
      if (v === undefined) return spec.d;
      if (typeof v !== 'number' || !Number.isFinite(v)) {
        report(ctx, path, 'invalid_value');
        return spec.d;
      }
      const n = Math.round(v);
      const clamped = Math.min(spec.max, Math.max(spec.min, n));
      if (clamped !== v) report(ctx, path, 'clamped');
      return clamped;
    }
    case 'text':
      return normalizeText(spec, v, path, ctx);
    case 'media': {
      const verdict = mediaKey(v, spec.kind, ctx.owner);
      if (!verdict) return '';
      // `in`, not `.ok`: the SPA's tsconfig is not strict, and it narrows this
      // union only by property presence.
      if ('code' in verdict) {
        report(ctx, path, verdict.code);
        return '';
      }
      return verdict.key;
    }
    case 'link': {
      const { link, issue } = linkTarget(v);
      if (issue) report(ctx, path, issue);
      return link;
    }
    case 'date': {
      if (v === undefined || v === null || v === '') return '';
      const ms = typeof v === 'string' && v.length <= 40 ? Date.parse(v) : NaN;
      if (!Number.isFinite(ms) || ms < MIN_DATE || ms > MAX_DATE) {
        report(ctx, path, 'invalid_value');
        return '';
      }
      return new Date(ms).toISOString();
    }
    case 'ref': {
      if (v === undefined || v === null || v === '') return '';
      const id = refId(v);
      if (!id) report(ctx, path, 'invalid_ref');
      return id ?? '';
    }
    case 'refs': {
      if (v === undefined) return [];
      if (!Array.isArray(v)) {
        report(ctx, path, 'invalid_value');
        return [];
      }
      if (v.length > spec.max) report(ctx, path, 'too_many');
      const out: string[] = [];
      v.slice(0, spec.max).forEach((item, i) => {
        const id = refId(item);
        if (!id) report(ctx, `${path}[${i}]`, 'invalid_ref');
        else if (!out.includes(id)) out.push(id);
      });
      return out;
    }
    case 'set': {
      if (v === undefined) return [...spec.d];
      if (!Array.isArray(v)) {
        report(ctx, path, 'invalid_value');
        return [...spec.d];
      }
      // A set holds each allowed value once, so anything longer is junk:
      // read at most twice that many entries, and report junk once.
      const cap = spec.values.length * 2;
      if (v.length > cap) report(ctx, path, 'too_many');
      const out: string[] = [];
      let junk = false;
      for (const item of v.slice(0, cap)) {
        if (typeof item === 'string' && spec.values.includes(item)) {
          if (!out.includes(item)) out.push(item);
        } else {
          junk = true;
        }
      }
      if (junk) report(ctx, path, 'invalid_value');
      if (out.length > spec.max) {
        report(ctx, path, 'too_many');
        out.length = spec.max;
      }
      if (out.length < spec.min) {
        report(ctx, path, 'invalid_value');
        return [...spec.d];
      }
      return out;
    }
    case 'socials': {
      if (v === undefined) return [];
      if (!Array.isArray(v)) {
        report(ctx, path, 'invalid_value');
        return [];
      }
      if (v.length > spec.max) report(ctx, path, 'too_many');
      const out: SocialItem[] = [];
      v.slice(0, spec.max).forEach((item, i) => {
        const provider = isObject(item) ? own(item, 'provider') : undefined;
        const handle = isObject(item) && isSocialProvider(provider) ? socialHandle(provider, own(item, 'handle')) : null;
        if (!isSocialProvider(provider) || !handle) {
          report(ctx, `${path}[${i}]`, 'invalid_value');
          return;
        }
        if (isObject(item)) reportUnknownKeys(ctx, item, ['provider', 'handle'], `${path}[${i}]`);
        if (!out.some((s) => s.provider === provider && s.handle === handle)) out.push({ provider, handle });
      });
      return out;
    }
    case 'list': {
      if (v === undefined) return [];
      if (!Array.isArray(v)) {
        report(ctx, path, 'invalid_value');
        return [];
      }
      if (v.length > spec.max) report(ctx, path, 'too_many');
      const out: Array<Record<string, unknown>> = [];
      v.slice(0, spec.max).forEach((raw, i) => {
        const itemPath = `${path}[${i}]`;
        if (!isObject(raw)) {
          report(ctx, itemPath, 'invalid_value');
          return;
        }
        const item = normalizeFields(spec.item, raw, itemPath, ctx);
        if (spec.requires.some((k) => isEmptyValue(item[k]))) {
          report(ctx, itemPath, 'dropped_item');
          return;
        }
        out.push(item);
      });
      return out;
    }
  }
}

function isEmptyValue(v: unknown): boolean {
  if (v === '' || v === undefined || v === null) return true;
  if (Array.isArray(v)) return v.length === 0;
  if (isObject(v) && 'ar' in v && 'en' in v && 'ckb' in v) return isBlank(v as unknown as LocalizedText);
  return false;
}

function normalizeFields(
  specs: { readonly [k: string]: FieldSpec },
  raw: Record<string, unknown>,
  path: string,
  ctx: Ctx
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(specs)) out[key] = normalizeField(specs[key], own(raw, key), join(path, key), ctx);
  reportUnknownKeys(ctx, raw, Object.keys(specs), path);
  return out;
}

// ------------------------------------------------------------------ blocks

/** Rules that span two settings of one block. */
function applyBlockRules(type: BlockType, settings: Record<string, unknown>, path: string, ctx: Ctx) {
  if (type === 'products_grid' || type === 'products_carousel') {
    if (settings.source === 'collection' && !settings.collection_id) {
      report(ctx, join(path, 'collection_id'), 'invalid_value');
      settings.source = 'latest';
    }
    if (settings.source !== 'collection') settings.collection_id = '';
  }
}

function normalizeVisibility(v: unknown, path: string, ctx: Ctx): Visibility {
  if (v === undefined) return { mobile: true, desktop: true };
  if (!isObject(v)) {
    report(ctx, path, 'invalid_value');
    return { mobile: true, desktop: true };
  }
  const flag = (key: 'mobile' | 'desktop') => {
    const x = own(v, key);
    if (x === undefined) return true;
    if (typeof x === 'boolean') return x;
    report(ctx, join(path, key), 'invalid_value');
    return true;
  };
  reportUnknownKeys(ctx, v, ['mobile', 'desktop'], path);
  return { mobile: flag('mobile'), desktop: flag('desktop') };
}

function uniqueId(base: string, used: Set<string>): string {
  const stem = base.slice(0, 28);
  if (!used.has(stem)) return stem;
  for (let n = 2; ; n++) {
    const id = `${stem}-${n}`;
    if (!used.has(id)) return id;
  }
}

function normalizeBlock(raw: unknown, index: number, counts: Map<BlockType, number>, used: Set<string>, ctx: Ctx): StoreBlock | null {
  const path = `blocks[${index}]`;
  if (!isObject(raw)) {
    report(ctx, path, 'invalid_block');
    return null;
  }
  const type = own(raw, 'type');
  if (!isBlockType(type)) {
    report(ctx, join(path, 'type'), 'unknown_block_type');
    return null;
  }
  const n = (counts.get(type) ?? 0) + 1;
  counts.set(type, n);
  if (n > blockMax(type)) {
    report(ctx, path, 'too_many');
    return null;
  }
  const def: BlockDef = BLOCKS[type];

  const rawId = own(raw, 'id');
  let id: string;
  if (typeof rawId === 'string' && BLOCK_ID.test(rawId)) {
    id = used.has(rawId) ? uniqueId(rawId, used) : rawId;
    if (id !== rawId) report(ctx, join(path, 'id'), 'duplicate_id');
  } else {
    if (rawId !== undefined) report(ctx, join(path, 'id'), 'invalid_value');
    id = uniqueId(type.replace(/_/g, '-'), used);
  }
  used.add(id);

  const rawVariant = own(raw, 'variant');
  let variant = def.variants[0];
  if (typeof rawVariant === 'string' && def.variants.includes(rawVariant)) variant = rawVariant;
  else if (rawVariant !== undefined) report(ctx, join(path, 'variant'), 'invalid_value');

  const rawSettings = own(raw, 'settings');
  if (rawSettings !== undefined && !isObject(rawSettings)) report(ctx, join(path, 'settings'), 'invalid_value');
  const settings = normalizeFields(def.settings, isObject(rawSettings) ? rawSettings : {}, join(path, 'settings'), ctx);
  applyBlockRules(type, settings, join(path, 'settings'), ctx);

  const hiddenRaw = own(raw, 'hidden');
  if (hiddenRaw !== undefined && typeof hiddenRaw !== 'boolean') report(ctx, join(path, 'hidden'), 'invalid_value');

  reportUnknownKeys(ctx, raw, ['id', 'type', 'variant', 'settings', 'visibility', 'hidden'], path);
  return {
    id,
    type,
    variant,
    settings,
    visibility: normalizeVisibility(own(raw, 'visibility'), join(path, 'visibility'), ctx),
    hidden: hiddenRaw === true,
  } as StoreBlock;
}

// ------------------------------------------------------------------ layout

function pick<T extends string>(v: unknown, allowed: readonly T[], fallback: T, path: string, ctx: Ctx): T {
  if (v === undefined) return fallback;
  if (typeof v === 'string' && (allowed as readonly string[]).includes(v)) return v as T;
  report(ctx, path, 'invalid_value');
  return fallback;
}

function normalizeTokens(v: unknown, theme: ThemeName, ctx: Ctx): ThemeTokens {
  const out: ThemeTokens = { ...THEME_PRESETS[theme] };
  if (v === undefined) return out;
  if (!isObject(v)) {
    report(ctx, 'tokens', 'invalid_value');
    return out;
  }
  for (const key of TOKEN_KEYS) {
    const x = own(v, key);
    if (x === undefined) continue;
    if ((TOKEN_VALUES[key] as readonly unknown[]).includes(x)) (out as unknown as Record<string, unknown>)[key] = x;
    else report(ctx, join('tokens', key), 'invalid_value');
  }
  reportUnknownKeys(ctx, v, TOKEN_KEYS, 'tokens');
  return out;
}

function normalizeVariantBox<T extends string>(v: unknown, allowed: readonly T[], fallback: T, path: string, ctx: Ctx): { variant: T } {
  if (v === undefined) return { variant: fallback };
  if (!isObject(v)) {
    report(ctx, path, 'invalid_value');
    return { variant: fallback };
  }
  reportUnknownKeys(ctx, v, ['variant'], path);
  return { variant: pick(own(v, 'variant'), allowed, fallback, join(path, 'variant'), ctx) };
}

export function emptyLayout(theme: ThemeName = 'classic'): StoreLayout {
  return {
    schema_version: SCHEMA_VERSION,
    theme,
    tokens: { ...THEME_PRESETS[theme] },
    header: { variant: 'overlay' },
    footer: { variant: 'minimal' },
    blocks: [],
  };
}

const utf8Bytes = (s: string) => new TextEncoder().encode(s).length;

export function normalizeLayout(input: unknown, opts: NormalizeOptions): NormalizeResult {
  const ctx: Ctx = { owner: opts.ownerUserId, issues: [], fatal: false };
  if (!isObject(input)) {
    report(ctx, '', 'not_an_object');
    return { layout: emptyLayout(), issues: ctx.issues, ok: false };
  }

  const version = own(input, 'schema_version');
  if (version === undefined) report(ctx, 'schema_version', 'missing_schema_version');
  else if (version !== SCHEMA_VERSION) {
    // Not read with this version's rules: a layout written by a newer schema
    // (a rolled-back Worker) is not half-understood. The public gets the
    // classic page, a write is refused.
    report(ctx, 'schema_version', 'unsupported_schema_version');
    return { layout: emptyLayout(), issues: ctx.issues, ok: false };
  }

  const rawTheme = own(input, 'theme');
  let theme: ThemeName = 'classic';
  if (isThemeName(rawTheme)) theme = rawTheme;
  else if (rawTheme !== undefined) report(ctx, 'theme', 'invalid_value');

  const layout: StoreLayout = {
    schema_version: SCHEMA_VERSION,
    theme,
    tokens: normalizeTokens(own(input, 'tokens'), theme, ctx),
    header: normalizeVariantBox<HeaderVariant>(own(input, 'header'), HEADER_VARIANTS, 'overlay', 'header', ctx),
    footer: normalizeVariantBox<FooterVariant>(own(input, 'footer'), FOOTER_VARIANTS, 'minimal', 'footer', ctx),
    blocks: [],
  };

  const rawBlocks = own(input, 'blocks');
  if (rawBlocks !== undefined && !Array.isArray(rawBlocks)) report(ctx, 'blocks', 'invalid_value');
  if (Array.isArray(rawBlocks)) {
    if (rawBlocks.length > MAX_BLOCKS) report(ctx, 'blocks', 'too_many');
    const counts = new Map<BlockType, number>();
    const used = new Set<string>();
    rawBlocks.slice(0, MAX_BLOCKS).forEach((raw, i) => {
      const block = normalizeBlock(raw, i, counts, used, ctx);
      if (block) layout.blocks.push(block);
    });
  }

  reportUnknownKeys(ctx, input, ['schema_version', 'theme', 'tokens', 'header', 'footer', 'blocks'], '');
  if (utf8Bytes(JSON.stringify(layout)) > MAX_LAYOUT_BYTES) report(ctx, '', 'payload_too_large');
  return { layout, issues: ctx.issues, ok: !ctx.fatal };
}

// ----------------------------------------------------------------- helpers

/** A block of `type` with every setting at its default, then `settings` applied. */
export function makeBlock<T extends BlockType>(
  type: T,
  id: string,
  opts: { variant?: string; settings?: Record<string, unknown>; hidden?: boolean } = {}
): StoreBlock {
  const ctx: Ctx = { owner: null, issues: [], fatal: false };
  const block = normalizeBlock(
    { id, type, variant: opts.variant, settings: opts.settings ?? {}, hidden: opts.hidden ?? false },
    0,
    new Map(),
    new Set(),
    ctx
  );
  if (!block || ctx.issues.length) throw new Error(`makeBlock(${type}): ${JSON.stringify(ctx.issues)}`);
  return block;
}

/**
 * Switch the preset a layout's tokens start from. PRESENTATION ONLY: the
 * blocks, their settings and order, the header and the footer are returned
 * untouched, and nothing outside the layout is read or written.
 */
export function applyTheme(layout: StoreLayout, theme: ThemeName): StoreLayout {
  return { ...layout, theme, tokens: { ...THEME_PRESETS[theme] } };
}

/** The blocks a visitor can see at all (not hidden, visible on some width). */
export function renderableBlocks(layout: StoreLayout): StoreBlock[] {
  return layout.blocks.filter((b) => !b.hidden && (b.visibility.mobile || b.visibility.desktop));
}
