/**
 * THE STORE BUILDER'S MODEL — every edit a merchant can make to a layout, as a
 * pure function from one layout to the next. No React, no I/O: the editor's
 * hook (useLayoutEditor.ts) holds the state and calls these, and
 * tests/storeDesignEditor.test.ts drives them directly.
 *
 * WHAT THIS MODULE MAY PRODUCE. Only schema-shaped values: a block made by
 * `makeBlock` (the normaliser's own output), a variant from the block's list,
 * a token from its enum, a setting under a key the registry declares. It never
 * copies an input object through. Even so it is NOT the gate: whatever the
 * editor holds is run through `normalizeLayout` (`validateLayout` below) on
 * every change for the inline issues, and what is SAVED is that function's
 * output — the builder has no path to the server around it.
 *
 * LIMITS ARE CHECKED HERE, BEFORE THEY BITE. The normaliser silently drops a
 * 41st block, an 11th grid or a second hero, and the data planner silently
 * skips a 13th product list (packages/storeLayout/src/data.ts
 * MAX_PRODUCT_QUERIES). The editor refuses the edit instead, with a reason the
 * UI shows before the merchant tries.
 */
import { BLOCKS, blockMax, isBlockType, type BlockDef, type BlockType } from '../../../../packages/storeLayout/src/blocks';
import { makeBlock, normalizeLayout, renderableBlocks, type LayoutIssue, type NormalizeResult } from '../../../../packages/storeLayout/src/normalize';
// Only what the storefront chunk already carries is imported from shared modules
// (`productQueryKey`, not `collectDataNeeds` / `applyTheme`): anything else the
// builder imported from them would be pulled into the storefront's chunk too.
import { productQueryKey, type ProductSource } from '../../../../packages/storeLayout/src/data';
import { MAX_BLOCKS, type FooterVariant, type HeaderVariant, type StoreBlock, type StoreLayout, type Visibility } from '../../../../packages/storeLayout/src/schema';
import { THEME_PRESETS, TOKEN_KEYS, TOKEN_VALUES, type ThemeName, type ThemeTokens } from '../../../../packages/storeLayout/src/tokens';

// ------------------------------------------------------------------ limits

/** Blocks that each read one product list from the database. */
export const PRODUCT_LIST_TYPES: readonly BlockType[] = ['products_grid', 'products_carousel', 'deals'];
/**
 * Product lists one page may hold — the data planner's cap (data.ts
 * MAX_PRODUCT_QUERIES; tests/storeDesignEditor.test.ts pins them equal), so
 * none is ever silently empty.
 */
export const MAX_PRODUCT_LISTS = 12;
const MAX_PRODUCT_QUERIES = MAX_PRODUCT_LISTS;

export type AddRefusal = 'max_blocks' | 'type_max' | 'product_lists';

export interface Limits {
  blocks: number;
  maxBlocks: number;
  productLists: number;
  maxProductLists: number;
  /** Blocks of each type in the layout. */
  perType: Partial<Record<BlockType, number>>;
}

export function limitsOf(layout: StoreLayout): Limits {
  const perType: Partial<Record<BlockType, number>> = {};
  for (const b of layout.blocks) perType[b.type] = (perType[b.type] ?? 0) + 1;
  return {
    blocks: layout.blocks.length,
    maxBlocks: MAX_BLOCKS,
    productLists: layout.blocks.filter((b) => PRODUCT_LIST_TYPES.includes(b.type)).length,
    maxProductLists: MAX_PRODUCT_LISTS,
    perType,
  };
}

/** Whether one more block of `type` fits, and if not, why. */
export function canAdd(layout: StoreLayout, type: BlockType): AddRefusal | null {
  const l = limitsOf(layout);
  if (l.blocks >= MAX_BLOCKS) return 'max_blocks';
  if ((l.perType[type] ?? 0) >= blockMax(type)) return 'type_max';
  if (PRODUCT_LIST_TYPES.includes(type) && l.productLists >= MAX_PRODUCT_LISTS) return 'product_lists';
  return null;
}

/**
 * Blocks whose product list would NOT be read: the data planner reads at most
 * MAX_PRODUCT_QUERIES distinct lists (the tab strip's included), in page
 * order, and skips the rest. Shown as a warning on those blocks.
 */
export function starvedProductLists(layout: StoreLayout): Set<string> {
  const keys = new Set<string>();
  const starved = new Set<string>();
  const ask = (id: string | null, source: ProductSource, collection: string) => {
    if (source === 'collection' && !collection) return;
    const key = productQueryKey(source, collection);
    if (keys.has(key)) return;
    if (keys.size >= MAX_PRODUCT_QUERIES) {
      if (id) starved.add(id);
      return;
    }
    keys.add(key);
  };
  for (const b of renderableBlocks(layout)) {
    if (b.type === 'products_grid' || b.type === 'products_carousel') ask(b.id, b.settings.source, b.settings.collection_id);
    else if (b.type === 'deals') ask(b.id, 'deals', '');
    else if (b.type === 'tabs') {
      if (b.settings.items.includes('products')) ask(null, 'latest', '');
      if (b.settings.items.includes('deals')) ask(null, 'deals', '');
    }
  }
  return starved;
}

