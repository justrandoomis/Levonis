/**
 * THE CUSTOMER'S CHOICE OF VARIANT — one fieldset per option group, native
 * radio inputs underneath (arrow keys, one tab stop per group, announced as
 * «2 of 4» by every screen reader without a line of ARIA here).
 *
 * A value is in one of three states (packages/catalog `valueState`), each
 * said in words and not only in colour:
 *   · available — selectable;
 *   · sold out  — selectable (so the customer can SEE it is sold out), struck
 *                 through, «نفد» in its accessible name;
 *   · unavailable — the merchant sells no such combination with the other
 *                 choices: disabled.
 * A colour group draws its swatch from the palette KEY (swatches.css); the
 * merchant's words are text, never style.
 *
 * Lives outside src/components/storefront/ on purpose: that directory's
 * import allow-list is for the store's blocks, and this is the product page's.
 */
import { useId } from 'react';
import { valueState, type PublicGroup, type PublicVariant } from '../../../packages/catalog/src/variants';
import './swatches.css';

export function VariantPicker({
  groups,
  variants,
  selection,
  onChange,
  lang,
  soldOutLabel,
}: {
  groups: PublicGroup[];
  variants: PublicVariant[];
  selection: Record<string, string>;
  onChange: (next: Record<string, string>) => void;
  lang: string;
  soldOutLabel: string;
}) {
  const base = useId();
  const name = (x: { name: string; name_ar: string }) => (lang === 'en' ? x.name : x.name_ar || x.name);
  return (
    <div className="space-y-4" data-variant-picker>
      {groups.map((g, gi) => {
        const chosen = g.values.find((v) => v.id === selection[g.id]);
        return (
          <fieldset key={g.id} className="min-w-0">
            <legend className="mb-2 text-[12.5px] text-zinc-400">
              <span className="font-semibold text-zinc-200">{name(g)}</span>
              {chosen && <span className="ms-1.5">· {name(chosen)}</span>}
            </legend>
            <div className="flex flex-wrap gap-2">
              {g.values.map((v) => {
                const state = valueState(groups, variants, selection, gi, v.id);
                const id = `${base}-${g.id}-${v.id}`;
                const checked = selection[g.id] === v.id;
                return (
                  <label
                    key={v.id}
                    htmlFor={id}
                    data-state={state}
                    className={`relative inline-flex min-h-[44px] items-center gap-2 rounded-xl border px-3.5 text-[13px] transition-colors ${
                      state === 'unavailable' ? 'cursor-not-allowed opacity-35' : 'cursor-pointer'
                    } ${checked ? 'border-gold bg-gold/10 text-white' : 'border-white/12 bg-white/[0.03] text-zinc-300'}
                      has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-gold`}
                  >
                    <input
                      id={id}
                      type="radio"
                      name={`${base}-${g.id}`}
                      className="sr-only"
                      checked={checked}
                      disabled={state === 'unavailable'}
                      onChange={() => onChange({ ...selection, [g.id]: v.id })}
                    />
                    {g.kind === 'color' && <span className="lv-swatch text-[18px]" data-swatch={v.swatch || undefined} aria-hidden="true" />}
                    <span className={state === 'sold_out' ? 'line-through decoration-zinc-500' : ''}>{name(v)}</span>
                    {state === 'sold_out' && <span className="sr-only">({soldOutLabel})</span>}
                  </label>
                );
              })}
            </div>
          </fieldset>
        );
      })}
    </div>
  );
}
