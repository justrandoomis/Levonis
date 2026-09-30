/**
 * THE CHECK — can this configuration be made, as it stands, at this price?
 * (docs/LEVO_PROJECT_PROGRAMME.md §B.1 hop 3, P15; survey §4.6 «engine check
 * codes» and §5.3 «Checks and automatic fixes».) The studio runs it on every
 * tap; the Worker runs it at every door. Codes are UI words (the studio's and
 * the builder's strings), never HTTP errors.
 *
 * THE FOUR GROUPS (vocab.ts `checkGroup`), and what each issue carries:
 *   fixed    applied by itself, one line each — `fix: {kind: 'auto',
 *            delta_iqd: 0}`: TEXT_FITTED (Smart Fit made it smaller, or moved
 *            it to a size of the same price — `to`), TEXT_TWO_LINES,
 *            TEXT_STYLE_BOLDER (`from` → `to`, the style), COLOR_MATCHED
 *            (`from` → `to`: a 'stocked' paint off the shelf, on the shop's
 *            `sub:` substitute — the Worker's stock map chose it within
 *            CIEDE2000 10, so the studio needs no colour science here),
 *            COLORS_MERGED (over the blueprint's max), CONTRAST_FIXED (a QR's
 *            surface colour changed so it scans, `from` → `to`), QR_ENLARGED
 *            (a size of the same price where the code scans, `to`),
 *            LOGO_SIMPLIFIED (drawn in the area's colours), RULE_ADJUSTED (a
 *            merchant rule set to auto, `say`)
 *   suggest  a priced one-tap fix — `fix: {kind: 'suggest', delta_iqd,
 *            config}`, `to` = the size: SIZE_UP_FOR_TEXT, SIZE_UP_FOR_QR,
 *            SIZE_UP_FOR_ADDON (from a size_at_least rule: with its `say`)
 *   review   the shop looks first: LOGO_DETAIL (more than 8 colours),
 *            PHOTO_LOW_RES (fewer px per mm than the area's minimum at the
 *            chosen size), PHOTO_NEEDS_CUTOUT (a silhouette of a picture
 *            without transparency), TOO_BIG_FOR_PRINTER (the chosen size is
 *            above the printer; the largest size it makes, `to`, rides as an
 *            optional suggestion — a review never blocks)
 *   blocked  the customer must act: TEXT_TOO_LONG, COMPONENT_OUT (`from`, the
 *            in-stock `alternatives` of the same slot, the nearest in price as
 *            `fix`), COLOR_OUT (`from`: off the shelf with no substitute it
 *            may wear; path `colors` when colours over the max cannot merge),
 *            SIZE_OUT (the variant is sold out; the nearest size of it in
 *            stock, `to` = its variant id, as `fix`), QR_UNREADABLE,
 *            CONTENT_MISSING (one per missing path), RULE_UNMET (`say`, its
 *            fix as a suggestion when there is one)
 * `path` names what the issue is about (texts.<id>, colors.<id>, qr.<id>,
 * logo.<id>, photo.<id>, slots.<id>, rules.<id>, roster.<i>.texts.<id>,
 * variant, colors); every `delta_iqd` is measured from this configuration's
 * unit.
 *
 * A FIX NEVER CHANGES THE PRICE BY ITSELF (P15): every automatic fix is priced
 * before it is applied, and one that would change the unit is demoted to a
 * suggestion under the same code (a demoted fixed code blocks until tapped);
 * the final unit is compared with the first and a difference throws.
 *
 * VERDICT: blocked if any issue is blocked or waits for a tap (a suggestion,
 * a demoted fix); else review if any review; else adjusted if a fix was
 * applied; else ready. `blockingCode` names the door's chip. Issues come in
 * the order the check runs: colours, rules set to auto, the merge, each area
 * in spec order (its text, its QR, its picture), the rules still unmet, then
 * the variant, the printer, the parts and the required content.
 *
 * QR READABILITY is analytic: the payload (`qrPayload`) sets the version
 * (byte mode, EC level M, versions 1–10 — worker/lib/qr.ts), the module is
 * the area's shorter side at the chosen size over (modules + 2 × 2 quiet
 * modules, as src/lib/viewer/decals.ts draws it) and must reach
 * `min_module_mm`; the code prints in the design's colour with the most
 * contrast against its surface (`qrColours`), at least 3:1.
 *
 * Roster names are fitted too (TEXT_TOO_LONG at their path); their colours,
 * fixed parts' stock and a model bigger than the printer without a size axis
 * are later phases' (C12, C3, the builder's publish check).
 */