// ------------------------------------------------------------------ blocks

const ID_OK = /^[a-z0-9][a-z0-9_-]{0,31}$/;

/** A fresh id for a block of `type`, unique in `layout`, in the shape the schema accepts. */
export function newBlockId(layout: StoreLayout, type: BlockType): string {
  const used = new Set(layout.blocks.map((b) => b.id));
  const stem = type.replace(/_/g, '-').slice(0, 24);
  if (!used.has(stem)) return stem;
  for (let n = 2; ; n++) {
    const id = `${stem}-${n}`;
    if (!used.has(id) && ID_OK.test(id)) return id;
  }
}

/** The new layout and the id of the block it concerns — or why the edit was refused. */
export type EditResult = { layout: StoreLayout; id: string } | { refused: AddRefusal | 'not_found' };

/** Insert a new block of `type` (every setting at its default) at `at`, or at the end. */
export function addBlock(layout: StoreLayout, type: BlockType, at?: number, opts: { variant?: string } = {}): EditResult {
  if (!isBlockType(type)) return { refused: 'not_found' };
  const refused = canAdd(layout, type);
  if (refused) return { refused };
  const id = newBlockId(layout, type);
  const block = makeBlock(type, id, { variant: variantOf(type, opts.variant) });
  const blocks = [...layout.blocks];
  blocks.splice(clampIndex(at ?? blocks.length, blocks.length), 0, block);
  return { layout: { ...layout, blocks }, id };
}

function variantOf(type: BlockType, v: string | undefined): string | undefined {
  const def: BlockDef = BLOCKS[type];
  return v && def.variants.includes(v) ? v : undefined;
}

const clampIndex = (i: number, len: number) => Math.max(0, Math.min(len, Math.trunc(i)));

export function indexOf(layout: StoreLayout, id: string): number {
  return layout.blocks.findIndex((b) => b.id === id);
}

/** Move the block at `from` to `to` (both indices into the current list). */
export function moveBlock(layout: StoreLayout, from: number, to: number): StoreLayout {
  const n = layout.blocks.length;
  if (from < 0 || from >= n) return layout;
  const target = Math.max(0, Math.min(n - 1, to));
  if (target === from) return layout;
  const blocks = [...layout.blocks];
  const [b] = blocks.splice(from, 1);
  blocks.splice(target, 0, b);
  return { ...layout, blocks };
}

/** One step up (-1) or down (+1): the keyboard path for drag. */
export function moveBy(layout: StoreLayout, id: string, delta: -1 | 1): StoreLayout {
  const i = indexOf(layout, id);
  return i < 0 ? layout : moveBlock(layout, i, i + delta);
}

/**
 * The order a drag produced, as ids. Anything but a permutation of the
 * current ids is ignored — a reorder can never add, drop or repeat a block.
 */
export function reorder(layout: StoreLayout, ids: readonly string[]): StoreLayout {
  if (ids.length !== layout.blocks.length) return layout;
  const byId = new Map(layout.blocks.map((b) => [b.id, b]));
  const blocks: StoreBlock[] = [];
  for (const id of ids) {
    const b = byId.get(id);
    if (!b) return layout;
    byId.delete(id);
    blocks.push(b);
  }
  return blocks.every((b, i) => b === layout.blocks[i]) ? layout : { ...layout, blocks };
}

const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/** A copy of the block right after it, with a new id. */
export function duplicateBlock(layout: StoreLayout, id: string): EditResult {
  const i = indexOf(layout, id);
  if (i < 0) return { refused: 'not_found' };
  const src = layout.blocks[i];
  const refused = canAdd(layout, src.type);
  if (refused) return { refused };
  const copy = { ...clone(src), id: newBlockId(layout, src.type) } as StoreBlock;
  const blocks = [...layout.blocks];
  blocks.splice(i + 1, 0, copy);
  return { layout: { ...layout, blocks }, id: copy.id };
}

export interface Removed {
  block: StoreBlock;
  index: number;
}

export function removeBlock(layout: StoreLayout, id: string): { layout: StoreLayout; removed: Removed | null } {
  const i = indexOf(layout, id);
  if (i < 0) return { layout, removed: null };
  const blocks = [...layout.blocks];
  const [block] = blocks.splice(i, 1);
  return { layout: { ...layout, blocks }, removed: { block, index: i } };
}

