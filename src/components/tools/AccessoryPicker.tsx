/**
 * «أضف مواد من إكسسوارات ميكر وورد مثل المغناطيس ومحرك وميدالية» — THE BILL OF
 * MATERIALS, TYPED IN.
 *
 * A MakerWorld listing says, in words on the page, "6× magnet 6×3 mm, 1× LED,
 * 20 cm wire". Nothing in the STL says it — no measurement of geometry can —
 * so this is where that sentence becomes money. The counts are ASKED FOR, and
 * that is the whole design rather than a shortcut.
 *
 * ---------------------------------------------------------------------------
 * NO ARITHMETIC ON MONEY IN THIS FILE, AND THAT IS NOT A STYLE RULE.
 *
 * It is one line of code to multiply a count by a price in a component, and the
 * moment that line exists the shop has two prices for one job: the one the
 * customer was shown and the one the engine charged. The per-piece figure below
 * is rendered as a LABEL on the option, exactly as the server sent it; every
 * total on the screen comes back from `priceJob`. The same rule the panel
 * around it already follows, for the same reason.
 *
 * ---------------------------------------------------------------------------
 * THE UNIT IS PART OF THE QUESTION.
 *
 * Wire is sold per centimetre and magnets per piece, so a bare number box
 * beside «سلك 22AWG» asks something the customer cannot answer: is 20 twenty
 * pieces or twenty centimetres? Every row prints its own unit beside the box.
 *
 * LANGUAGE. `loc(ar, en, ckb)` throughout, never `dir === 'rtl' ? ar : en` —
 * Sorani is right-to-left too, and that idiom serves Arabic to every Kurdish
 * reader while looking correct.
 */
import { useMemo, useState } from 'react';
import { ChevronDown, Package, Plus, Trash2 } from 'lucide-react';
import { useLanguage } from '../../LanguageContext';
import { formatIqd } from '../../lib/api';

export type AccessoryUnit = 'piece' | 'pair' | 'set' | 'cm' | 'gram';

export interface AccessoryOption {
  id: string;
  name_ar: string;
  name_en: string;
  name_ckb: string;
  unit: AccessoryUnit;
  category: 'magnet' | 'motion' | 'electronics' | 'fastener' | 'finishing';
  cost_iqd: number;
}

export interface AccessoryRow {
  /** Stable across re-orders, so removing the first row does not re-key the
   *  rest into each other's inputs. Same reason the grams rows carry one. */
  key: string;
  id: string;
  /** The RAW STRING the customer typed. A number state turns a half-typed
   *  value into 0 and fights the person editing it. */
  qty: string;
}

export const emptyAccessoryRow = (): AccessoryRow => ({
  key: Math.random().toString(36).slice(2),
  id: '',
  qty: '',
});

/** What the request body carries: only complete rows, counts as integers. */
export function accessoryPayload(rows: readonly AccessoryRow[]): Array<{ id: string; qty: number }> {
  return rows
    .map((r) => ({ id: r.id, qty: Math.floor(Number(r.qty)) }))
    .filter((r) => r.id !== '' && Number.isFinite(r.qty) && r.qty > 0);
}

const CATEGORY_ORDER: AccessoryOption['category'][] = [
  'magnet',
  'motion',
  'electronics',
  'fastener',
  'finishing',
];

