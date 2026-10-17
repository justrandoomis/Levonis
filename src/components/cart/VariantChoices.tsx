/**
 * THE CART'S «تغيير الخيارات» SHEET — ITS COLOUR AND OPTION ROWS.
 *
 * Lifted out of src/pages/Cart.tsx so the rows can be rendered from a real
 * cart answer (tests/cartVariantSheetNames.test.ts): they printed each value's
 * UUID, because they read the V1 `name` field a V2 product never sends
 * (src/lib/choiceNames.ts says why). Each row's label is now `choiceName` —
 * the product page's rule — and a row with no name at all is numbered in the
 * reader's language; an id is never a label.
 *
 * The sheet itself (the `Sheet`, the picture, the price, the shelf and the
 * confirm button) stays in the page: this is only what the customer picks.
 */
import { Check } from 'lucide-react';
import type { CartItem } from '../../lib/api';
import { choiceName, unnamedChoice, type ChoiceLang } from '../../lib/choiceNames';

export interface VariantChoicesProps {
  lang: ChoiceLang;
  colors: CartItem['colors'] | null | undefined;
  options: CartItem['options'] | null | undefined;
  pendingColorId: string;
  pendingOptionId: string;
  onColor: (id: string) => void;
  onOption: (id: string) => void;
  money: (iqd: number) => string;
}

const loc = (lang: ChoiceLang, ar: string, en: string, ckb: string) => (lang === 'en' ? en : lang === 'ckb' ? ckb : ar);

export default function VariantChoices({ lang, colors, options, pendingColorId, pendingOptionId, onColor, onOption, money }: VariantChoicesProps) {
  const colourRows = colors ?? [];
  const optionRows = options ?? [];
  return (
    <>
      {colourRows.length > 0 && (
        <div>
          <p className="text-text-primary font-bold mb-2">{loc(lang, 'اللون', 'Color', 'ڕەنگ')}</p>
          <div className="flex gap-2 flex-wrap">
            {colourRows.map((c, i) => {
              const cName = choiceName(c, lang) || unnamedChoice('colour', i + 1, lang);
              const active = pendingColorId === c.id;
              return (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => onColor(active ? '' : c.id)}
                  aria-pressed={active}
                  data-variant-choice="colour"
                  className="lv-choice flex items-center gap-2 px-4 py-2 text-sm"
                >
                  <span
                    aria-hidden="true"
                    className="w-3.5 h-3.5 rounded-full border border-border-subtle inline-block"
                    style={c.gradient ? { background: c.gradient } : { backgroundColor: c.hex || '#333' }}
                  ></span>
                  <bdi data-variant-choice-name>{cName}</bdi>
                  <span className="lv-choice-mark"><Check aria-hidden="true" className="h-3 w-3" /></span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {optionRows.length > 0 && (
        <div>
          <p className="text-text-primary font-bold mb-2">{loc(lang, 'الخيارات', 'Options', 'هەڵبژاردنەکان')}</p>
          <div className="flex gap-2 flex-wrap">
            {optionRows.map((o, i) => {
              const oName = choiceName(o, lang) || unnamedChoice('option', i + 1, lang);
              const active = pendingOptionId === o.id;
              return (
                <button
                  key={o.id}
                  type="button"
                  onClick={() => onOption(active ? '' : o.id)}
                  aria-pressed={active}
                  data-variant-choice="option"
                  className="lv-choice flex items-center gap-2 px-4 py-2 text-sm"
                >
                  <span>
                    <bdi data-variant-choice-name>{oName}</bdi>
                    {typeof o.price_iqd === 'number' && o.price_iqd > 0 ? ` — ${money(o.price_iqd)}` : ''}
                  </span>
                  <span className="lv-choice-mark"><Check aria-hidden="true" className="h-3 w-3" /></span>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </>
  );
}
