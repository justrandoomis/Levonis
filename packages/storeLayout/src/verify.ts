/**
 * THE REFERENCES A LAYOUT MAKES, SO THE SERVER CAN CHECK THEM AGAINST THE
 * STORE'S OWN ROWS.
 *
 * `normalizeLayout` proves a layout is WELL-FORMED: ids have the id shape,
 * media keys live under the owner's prefix. Whether product `p_123` is one of
 * THIS store's products, or the key names a file that was really uploaded, is
 * a database question — the Worker asks it (worker/lib/storeLayout.ts) with
 * one set-based query per kind, using the list `collectLayoutRefs` produces,
 * and hands back what failed. `dropLayoutRefs` removes exactly those, with an
 * issue at each place, and re-normalises so cross-field rules still hold (a
 * grid whose collection is gone falls back to «latest»; a gallery picture
 * whose file is gone drops its item).
 *
 * Pure, so the builder can run the same walk over its draft.
 */
import { BACKGROUND_MEDIA, BLOCKS, FOOTER_LINKS_SPEC, HEADER_FIELDS, type BlockDef, type FieldSpec, type RefKind } from './blocks';
import { normalizeLayout, type LayoutIssue, type NormalizeOptions } from './normalize';
import { NO_LINK, type LinkTarget, type MediaKind } from './refs';
import type { StoreLayout } from './schema';

export { renderableBlocks, scheduledNow, type RenderMode } from './normalize';

export interface LayoutRefs {
  media: Array<{ key: string; kind: MediaKind }>;
  product: string[];
  collection: string[];
  coupon: string[];
}

export interface RefRejects {
  /** Media keys that are not this owner's live uploads of the right kind. */
  media?: ReadonlySet<string>;
  /**
   * The ledger's `byte_size` per media key (storefront L5). A key heavier
   * than the slot it sits in is dropped there with `media_too_heavy`; a key
   * this map does not name (a legacy upload without a ledger row) is never
   * too heavy.
   */
  bytes?: ReadonlyMap<string, number>;
  product?: ReadonlySet<string>;
  collection?: ReadonlySet<string>;
  coupon?: ReadonlySet<string>;
}

type Visit = {
  /** `maxBytes` is the slot's cap, when it has one. */
  media(key: string, kind: MediaKind, path: string, maxBytes: number | undefined): boolean;
  ref(kind: RefKind, id: string, path: string): boolean;
};

/** Walk one settings object; a visitor returning false blanks the value. */
function walkFields(specs: { readonly [k: string]: FieldSpec }, values: Record<string, unknown>, path: string, visit: Visit) {
  for (const key of Object.keys(specs)) {
    const spec = specs[key];
    const at = `${path}.${key}`;
    const v = values[key];
    switch (spec.t) {
      case 'media':
        if (typeof v === 'string' && v && !visit.media(v, spec.kind, at, spec.max_bytes)) values[key] = '';
        break;
      case 'ref':
        if (typeof v === 'string' && v && !visit.ref(spec.ref, v, at)) values[key] = '';
        break;
      case 'refs':
        if (Array.isArray(v)) values[key] = v.filter((id, i) => typeof id === 'string' && visit.ref(spec.ref, id, `${at}[${i}]`));
        break;
      case 'link': {
        const link = v as LinkTarget | undefined;
        if (link && (link.kind === 'product' || link.kind === 'collection') && !visit.ref(link.kind, link.id, at)) values[key] = { ...NO_LINK };
        break;
      }
      case 'list':
        if (Array.isArray(v)) v.forEach((item, i) => walkFields(spec.item, item as Record<string, unknown>, `${at}[${i}]`, visit));
        break;
      default:
        break;
    }
  }
}

/**
 * The whole page: the header's notice link, the footer links, the background's
 * two media slots (by the background's kind — storefront L4), then every block.
 */
function walk(layout: StoreLayout, visit: Visit): StoreLayout {
  const copy = JSON.parse(JSON.stringify(layout)) as StoreLayout;
  walkFields(HEADER_FIELDS, copy.header as unknown as Record<string, unknown>, 'header', visit);
  walkFields({ links: FOOTER_LINKS_SPEC }, copy.footer as unknown as Record<string, unknown>, 'footer', visit);
  const bg = copy.background;
  if (bg && bg.kind !== 'none') {
    const slot = bg.kind === 'video' ? BACKGROUND_MEDIA.video : BACKGROUND_MEDIA.image;
    if (bg.media && !visit.media(bg.media, slot.kind, 'background.media', slot.max_bytes)) bg.media = '';
    if (bg.poster && !visit.media(bg.poster, 'image', 'background.poster', BACKGROUND_MEDIA.poster.max_bytes)) bg.poster = '';
  }
  copy.blocks.forEach((block, i) => {
    const def: BlockDef = BLOCKS[block.type];
    walkFields(def.settings, block.settings as unknown as Record<string, unknown>, `blocks[${i}].settings`, visit);
  });
  return copy;
}