export default function AccessoryPicker({
  options,
  rows,
  onChange,
  disabled,
}: {
  options: readonly AccessoryOption[];
  rows: readonly AccessoryRow[];
  onChange: (rows: AccessoryRow[]) => void;
  disabled?: boolean;
}) {
  const { loc } = useLanguage();
  // Closed by default. Most jobs have no hardware at all, and a section that
  // opens itself asks every customer a question that only some of them have.
  const [open, setOpen] = useState(rows.length > 0);

  const name = (o: AccessoryOption) => loc(o.name_ar, o.name_en, o.name_ckb);
  const unitLabel = (u: AccessoryUnit) =>
    u === 'cm' ? loc('سم', 'cm', 'سم')
    : u === 'gram' ? loc('غم', 'g', 'گم')
    : u === 'pair' ? loc('زوج', 'pair', 'جووت')
    : u === 'set' ? loc('طقم', 'set', 'سێت')
    : loc('قطعة', 'pc', 'دانە');

  const groups = useMemo(() => {
    const label: Record<AccessoryOption['category'], string> = {
      magnet: loc('مغناطيس', 'Magnets', 'ماگنێت'),
      motion: loc('حركة ومحركات', 'Motion & motors', 'جووڵە و مۆتۆر'),
      electronics: loc('إلكترونيات وإضاءة', 'Electronics & light', 'ئەلیکترۆنیک و ڕووناکی'),
      fastener: loc('براغي وتثبيت', 'Fasteners', 'برغی و بەستن'),
      finishing: loc('تشطيب وتعليق', 'Finishing', 'تەواوکاری'),
    };
    return CATEGORY_ORDER.map((c) => ({
      category: c,
      label: label[c],
      items: options.filter((o) => o.category === c),
    })).filter((g) => g.items.length > 0);
  }, [options, loc]);

  if (options.length === 0) return null;

  const set = (key: string, patch: Partial<AccessoryRow>) =>
    onChange(rows.map((r) => (r.key === key ? { ...r, ...patch } : r)));

  return (
    <section className="rounded-xl border border-zinc-800 bg-zinc-900/40">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex min-h-[44px] w-full items-center gap-2 px-3 py-2.5 text-start"
      >
        <Package aria-hidden="true" className="h-4 w-4 shrink-0 text-zinc-400" />
        <span className="flex-1 text-[13px] font-semibold leading-5 text-zinc-100">
          {loc('إضافات وقطع (مغناطيس، محرك، ليد…)', 'Add-on hardware (magnets, motor, LED…)', 'پێداویستی زیادە (ماگنێت، مۆتۆر، LED…)')}
        </span>
        {rows.length > 0 ? (
          <span className="rounded-full bg-zinc-800 px-2 py-0.5 text-[11px] font-bold text-zinc-300">
            {rows.length}
          </span>
        ) : null}
        <ChevronDown
          aria-hidden="true"
          className={`h-4 w-4 shrink-0 text-zinc-500 transition-transform ${open ? 'rotate-180' : ''}`}
        />
      </button>

      {open ? (
        <div className="flex flex-col gap-2.5 border-t border-zinc-800 p-3">
          <p className="text-[11.5px] leading-5 text-zinc-500">
            {loc(
              'إذا كان الموديل يحتاج قطعًا مثل المغناطيس أو محرك أو ليد، أضفها هنا بعددها لكل قطعة مطبوعة — وتُحسب ضمن السعر النهائي.',
              'If the model calls for hardware — magnets, a motor, an LED — add it here with the count PER PRINTED PART. It is priced into the final figure.',
              'ئەگەر مۆدێلەکە پێویستی بە پارچە هەیە وەک ماگنێت یان مۆتۆر یان LED، لێرە زیادی بکە بە ژمارەی هەر پارچەیەک.'
            )}
          </p>

          {rows.map((r) => {
            const chosen = options.find((o) => o.id === r.id);
            return (
              <div key={r.key} className="flex items-center gap-2">
                <select
                  value={r.id}
                  disabled={disabled}
                  onChange={(e) => set(r.key, { id: e.target.value })}
                  aria-label={loc('القطعة', 'Part', 'پارچە')}
                  className="min-h-[44px] min-w-0 flex-1 rounded-lg border border-zinc-700 bg-zinc-900 px-2 text-[13px] text-zinc-100"
                >
                  <option value="">{loc('اختر قطعة…', 'Choose a part…', 'پارچەیەک هەڵبژێرە…')}</option>
                  {groups.map((g) => (
                    <optgroup key={g.category} label={g.label}>
                      {g.items.map((o) => (
                        <option key={o.id} value={o.id}>
                          {`${name(o)} — ${formatIqd(o.cost_iqd)}/${unitLabel(o.unit)}`}
                        </option>
                      ))}
                    </optgroup>
                  ))}
                </select>

                <div className="flex items-center gap-1">
                  <input
                    // `inputMode="numeric"` and not `type="number"`: the spinner
                    // is useless on a phone and the number type silently drops
                    // what it cannot parse while the person is still typing.
                    inputMode="numeric"
                    value={r.qty}
                    disabled={disabled}
                    onChange={(e) => set(r.key, { qty: e.target.value.replace(/[^\d]/g, '').slice(0, 4) })}
                    placeholder="0"
                    aria-label={loc('العدد', 'Count', 'ژمارە')}
                    className="min-h-[44px] w-[64px] rounded-lg border border-zinc-700 bg-zinc-900 px-2 text-center text-[13px] text-zinc-100"
                  />
                  <span className="w-[34px] shrink-0 text-[11px] leading-4 text-zinc-500">
                    {chosen ? unitLabel(chosen.unit) : ''}
                  </span>
                </div>

                <button
                  type="button"
                  disabled={disabled}
                  onClick={() => onChange(rows.filter((x) => x.key !== r.key))}
                  aria-label={loc('حذف', 'Remove', 'سڕینەوە')}
                  className="flex h-[44px] w-[38px] shrink-0 items-center justify-center rounded-lg text-zinc-500"
                >
                  <Trash2 aria-hidden="true" className="h-4 w-4" />
                </button>
              </div>
            );
          })}

          <button
            type="button"
            disabled={disabled}
            onClick={() => onChange([...rows, emptyAccessoryRow()])}
            className="inline-flex min-h-[44px] items-center gap-1.5 self-start rounded-lg border border-dashed border-zinc-700 px-3 text-[12.5px] font-semibold text-zinc-300"
          >
            <Plus aria-hidden="true" className="h-4 w-4" />
            {loc('أضف قطعة', 'Add a part', 'پارچەیەک زیاد بکە')}
          </button>
        </div>
      ) : null}
    </section>
  );
}

