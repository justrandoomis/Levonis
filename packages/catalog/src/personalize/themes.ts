/**
 * THE TEN ONE-TAP THEMES and «✨ Choose for me» (the owner's brief: Gaming ·
 * Fire · Ocean · Candy · Pastel · Mono · Royal · Fresh · Sunset · Cyber, then
 * optional fine tuning per part; docs/LEVO_PROJECT_PROGRAMME.md §A C1.11,
 * C1.14; survey §5.3 «Choose for me and Make it better»).
 *
 * A theme maps each TONE a region carries (primary, secondary, accent, text,
 * neutral) to a palette key, chosen so its text colour reads at 3:1 or better
 * (WCAG) on its primary, secondary and accent — the tones a name is printed
 * on (tests/personalizeThemes.test.ts) — and brings a text style.
 *
 * `applyTheme` paints every region with its tone's colour and every text with
 * the theme's text colour, or — where a part may not wear it now (its paint,
 * the shop's shelf for the chosen look, a merchant's colour rule: rules.ts
 * `colourChoices`) — the nearest colour it may (rules.ts `nearestColour`,
 * CIEDE2000, as the check matches colours), a text's among those that read at
 * 3:1 on its part; then it merges down to the blueprint's colour maximum.
 *
 * `chooseForMe` is seeded («Try another» = seed + 1) and never answers the
 * current theme. Among the blueprint's themes whose texts stay legible, it
 * keeps the best tier — the theme's own colours all available for the chosen
 * look (nothing stood in), then the same price — and picks by seed within it,
 * the themes whose tags match the product's family, occasion or recipient
 * first; the theme's text style comes with it where the area offers it and
 * the text still fits.
 * Pure: no clock, no randomness (the seed is an argument).
 */
import type { DesignConfig, FamilyKey, PaletteKey, StyleKey, ThemeKey, Tone } from './types';
import type { SpecLike } from './canonical';
import { THEMES, TONES, type Occasion } from './vocab';
import { keyContrast } from './color';
import { fitText, sizeSteps, type FitResult } from './fit';
import { stylesFor } from './styles';
import { paintTargets, priceContextFromPublic } from './price';
import { colourChoices, mergeColours, nearestColour, unitPricer, withPublic, type RulesContext } from './rules';

/**
 * Per theme, in THEMES order: the primary, secondary, accent, text and neutral
 * colours, the text style, then the tags it suits (families, occasions,
 * recipients, `biz`).
 */
export const THEME_TABLE =
  'black purple red white gray gaming toy figure birthday kids team|red orange yellow black gray bold sign opening him team|' +
  'blue teal white black silver minimal lamp decor him family|pink yellow teal navy white fun toy birthday birth kids|' +
  'beige pink white navy silver kids frame birth mothers_day her|white gray silver black white minimal sign plaque biz business|' +
  'purple gold white black navy elegant plaque wedding eid ramadan graduation|green white yellow navy silver fun magnet newroz opening friend|' +
  'orange pink yellow navy purple elegant lamp valentine couple her|black navy purple glow teal gaming keychain newyear him';

const row = (theme: ThemeKey): string[] => THEME_TABLE.split('|')[THEMES.indexOf(theme)].split(' ');

/** A theme's colour per tone. */
export const themePalette = (theme: ThemeKey): Record<Tone, PaletteKey> =>
  Object.fromEntries(TONES.map((t, i) => [t, row(theme)[i]])) as Record<Tone, PaletteKey>;
/** The text style a theme brings. */
export const themeStyle = (theme: ThemeKey): StyleKey => row(theme)[5] as StyleKey;

/**
 * What the taste functions read: the rules context (rules.ts — the shop's
 * shelf per look, the variants, the price) where the caller has it; a
 * PublicBlueprint brings its own. `family` / `occasion` steer Choose for me.
 */
export interface TasteCtx extends Partial<RulesContext> { family?: FamilyKey; occasion?: Occasion }

/** The rules context for a configuration, filled from a PublicBlueprint where the caller left it out. */
export function tasteContext(spec: SpecLike, config: DesignConfig, ctx: TasteCtx = {}): RulesContext {
  let price = ctx.price;
  try {
    price ??= 'product' in spec ? priceContextFromPublic(spec, config.variant) : undefined;
  } catch {
    // a variant the product does not sell: prices unknown, nothing is chosen for price
  }
  return withPublic(spec, { ...ctx, price: price ?? { base_iqd: 0, parts: {} } });
}

/** The themes a blueprint offers, in list order. */
export const themesOf = (spec: SpecLike): ThemeKey[] => (spec.themes === 'all' ? [...THEMES] : spec.themes);

