/**
 * THE TRANSLATABLE SLOTS OF A PRODUCT DOCUMENT — every place an Arabic or
 * Kurdish copy of an English source lives, keyed exactly as
 * worker/lib/translate/localizeProduct.ts and `product_translations` key
 * them. Shared by the template bookkeeping (which marks what a file
 * authored) and the persistence contract (which keeps authored text through
 * a form save), so the two can never disagree about what a slot is called.
 */

/** One translatable slot of a document: its English source and where the
 *  Arabic and Kurdish copies live. Keys match localizeProductDoc's. */
export interface Slot {
  key: string;
  en: string;
  ar: string;
  ckb: string;
  set: (lang: 'ar' | 'ckb', text: string) => void;
}

const sv = (v: unknown): string => (typeof v === 'string' ? v : '');

/** Every ar/ckb slot of a document (or of a loose merge body of the same
 *  shape), keyed exactly as localizeProductDoc and product_translations key
 *  them. */
export function localizableSlots(d: Record<string, unknown>): Slot[] {
  const out: Slot[] = [];
  const scalar = (key: string, en: string, ar: string, ckb: string) => {
    out.push({
      key,
      en: sv(d[en]),
      ar: sv(d[ar]),
      ckb: sv(d[ckb]),
      set: (lang, text) => {
        d[lang === 'ar' ? ar : ckb] = text;
      },
    });
  };
  const item = (key: string, o: Record<string, unknown>, base: string) => {
    out.push({
      key,
      en: sv(o[`${base}_en`]),
      ar: sv(o[`${base}_ar`]),
      ckb: sv(o[`${base}_ckb`]),
      set: (lang, text) => {
        o[`${base}_${lang}`] = text;
      },
    });
  };
  const list = (v: unknown): Record<string, unknown>[] =>
    Array.isArray(v) ? v.filter((x): x is Record<string, unknown> => !!x && typeof x === 'object') : [];
  scalar('name', 'name_en', 'name_ar', 'name_ckb');
  scalar('description', 'description_en', 'description_ar', 'description_ckb');
  for (const g of list(d.spec_groups)) {
    item(`spec_group:${sv(g.id)}:title`, g, 'title');
    for (const r of list(g.rows)) {
      item(`spec:${sv(g.id)}:${sv(r.id)}:label`, r, 'label');
      item(`spec:${sv(g.id)}:${sv(r.id)}:value`, r, 'value');
    }
  }
  for (const l of list(d.labels)) item(`label:${sv(l.id)}`, l, 'text');
  for (const b of list(d.content_blocks)) {
    item(`block:${sv(b.id)}:body`, b, 'body');
    item(`block:${sv(b.id)}:caption`, b, 'caption');
    item(`block:${sv(b.id)}:alt`, b, 'alt');
  }
  for (const w of list(d.warranty_plans)) {
    item(`warranty:${sv(w.id)}:title`, w, 'title');
    item(`warranty:${sv(w.id)}:terms`, w, 'terms');
  }
  for (const o of list(d.options)) item(`option:${sv(o.id)}:name`, o, 'name');
  for (const c of list(d.colors)) item(`color:${sv(c.id)}:name`, c, 'name');
  return out;
}

