/**
 * Option group label → canonical group (spec §C.2), by exact or pattern match
 * on the source's `propertyKey` and the shape of its values. The original
 * wording is always kept in product_option_source_refs.source_label.
 */
import { allPrinterLabels } from './models';
import { tri, type Tri } from './labels';
import { labelKey } from '../normalize';

/** product_option_groups.kind (0194's CHECK list). */
export type GroupKind = '' | 'color' | 'spool' | 'printer' | 'version' | 'size' | 'nozzle' | 'plate' | 'units' | 'pack' | 'item' | 'other';

export interface CanonicalGroup {
  canonical: string;
  kind: GroupKind;
  label: Tri;
}

export const CANONICAL_GROUPS: Readonly<Record<string, CanonicalGroup>> = {
  color: { canonical: 'color', kind: 'color', label: tri('اللون', 'Colour', 'ڕەنگ') },
  spool: { canonical: 'spool', kind: 'spool', label: tri('البكرة', 'Spool', 'ماسوورە') },
  net_weight: { canonical: 'net_weight', kind: 'pack', label: tri('الوزن الصافي', 'Net weight', 'کێشی پوخت') },
  printer: { canonical: 'printer', kind: 'printer', label: tri('الطابعة', 'Printer', 'چاپکەر') },
  version: { canonical: 'version', kind: 'version', label: tri('الإصدار', 'Version', 'وەشان') },
  units: { canonical: 'units', kind: 'units', label: tri('عدد الوحدات', 'Units', 'ژمارەی یەکە') },
  nozzle: { canonical: 'nozzle', kind: 'nozzle', label: tri('النوزل', 'Nozzle', 'نۆزڵ') },
  size: { canonical: 'size', kind: 'size', label: tri('المقاس', 'Size', 'قەبارە') },
  plate_type: { canonical: 'plate_type', kind: 'plate', label: tri('نوع الصفيحة', 'Plate type', 'جۆری پلێت') },
  item: { canonical: 'item', kind: 'item', label: tri('القطعة', 'Item', 'پارچە') },
  combo_type: { canonical: 'combo_type', kind: 'other', label: tri('نوع المجموعة', 'Combo type', 'جۆری کۆمبۆ') },
  option: { canonical: 'option', kind: 'other', label: tri('الخيار', 'Option', 'هەڵبژاردە') },
  pack: { canonical: 'pack', kind: 'pack', label: tri('الحزمة', 'Pack', 'پاکێت') },
  type: { canonical: 'type', kind: 'other', label: tri('النوع', 'Type', 'جۆر') },
  compatibility: { canonical: 'compatibility', kind: 'other', label: tri('التوافق', 'Compatibility', 'گونجاوی') },
};

/** Spool-type value words (a `Type` group made only of these is the spool group). */
export const SPOOL_WORDS: ReadonlySet<string> = new Set(
  ['Refill', 'Spool', 'With Spool', 'Filament with spool', 'Filament with Spool', 'Without Spool', 'Refill (No Spool)', 'Refill Only', 'Spool + Refill', 'With spool', 'Refill + Spool'].map(labelKey)
);

const WEIGHT_VALUE = /^\s*\d+(?:\.\d+)?\s*(?:kg|g)\s*$/i;
const NOZZLE_VALUE = /\b\d(?:\.\d+)?\s*mm\b.*\b(?:steel|brass|hardened|stainless|tungsten|carbide|high[\s-]?flow|nozzle|hotend|copper)\b|\b(?:hardened|stainless)\s+steel\b.*\b\d(?:\.\d+)?\s*mm\b/i;

export interface GroupInput {
  propertyKey: string;
  type: number;
  title: string;
  values: ReadonlyArray<{ value: string; colorUrl: string }>;
}

export interface GroupClass {
  /** The canonical entry, or null when the label is not in the registry (kind 'other', English label kept). */
  group: CanonicalGroup | null;
  kind: GroupKind;
}

/** The canonical group of a source option group (first rule that matches). */
export function classifyGroup(g: GroupInput): GroupClass {
  const key = labelKey(g.propertyKey);
  const values = g.values.map((v) => v.value);
  const hit = (c: string): GroupClass => ({ group: CANONICAL_GROUPS[c], kind: CANONICAL_GROUPS[c].kind });
  if (/^colou?rs?$/.test(key) || (g.values.length > 0 && g.values.some((v) => !!v.colorUrl))) return hit('color');
  if (/^(type|spool type|spool)$/.test(key) && values.length > 0 && values.every((v) => SPOOL_WORDS.has(labelKey(v)))) return hit('spool');
  if (/^(size|weight|net weight)$/.test(key) && values.length > 0 && values.every((v) => WEIGHT_VALUE.test(v))) return hit('net_weight');
  if (/^printer model$|^printer$|^select the type of printer|^compatible printer|^printer type$/.test(key)) return hit('printer');
  if (/^compatibility$|^compatible with$/.test(key) && allPrinterLabels(values)) return hit('printer');
  if (g.type === 4 || /^variant$|^version$|^model$/.test(key)) return hit('version');
  if (/^how many .*unit/.test(key) || /^units?$|^quantity$/.test(key)) return hit('units');
  if (/^(size|nozzle|nozzle size|nozzle diameter|diameter)$/.test(key) && values.length > 0 && values.every((v) => NOZZLE_VALUE.test(v))) return hit('nozzle');
  if (/^size$|^dimensions?$|^thickness$|^length$/.test(key)) return hit('size');
  if (/plate/.test(key)) return hit('plate_type');
  if (/^items?$/.test(key)) return hit('item');
  if (/^combo type$|^combo$|^bundle$/.test(key)) return hit('combo_type');
  if (/^options?$/.test(key)) return hit('option');
  if (/^pack$|^pack size$|^package$|^packs?$/.test(key)) return hit('pack');
  if (/^type$|^types$/.test(key)) return hit('type');
  if (/^compatibility$|^compatible with$/.test(key)) return hit('compatibility');
  return { group: null, kind: 'other' };
}
