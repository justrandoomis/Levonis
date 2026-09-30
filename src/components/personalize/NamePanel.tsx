/**
 * NAME (or any text area) — typed, fitted, styled (survey S1: «Input dir=auto,
 * letters-left counter, NO size control (Smart Fit)»; §A C1.7–C1.9, C1.33).
 *
 * One field per entry (1–4 names for a names area, else one line of text that
 * Smart Fit wraps by itself). Typing is filtered by THE TEXT RULE as it is
 * typed (a refused character is dropped, with one quiet hint) and cut at the
 * area's letters; the counter says how many are left. `data-fit-lines` is
 * what Smart Fit will print («ALI», or «ALI|SARA» on two lines). The styles
 * are the area's own, each chip drawn in its own weight. An icon area on the
 * same piece rides here (`name_icons`).
 */
import { lazy, Suspense, useEffect, useId, useRef, useState } from 'react';
import { STYLES, STYLE_WORDS, word } from '../../../packages/catalog/src/personalize/vocab';
import { STYLE_PRESETS, stylesFor } from '../../../packages/catalog/src/personalize/styles';
import { graphemeCount } from '../../../packages/catalog/src/personalize/config';
import { Input } from '../ui/Field';
import { fill } from './strings';
import { cleanTyping, type Kit } from './useStudio';

/** The icon set and its picker load only for a blueprint with an icon area. */
const IconPicker = lazy(() => import('./extras').then((x) => ({ default: x.IconPicker })));

export function NamePanel({ k, areaId, icons = [] }: { k: Kit; areaId: string; icons?: readonly string[] }) {
  const { pub, state, derived, dispatch, t, lang } = k;
  const area = pub.areas.find((a) => a.id === areaId);
  const [dropped, setDropped] = useState(false);
  const uid = useId();
  const chips = useRef<HTMLDivElement>(null);
  // The chosen style in view (the heaviest is last in the row).
  useEffect(() => {
    chips.current?.querySelector<HTMLElement>('[aria-checked="true"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [areaId]);
  if (!area?.text) return null;
  const text = area.text;
  const label = area.role === 'name' ? t.tiles.name : t.tiles.text;
  const drafts = state.drafts[areaId] ?? [];
  const style = state.config.texts[areaId]?.style ?? text.default_style;
  const styles = stylesFor(area);
  const fit = derived.fits[areaId];
  return (
    <div className="space-y-3 px-3 py-3" data-area={areaId} data-fit-lines={fit ? fit.lines.join('|') : ''}>
      {Array.from({ length: text.count }, (_, i) => {
        const value = drafts[i] ?? '';
        const left = text.max - graphemeCount(value);
        const name = text.count > 1 ? fill(t.entry, { label, n: i + 1 }) : label;
        return (
          <div key={i} className="flex items-center gap-2">
            <Input
              value={value}
              dir="auto"
              aria-label={name}
              aria-describedby={`${uid}-${i}`}
              placeholder={i === 0 ? text.sample[lang] : name}
              autoComplete="off"
              enterKeyHint="done"
              onChange={(e) => {
                setDropped(cleanTyping(e.target.value, text.max).dropped);
                dispatch({ type: 'text', area: areaId, index: i, raw: e.target.value });
              }}
              className="min-w-0 flex-1 text-[15px]"
            />
            {/* Outside the field: a name typed in the other script turns the field's own direction round. */}
            <span aria-hidden="true" className="w-6 shrink-0 text-center text-[12px] tabular-nums text-text-muted">
              {left}
            </span>
            <span id={`${uid}-${i}`} className="sr-only">{fill(t.left, { n: left })}</span>
          </div>
        );
      })}
      {dropped && <p className="text-[12px] text-text-muted" role="status">{t.lettersOnly}</p>}
      {styles.length > 1 && (
        <div>
          <p className="mb-1.5 text-[12px] font-medium text-text-muted">{t.style}</p>
          <div ref={chips} className="-mx-3 flex snap-x gap-2 overflow-x-auto px-3 pb-1 hide-scrollbar" role="radiogroup" aria-label={t.style}>
            {styles.map((s) => (
              <button
                key={s}
                type="button"
                role="radio"
                aria-checked={s === style}
                onClick={() => dispatch({ type: 'style', area: areaId, style: s })}
                className="lv-choice shrink-0 snap-start px-3.5 text-[14px]"
                style={{ fontWeight: STYLE_PRESETS[s].weight }}
              >
                {word(STYLE_WORDS, STYLES, s, lang)}
              </button>
            ))}
          </div>
        </div>
      )}
      {icons.length > 0 && (
        <Suspense fallback={null}>
          {icons.map((id) => (
            <IconPicker key={id} k={k} areaId={id} />
          ))}
        </Suspense>
      )}
    </div>
  );
}
