import React, { useCallback, useSyncExternalStore } from 'react';
import { Check, Scale } from 'lucide-react';
import { useLanguage } from '../../LanguageContext';
import { compareTray, type TrayItem } from '../../lib/compareTray';

/**
 * THE CARD'S COMPARE TOGGLE (CATALOG_DISCOVERY §4.1, §10.4).
 *
 * A SIBLING of the card's link, never inside it — a `<button>` nested in an
 * `<a>` is invalid HTML and reads as one confused control to a screen reader.
 * The card positions it over the photograph's top inline-start corner.
 *
 * Drawn 30 px (it sits on a photograph and must not bury it), hit 44 px
 * (`.lv-hit`). It lives on the photograph, which is the fixed dark `charcoal`
 * in both themes, so its colours are the fixed ones too: a smoked `onyx` disc
 * with a `snow` scale; when on, an `ivory` disc with an `ink` check. The state
 * is `aria-pressed` AND the glyph, never the fill alone.
 *
 * A refused add (the fifth product, or another type) is answered by the tray
 * itself — a toast, or a «start a new comparison?» dialog — through the
 * store's notice (src/lib/compareTray.ts).
 */
export default function CompareToggle({
  item,
  type,
  className = 'relative',
}: {
  item: TrayItem;
  /** The product's compare type (`printer`, `laser`, `filament`). */
  type: string;
  /** Positioning; `.lv-hit` needs the button positioned (default `relative`). */
  className?: string;
}) {
  const { loc } = useLanguage();
  const on = useSyncExternalStore(
    compareTray.subscribe,
    () => compareTray.has(item.id),
    () => false
  );
  const onClick = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      compareTray.toggle(item, type);
    },
    [item, type]
  );
  // OWNER: Sorani to be written by hand (the two toggle labels).
  const label = on
    ? loc(`أزل ${item.name} من المقارنة`, `Remove ${item.name} from comparison`)
    : loc(`أضف ${item.name} إلى المقارنة`, `Add ${item.name} to comparison`);

  return (
    <button
      type="button"
      aria-pressed={on}
      aria-label={label}
      title={label}
      data-compare-toggle={item.id}
      onClick={onClick}
      className={`lv-hit grid size-[30px] place-items-center rounded-full border backdrop-blur-md transition-[background-color,color,transform] duration-150 active:scale-[0.94] motion-reduce:transition-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-1 ${
        on ? 'border-ivory bg-ivory text-ink' : 'border-snow/15 bg-onyx/55 text-snow hover:bg-onyx/70'
      } ${className}`}
    >
      {on ? <Check aria-hidden="true" className="size-4" strokeWidth={2.6} /> : <Scale aria-hidden="true" className="size-[15px]" strokeWidth={2} />}
    </button>
  );
}
