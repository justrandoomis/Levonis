/**
 * THE PAGE-WIDE PANELS — the look (a preset, then each token) and the page's
 * top and bottom.
 *
 * Every choice here is an ENUM value from packages/storeLayout/src/tokens.ts
 * or schema.ts: there is no colour picker, no font field, no CSS box, and
 * that is decision 12, not a gap. A token becomes a `data-sf-*` attribute the
 * platform's own stylesheet reads (src/components/storefront/theme.ts).
 * Changing the look never touches a block, a product or a word.
 */
import { useId } from 'react';
import { Check, LayoutTemplate } from 'lucide-react';
import { useLanguage } from '../../../LanguageContext';
import { Segmented } from '../../ui/Segmented';
import { Button } from '../../ui/Button';
import StoreTheme from '../../storefront/StoreTheme';
import '../../storefront/styles';
import { ACCENTS, accentFor } from '../../storefront/theme';
import { FOOTER_VARIANTS, HEADER_VARIANTS, type StoreLayout } from '../../../../packages/storeLayout/src/schema';
import { THEME_NAMES, THEME_PRESETS, TOKEN_KEYS, TOKEN_VALUES, type ThemeName, type ThemeTokens } from '../../../../packages/storeLayout/src/tokens';
import { FOOTER_COPY, HEADER_COPY, say, THEME_COPY, TOKEN_COPY, TOKEN_VALUE_COPY } from './catalog';
import { setFooter, setHeader, setPreset, setToken } from './editorModel';

// ----------------------------------------------------------- the swatch

/** A small, faithful sample of a preset: its ground, a card, a product tile and the accent. */
export function ThemeSwatch({ tokens, storeAccent, className = 'h-16' }: { tokens: ThemeTokens; storeAccent: unknown; className?: string }) {
  return (
    <StoreTheme tokens={tokens} storeAccent={storeAccent} className={`relative w-full overflow-hidden rounded-lg border border-white/10 p-2 ${className}`}>
      <SwatchBody accent={accentFor(tokens, storeAccent).classes.indicator} />
    </StoreTheme>
  );
}

