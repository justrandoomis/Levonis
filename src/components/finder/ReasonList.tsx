import React from 'react';
import { Check, Info } from 'lucide-react';
import type { FinderCaveat, FinderReason } from '../../../packages/catalog/src/discoveryTypes';
import { caveatCopy, reasonCopy, type FinderLang } from './strings';

/**
 * «{v}» in a sentence → the sentence with the value as an LTR isolate, so
 * «256 × 256 × 260 mm» and «1,000 mm/s» never reorder inside Arabic (§13).
 */
export function withValue(text: string, value: string | null): React.ReactNode {
  if (value === null || !text.includes('{v}')) return text;
  const [before, after] = text.split('{v}');
  return (
    <>
      {before}
      <bdi dir="ltr" className="font-bold text-text-primary">
        {value}
      </bdi>
      {after}
    </>
  );
}

/**
 * «لماذا نرشّحها»: reasons (✓, success) then at most `maxCaveats` «انتبه»
 * lines (ⓘ, warning). EVERY LINE IS A SERVER CODE rendered through strings.ts;
 * a code the table does not know is skipped, never paraphrased. The icon is
 * the state's shape, the word is in the sentence, so colour is never alone.
 */
export default function ReasonList({
  reasons,
  caveats,
  lang,
  maxReasons,
  maxCaveats = 1,
  dense = false,
  watchLabel,
  specFirst = false,
}: {
  reasons: FinderReason[];
  caveats: FinderCaveat[];
  lang: FinderLang;
  maxReasons: number;
  maxCaveats?: number;
  dense?: boolean;
  /** «انتبه» — read before each caveat by a screen reader. */
  watchLabel?: string;
  /**
   * Put spec reasons before «متوفرة الآن» / «ضمن ميزانيتك». On a compact row
   * with room for one reason, the availability line above already says the
   * stock, so the one line goes to what the spec sheet says.
   */
  specFirst?: boolean;
}) {
  const ordered = specFirst
    ? [...reasons].sort((a, b) => Number(a.code === 'in_stock' || a.code === 'in_budget') - Number(b.code === 'in_stock' || b.code === 'in_budget'))
    : reasons;
  const r = ordered
    .map((x, i) => ({ key: `r${i}-${x.code}`, copy: reasonCopy(x, lang) }))
    .filter((x) => x.copy !== null)
    .slice(0, maxReasons);
  const c = caveats
    .map((x, i) => ({ key: `c${i}-${x.code}`, copy: caveatCopy(x, lang) }))
    .filter((x) => x.copy !== null)
    .slice(0, maxCaveats);
  if (r.length === 0 && c.length === 0) return null;
  const text = dense ? 'text-[12.5px] leading-[19px]' : 'text-[13.5px] leading-[21px]';
  return (
    <ul className={`flex flex-col ${dense ? 'gap-1' : 'gap-1.5'}`}>
      {r.map(({ key, copy }) => (
        <li key={key} data-reason className={`flex items-start gap-2 ${text} text-text-secondary`}>
          <Check aria-hidden="true" className="mt-[3px] size-4 shrink-0 text-success" strokeWidth={2.6} />
          <span className="min-w-0">
            {withValue(copy!.text, copy!.value)}
            {copy!.suffix ? <span className="text-text-muted"> {copy!.suffix}</span> : null}
          </span>
        </li>
      ))}
      {c.map(({ key, copy }) => (
        <li key={key} data-caveat className={`flex items-start gap-2 ${text} text-text-secondary`}>
          <Info aria-hidden="true" className="mt-[3px] size-4 shrink-0 text-warning" strokeWidth={2.2} />
          <span className="min-w-0">
            {watchLabel ? <span className="sr-only">{watchLabel}: </span> : null}
            {withValue(copy!.text, copy!.value)}
          </span>
        </li>
      ))}
    </ul>
  );
}