import type { Area, CheckCode, CheckIssue, DesignConfig, PaletteKey, PriceBreakdown, PublicVariant, QrKind, SayCode, Vec3, Verdict } from './types';
import { canonicalize, utf8Bytes, type SpecLike } from './canonical';
import { CHECK_CODES, checkGroup } from './vocab';
import { requiredMissing } from './config';
import { sizeOrder } from './spec';
import { PALETTE_RGB, contrastRatio, type RGB } from './color';
import { fitText, sizeSteps, type FitOptions, type FitResult } from './fit';
import { EngineError, customerColours, paintTargets, partKey, priceConfig, regionShown, slotChoice } from './price';
import { axisValue, colourChoices, evaluateRules, fitsInBuild, mergeColours, nearestColour, rebase, sizeValuesInBuild, stockedKeys, unitPricer, withPublic, withSize, type RulesContext } from './rules';

/** What the Worker (or the upload) knows of an owner's picture. */
export interface AssetFacts { px_w: number; px_h: number; colours?: number; has_alpha?: boolean }
export interface CheckContext extends RulesContext {
  /** Facts of the logo and photo areas' pictures, by area id — an area without them is not judged. */
  assets?: Readonly<Record<string, AssetFacts>>;
  /** Smart Fit — fit.ts `fitText` unless a test stands one in. */
  fit?: (value: readonly string[], area: Area, opts: FitOptions) => FitResult;
}
export interface CheckAlternative { key: string; config: DesignConfig; delta_iqd?: number }
export interface CheckFinding extends CheckIssue {
  from?: string;
  to?: string;
  say?: SayCode;
  alternatives?: CheckAlternative[];
}
export interface CheckResult {
  verdict: Verdict;
  issues: CheckFinding[];
  /** After the automatic fixes (canonical when one applied). */
  config: DesignConfig;
  /** Null only when a chosen part has no live price (COMPONENT_OUT). */
  price: PriceBreakdown | null;
}

export const QR_QUIET_MODULES = 2;
export const QR_MIN_CONTRAST = 3;
/** More colours than this in a logo is a picture, not a mark: the shop looks first. */
export const LOGO_REVIEW_COLOURS = 8;
/** Byte-mode capacity at EC level M, versions 1–10 (worker/lib/qr.ts). */
const QR_BYTES = [14, 26, 42, 62, 84, 106, 122, 152, 180, 213];
/** The reorder link (the twin's, filled by the server in C3) is sized at this many bytes. */
const QR_REORDER_BYTES = 40;

/** What a QR of this kind encodes (the canonical value from config.ts `normalizeTarget`). */
export function qrPayload(kind: QrKind, value: string): string {
  return kind === 'instagram' ? `https://instagram.com/${value}`
    : kind === 'tiktok' ? `https://www.tiktok.com/@${value}`
    : kind === 'whatsapp' ? `https://wa.me/${value.replace('+', '')}`
    : kind === 'contact' ? `tel:${value}`
    : value;
}

/** Modules on a side of the code (17 + 4 × version); 0 when the payload is too long for the encoder. */
export function qrModules(kind: QrKind, value: string): number {
  const bytes = kind === 'reorder' ? QR_REORDER_BYTES : utf8Bytes(qrPayload(kind, value));
  const v = QR_BYTES.findIndex((c) => c >= bytes) + 1;
  return v ? 17 + 4 * v : 0;
}

/** An area's box in mm at a size (a photo-only area: its quad over the face the size's two largest sides span, as fit.ts measures it). */
function boxMm(a: Area, scale: number, dims?: Vec3): { w: number; h: number } | null {
  if (a.frame) return { w: a.frame.w * scale, h: a.frame.h * scale };
  const q = a.photo_frame?.quad;
  if (!q || !dims) return null;
  const [fw, fh] = [...dims].sort((x, y) => y - x);
  const span = (i: 0 | 1): number => Math.max(...q.map((p) => p[i])) - Math.min(...q.map((p) => p[i]));
  return { w: span(0) * fw, h: span(1) * fh };
}

/**
 * A QR's two colours: `off` = its region's colour (the surface it is printed
 * on); `on` = the design's colour with the most contrast against it — black
 * or white when the design has no other. `rgb` = the shop's colours when known.
 */
