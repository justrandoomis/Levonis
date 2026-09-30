/**
 * THE WORDS OF A CONFIGURATION — what the customer chose, said the way a
 * shopper says it (docs/LEVO_PROJECT_PROGRAMME.md §B.1 hop 3 «words in
 * ar/en/ckb»; survey §5.3 «Price and words»).
 *
 *   configWords   one line, at most 200 characters, Arabic first for `ar` —
 *                 «حامل باسم علي (ألعاب) · كحلي وفيروزي · وسط · مغناطيس ×2».
 *                 It becomes the order line's `option_snapshot` (C3) and the
 *                 merchant's first look at the order, so it names everything
 *                 made to measure: the text and its style, the colours, the
 *                 variant, the add-ons, a logo / photo / QR / icon, NFC, the
 *                 optional pieces added and a roster's size.
 *   summaryRows   the same, one {label, value} per thing — the studio's
 *                 ReadyLine and the confirm sheet.
 *
 * Words come from vocab.ts (per list), the palette's colour names, the slot
 * options' names (the shop's product names: `names.slot_options`, else the
 * public blueprint's) and the merchant's own variant and value names when the
 * caller has them (`names.variants`, `names.values`); a size without a name
 * reads as its longest side in centimetres. Customer vocabulary only.
 */
import type { DesignConfig, Lang, PublicBlueprint } from './types';
import type { SpecLike } from './canonical';
import {
  CONTENT_KINDS, FAMILIES, FAMILY_WORDS, ICON_KEYS, ICON_WORDS, KIND_WORDS, LOGO_MODES, LOGO_WORDS, LOOKS, LOOK_WORDS, PHOTO_MODES, PHOTO_WORDS,
  REGION_ROLES, ROLE_WORDS, STYLES, STYLE_WORDS, TARGET_KEYS, TARGET_WORDS, TIERS, TIER_WORDS, colorWord, slotKindWord, word, type Words,
} from './vocab';
import { paintTargets, regionShown, slotChoice } from './price';

export const SUMMARY_KEYS = ['named', 'colours', 'size', 'look', 'tier', 'addons', 'copies', 'notes', 'added', 'cm', 'and', 'style'] as const;
/** The summary's own words — reuse them rather than re-translating. */
export const SUMMARY_WORDS: Words = [
  'باسم|الألوان|المقاس|المظهر|الجودة|الإضافات|النسخ|ملاحظات|مضاف|سم|و|أسلوب',
  'with the name|Colours|Size|Look|Quality|Add-ons|Copies|Notes|Added|cm|and|style',
  'بە ناوی|ڕەنگەکان|قەبارە|شێوە|چۆنایەتی|زیادەکان|دانەکان|تێبینی|زیادکراو|سم|و|شێواز',
];

/** The merchant's own names the caller may have: slot options by slot and key, variants by id, axis values by id. */
export interface SummaryNames {
  slot_options?: Record<string, Record<string, string>>;
  variants?: Record<string, string>;
  values?: Record<string, string>;
}
export interface SummaryRow { label: string; value: string }

const say = (key: (typeof SUMMARY_KEYS)[number], lang: Lang): string => word(SUMMARY_WORDS, SUMMARY_KEYS, key, lang);

/** «a وb وc» · «a و b و c» · «a, b and c». */
export function listWords(items: readonly string[], lang: Lang): string {
  if (lang === 'ar') return items.join(' و');
  const and = ` ${say('and', lang)} `;
  return lang === 'en' && items.length > 2 ? items.slice(0, -1).join(', ') + and + items[items.length - 1] : items.join(and);
}

type Tag = 'text' | 'content' | 'colours' | 'axis' | 'slot' | 'part' | 'more' | 'notes';
interface Said extends SummaryRow { tag: Tag; role?: string; text?: string; style?: string }

