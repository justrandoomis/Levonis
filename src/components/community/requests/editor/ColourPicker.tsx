/**
 * «اختر الألوان» (plan P1-06; design §6.4, critique 12).
 *
 * One field, «اسم اللون», does two jobs: what is typed filters the palette
 * (in three languages, search.ts), and a name the palette does not have is
 * offered as «أضف «…» كلونٍ آخر», with its shade if the customer wants to
 * show it. The choices are CHECKBOXES (several colours a material, sixteen at
 * most), and «أي لون مناسب» stands alone: choosing it clears the others,
 * choosing another clears it. «كما في المرجع» can sit beside named colours,
 * and asks which reference — the references in general, or one of them.
 * A colour is never told by its swatch alone: every one carries its name.
 */
import { useMemo, useState } from 'react';
import { Sheet } from '../../../ui/Sheet';
import { useSheetPlacement } from './useKeyboardOpen';
import { Button } from '../../../ui/Button';
import { Checkbox } from '../../../ui/Switch';
import { Field, Input } from '../../../ui/Field';
import { REQUEST_COLOURS, localColour } from '../mirrors';
import { matchesSearch, normaliseForSearch } from './search';
import { LIMITS, isNamed, namedColour, sameColour, toggleColour, type EditorColour } from './state';
import { fill, type EditorLang, type EditorStrings } from './strings';

export interface RefChoice {
  key: string;
  label: string;
}

/** The palette entries a typed name shows. */
export function filterPalette(query: string) {
  return REQUEST_COLOURS.filter((c) => matchesSearch(query, [c.ar, c.en, c.ckb, c.hex]));
}

/** Is the typed name one the palette already has (in any language)? */
export function paletteHas(query: string): boolean {
  const q = normaliseForSearch(query);
  return !!q && REQUEST_COLOURS.some((c) => [c.ar, c.en, c.ckb].some((n) => normaliseForSearch(n) === q));
}