export function qrColours(spec: SpecLike, c: DesignConfig, areaId: string, rgb: (k: PaletteKey) => RGB = (k) => PALETTE_RGB[k]): { on: PaletteKey; off: PaletteKey; ratio: number } | null {
  const a = spec.areas.find((x) => x.id === areaId);
  const ts = paintTargets(spec, c);
  const off = ts.find((t) => t.id === a?.region)?.key;
  if (!off) return null;
  const others = [...new Set(ts.map((t) => t.key))].filter((k) => k !== off);
  let best = { on: off, off, ratio: 0 };
  for (const on of others.length ? others : (['black', 'white'] as const)) {
    const ratio = contrastRatio(rgb(on), rgb(off));
    if (ratio > best.ratio) best = { on, off, ratio };
  }
  return best;
}

/** An applied fix (shared, frozen). */
const AUTO = Object.freeze({ kind: 'auto' as const, delta_iqd: 0 });

const blocks = (i: CheckFinding): boolean => {
  const g = checkGroup(i.code);
  return g === 'blocked' || (g !== 'review' && i.fix?.kind !== 'auto');
};

/**
 * The code the disabled door names: the most serious blocking issue — a
 * blocked code before one that waits for a tap, then in CHECK_CODES order.
 */
export function blockingCode(issues: readonly CheckFinding[]): CheckCode | undefined {
  const rank = (i: CheckFinding): number => (checkGroup(i.code) === 'blocked' ? 0 : 99) + CHECK_CODES.indexOf(i.code);
  return issues.filter(blocks).sort((a, b) => rank(a) - rank(b))[0]?.code;
}