/**
 * Put a removed block back where it was (the «تراجع» of the delete toast).
 * Refused if it no longer fits; if another block took its id meanwhile, it
 * comes back under a fresh one.
 */
export function restoreBlock(layout: StoreLayout, removed: Removed): EditResult {
  const refused = canAdd(layout, removed.block.type);
  if (refused) return { refused };
  const taken = layout.blocks.some((b) => b.id === removed.block.id);
  const block = taken ? ({ ...removed.block, id: newBlockId(layout, removed.block.type) } as StoreBlock) : removed.block;
  const blocks = [...layout.blocks];
  blocks.splice(clampIndex(removed.index, blocks.length), 0, block);
  return { layout: { ...layout, blocks }, id: block.id };
}

function mapBlock(layout: StoreLayout, id: string, fn: (b: StoreBlock) => StoreBlock): StoreLayout {
  let hit = false;
  const blocks = layout.blocks.map((b) => {
    if (b.id !== id) return b;
    const next = fn(b);
    if (next !== b) hit = true;
    return next;
  });
  return hit ? { ...layout, blocks } : layout;
}

export function setHidden(layout: StoreLayout, id: string, hidden: boolean): StoreLayout {
  return mapBlock(layout, id, (b) => ({ ...b, hidden }));
}

export function setVisibility(layout: StoreLayout, id: string, patch: Partial<Visibility>): StoreLayout {
  return mapBlock(layout, id, (b) => ({
    ...b,
    visibility: {
      mobile: typeof patch.mobile === 'boolean' ? patch.mobile : b.visibility.mobile,
      desktop: typeof patch.desktop === 'boolean' ? patch.desktop : b.visibility.desktop,
    },
  }));
}

export function setVariant(layout: StoreLayout, id: string, variant: string): StoreLayout {
  return mapBlock(layout, id, (b) => {
    const def: BlockDef = BLOCKS[b.type];
    return def.variants.includes(variant) ? ({ ...b, variant } as StoreBlock) : b;
  });
}

/**
 * One setting of one block. Only a key the block's registry entry declares is
 * written; the VALUE is checked by `validateLayout` on the next render (and
 * stripped by it before any save) — the form controls only offer values of
 * the declared shape, but the gate does not rely on that.
 */
export function setSetting(layout: StoreLayout, id: string, key: string, value: unknown): StoreLayout {
  return mapBlock(layout, id, (b) => {
    const def: BlockDef = BLOCKS[b.type];
    if (!Object.hasOwn(def.settings, key)) return b;
    return { ...b, settings: { ...(b.settings as Record<string, unknown>), [key]: value } } as StoreBlock;
  });
}

// ------------------------------------------------------------------ page

export function setToken<K extends keyof ThemeTokens>(layout: StoreLayout, key: K, value: ThemeTokens[K]): StoreLayout {
  if (!TOKEN_KEYS.includes(key) || !(TOKEN_VALUES[key] as readonly unknown[]).includes(value)) return layout;
  return { ...layout, tokens: { ...layout.tokens, [key]: value } };
}

/** A preset's tokens; blocks, header and footer untouched (what `applyTheme` does). */
export function setPreset(layout: StoreLayout, theme: ThemeName): StoreLayout {
  return Object.hasOwn(THEME_PRESETS, theme) ? { ...layout, theme, tokens: { ...THEME_PRESETS[theme] } } : layout;
}

/**
 * What the preview's rows depend on: each visible block's type and every
 * setting that is not words, a picture, a switch or a date. When this is
 * unchanged after a save, the preview keeps the rows it has.
 */
export function dataKey(layout: StoreLayout): string {
  return JSON.stringify(
    renderableBlocks(layout).map((b) => {
      const def: BlockDef = BLOCKS[b.type];
      const s = b.settings as unknown as Record<string, unknown>;
      return [b.type, Object.keys(def.settings).filter((k) => !['text', 'media', 'bool', 'date'].includes(def.settings[k].t)).map((k) => s[k])];
    })
  );
}

export function setHeader(layout: StoreLayout, variant: HeaderVariant): StoreLayout {
  return { ...layout, header: { variant } };
}

export function setFooter(layout: StoreLayout, variant: FooterVariant): StoreLayout {
  return { ...layout, footer: { variant } };
}

// -------------------------------------------------------------- validation

export interface FieldIssue extends LayoutIssue {
  /** The setting path inside the block, e.g. `link`, `title.en`, `items[2].q.ar`, or `variant`. */
  field: string;
}

export interface Validation {
  result: NormalizeResult;
  /** What `normalizeLayout` said, by block id then by field. */
  byBlock: Map<string, FieldIssue[]>;
  /** Issues about the page itself (tokens, header, footer, size). */
  page: LayoutIssue[];
  /** Any issue that refuses a save. */
  fatal: boolean;
}