export function ColourPicker({
  open,
  onClose,
  colours,
  onChange,
  refs,
  lang,
  t,
}: {
  open: boolean;
  onClose: () => void;
  colours: EditorColour[];
  onChange: (next: EditorColour[]) => void;
  refs: RefChoice[];
  lang: EditorLang;
  t: EditorStrings;
}) {
  const sheetPlacement = useSheetPlacement();
  const [query, setQuery] = useState('');
  const [shade, setShade] = useState('');
  const shown = useMemo(() => filterPalette(query), [query]);
  const any = colours.length === 0 || colours.some((c) => c.mode === 'any');
  const asRef = colours.find((c) => c.mode === 'as_reference');
  const named = colours.filter(isNamed);
  const full = colours.filter((c) => c.mode !== 'any').length >= LIMITS.maxColoursPerMaterial;
  const custom = named.filter((c) => !REQUEST_COLOURS.some((p) => p.hex === c.hex));
  const typed = query.trim();
  const toggle = (c: EditorColour) => onChange(toggleColour(colours, c));

  const swatch = (hex: string) => (
    <span aria-hidden="true" className="h-5 w-5 shrink-0 rounded-full border border-border-subtle" style={{ backgroundColor: hex || 'transparent' }} />
  );

  return (
    <Sheet
      open={open}
      onClose={onClose}
      label={t.colourPickerTitle}
      {...sheetPlacement}
      detents={['large']}
      testId="colour-picker"
      header={<h2 className="px-4 pb-2 pt-1 text-[15px] font-bold text-text-primary">{t.colourPickerTitle}</h2>}
      footer={
        <div className="px-4 pb-3 pt-2">
          <Button variant="primary" block onClick={onClose}>
            {t.done}
          </Button>
        </div>
      }
    >
      <div className="space-y-3 px-4 pb-4">
        <Checkbox checked={any} onChange={() => toggle({ mode: 'any', hex: '', label: '', ref: '' })} label={t.colourAny} data-colour-option="any" />
        <div>
          <Checkbox
            checked={!!asRef}
            disabled={!asRef && full}
            onChange={() => toggle({ mode: 'as_reference', hex: '', label: '', ref: '' })}
            label={t.colourAsRef}
            data-colour-option="as_reference"
          />
          {asRef && (
            <fieldset className="ms-8 mt-1 space-y-1">
              <legend className="mb-1 text-[12px] font-semibold text-text-secondary">{t.asRefWhich}</legend>
              {[{ key: '', label: t.asRefAll }, ...refs].map((r) => (
                <label key={r.key || 'all'} className="flex min-h-11 cursor-pointer items-center gap-3 text-[13.5px] text-text-primary">
                  <input
                    type="radio"
                    name="colour-ref"
                    checked={(asRef.ref || '') === r.key}
                    onChange={() => onChange(colours.map((c) => (c.mode === 'as_reference' ? { ...c, ref: r.key } : c)))}
                    className="h-[18px] w-[18px] shrink-0 accent-gold"
                  />
                  <span className="min-w-0 truncate">{r.label}</span>
                </label>
              ))}
            </fieldset>
          )}
        </div>

        <Field label={t.colourName} hint={t.colourNameHint}>
          <Input type="search" enterKeyHint="search" dir="auto" autoComplete="off" value={query} onChange={(e) => setQuery(e.target.value)} data-colour-search />
        </Field>

        <fieldset className="space-y-1">
          <legend className="mb-1 text-[12px] font-semibold text-text-secondary">{t.paletteLabel}</legend>
          {shown.map((c) => {
            const entry = namedColour(c.en, c.hex);
            const checked = named.some((x) => sameColour(x, entry));
            return (
              <Checkbox
                key={c.hex}
                checked={checked}
                disabled={!checked && full}
                onChange={() => toggle(entry)}
                data-colour-option={c.hex}
                label={
                  <span className="inline-flex items-center gap-2">
                    {swatch(c.hex)}
                    {c[lang]}
                  </span>
                }
              />
            );
          })}
          {!shown.length && <p className="text-[12.5px] text-text-muted">{t.colourNoMatch}</p>}
        </fieldset>

        {custom.length > 0 && (
          <fieldset className="space-y-1">
            <legend className="mb-1 text-[12px] font-semibold text-text-secondary">{t.customColours}</legend>
            {custom.map((c) => (
              <Checkbox
                key={`${c.label}|${c.hex}`}
                checked
                onChange={() => toggle(c)}
                label={
                  <span className="inline-flex items-center gap-2">
                    {c.hex ? swatch(c.hex) : null}
                    <bdi>{localColour(c.label || c.hex, lang)}</bdi>
                  </span>
                }
              />
            ))}
          </fieldset>
        )}

        {typed && !paletteHas(typed) && (
          <div className="space-y-2 rounded-md border border-border-subtle p-3" data-colour-custom>
            <label className="flex min-h-11 items-center gap-3 text-[13px] text-text-secondary">
              <input
                type="color"
                value={shade || '#808080'}
                onChange={(e) => setShade(e.target.value)}
                aria-label={t.customShade}
                className="h-9 w-12 shrink-0 cursor-pointer rounded-sm border border-border-subtle bg-transparent"
              />
              {t.customShade}
            </label>
            <Button
              size="sm"
              variant="secondary"
              disabled={full}
              onClick={() => {
                const c = namedColour(typed, shade);
                if (!named.some((x) => sameColour(x, c))) onChange(toggleColour(colours, c));
                setQuery('');
                setShade('');
              }}
            >
              {fill(t.addCustomColour, { x: typed.slice(0, LIMITS.colourLabelMax) })}
            </Button>
          </div>
        )}
        {full && <p className="text-[12px] text-text-muted">{fill(t.coloursMax, { n: LIMITS.maxColoursPerMaterial })}</p>}
        {named.length > 1 && (
          <p className="lv-alert lv-alert-warning text-[12.5px]" role="note">
            {t.multicolourHint}
          </p>
        )}
      </div>
    </Sheet>
  );
}
