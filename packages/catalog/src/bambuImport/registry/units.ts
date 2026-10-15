/**
 * Units (spec §B.7, §C.6): the forms the store writes, normalised to the unit
 * a key stores. Lengths are stored in mm, masses in g; everything else keeps
 * its published unit in canonical spelling.
 */

export interface UnitDef {
  /** Canonical spelling stored in product_spec_values.unit. */
  unit: string;
  /** Multiply by this to reach `base` (mm for lengths, g for masses), when convertible. */
  factor?: number;
  base?: 'mm' | 'g';
}

const U: ReadonlyArray<[RegExp, UnitDef]> = [
  [/^(mm³|mm3|mm\^3|mm)$/i, { unit: 'mm', factor: 1, base: 'mm' }],
  [/^cm$/i, { unit: 'mm', factor: 10, base: 'mm' }],
  [/^m$/, { unit: 'mm', factor: 1000, base: 'mm' }],
  [/^(in|inch|inches|")$/i, { unit: 'mm', factor: 25.4, base: 'mm' }],
  [/^(μm|µm|um)$/i, { unit: 'μm' }],
  [/^(kg|kgs)$/i, { unit: 'g', factor: 1000, base: 'g' }],
  [/^(g|gr|gram|grams)$/i, { unit: 'g', factor: 1, base: 'g' }],
  [/^(lb|lbs)$/i, { unit: 'g', factor: 453.59237, base: 'g' }],
  [/^(°c|℃|ºc|c°|degc)$/i, { unit: '°C' }],
  [/^(mm\/s²|mm\/s2|mm\/s\^2)$/i, { unit: 'mm/s²' }],
  [/^mm\/s$/i, { unit: 'mm/s' }],
  [/^(mm³\/s|mm3\/s)$/i, { unit: 'mm³/s' }],
  [/^(w|watt|watts)$/i, { unit: 'W' }],
  [/^kw$/i, { unit: 'kW' }],
  [/^(v|vac|vdc|volt|volts)$/i, { unit: 'V' }],
  [/^(a|amp|amps)$/i, { unit: 'A' }],
  [/^ma$/i, { unit: 'mA' }],
  [/^mah$/i, { unit: 'mAh' }],
  [/^hz$/i, { unit: 'Hz' }],
  [/^mpa$/i, { unit: 'MPa' }],
  [/^gpa$/i, { unit: 'GPa' }],
  [/^(kj\/m²|kj\/m2)$/i, { unit: 'kJ/m²' }],
  [/^(g\/cm³|g\/cm3)$/i, { unit: 'g/cm³' }],
  [/^%$/, { unit: '%' }],
  [/^(h|hr|hrs|hour|hours)$/i, { unit: 'h' }],
  [/^(min|mins|minute|minutes)$/i, { unit: 'min' }],
  [/^(s|sec|secs|second|seconds)$/i, { unit: 's' }],
  [/^db$/i, { unit: 'dB' }],
  [/^(fps)$/i, { unit: 'fps' }],
  [/^(nm)$/i, { unit: 'nm' }],
];

/** The canonical unit definition of a written unit, or null. */
export function unitOf(written: string): UnitDef | null {
  const w = written.trim().replace(/\s+/g, '');
  for (const [re, def] of U) if (re.test(w)) return def;
  return null;
}

/** A written unit token, as the value parsers find it after a number. */
export const UNIT_TOKEN =
  /(mm³\/s|mm3\/s|mm\/s²|mm\/s2|mm\/s|kJ\/m²|kJ\/m2|g\/cm³|g\/cm3|mm³|mm3|mm|cm|μm|µm|kg|lbs|lb|mAh|mA|°C|℃|ºC|MPa|GPa|kW|VAC|VDC|W|V|A|Hz|dB|fps|nm|%|g|in|m|h|min|s)(?![A-Za-z])/;

/** Converts a value written in `written` to its stored unit (mm, g, or the canonical unit). */
export function toStored(value: number, written: string): { value: number; unit: string } | null {
  const def = unitOf(written);
  if (!def) return null;
  if (def.factor && def.base) return { value: round(value * def.factor), unit: def.base };
  return { value, unit: def.unit };
}

export function round(n: number, digits = 4): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}
