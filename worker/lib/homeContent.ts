/**
 * The shape of the owner-authored home page: hero banners, the item strips
 * (coupons / categories / top brands) and the section layout.
 *
 * WHY THIS FILE EXISTS. `homeBanners` and `homeSectionItems` were stored with
 * no validation beyond "an object under 100KB", so nothing checked that a
 * banner had a usable image, that a link was a link rather than a
 * `javascript:` URL, or that a title was a string at all. They are also about
 * to carry per-language marketing copy, which makes a real schema worth
 * having: the storefront renders whatever is in here.
 *
 * PER-LANGUAGE TEXT IS OWNER-AUTHORED, NEVER TRANSLATED. There is no AI
 * translation anywhere in this project, and the local deterministic engine is
 * for product copy, not for marketing headlines — a machine-rearranged slogan
 * is worse than an honest fallback. So each field holds up to three strings
 * and `pickText` falls back to the first one the owner actually filled in.
 */

export interface LocalizedText {
  ar: string;
  en: string;
  ckb: string;
}

export interface HomeBanner {
  id: string;
  image: string;
  link: string;
  /** Hero headline over the image. All three may be empty — then no text. */
  title: LocalizedText;
  subtitle: LocalizedText;
  /** Call-to-action label. Empty everywhere = the whole banner is the link. */
  cta: LocalizedText;
}

export interface HomeSectionItem {
  id: string;
  title: string;
  subtitle: string;
  image: string;
  link: string;
}

export interface HomeSection {
  id: string;
  titleEn: string;
  titleAr: string;
  isVisible: boolean;
}

export const MAX_BANNERS_PER_SLOT = 10;
export const MAX_SECTION_ITEMS = 30;
const MAX_TEXT = 200;
const MAX_SUBTITLE = 400;
const MAX_URL = 1000;

/**
 * A link the storefront may put in an href. Same-origin paths and http(s)
 * only — `javascript:`, `data:` and friends are dropped, not escaped, because
 * there is no legitimate banner that needs one.
 */
export function safeLink(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  const v = raw.trim();
  if (!v || v.length > MAX_URL) return '';
  if (v.startsWith('/') && !v.startsWith('//')) return v;
  if (/^https?:\/\//i.test(v)) return v;
  return '';
}

/** Same rule for an <img src>, which must also never be a script URL. */
export function safeImage(raw: unknown): string {
  return safeLink(raw);
}

function text(raw: unknown, max: number): string {
  return typeof raw === 'string' ? raw.trim().slice(0, max) : '';
}

export function localized(raw: unknown, max = MAX_TEXT): LocalizedText {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return { ar: text(o.ar, max), en: text(o.en, max), ckb: text(o.ckb, max) };
}

/** True when the owner left every language blank. */
export function isBlank(t: LocalizedText): boolean {
  return !t.ar && !t.en && !t.ckb;
}

/**
 * The string to show for `lang`, falling back to the first language the owner
 * actually wrote — never to a machine translation, and never to a language
 * name or a placeholder.
 */
export function pickText(t: LocalizedText | undefined, lang: string): string {
  if (!t) return '';
  const order =
    lang === 'en' ? [t.en, t.ar, t.ckb] : lang === 'ckb' ? [t.ckb, t.ar, t.en] : [t.ar, t.en, t.ckb];
  return order.find((v) => !!v) ?? '';
}

let seq = 0;
const nextId = (prefix: string) => `${prefix}_${Date.now().toString(36)}${(seq++).toString(36)}`;

export function normalizeBanner(raw: unknown): HomeBanner | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const image = safeImage(o.image);
  const title = localized(o.title);
  const subtitle = localized(o.subtitle, MAX_SUBTITLE);
  // A banner with neither a picture nor a headline has nothing to render.
  if (!image && isBlank(title)) return null;
  return {
    id: typeof o.id === 'string' && o.id ? o.id.slice(0, 60) : nextId('bn'),
    image,
    link: safeLink(o.link),
    title,
    subtitle,
    cta: localized(o.cta, 60),
  };
}

/**
 * Accepts BOTH shapes: the stored `{id, image, link}` banners written before
 * hero text existed, and the new localized ones. An old banner simply comes
 * back with three empty text fields, so an existing home page keeps rendering
 * exactly as it did.
 */
export function normalizeHomeBanners(raw: unknown): Record<string, HomeBanner[]> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, HomeBanner[]> = {};
  for (const [slot, list] of Object.entries(raw as Record<string, unknown>)) {
    if (!Array.isArray(list)) continue;
    const banners = list
      .slice(0, MAX_BANNERS_PER_SLOT)
      .map(normalizeBanner)
      .filter((b): b is HomeBanner => b !== null);
    if (banners.length) out[slot.slice(0, 60)] = banners;
  }
  return out;
}

export function normalizeSectionItems(raw: unknown): Record<string, HomeSectionItem[]> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, HomeSectionItem[]> = {};
  for (const [slot, list] of Object.entries(raw as Record<string, unknown>)) {
    if (!Array.isArray(list)) continue;
    const items = list
      .slice(0, MAX_SECTION_ITEMS)
      .map((raw2): HomeSectionItem | null => {
        if (!raw2 || typeof raw2 !== 'object') return null;
        const o = raw2 as Record<string, unknown>;
        const title = text(o.title, MAX_TEXT);
        const image = safeImage(o.image);
        // Nothing to show without either a label or a picture.
        if (!title && !image) return null;
        return {
          id: typeof o.id === 'string' && o.id ? o.id.slice(0, 60) : nextId('si'),
          title,
          subtitle: text(o.subtitle, MAX_SUBTITLE),
          image,
          link: safeLink(o.link),
        };
      })
      .filter((x): x is HomeSectionItem => x !== null);
    if (items.length) out[slot.slice(0, 60)] = items;
  }
  return out;
}