function SwatchBody({ accent }: { accent: string }) {
  return (
    <div className="flex h-full gap-1.5" aria-hidden="true">
      <div className="sf-tile h-full w-8">
        <div className="sf-well h-2/3" />
      </div>
      <div className="flex flex-1 flex-col gap-1.5">
        <div className="sf-card h-5" />
        <div className="sf-card flex h-5 items-center px-1.5">
          <span className={`h-1.5 w-6 rounded-full ${accent}`} />
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------ choices

/** A radio group of chips that wraps — for token lists too long for one pill. */
export function ChoiceChips<T extends string>({
  label,
  value,
  options,
  onChange,
  render,
}: {
  label: string;
  value: T;
  options: readonly T[];
  onChange: (v: T) => void;
  render?: (v: T) => React.ReactNode;
}) {
  const id = useId();
  const move = (e: React.KeyboardEvent, i: number) => {
    const rtl = document.dir === 'rtl' || document.documentElement.dir === 'rtl';
    const fwd = e.key === 'ArrowDown' || e.key === (rtl ? 'ArrowLeft' : 'ArrowRight');
    const back = e.key === 'ArrowUp' || e.key === (rtl ? 'ArrowRight' : 'ArrowLeft');
    if (!fwd && !back) return;
    e.preventDefault();
    const j = (i + (fwd ? 1 : -1) + options.length) % options.length;
    onChange(options[j]);
    requestAnimationFrame(() => document.getElementById(`${id}-${j}`)?.focus());
  };
  return (
    <div role="radiogroup" aria-label={label} className="flex flex-wrap gap-1.5">
      {options.map((o, i) => {
        const on = o === value;
        return (
          <button
            key={o}
            id={`${id}-${i}`}
            type="button"
            role="radio"
            aria-checked={on}
            tabIndex={on ? 0 : -1}
            onClick={() => onChange(o)}
            onKeyDown={(e) => move(e, i)}
            className="lv-choice inline-flex min-h-10 items-center gap-1.5 px-3 text-[12.5px] font-medium"
          >
            {render ? render(o) : o}
            {on && <Check className="h-3.5 w-3.5 text-gold" aria-hidden="true" />}
          </button>
        );
      })}
    </div>
  );
}

// ------------------------------------------------------------ theme

export function ThemePanel({
  layout,
  storeAccent,
  onChange,
  onStarter,
}: {
  layout: StoreLayout;
  storeAccent: unknown;
  onChange: (l: StoreLayout) => void;
  onStarter: () => void;
}) {
  const { loc } = useLanguage();
  const word = (v: string | number) => say(loc, TOKEN_VALUE_COPY[String(v)], String(v));
  const presetMatches = TOKEN_KEYS.every((k) => layout.tokens[k] === THEME_PRESETS[layout.theme][k]);

  return (
    <div className="space-y-6" data-sd-theme>
      <section aria-labelledby="sd-presets" className="space-y-2">
        <div className="flex items-center gap-2">
          <h3 id="sd-presets" className="text-[13px] font-bold text-text-primary">
            {loc('النمط', 'Style')}
          </h3>
          {!presetMatches && <span className="text-[11.5px] text-text-muted">{loc('— معدّل', '— adjusted')}</span>}
        </div>
        <p className="text-[12px] leading-relaxed text-text-muted">{loc('يغيّر الألوان والأشكال فقط — أقسامك ومحتواها كما هي.', 'Changes colours and shapes only — your sections and their content stay.')}</p>
        <div role="radiogroup" aria-labelledby="sd-presets" className="grid grid-cols-2 gap-2">
          {THEME_NAMES.map((t) => {
            const selected = layout.theme === t;
            return (
              <button
                key={t}
                type="button"
                role="radio"
                aria-checked={selected}
                data-sd-preset={t}
                onClick={() => onChange(setPreset(layout, t))}
                className="lv-choice flex flex-col gap-2 p-2.5 text-start"
              >
                <ThemeSwatch tokens={THEME_PRESETS[t]} storeAccent={storeAccent} />
                <span className="min-w-0">
                  <span className="block truncate text-[12.5px] font-bold text-text-primary">{say(loc, THEME_COPY[t].name)}</span>
                  <span className="line-clamp-2 block text-[11px] leading-snug text-text-muted">{say(loc, THEME_COPY[t].line)}</span>
                </span>
              </button>
            );
          })}
        </div>
        <Button variant="ghost" size="sm" icon={<LayoutTemplate className="h-4 w-4" aria-hidden="true" />} onClick={onStarter}>
          {loc('ابدأ من قالب كامل…', 'Start from a full template…')}
        </Button>
      </section>

      <section aria-labelledby="sd-tokens" className="space-y-4">
        <h3 id="sd-tokens" className="text-[13px] font-bold text-text-primary">
          {loc('التفاصيل', 'Details')}
        </h3>
        {TOKEN_KEYS.map((key) => {
          const values = TOKEN_VALUES[key] as readonly (string | number)[];
          const label = say(loc, TOKEN_COPY[key]);
          const current = layout.tokens[key];
          const set = (v: string | number) => onChange(setToken(layout, key, (key === 'grid_columns' ? Number(v) : v) as ThemeTokens[typeof key]));
          return (
            <div key={key} className="space-y-1.5" data-sd-token={key}>
              <p className="text-[12.5px] font-medium text-text-secondary">{label}</p>
              {key === 'accent' ? (
                <ChoiceChips
                  label={label}
                  value={String(current)}
                  options={values.map(String)}
                  onChange={set}
                  render={(v) => (
                    <>
                      <span aria-hidden="true" className={`h-3 w-3 rounded-full ${v === 'store' ? accentFor({ ...layout.tokens, accent: 'store' }, storeAccent).classes.indicator : (ACCENTS[v] ?? ACCENTS.default).indicator}`} />
                      {word(v)}
                    </>
                  )}
                />
              ) : values.length <= 3 ? (
                <Segmented size="sm" group={`sd-token-${key}`} label={label} value={String(current)} onChange={set} items={values.map((v) => ({ id: String(v), label: word(v) }))} />
              ) : (
                <ChoiceChips label={label} value={String(current)} options={values.map(String)} onChange={set} render={(v) => word(v)} />
              )}
            </div>
          );
        })}
      </section>
    </div>
  );
}

// ------------------------------------------------------------ page

export function PagePanel({ layout, onChange }: { layout: StoreLayout; onChange: (l: StoreLayout) => void }) {
  const { loc } = useLanguage();
  return (
    <div className="space-y-6" data-sd-page>
      <VariantCards
        title={loc('رأس الصفحة', 'Page header')}
        value={layout.header.variant}
        options={HEADER_VARIANTS}
        copy={HEADER_COPY}
        onChange={(v) => onChange(setHeader(layout, v))}
      />
      <VariantCards
        title={loc('تذييل الصفحة', 'Page footer')}
        value={layout.footer.variant}
        options={FOOTER_VARIANTS}
        copy={FOOTER_COPY}
        onChange={(v) => onChange(setFooter(layout, v))}
      />
      <p className="text-[12px] leading-relaxed text-text-muted">
        {loc(
          'اسم المتجر وشعاره وغلافه ووصفه وروابطه تُعدَّل من «إعدادات المتجر»، فتبقى واحدة في كل مكان.',
          'Your store name, logo, cover, description and links are edited in «Store settings», so they stay the same everywhere.'
        )}
      </p>
    </div>
  );
}

function VariantCards<T extends string>({
  title,
  value,
  options,
  copy,
  onChange,
}: {
  title: string;
  value: T;
  options: readonly T[];
  copy: Record<T, { name: readonly [string, string]; line: readonly [string, string] }>;
  onChange: (v: T) => void;
}) {
  const { loc } = useLanguage();
  const id = useId();
  return (
    <section aria-labelledby={id} className="space-y-2">
      <h3 id={id} className="text-[13px] font-bold text-text-primary">
        {title}
      </h3>
      <div role="radiogroup" aria-labelledby={id} className="space-y-1.5">
        {options.map((o) => {
          const on = o === value;
          return (
            <button key={o} type="button" role="radio" aria-checked={on} onClick={() => onChange(o)} className="lv-choice flex w-full items-center gap-3 px-3 py-2.5 text-start">
              <span className="min-w-0 flex-1">
                <span className="block text-[13px] font-semibold text-text-primary">{say(loc, copy[o].name)}</span>
                <span className="block text-[11.5px] text-text-muted">{say(loc, copy[o].line)}</span>
              </span>
              {on && <Check className="h-4 w-4 shrink-0 text-gold" aria-hidden="true" />}
            </button>
          );
        })}
      </div>
    </section>
  );
}

export type { ThemeName };
