/**
 * Variant + quantity rows — what a print consumed, what a failure wasted,
 * what a failure is billed. Quantities are whole units of the variant's base
 * unit (grams for a filament), as the server counts them.
 */
import { tri } from '../../i18n';
import type { RefLists } from '../../refs';
import { IntField, SelectField, T, usePcLang } from '../../ui';

const S = {
  variant: tri('الصنف', 'Variant', 'جۆر'),
  qty: tri('الكمية', 'Quantity', 'بڕ'),
  add: tri('إضافة مادة', 'Add a material', 'زیادکردنی کەرەستە'),
  remove: tri('حذف', 'Remove', 'سڕینەوە'),
};

export interface MatLine {
  variant_id: string;
  qty: number | null;
}

export function MaterialLines({ lines, onChange, refs, label, qtyLabel }: { lines: MatLine[]; onChange: (l: MatLine[]) => void; refs: RefLists; label: string; qtyLabel?: string }) {
  const { t } = usePcLang();
  return (
    <fieldset className="space-y-2">
      <legend className={`text-[12px] font-semibold ${T.text2}`}>{label}</legend>
      {lines.map((l, i) => (
        <div key={i} className="flex flex-wrap items-end gap-2">
          <SelectField
            className="min-w-[12rem] flex-1"
            label={t(S.variant)}
            value={l.variant_id}
            placeholder="—"
            options={refs.options('variants')}
            onChange={(v) => onChange(lines.map((x, j) => (j === i ? { ...x, variant_id: v } : x)))}
          />
          <IntField
            className="w-40"
            label={qtyLabel ?? t(S.qty)}
            unit={String(refs.row('variants', l.variant_id)?.unit_code ?? '') || undefined}
            value={l.qty}
            onChange={(v) => onChange(lines.map((x, j) => (j === i ? { ...x, qty: v } : x)))}
          />
          <button type="button" className={T.btnGhostSm} onClick={() => onChange(lines.filter((_, j) => j !== i))}>
            {t(S.remove)}
          </button>
        </div>
      ))}
      <button type="button" className={T.btnGhostSm} onClick={() => onChange([...lines, { variant_id: '', qty: null }])}>
        {t(S.add)}
      </button>
    </fieldset>
  );
}

/** The filled rows, as the server takes them. */
export const cleanLines = (lines: MatLine[]) => lines.filter((l) => l.variant_id && l.qty !== null).map((l) => ({ variant_id: l.variant_id, qty: l.qty as number }));
