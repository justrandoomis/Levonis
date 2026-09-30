/**
 * LOOK — colours first (survey S1a): the ten one-tap themes (the blueprint's
 * own list; the shop's exact ones first) with «✨ Choose for me» / «Try
 * another», then one row per part the customer colours — the list twin of
 * tapping the model — each opening its palette in place, then the optional
 * pieces. Every swatch carries its name, never colour alone.
 *
 * THE PALETTE is what the part may wear now (packages/catalog/src/
 * personalize/rules.ts `colourChoices`: the paint's list, the shop's shelf
 * for a stocked paint, a merchant's colour rule), with the shop's stock
 * states: out = not offered; sub = offered, showing the colour that will
 * print and its name. Swatch colours are the engine's numbers (the shop's own
 * filament where it has one) as inline styles — never a hex in this code.
 *
 * The finish (the look axis) and Good value / Best look (the tier axis) are
 * More pages when the blueprint has them (`FinishChoices`, `TierChoices`).
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Sparkles } from 'lucide-react';
import type { DesignConfig, LookKey, PublicBlueprint, ThemeKey, Tier } from '../../../packages/catalog/src/personalize/types';
import { LOOKS, LOOK_WORDS, REGION_ROLES, ROLE_WORDS, THEMES, THEME_WORDS, TIERS, TIER_WORDS, colorWord, isTag, word, type Occasion } from '../../../packages/catalog/src/personalize/vocab';
import { PALETTE_RGB } from '../../../packages/catalog/src/personalize/color';
import { Switch } from '../ui/Switch';
import { Money } from '../ui/Money';
import { Skeleton } from '../ui/Skeleton';
import { fill } from './strings';
import type { Taste } from './taste';
import { axisOf, paintRows, rgbOf, swatchesFor, variantWith, type Kit } from './useStudio';

type Rgb = readonly [number, number, number];
const dot = (rgb: Rgb) => ({ backgroundColor: `rgb(${rgb[0]} ${rgb[1]} ${rgb[2]})` });

/** A round colour dot — the engine's numbers as an inline style. */
export function Dot({ rgb, size = 14 }: { rgb: Rgb; size?: number }) {
  return <span aria-hidden="true" className="inline-block shrink-0 rounded-full border border-border-subtle" style={{ ...dot(rgb), width: size, height: size }} />;
}

/** What steers «Choose for me»: the family and the occasion the merchant tagged. */
export function tasteCtx(pub: PublicBlueprint): { family: PublicBlueprint['family']; occasion?: Occasion } {
  const occ = pub.tags.find((g) => isTag(g) && g.startsWith('occ:'))?.slice(4) as Occasion | undefined;
  return occ ? { family: pub.family, occasion: occ } : { family: pub.family };
}

