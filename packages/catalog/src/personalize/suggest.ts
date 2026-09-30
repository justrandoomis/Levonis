/**
 * «✨ Make it better» and «🎲 Surprise me» (the owner's brief; docs/
 * LEVO_PROJECT_PROGRAMME.md §A C1.15, C1.22; survey §5.3).
 *
 * `makeItBetter` looks for ONE improvement, in the order of BETTER_CODES, and
 * answers the first that keeps the price — or, when none does, the first that
 * changes it, with its `delta_iqd` (a priced suggestion says its price; the
 * studio shows one chip, and undo):
 *   CONTRAST_TEXT     a text reads below 3:1 on its part → the nearest colour
 *                     it may wear that reads
 *   STOCKED_ONLY      a colour the part may not wear now (the shop's shelf for
 *                     this look, a colour rule) → the nearest it may
 *   FEWER_COLOURS     more colours than the price includes (or than three) →
 *                     the nearest merged (rules.ts `mergeColours`) — usually
 *                     a saving, so a priced suggestion
 *   STYLE_FOR_LENGTH  another style the area offers prints the text at least a
 *                     fifth larger (or makes it fit at all)
 *   BALANCE_ACCENT    an accent part wears its body's colour → the theme's
 *                     accent, else the colour it may wear that stands out
 *                     most, every text staying legible
 *   LOGO_FIT          a logo cropped to less than 90 % of its picture → all of it
 *   THEME_MATCH       no theme, and one colour away from one of the
 *                     blueprint's themes in its own colours → that theme
 * Null when nothing would be better.
 *
 * `surpriseMe` is seeded («Try another» = seed + 1): another look in stock
 * (same size and quality), another theme and a style per text that fits — it
 * never touches what the customer wrote or uploaded (texts, logos, photos,
 * QR targets).
 * Pure: no clock, no randomness (the seed is an argument).
 */
import type { DesignConfig, PaletteKey } from './types';
import type { SpecLike } from './canonical';
import { keyContrast } from './color';
import { customerColours, paintTargets } from './price';
import { colourChoices, mergeColours, nearestColour, unitPricer } from './rules';
import { applyTheme, seedIndex, tasteContext, textsLegible, themeExact, themePalette, themesOf, withStyle, type TasteCtx } from './themes';

export const BETTER_CODES = ['CONTRAST_TEXT', 'STOCKED_ONLY', 'FEWER_COLOURS', 'STYLE_FOR_LENGTH', 'BALANCE_ACCENT', 'LOGO_FIT', 'THEME_MATCH'] as const;
export type BetterCode = (typeof BETTER_CODES)[number];
export interface Better { code: BetterCode; config: DesignConfig; delta_iqd: number }