/** Everything chosen, tagged, in the order the piece is described. */
function describe(spec: SpecLike, config: DesignConfig, lang: Lang, names: SummaryNames): Said[] {
  const out: Said[] = [];
  const add = (tag: Tag, label: string, value: string, more?: Partial<Said>): number => out.push({ tag, label, value, ...more });
  const w = (words: Words, keys: readonly string[], key: string): string => word(words, keys, key, lang);
  const pub = 'product' in spec ? (spec as PublicBlueprint) : undefined;
  for (const a of spec.areas) {
    const t = config.texts[a.id];
    if (a.text && t?.value.length) {
      const text = t.value.join(a.text.count < 2 ? ' ' : lang === 'en' ? ' & ' : ' و ');
      const style = w(STYLE_WORDS, STYLES, t.style);
      add('text', w(ROLE_WORDS, REGION_ROLES, a.role), `${text} · ${style}`, { role: a.role, text, style });
    }
    const kinds = [
      ['logo', LOGO_WORDS, LOGO_MODES, config.logo[a.id]?.mode],
      ['photo', PHOTO_WORDS, PHOTO_MODES, config.photo[a.id]?.mode],
      ['qr', TARGET_WORDS, TARGET_KEYS, config.qr[a.id]?.kind],
      ['icon', ICON_WORDS, ICON_KEYS, config.icon[a.id]],
    ] as const;
    for (const [kind, words, keys, v] of kinds) if (v) add('content', w(KIND_WORDS, CONTENT_KINDS, kind), w(words, keys, v));
  }
  const colours = [...new Set(paintTargets(spec, config).map((t) => colorWord(t.key, lang)))];
  if (colours.length) add('colours', say('colours', lang), listWords(colours, lang));
  const v = pub?.variants.find((x) => x.id === config.variant);
  const named = config.variant && names.variants?.[config.variant];
  if (named) add('axis', say('size', lang), named);
  else if (v) {
    const { size, look, tier } = spec.axes;
    const id = (g?: string): string => (g && v.values[g]) || '';
    const s = size?.values[id(size.group)];
    if (s) add('axis', say('size', lang), names.values?.[id(size!.group)] ?? `${Math.round(Math.max(...s.dims_mm) / 10)} ${say('cm', lang)}`);
    const l = look?.values[id(look.group)];
    if (l) add('axis', say('look', lang), names.values?.[id(look!.group)] ?? w(LOOK_WORDS, LOOKS, l.look));
    const q = tier?.values[id(tier.group)];
    if (q) add('axis', say('tier', lang), names.values?.[id(tier!.group)] ?? w(TIER_WORDS, TIERS, q.tier));
  }
  for (const s of spec.slots) {
    const o = slotChoice(s, config);
    if (s.choice !== 'customer' || !o) continue;
    const name = names.slot_options?.[s.id]?.[o] ?? pub?.slot_options[s.id]?.find((x) => x.key === o)?.name ?? slotKindWord(s.kind, lang);
    add('slot', s.label?.[lang] || slotKindWord(s.kind, lang), s.qty > 1 ? `${name} ×${s.qty}` : name);
  }
  for (const r of spec.regions) if (r.optional && regionShown(spec, config, r.id)) add('part', w(ROLE_WORDS, REGION_ROLES, r.role), say('added', lang));
  if (config.nfc) add('more', 'NFC', w(TARGET_WORDS, TARGET_KEYS, config.nfc.kind));
  if (config.roster?.length) add('more', say('copies', lang), String(config.roster.length));
  if (config.notes) add('notes', say('notes', lang), config.notes);
  return out;
}

/** One {label, value} per thing chosen — the ReadyLine and the confirm sheet. */
export const summaryRows = (spec: SpecLike, config: DesignConfig, lang: Lang, names: SummaryNames = {}): SummaryRow[] =>
  describe(spec, config, lang, names).map(({ label, value }) => ({ label, value }));

/** One line of at most 200 characters (see the header): the text first, then the colours, the variant, the rest. */
export function configWords(spec: SpecLike, config: DesignConfig, lang: Lang, names: SummaryNames = {}): string {
  const said = describe(spec, config, lang, names);
  const head = [spec.family === 'other' ? '' : word(FAMILY_WORDS, FAMILIES, spec.family, lang)];
  for (const d of said) if (d.tag === 'text') head.push(`${d.role === 'name' ? `${say('named', lang)} ${d.text}` : `«${d.text}»`} (${d.style})`);
  const parts = [head.filter(Boolean).join(' ')];
  for (const d of said) {
    if (d.tag === 'colours' || d.tag === 'axis' || d.tag === 'slot') parts.push(d.value);
    else if (d.tag === 'part') parts.push(`+ ${d.label}`);
    else if (d.tag === 'content' || d.tag === 'more') parts.push(`${d.label}: ${d.value}`);
  }
  const kept = parts.filter(Boolean);
  while (kept.length > 2 && kept.join(' · ').length > 200) kept.pop();
  const line = kept.join(' · ');
  return line.length > 200 ? `${line.slice(0, 199)}…` : line;
}