/** Paint the configuration in a theme (see the header); the price may change — the studio shows it. */
export function applyTheme(spec: SpecLike, config: DesignConfig, theme: ThemeKey, ctx: TasteCtx = {}): DesignConfig {
  const cx = tasteContext(spec, config, ctx);
  const pal = themePalette(theme);
  const c: DesignConfig = { ...config, theme, colors: { ...config.colors } };
  const paint = (id: string, want: PaletteKey, under?: PaletteKey): void => {
    const all = colourChoices(spec, c, cx, id);
    const legible = under ? all.filter((k) => keyContrast(k, under) >= 3) : [];
    const list = legible.length ? legible : all;
    c.colors[id] = (list.includes(want) ? want : nearestColour(want, list)) ?? c.colors[id];
  };
  for (const r of spec.regions) paint(r.id, pal[r.tone]);
  for (const a of spec.areas) if (a.text) paint(a.id, pal.text, c.colors[a.region]);
  return mergeColours(spec, c, cx, spec.colors.max) ?? c;
}

/** Every filled text reads at 3:1 on the part it is printed on. */
export function textsLegible(spec: SpecLike, c: DesignConfig): boolean {
  const ts = paintTargets(spec, c);
  return ts.every((t) => t.region === t.id || keyContrast(t.key, ts.find((r) => r.id === t.region)?.key ?? t.key) >= 3);
}

/**
 * Each filled text area in the style `pick` names among those that fit it
 * exactly at the chosen size (each with its cap height; `now` = the fit of
 * the `current` style); unchanged where it names none.
 */
export function withStyle(
  spec: SpecLike,
  c: DesignConfig,
  cx: RulesContext,
  pick: (i: number, fitting: Array<[StyleKey, number]>, now: FitResult, current: StyleKey) => StyleKey | undefined
): DesignConfig {
  const texts = { ...c.texts };
  const steps = sizeSteps({ axes: spec.axes, variants: [...(cx.variants ?? [])] }, c.variant);
  spec.areas.forEach((a, i) => {
    const t = texts[a.id];
    if (!a.text || !t?.value.length) return;
    const fit = (style: StyleKey) => fitText(t.value, a, { style, scale: steps.scale, dims_mm: steps.dims_mm });
    const fitting = stylesFor(a).flatMap((s): Array<[StyleKey, number]> => {
      const f = fit(s);
      return f.fits && f.style === s ? [[s, f.cap_mm]] : [];
    });
    const s = pick(i, fitting, fit(t.style), t.style);
    if (s && fitting.some(([x]) => x === s)) texts[a.id] = { ...t, style: s };
  });
  return { ...c, texts };
}

/** `n` wrapped into 0 … m − 1 — negative and fractional seeds too. */
export const seedIndex = (n: number, m: number): number => ((Math.trunc(n) % m) + m) % m;

/** Every colour the customer picks is the theme's own colour for its tone (nothing stood in). */
export function themeExact(spec: SpecLike, c: DesignConfig, theme: ThemeKey): boolean {
  const pal = themePalette(theme);
  return paintTargets(spec, c).every((p) => !p.choice || p.key === pal[spec.regions.find((r) => r.id === p.id)?.tone ?? 'text']);
}

/** «✨ Choose for me»: a theme (and its text style) for this product — see the header. `config` unchanged when nothing qualifies. */
export function chooseForMe(spec: SpecLike, config: DesignConfig, ctx: TasteCtx = {}, seed = 0): DesignConfig {
  const cx = tasteContext(spec, config, ctx);
  const unit = unitPricer(spec, cx, config.variant);
  const tags = [ctx.family ?? spec.family, ctx.occasion, ...spec.tags.map((t) => t.replace(/^\w+:/, ''))];
  const ranked: Array<[number, DesignConfig]> = [];
  for (const t of themesOf(spec)) {
    if (t === config.theme) continue;
    const c = withStyle(spec, applyTheme(spec, config, t, ctx), cx, () => themeStyle(t));
    if (!textsLegible(spec, c)) continue;
    const tier = (themeExact(spec, c, t) ? 0 : 4) + (unit(c) === unit(config) ? 0 : 2) + (tags.some((x) => x && row(t).slice(6).includes(x)) ? 0 : 1);
    ranked.push([tier, c]);
  }
  const best = Math.min(...ranked.map(([t]) => t & 6));
  const pool = ranked.filter(([t]) => (t & 6) === best).sort((a, b) => a[0] - b[0]);
  return pool.length ? pool[seedIndex(seed, pool.length)][1] : config;
}