const BLOCK_PATH = /^blocks\[(\d+)\](?:\.(.*))?$/;

/**
 * THE SAME GATE THE SERVER RUNS, run on what the editor holds. The issues are
 * mapped back to the block and the field they are about, for the inspector to
 * show next to the control; `result.layout` is the only thing ever saved.
 */
export function validateLayout(layout: StoreLayout, ownerUserId: string): Validation {
  const result = normalizeLayout(layout, { ownerUserId });
  const byBlock = new Map<string, FieldIssue[]>();
  const page: LayoutIssue[] = [];
  for (const issue of result.issues) {
    const m = BLOCK_PATH.exec(issue.path);
    const block = m ? layout.blocks[Number(m[1])] : undefined;
    if (!m || !block) {
      page.push(issue);
      continue;
    }
    const field = (m[2] ?? '').replace(/^settings\./, '');
    const list = byBlock.get(block.id) ?? [];
    list.push({ ...issue, field });
    byBlock.set(block.id, list);
  }
  return { result, byBlock, page, fatal: !result.ok };
}

/** The issues of one field (and of anything under it: `title` matches `title.en`). */
export function issuesFor(v: Validation, blockId: string, field: string): FieldIssue[] {
  return (v.byBlock.get(blockId) ?? []).filter((i) => i.field === field || i.field.startsWith(`${field}.`) || i.field.startsWith(`${field}[`));
}

// ------------------------------------------------------------------ changes

export interface ChangeSummary {
  theme: boolean;
  tokens: Array<keyof ThemeTokens>;
  header: boolean;
  footer: boolean;
  added: StoreBlock[];
  removed: StoreBlock[];
  /** Kept blocks whose variant, settings, visibility or hidden flag changed. */
  edited: StoreBlock[];
  /** The kept blocks are in a different order. */
  reordered: boolean;
  /** Nothing differs. */
  none: boolean;
}

/** What publishing `next` would change for visitors who now see `live`. */
export function summarizeChanges(live: StoreLayout, next: StoreLayout): ChangeSummary {
  const liveById = new Map(live.blocks.map((b) => [b.id, b]));
  const nextIds = new Set(next.blocks.map((b) => b.id));
  const added = next.blocks.filter((b) => !liveById.has(b.id));
  const removed = live.blocks.filter((b) => !nextIds.has(b.id));
  const edited = next.blocks.filter((b) => {
    const was = liveById.get(b.id);
    return !!was && JSON.stringify(was) !== JSON.stringify(b);
  });
  const keptLive = live.blocks.filter((b) => nextIds.has(b.id)).map((b) => b.id);
  const keptNext = next.blocks.filter((b) => liveById.has(b.id)).map((b) => b.id);
  const reordered = keptLive.join('\u0000') !== keptNext.join('\u0000');
  const tokens = TOKEN_KEYS.filter((k) => live.tokens[k] !== next.tokens[k]);
  const s: ChangeSummary = {
    theme: live.theme !== next.theme,
    tokens,
    header: live.header.variant !== next.header.variant,
    footer: live.footer.variant !== next.footer.variant,
    added,
    removed,
    edited,
    reordered,
    none: false,
  };
  s.none = !s.theme && !tokens.length && !s.header && !s.footer && !added.length && !removed.length && !edited.length && !reordered;
  return s;
}

// ------------------------------------------------------------------ history

export interface History {
  past: StoreLayout[];
  present: StoreLayout;
  future: StoreLayout[];
  /** The last commit's coalescing key: typing into one field is one undo step. */
  lastKey: string | null;
}

export const HISTORY_DEPTH = 60;

export function historyOf(layout: StoreLayout): History {
  return { past: [], present: layout, future: [], lastKey: null };
}

/**
 * Record `next` as the present. With the same `key` as the previous commit
 * (keystrokes into one field), the step is merged into that one.
 */
export function commit(h: History, next: StoreLayout, key: string | null = null): History {
  if (next === h.present) return h;
  if (key && key === h.lastKey) return { ...h, present: next, future: [] };
  const past = [...h.past, h.present].slice(-HISTORY_DEPTH);
  return { past, present: next, future: [], lastKey: key };
}

export function undo(h: History): History {
  if (!h.past.length) return h;
  const past = h.past.slice(0, -1);
  return { past, present: h.past[h.past.length - 1], future: [h.present, ...h.future], lastKey: null };
}

export function redo(h: History): History {
  if (!h.future.length) return h;
  const [present, ...future] = h.future;
  return { past: [...h.past, h.present], present, future, lastKey: null };
}

/** Replace everything (a reload from the server, a template): no undo across it. */
export function reset(layout: StoreLayout): History {
  return historyOf(layout);
}