/** «✨ Make it better»: the one suggestion (see the header), or null. */
export function makeItBetter(spec: SpecLike, config: DesignConfig, ctx: TasteCtx = {}): Better | null {
  const cx = tasteContext(spec, config, ctx);
  const unit = unitPricer(spec, cx, config.variant);
  const ts = paintTargets(spec, config);
  const on = (id: string): PaletteKey => ts.find((t) => t.id === id)?.key ?? config.colors[id];
  const may = (id: string): PaletteKey[] => colourChoices(spec, config, cx, id);
  const tone = (id: string): string | undefined => spec.regions.find((r) => r.id === id)?.tone;
  const paint = (edits: Array<[string, PaletteKey | null]>): DesignConfig | null => {
    const c = { ...config, colors: { ...config.colors } };
    for (const [id, k] of edits) if (k) c.colors[id] = k;
    return edits.some(([id, k]) => k && k !== config.colors[id]) ? c : null;
  };
  const tries: Record<BetterCode, () => DesignConfig | null> = {
    CONTRAST_TEXT: () =>
      paint(ts.filter((t) => t.id !== t.region && keyContrast(t.key, on(t.region)) < 3).map((t) => [t.id, nearestColour(t.key, may(t.id).filter((k) => keyContrast(k, on(t.region)) >= 3))])),
    STOCKED_ONLY: () => paint(ts.filter((t) => t.choice && !may(t.id).includes(t.key)).map((t) => [t.id, nearestColour(t.key, may(t.id))])),
    FEWER_COLOURS: () => {
      const n = Math.min(spec.colors.included, 3);
      return customerColours(spec, config).length > n ? mergeColours(spec, config, cx, n) : null;
    },
    STYLE_FOR_LENGTH: () => {
      let changed = false;
      const c = withStyle(spec, config, cx, (_, fitting, now, current) => {
        const best = fitting.filter(([s]) => s !== current).sort((a, b) => b[1] - a[1])[0];
        if (!changed && best && (!now.fits || best[1] >= now.cap_mm * 1.2)) return (changed = true), best[0];
        return undefined;
      });
      return changed ? c : null;
    },
    BALANCE_ACCENT: () => {
      const body = ts.find((t) => tone(t.id) === 'primary');
      const accent = config.theme && themePalette(config.theme).accent;
      for (const t of ts) {
        if (!body || t.key !== body.key || tone(t.id) !== 'accent') continue;
        const ranked = may(t.id).sort((a, b) => Number(b === accent) - Number(a === accent) || keyContrast(b, body.key) - keyContrast(a, body.key));
        for (const k of ranked) {
          const c = k !== body.key && paint([[t.id, k]]);
          if (c && textsLegible(spec, c)) return c;
        }
      }
      return null;
    },
    LOGO_FIT: () => {
      const logo = Object.fromEntries(Object.entries(config.logo).map(([id, l]) => [id, l.crop[2] * l.crop[3] < 0.9 ? { ...l, crop: [0, 0, 1, 1] as typeof l.crop } : l]));
      return Object.keys(logo).some((id) => logo[id] !== config.logo[id]) ? { ...config, logo } : null;
    },
    THEME_MATCH: () =>
      (!config.theme &&
        themesOf(spec)
          .map((t) => applyTheme(spec, config, t, ctx))
          .find((c) => themeExact(spec, c, c.theme!) && paintTargets(spec, c).filter((p) => p.key !== config.colors[p.id]).length === 1 && textsLegible(spec, c))) ||
      null,
  };
  const base = unit(config);
  let priced: Better | null = null;
  for (const code of BETTER_CODES) {
    const c = tries[code]();
    const u = c && unit(c);
    if (u == null || base == null) continue;
    if (u === base) return { code, config: c!, delta_iqd: 0 };
    priced ??= { code, config: c!, delta_iqd: u - base };
  }
  return priced;
}

/**
 * «🎲 Surprise me»: `ctx.config` in another look (in stock, same size and
 * quality), another theme, and a style per filled text that fits — all picked
 * by `seed`. Texts, logos, photos and QR targets are never touched.
 */
export function surpriseMe(spec: SpecLike, ctx: TasteCtx & { config: DesignConfig }, seed = 0): DesignConfig {
  let c = ctx.config;
  const cx = tasteContext(spec, c, ctx);
  const look = spec.axes.look;
  const cur = cx.variants?.find((v) => v.id === c.variant);
  const others = (look && cur && cx.variants?.filter((v) => v.in_stock && v !== cur && Object.keys(cur.values).every((g) => g === look.group || v.values[g] === cur.values[g]))) || [];
  if (others.length) c = { ...c, variant: others[seedIndex(seed * 7 + 3, others.length)].id };
  const themes = themesOf(spec).filter((t) => t !== c.theme);
  if (themes.length) c = applyTheme(spec, c, themes[seedIndex(seed, themes.length)], ctx);
  return withStyle(spec, c, cx, (i, fitting) => fitting[seedIndex(seed * 5 + i, fitting.length || 1)]?.[0]);
}
