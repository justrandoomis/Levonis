/**
 * WHAT OF A PRODUCT IS SEARCHABLE, AND HOW HEAVILY.
 *
 * The one decision here is which text goes in and under which weight, and it
 * is a decision about what a shopper actually types. Two things follow from
 * that, and both are the opposite of "index everything":
 *
 *   THE HASHTAGS ARE AMONG THE BEST SIGNALS IN THIS DATABASE, not an
 *   afterthought. The owner tags products richly — the X2D carries #x2d,
 *   #x2d-combo, #bambu-lab, #dual-nozzle, #ams-2-pro, #multi-material, #fdm,
 *   #3d-printer — which is a hand-written list of the exact words a customer
 *   would search for, already attached to the right product. They are weighted
 *   just below the brand.
 *
 *   THE DESCRIPTION IS WEIGHTED ALMOST TO NOTHING. Half the accessory
 *   catalogue says "compatible with Bambu Lab" somewhere in its copy. At an
 *   equal weight, searching «بامبو» would bury the Bambu printer under every
 *   product that mentions one — the classic failure of a naive index, and the
 *   reason weights exist at all.
 *
 * SECTION AND BRAND NAMES ARE INDEXED ON THE PRODUCT, not joined at query
 * time. «طابعات» is a word about the SECTION, and a shopper typing it means
 * "show me what is in there". Resolving that through a join on every search
 * would cost a read; folding the names in when the product is saved costs
 * nothing at query time and is correct for exactly as long as the names are.
 */

import type { SearchDoc } from './index';

/** Just enough of a product to index it. Everything is optional: a draft row
 *  half-filled in by the admin form must not throw on the way to the index. */
export interface IndexableProduct {
  id: string;
  name?: unknown;
  name_ar?: unknown;
  name_ku?: unknown;
  name_ckb?: unknown;
  description?: unknown;
  hashtags?: unknown;
  sku?: unknown;
  /** Resolved by the caller — the index holds names, not ids. */
  brandName?: string | null;
  categoryNames?: string[];
  /** Option and colour names: "Combo", "Dual nozzle", "Jade White". */
  variantNames?: string[];
}

const text = (v: unknown): string[] => (typeof v === 'string' && v.trim() ? [v] : []);

/** A JSON array column, read defensively — it is user data via the form. */
function list(v: unknown): string[] {
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string' && x.trim() !== '');
  if (typeof v === 'string' && v.startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(v);
      return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
    } catch {
      return [];
    }
  }
  return [];
}

export function toSearchDoc(p: IndexableProduct): SearchDoc {
  return {
    productId: String(p.id),
    fields: {
      // THE NAME IN EVERY LANGUAGE THE SHOP HOLDS IT IN. A product's English
      // name is never translated in this storefront (§3/§12), so the Arabic
      // and Kurdish names are the only place an Arabic-speaking customer's own
      // words for it are written down.
      name: [...text(p.name), ...text(p.name_ar), ...text(p.name_ku), ...text(p.name_ckb), ...text(p.sku)],
      brand: p.brandName ? [p.brandName] : [],
      model: p.variantNames ?? [],
      hashtag: list(p.hashtags),
      category: p.categoryNames ?? [],
      description: text(p.description),
    },
  };
}

/** An array column that holds objects, read defensively: it is the JSON
 *  mirror on `products`, written by the save path and by nothing else. */
function objectList(v: unknown): Record<string, unknown>[] {
  const arr: unknown = Array.isArray(v)
    ? v
    : typeof v === 'string' && v.trim().startsWith('[')
      ? (() => {
          try {
            return JSON.parse(v) as unknown;
          } catch {
            return [];
          }
        })()
      : [];
  return Array.isArray(arr) ? arr.filter((x): x is Record<string, unknown> => !!x && typeof x === 'object') : [];
}

/**
 * The option and colour names of a stored product row — `variantNames` for
 * `toSearchDoc`, read straight out of the `options` / `colors` JSON mirror.
 *
 * WHY THIS EXISTS AT ALL. «كومبو» is an OPTION name on this shop's products,
 * not part of any product's name: "X2D Combo" is a selection under
 * "Bambu Lab X2D". A document built without these finds nothing for it. The
 * product save path had them and the cron backfill did not, so every product
 * the owner had not re-saved since the index landed was unfindable by the one
 * word half of them are sold under. One reader now, used by both.
 *
 * THE LEGACY SPELLINGS ARE READ TOO (`name`, `name_ku`). They are what
 * `upgradeOptions` falls back to for a row written before 0055 named the
 * three languages apart — and a backfill exists precisely for the rows nobody
 * has re-saved since, which are the rows most likely to be in the old shape.
 * Nothing is translated or invented here: only what is written down is
 * indexed.
 */
export function variantNamesFrom(options: unknown, colors: unknown): string[] {
  const out: string[] = [];
  for (const item of [...objectList(options), ...objectList(colors)]) {
    for (const key of ['name_en', 'name_ar', 'name_ckb', 'name', 'name_ku']) {
      const v = item[key];
      if (typeof v === 'string' && v.trim() !== '') out.push(v);
    }
  }
  return out;
}