/** One media reference and the slot it sits in. */
export interface MediaSlot {
  key: string;
  kind: MediaKind;
  /** e.g. `blocks[2].settings.image`, `background.media`. */
  path: string;
  /** The block's id, or the page slot (`header`, `footer`, `background`). */
  block_id: string;
  max_bytes?: number;
}

const BLOCK_AT = /^blocks\[(\d+)\]/;

/** Every media reference a (normalised) layout makes, slot by slot — a key once per slot it sits in. */
export function mediaSlots(layout: StoreLayout): MediaSlot[] {
  const out: MediaSlot[] = [];
  walk(layout, {
    media(key, kind, path, maxBytes) {
      const m = BLOCK_AT.exec(path);
      const block_id = m ? layout.blocks[Number(m[1])]?.id ?? path : path.split('.')[0];
      out.push({ key, kind, path, block_id, ...(maxBytes ? { max_bytes: maxBytes } : {}) });
      return true;
    },
    ref: () => true,
  });
  return out;
}

/** A slot whose key the ledger says is heavier than the slot allows (storefront L5). */
export interface HeavyMedia extends MediaSlot {
  size: number;
  max: number;
}

/** The slots `dropLayoutRefs` would empty as `media_too_heavy`, with the figures the refusal names. */
export function heavyMedia(layout: StoreLayout, bytes: ReadonlyMap<string, number>): HeavyMedia[] {
  const out: HeavyMedia[] = [];
  for (const slot of mediaSlots(layout)) {
    const size = bytes.get(slot.key);
    if (slot.max_bytes && size !== undefined && size > slot.max_bytes) out.push({ ...slot, size, max: slot.max_bytes });
  }
  return out;
}

/**
 * THE POSTER RULE (storefront L3/L4): a hero video and a background video each
 * need their still — it is what phones, reduced motion and the first paint
 * show. Returns the path of every poster slot that is empty beside a video;
 * publishing with any is refused (LAYOUT_POSTER_REQUIRED). The video BLOCK
 * keeps its poster optional, as it always was.
 */
export function missingPosters(layout: StoreLayout): string[] {
  const out: string[] = [];
  const bg = layout.background;
  if (bg && bg.kind === 'video' && bg.media && !bg.poster) out.push('background.poster');
  layout.blocks.forEach((b, i) => {
    if (b.type === 'hero' && b.settings.video && !b.settings.image) out.push(`blocks[${i}].settings.image`);
  });
  return out;
}

/** Every reference a (normalised) layout makes, each value once. */
export function collectLayoutRefs(layout: StoreLayout): LayoutRefs {
  const refs: LayoutRefs = { media: [], product: [], collection: [], coupon: [] };
  walk(layout, {
    media(key, kind) {
      if (!refs.media.some((m) => m.key === key && m.kind === kind)) refs.media.push({ key, kind });
      return true;
    },
    ref(kind, id) {
      if (!refs[kind].includes(id)) refs[kind].push(id);
      return true;
    },
  });
  return refs;
}

/**
 * The layout without the rejected references, and an issue for each place one
 * was removed (`media_not_found`, `media_too_heavy`, `unknown_ref`) — then
 * normalised again with the same owner, whose own issues are appended.
 */
export function dropLayoutRefs(
  layout: StoreLayout,
  reject: RefRejects,
  opts: NormalizeOptions
): { layout: StoreLayout; issues: LayoutIssue[] } {
  const issues: LayoutIssue[] = [];
  const stripped = walk(layout, {
    media(key, _kind, path, maxBytes) {
      if (reject.media?.has(key)) {
        issues.push({ path, code: 'media_not_found', fatal: false });
        return false;
      }
      const size = reject.bytes?.get(key);
      if (maxBytes && size !== undefined && size > maxBytes) {
        issues.push({ path, code: 'media_too_heavy', fatal: false });
        return false;
      }
      return true;
    },
    ref(kind, id, path) {
      if (!reject[kind]?.has(id)) return true;
      issues.push({ path, code: 'unknown_ref', fatal: false });
      return false;
    },
  });
  if (!issues.length) return { layout, issues };
  const again = normalizeLayout(stripped, opts);
  return { layout: again.layout, issues: [...issues, ...again.issues] };
}
