/**
 * «أي طابعة هذه؟» — TIE A PRINTER TO ITS CANONICAL MACHINE (stream W5-B).
 *
 * Picking a machine from the list fills its PHYSICS from the manufacturer's
 * specification (`printer_models`: technology, build volume, enclosure, the
 * nozzles it takes, whether a hardened nozzle or a multi-material unit can be
 * fitted) and the server keeps them — a merchant cannot widen what the
 * matcher believes by typing a bigger bed. «غير مدرجة» keeps the typed
 * physics, shown as self-declared.
 */
import { useId } from 'react';
import { useLanguage } from '../../../LanguageContext';
import { Select } from '../../ui/Field';
import type { PrinterModelOption } from './api';

export default function PrinterModelPicker({
  models,
  value,
  onPick,
}: {
  models: PrinterModelOption[];
  value: string | null;
  onPick: (model: PrinterModelOption | null) => void;
}) {
  const { loc } = useLanguage();
  const id = useId();
  const picked = models.find((m) => m.id === value) ?? null;
  const groups: Array<['fdm' | 'resin', string]> = [
    ['fdm', 'FDM'],
    ['resin', loc('ريزن', 'Resin')],
  ];
  return (
    <div data-printer-model>
      <label htmlFor={id} className="mb-1.5 block text-[12px] font-semibold text-zinc-400">
        {loc('الطابعة', 'Which printer')}
      </label>
      <Select id={id} value={value ?? ''} onChange={(e) => onPick(models.find((m) => m.id === e.target.value) ?? null)} data-printer-model-select>
        <option value="">{loc('طابعة غير مدرجة — أُدخل مواصفاتها بنفسي', 'Not listed — I will enter its specs')}</option>
        {groups.map(([tech, label]) => (
          <optgroup key={tech} label={label}>
            {models
              .filter((m) => m.technology === tech)
              .map((m) => (
                <option key={m.id} value={m.id}>
                  {m.manufacturer} {m.model}
                </option>
              ))}
          </optgroup>
        ))}
      </Select>
      <p className="mt-1.5 text-[11px] leading-relaxed text-zinc-500">
        {picked
          ? loc(
              `المواصفات من الشركة المصنّعة: ${picked.build_mm.x} × ${picked.build_mm.y} × ${picked.build_mm.z} مم${picked.enclosed ? '، حجرة مغلقة' : ''}. تُطابَق الطلبات عليها ولا تُعدَّل يدويًا.`,
              `Specs from the manufacturer: ${picked.build_mm.x} × ${picked.build_mm.y} × ${picked.build_mm.z} mm${picked.enclosed ? ', enclosed' : ''}. Requests are matched against them; they are not edited by hand.`
            )
          : loc(
              'طابعة من القائمة تُطابَق بمواصفاتها الحقيقية. طابعة غير مدرجة تُطابَق بالمواصفات التي تدخلها أنت.',
              'A listed printer is matched on its real specs. An unlisted one is matched on the specs you enter.'
            )}
      </p>
    </div>
  );
}
