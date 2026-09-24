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
import { BLOCKS, type BlockDef, type FieldSpec, type RefKind } from './blocks';
import { normalizeLayout, type LayoutIssue, type NormalizeOptions } from './normalize';
import { NO_LINK, type LinkTarget, type MediaKind } from './refs';
import type { StoreLayout } from './schema';

export interface LayoutRefs {
  media: Array<{ key: string; kind: MediaKind }>;
  product: string[];
  collection: string[];
  coupon: string[];
}

export interface RefRejects {
  /** Media keys that are not this owner's live uploads of the right kind. */
  media?: ReadonlySet<string>;
  product?: ReadonlySet<string>;
  collection?: ReadonlySet<string>;
  coupon?: ReadonlySet<string>;
}

type Visit = {
  media(key: string, kind: MediaKind, path: string): boolean;
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
        if (typeof v === 'string' && v && !visit.media(v, spec.kind, at)) values[key] = '';
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

function walk(layout: StoreLayout, visit: Visit): StoreLayout {
  const copy = JSON.parse(JSON.stringify(layout)) as StoreLayout;
  copy.blocks.forEach((block, i) => {
    const def: BlockDef = BLOCKS[block.type];
    walkFields(def.settings, block.settings as unknown as Record<string, unknown>, `blocks[${i}].settings`, visit);
  });
  return copy;
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
 * was removed (`media_not_found`, `unknown_ref`) — then normalised again with
 * the same owner, whose own issues are appended.
 */
export function dropLayoutRefs(
  layout: StoreLayout,
  reject: RefRejects,
  opts: NormalizeOptions
): { layout: StoreLayout; issues: LayoutIssue[] } {
  const issues: LayoutIssue[] = [];
  const stripped = walk(layout, {
    media(key, _kind, path) {
      if (!reject.media?.has(key)) return true;
      issues.push({ path, code: 'media_not_found', fatal: false });
      return false;
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