/**
 * The priced rows, as the SERVER returned them. Rendered from the response and
 * never from the form: what was charged for is not always what is currently
 * typed, and the customer is owed the first.
 */
export function AccessoryBreakdown({
  lines,
  unknown,
}: {
  lines: ReadonlyArray<{ id: string; qty: number; iqd: number; name_ar: string; name_en: string; name_ckb: string }>;
  unknown: readonly string[];
}) {
  const { loc } = useLanguage();
  if (lines.length === 0 && unknown.length === 0) return null;
  return (
    <div className="mt-2 flex flex-col gap-1">
      {lines.map((l) => (
        <div key={l.id} className="flex items-center justify-between gap-2 text-[11.5px] leading-5 text-zinc-400">
          <span dir="auto" className="min-w-0 truncate">{`${l.qty}× ${loc(l.name_ar, l.name_en, l.name_ckb)}`}</span>
          <span className="shrink-0 tabular-nums">{formatIqd(l.iqd)}</span>
        </div>
      ))}
      {unknown.length > 0 ? (
        // Said out loud rather than swallowed. A customer whose menu is one
        // version stale must know their magnet was not counted — a quote that
        // silently drops it is a quote that under-charges in secret.
        <p className="text-[11.5px] leading-5 text-amber-400/90">
          {loc(
            'قطعة أو أكثر لم تعد موجودة في القائمة ولم تُحتسب. حدّث الصفحة واخترها من جديد.',
            'One or more parts are no longer in the catalogue and were not counted. Reload and pick them again.',
            'یەک پارچە یان زیاتر لە لیستەکەدا نەماون و نەژمێردران.'
          )}
        </p>
      ) : null}
    </div>
  );
}