export function checkConfig(spec: SpecLike, config: DesignConfig, ctx: CheckContext): CheckResult {
  const cx = withPublic(spec, ctx);
  const unit = unitPricer(spec, cx, config.variant);
  const rgb = (k: PaletteKey): RGB => cx.stock_rgb?.[k] ?? PALETTE_RGB[k];
  const fit = ctx.fit ?? fitText;
  const issues: CheckFinding[] = [];
  const push = (code: CheckCode, path: string, more: Partial<CheckFinding> = {}): void => void issues.push({ code, path, ...more });
  let cur = config;
  let start: number | null = null;
  let unpriced = '';
  try {
    start = priceConfig(spec, config, cx.price).unit_iqd;
  } catch (e) {
    if (!(e instanceof EngineError) || e.code !== 'PART_UNPRICED') throw e;
    unpriced = e.path;
  }
  const steps = () => sizeSteps({ axes: spec.axes, variants: (cx.variants ?? []) as PublicVariant[] }, cur.variant);
  const inBuild = sizeValuesInBuild(spec, cx.printer);
  const setColour = (id: string, key: PaletteKey): DesignConfig => ({ ...cur, colors: { ...cur.colors, [id]: key } });
  /** A one-tap fix and what it does to the price (unknown when the configuration cannot be priced). */
  const suggest = (next: DesignConfig): { kind: 'suggest'; config: DesignConfig; delta_iqd?: number } => {
    const then = unit(next);
    return { kind: 'suggest', config: next, ...(then !== null && start !== null ? { delta_iqd: then - start } : {}) };
  };
  /** `next` as the fix of `code`: applied when price-neutral, else a suggestion under `priced`. */
  const offer = (code: CheckCode, path: string, next: DesignConfig, more: Partial<CheckFinding> = {}, priced: CheckCode = code): void => {
    const then = unit(next);
    if (then === start) cur = next;
    push(then === start ? code : priced, path, { ...more, ...(then === null ? {} : then === start ? { fix: AUTO } : { fix: suggest(next) }) });
  };

  if (start !== null) {
    // A 'stocked' paint off the shelf → the shop's substitute (`sub:`, when the target may wear it), else COLOR_OUT.
    const st = stockedKeys(spec, cur, cx);
    for (const t of st ? paintTargets(spec, cur) : []) {
      const k = t.key;
      const sub = st!.map[k]?.startsWith('sub:') ? (st!.map[k]!.slice(4) as PaletteKey) : null;
      if (t.paint.allowed !== 'stocked' || st!.shelf.has(k)) continue;
      if (sub && colourChoices(spec, cur, cx, t.id).includes(sub)) offer('COLOR_MATCHED', `colors.${t.id}`, setColour(t.id, sub), { from: k, to: sub });
      else push('COLOR_OUT', `colors.${t.id}`, { from: k });
    }

    // The merchant's rules set to auto, while one applies at the same price.
    for (let i = 0; i < spec.rules.length; i++) {
      const p = rebase(cx, config.variant, cur.variant);
      const o = p && evaluateRules(spec, cur, { ...cx, price: p }).find((x) => !x.satisfied && x.fix?.kind === 'auto');
      if (!o) break;
      cur = o.fix!.config;
      push('RULE_ADJUSTED', `rules.${o.rule}`, { say: o.say, fix: AUTO });
    }

    // Over the blueprint's colours → the nearest merged.
    if (customerColours(spec, cur).length > spec.colors.max) {
      const next = mergeColours(spec, cur, cx, spec.colors.max);
      if (next) offer('COLORS_MERGED', 'colors', next);
      else push('COLOR_OUT', 'colors');
    }

    // Each area at the chosen size: texts through Smart Fit, QR codes, the owner's pictures.
    for (const a of spec.areas) {
      if (!regionShown(spec, cur, a.region)) continue;
      const z = steps();
      const box = boxMm(a, z.scale, z.dims_mm);
      if (a.text) {
        const t = cur.texts[a.id];
        const path = `texts.${a.id}`;
        const at = { style: t?.style ?? a.text.default_style, scale: z.scale, dims_mm: z.dims_mm };
        const r = t?.value.length ? fit(t.value, a, { ...at, sizes: z.sizes.filter((s) => inBuild.includes(s.value)) }) : null;
        const next = r?.code === 'SIZE_UP_FOR_TEXT' && r.size_value ? withSize(spec, cur, cx, r.size_value) : null;
        if (r?.code === 'TEXT_FITTED' || r?.code === 'TEXT_TWO_LINES') push(r.code, path, { fix: AUTO });
        else if (r?.code === 'TEXT_STYLE_BOLDER') offer(r.code, path, { ...cur, texts: { ...cur.texts, [a.id]: { ...t!, style: r.style } } }, { from: t!.style, to: r.style });
        else if (next) offer('TEXT_FITTED', path, next, { to: r!.size_value }, 'SIZE_UP_FOR_TEXT');
        else if (r && r.code !== 'TEXT_OK') push('TEXT_TOO_LONG', path);
        cur.roster?.forEach((e, i) => {
          const v = e.texts?.[a.id];
          if (v?.length && !fit(v, a, at).fits) push('TEXT_TOO_LONG', `roster.${i}.texts.${a.id}`);
        });
      }
      const q = cur.qr[a.id];
      if (a.qr && q) {
        const path = `qr.${a.id}`;
        const n = qrModules(q.kind, q.value);
        const min = a.qr.min_module_mm;
        const scans = (b: { w: number; h: number } | null): boolean => !b || Math.min(b.w, b.h) / (n + 2 * QR_QUIET_MODULES) >= min;
        if (!n) push('QR_UNREADABLE', path);
        else if (!scans(box)) {
          const up = z.sizes
            .filter((s) => s.scale > z.scale && inBuild.includes(s.value) && scans(boxMm(a, s.scale, s.dims_mm)))
            .sort((x, y) => x.scale - y.scale || (x.iqd_delta ?? 0) - (y.iqd_delta ?? 0))[0];
          const next = up && withSize(spec, cur, cx, up.value);
          if (next) offer('QR_ENLARGED', path, next, { to: up.value }, 'SIZE_UP_FOR_QR');
          else push('QR_UNREADABLE', path);
        }
        const ink = n ? qrColours(spec, cur, a.id, rgb) : null;
        if (ink && ink.ratio < QR_MIN_CONTRAST) {
          const ok = colourChoices(spec, cur, cx, a.region).filter((k) => (qrColours(spec, setColour(a.region, k), a.id, rgb)?.ratio ?? 0) >= QR_MIN_CONTRAST);
          const to = nearestColour(ink.off, ok);
          if (to) offer('CONTRAST_FIXED', `colors.${a.region}`, setColour(a.region, to), { from: ink.off, to });
          else push('QR_UNREADABLE', path);
        }
      }
      const f = ctx.assets?.[a.id];
      const pick = a.logo ? cur.logo[a.id] : a.photo ? cur.photo[a.id] : undefined;
      const path = `${a.kind}.${a.id}`;
      if (f && pick && a.logo) {
        if ((f.colours ?? 0) > LOGO_REVIEW_COLOURS) push('LOGO_DETAIL', path);
        else if ((f.colours ?? 0) > a.logo.max_colors) push('LOGO_SIMPLIFIED', path, { fix: AUTO });
      }
      if (f && pick && a.photo) {
        if (box && Math.min((f.px_w * pick.crop[2]) / box.w, (f.px_h * pick.crop[3]) / box.h) < a.photo.min_px_per_mm) push('PHOTO_LOW_RES', path);
        if (pick.mode === 'silhouette' && !f.has_alpha) push('PHOTO_NEEDS_CUTOUT', path);
      }
    }

    // The rules still unmet: a priced size → SIZE_UP_*, anything else RULE_UNMET.
    const p = rebase(cx, config.variant, cur.variant);
    for (const o of p ? evaluateRules(spec, cur, { ...cx, price: p }) : []) {
      if (o.satisfied) continue;
      const r = spec.rules.find((x) => x.id === o.rule)!;
      const size = 'size_at_least' in r.then && o.fix;
      push(size ? ('text' in r.if ? 'SIZE_UP_FOR_TEXT' : 'qr' in r.if ? 'SIZE_UP_FOR_QR' : 'SIZE_UP_FOR_ADDON') : 'RULE_UNMET', `rules.${o.rule}`, {
        say: o.say,
        ...(size ? { to: axisValue(spec, cx, o.fix!.config, 'size') } : {}),
        ...(o.fix ? { fix: { kind: 'suggest', delta_iqd: o.fix.delta_iqd, config: o.fix.config } } : {}),
      });
    }
  }

  // What the shop sells today: the variant (sold out → the nearest size of it in stock), the printer, the parts, the content.
  const sv = axisValue(spec, cx, cur, 'size');
  const variants = cx.variants ?? [];
  if (variants.length && !variants.find((v) => v.id === cur.variant)?.in_stock) {
    const rank = (v?: string): number => sizeOrder(spec).indexOf(v!);
    const alt = steps().sizes.filter((z) => inBuild.includes(z.value)).sort((x, y) => Math.abs(rank(x.value) - rank(sv)) - Math.abs(rank(y.value) - rank(sv)))[0];
    push('SIZE_OUT', 'variant', alt?.variant ? { to: alt.variant, fix: suggest({ ...cur, variant: alt.variant }) } : {});
  }
  const dims = sv === undefined ? undefined : spec.axes.size?.values[sv]?.dims_mm;
  if (dims && cx.printer && !fitsInBuild(dims, cx.printer.max_mm)) {
    // The shop looks first; the largest size its printer makes is offered beside it.
    const next = [...inBuild].reverse().map((v) => withSize(spec, cur, cx, v)).find((x) => x !== null);
    push('TOO_BIG_FOR_PRINTER', 'variant', next ? { to: axisValue(spec, cx, next, 'size'), fix: suggest(next) } : {});
  }
  for (const s of spec.slots) {
    const k = slotChoice(s, cur);
    const path = `slots.${s.id}`;
    const ok = (key: string): boolean => {
      const o = s.options.find((x) => x.key === key);
      return !!o && cx.price.parts[partKey(o.part.p, o.part.v)]?.in_stock === true;
    };
    if (k === null || (ok(k) && unpriced !== path)) continue;
    const alternatives: CheckAlternative[] = (s.choice === 'customer' ? s.options : [])
      .filter((o) => o.key !== k && ok(o.key))
      .map((o) => {
        const { config: next, delta_iqd } = suggest({ ...cur, slots: { ...cur.slots, [s.id]: { option: o.key } } });
        return { key: o.key, config: next, ...(delta_iqd !== undefined ? { delta_iqd } : {}) };
      })
      .sort((x, y) => Math.abs(x.delta_iqd ?? 0) - Math.abs(y.delta_iqd ?? 0));
    push('COMPONENT_OUT', path, { from: k, alternatives, ...(alternatives[0] ? { fix: suggest(alternatives[0].config) } : {}) });
  }
  for (const path of requiredMissing(cur, spec)) push('CONTENT_MISSING', path);

  const price = start === null ? null : priceConfig(spec, cur, rebase(cx, config.variant, cur.variant)!);
  if (price && price.unit_iqd !== start) throw new Error('P15: an automatic fix changed the price');
  const verdict: Verdict = issues.some(blocks) ? 'blocked'
    : issues.some((i) => checkGroup(i.code) === 'review') ? 'review'
    : issues.some((i) => i.fix?.kind === 'auto') ? 'adjusted'
    : 'ready';
  return { verdict, issues, config: cur === config ? config : canonicalize(cur, spec), price };
}