export function LookPanel({ k, taste, focus }: { k: Kit; taste: Taste | null; focus?: string | null }) {
  const { pub, state, derived, dispatch, t, lang } = k;
  const [open, setOpen] = useState<string | null>(focus ?? null);
  const list = useRef<HTMLUListElement>(null);
  useEffect(() => {
    if (focus) setOpen(focus);
  }, [focus]);
  // The opened row in view with its part's name above its palette (the panel is short on a phone).
  useEffect(() => {
    if (open) list.current?.querySelector(`[data-colors-for="${open}"]`)?.closest('li')?.scrollIntoView({ block: 'nearest' });
  }, [open]);
  const config = state.config;
  const made = derived.made;
  const themes = useMemo(() => {
    if (!taste) return null;
    const list = taste.themesOf(pub);
    const applied = list.map((th): [ThemeKey, DesignConfig, boolean] => {
      const c = taste.applyTheme(pub, config, th, tasteCtx(pub));
      return [th, c, taste.themeExact(pub, c, th)];
    });
    return [...applied.filter((a) => a[2]), ...applied.filter((a) => !a[2])];
  }, [taste, pub, config]);
  const seed = state.seeds.choose;
  const chosen = useMemo(() => (taste ? taste.chooseForMe(pub, config, tasteCtx(pub), seed) : null), [taste, pub, config, seed]);
  const offersThemes = pub.themes === 'all' || pub.themes.length > 0;
  const rows = paintRows(pub, made);
  const pieces = pub.regions.filter((r) => r.optional);
  const roleWord = (id: string): string => {
    const r = pub.regions.find((x) => x.id === id);
    if (r) return r.role === 'name' || r.role === 'text' ? t.plate[r.role] : word(ROLE_WORDS, REGION_ROLES, r.role, lang);
    const a = pub.areas.find((x) => x.id === id);
    return fill(t.colourOf, { name: a?.role === 'name' ? t.tiles.name : t.tiles.text });
  };
  return (
    <div className="space-y-4 px-3 py-3">
      {offersThemes && (
        <div>
          <p className="mb-1.5 text-[12px] font-medium text-text-muted">{t.themes}</p>
          <div className="-mx-3 flex snap-x gap-2 overflow-x-auto px-3 pb-1 hide-scrollbar">
            {!themes ? (
              <>
                <Skeleton className="h-11 w-28 shrink-0 rounded-xl" />
                <Skeleton className="h-11 w-24 shrink-0 rounded-xl" />
                <Skeleton className="h-11 w-24 shrink-0 rounded-xl" />
              </>
            ) : (
              <>
                {chosen && chosen !== config && (
                  <button
                    type="button"
                    data-chip="choose"
                    className="lv-choice flex shrink-0 snap-start items-center gap-1.5 px-3 text-[13px] font-semibold"
                    onClick={() => dispatch({ type: 'apply', config: chosen, why: 'choose', seed: 'choose' })}
                  >
                    <Sparkles aria-hidden="true" className="h-4 w-4 text-gold" />
                    {state.seeds.choose ? t.tryAnother : t.chooseForMe}
                  </button>
                )}
                {themes.map(([th, c]) => {
                  const p = taste!.themePalette(th);
                  return (
                    <button
                      key={th}
                      type="button"
                      aria-pressed={made.theme === th}
                      data-theme-key={th}
                      className="lv-choice flex shrink-0 snap-start items-center gap-2 px-3 text-[13px]"
                      onClick={() => dispatch({ type: 'apply', config: c, why: 'theme' })}
                    >
                      <span className="flex gap-0.5" aria-hidden="true">
                        <Dot rgb={PALETTE_RGB[p.primary]} size={12} />
                        <Dot rgb={PALETTE_RGB[p.secondary]} size={12} />
                        <Dot rgb={PALETTE_RGB[p.accent]} size={12} />
                      </span>
                      {word(THEME_WORDS, THEMES, th, lang)}
                    </button>
                  );
                })}
              </>
            )}
          </div>
        </div>
      )}
      {rows.length > 0 && (
        <div>
          <p className="mb-1.5 text-[12px] font-medium text-text-muted">{t.parts}</p>
          <ul ref={list} className="divide-y divide-border-subtle rounded-2xl border border-border-subtle">
            {rows.map((row) => {
              const expanded = open === row.id;
              const key = made.colors[row.id];
              return (
                <li key={row.id}>
                  <button
                    type="button"
                    aria-expanded={expanded}
                    data-region={row.id}
                    onClick={() => setOpen(expanded ? null : row.id)}
                    className="flex min-h-12 w-full items-center gap-3 px-3 text-start"
                  >
                    <Dot rgb={rgbOf(pub, made, key)} size={18} />
                    <span className="min-w-0 flex-1 truncate text-[13.5px] font-medium text-text-primary">{roleWord(row.id)}</span>
                    <span className="shrink-0 text-[12.5px] text-text-secondary">{colorWord(key, lang)}</span>
                  </button>
                  {expanded && (
                    <div
                      className="flex flex-wrap gap-2 px-3 pb-3"
                      role="radiogroup"
                      aria-label={roleWord(row.id)}
                      data-colors-for={row.id}
                    >
                      {swatchesFor(pub, config, row.id).map((s) => (
                        <button
                          key={s.key}
                          type="button"
                          role="radio"
                          aria-checked={s.key === key}
                          data-swatch-key={s.key}
                          onClick={() => dispatch({ type: 'colour', target: row.id, key: s.key })}
                          className="lv-choice flex items-center gap-2 px-2.5 text-start text-[12.5px]"
                        >
                          <Dot rgb={rgbOf(pub, config, s.key)} size={16} />
                          <span className="leading-tight">
                            <span className="block">{colorWord(s.key, lang)}</span>
                            {s.matched && <span className="block text-[11px] text-text-muted">{fill(t.matched, { name: colorWord(s.matched, lang) })}</span>}
                          </span>
                        </button>
                      ))}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}
      {pieces.map((r) => (
        <Switch
          key={r.id}
          checked={config.parts[r.id] ?? r.optional!.on}
          onChange={(on) => dispatch({ type: 'piece', region: r.id, on })}
          label={fill(t.addPiece, { part: word(ROLE_WORDS, REGION_ROLES, r.role, lang) })}
          description={r.optional!.fee_iqd ? <Money iqd={r.optional!.fee_iqd} signed /> : undefined}
        />
      ))}
      {rows.length > 0 && <p className="text-[11.5px] text-text-muted">{t.approx}</p>}
    </div>
  );
}

/** The finish — the product's look axis (Classic, Silk, …), each a variant of its own. */
export function FinishChoices({ k }: { k: Kit }) {
  return <AxisChoices k={k} axis="look" words={(v) => word(LOOK_WORDS, LOOKS, k.pub.axes.look!.values[v].look as LookKey, k.lang)} />;
}

/** Good value / Best look — the product's tier axis. */
export function TierChoices({ k }: { k: Kit }) {
  return <AxisChoices k={k} axis="tier" words={(v) => word(TIER_WORDS, TIERS, k.pub.axes.tier!.values[v].tier as Tier, k.lang)} />;
}

function AxisChoices({ k, axis, words }: { k: Kit; axis: 'look' | 'tier'; words: (value: string) => string }) {
  const { pub, state, derived, dispatch, t } = k;
  const ax = pub.axes[axis];
  if (!ax) return null;
  const now = axisOf(pub, state.config, axis);
  const cur = pub.variants.find((v) => v.id === state.config.variant);
  return (
    <div className="space-y-2 px-3 py-3" role="radiogroup" aria-label={axis === 'look' ? t.look : t.tier}>
      {Object.keys(ax.values).map((value) => {
        const id = variantWith(pub, state.config, axis, value);
        const v = pub.variants.find((x) => x.id === id);
        const delta = v && cur ? v.price_iqd - cur.price_iqd : 0;
        const out = !v || !v.in_stock;
        return (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={value === now}
            aria-disabled={out || undefined}
            data-value={value}
            onClick={() => !out && id && dispatch({ type: 'variant', variant: id })}
            className="lv-choice flex min-h-12 w-full items-center justify-between gap-3 px-3 text-start"
          >
            <span className="text-[13.5px] font-medium text-text-primary">{words(value)}</span>
            <span className="shrink-0 text-[12.5px] text-text-secondary">
              {out ? <span className="text-warning">{t.soldOut}</span> : delta ? <Money iqd={delta} signed /> : value === now ? null : t.samePrice}
            </span>
          </button>
        );
      })}
      {derived.check.issues.some((i) => i.code === 'RULE_ADJUSTED' && i.say === 'look_limits_colors') && <p className="text-[12px] text-text-muted">{t.say.look_limits_colors}</p>}
    </div>
  );
}
