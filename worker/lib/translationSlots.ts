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
  /**
   * 0079 — a slot whose ENGLISH SOURCE IS THE BARE KEY, not `<base>_en`.
   * `how_to_use`, a usage step's `title`/`body` and every `lead_time_text`
   * were written as one column long before the three-language shape existed,
   * so the source keeps its own name and only the two translations are
   * suffixed. Same contract as `item` otherwise.
   */
  const bare = (key: string, o: Record<string, unknown>, base: string) => {
    out.push({
      key,
      en: sv(o[base]),
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
  // 0079. The plain-text «طريقة الاستخدام» — translated on every save since the
  // engine existed, and discarded on every save until it had these columns.
  scalar('how_to_use', 'how_to_use', 'how_to_use_ar', 'how_to_use_ckb');
  // …and the structured guide beside it, one slot per step per field.
  const guide = d.usage_guide;
  if (guide && typeof guide === 'object' && !Array.isArray(guide)) {
    for (const st of list((guide as Record<string, unknown>).steps)) {
      bare(`usage_step:${sv(st.id)}:title`, st, 'title');
      bare(`usage_step:${sv(st.id)}:body`, st, 'body');
    }
  }
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
  /**
   * 0079 — «مدة التجهيز» at all three rungs of the 0073 ladder: the model's own
   * sentence, its pre-order cell's, and one per route. The key is NOT prefixed
   * `option:` on purpose — that prefix marks the English-only names §7 forbids
   * translating, and these are the opposite: prose that only a human can put
   * into Arabic and Kurdish.
   */
  for (const o of list(d.options)) {
    const oid = sv(o.id);
    bare(`lead_time:${oid}`, o, 'lead_time_text');
    for (const fCell of list(o.fulfillments)) {
      const type = sv(fCell.fulfillment_type) || 'direct_sale';
      bare(`lead_time:${oid}:${type}`, fCell, 'lead_time_text');
      for (const t of list(fCell.transports)) {
        bare(`lead_time:${oid}:${type}:${sv(t.method)}`, t, 'lead_time_text');
      }
    }
  }
  for (const c of list(d.colors)) item(`color:${sv(c.id)}:name`, c, 'name');
  return out;
}

