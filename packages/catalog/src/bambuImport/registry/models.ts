/**
 * Bambu Lab model vocabulary (spec §C.1 identity, §C.2 printer groups, §C.6
 * composite-cell scoping, §B.6 relation labels). Names only: which Levonis or
 * manifest product a label points at is the reviewed compat-targets.json's
 * job, never this file's — name similarity never creates a relation.
 */
import { labelKey } from '../normalize';

export type ModelKind = 'printer' | 'printer_family' | 'ams' | 'ams_family' | 'hub' | 'buffer' | 'laser_module' | 'toolhead' | 'spool';

export interface ModelEntry {
  /** The canonical token as Bambu writes it. */
  token: string;
  kind: ModelKind;
  /** Lower-cased match forms (labelKey), longest first at match time. */
  forms: readonly string[];
  /** The series a printer belongs to (identity.series). */
  series?: string;
}

const m = (token: string, kind: ModelKind, forms: string[], series?: string): ModelEntry => ({
  token,
  kind,
  forms: [token, ...forms].map(labelKey),
  series,
});

export const MODELS: readonly ModelEntry[] = [
  m('A1 mini', 'printer', ['A1mini', 'A1-mini'], 'A1 Series'),
  m('A1', 'printer', [], 'A1 Series'),
  m('A2L', 'printer', [], 'A2 Series'),
  m('P1P', 'printer', [], 'P1 Series'),
  m('P1S', 'printer', [], 'P1 Series'),
  m('P2S', 'printer', [], 'P2 Series'),
  m('X1C', 'printer', ['X1 Carbon', 'X1-Carbon'], 'X1 Series'),
  m('X1E', 'printer', [], 'X1 Series'),
  m('X2D', 'printer', [], 'X2 Series'),
  m('H2D Pro', 'printer', [], 'H2 Series'),
  m('H2D', 'printer', [], 'H2 Series'),
  m('H2S', 'printer', [], 'H2 Series'),
  m('H2C', 'printer', [], 'H2 Series'),
  m('A1 Series', 'printer_family', []),
  m('A2 Series', 'printer_family', []),
  m('P1 Series', 'printer_family', []),
  m('P2 Series', 'printer_family', []),
  m('X1 Series', 'printer_family', []),
  m('X2 Series', 'printer_family', []),
  m('H2 Series', 'printer_family', []),
  m('AMS 2 Pro', 'ams', []),
  m('AMS HT', 'ams', []),
  m('AMS lite', 'ams', ['AMS-lite']),
  m('AMS', 'ams', []),
  m('AMS Series', 'ams_family', ['All AMS Series']),
  m('AMS Hub', 'hub', []),
  m('Filament Buffer', 'buffer', []),
  m('Laser Module 10W', 'laser_module', ['10W Laser Module']),
  m('Laser Module 40W', 'laser_module', ['40W Laser Module']),
  m('Reusable Spool', 'spool', ['Bambu Reusable Spool']),
];

const BY_FORM: ReadonlyArray<[string, ModelEntry]> = MODELS.flatMap((e) => e.forms.map((f) => [f, e] as [string, ModelEntry])).sort(
  (a, b) => b[0].length - a[0].length
);

/** The model a whole label names exactly (`A1 mini`, `X1 Series`, `H2D`), or null. */
export function modelOfLabel(label: string): ModelEntry | null {
  const k = labelKey(label);
  for (const [form, e] of BY_FORM) if (form === k) return e;
  return null;
}

/** Every model token named as a whole word inside a text, longest match first, without overlaps. */
export function modelsInText(text: string): ModelEntry[] {
  let k = ` ${labelKey(text)} `;
  const out: ModelEntry[] = [];
  for (const [form, e] of BY_FORM) {
    const needle = ` ${form} `;
    if (k.includes(needle)) {
      if (!out.includes(e)) out.push(e);
      k = k.split(needle).join(' '.repeat(needle.length));
    }
  }
  return out;
}

/** True when every value of a group names a printer or a printer family (a printer-compatibility group). */
export function allPrinterLabels(values: readonly string[]): boolean {
  return values.length > 0 && values.every((v) => {
    const e = modelOfLabel(v);
    return !!e && (e.kind === 'printer' || e.kind === 'printer_family');
  });
}
