/**
 * A SECTION'S PICTURES, FOR EACH THEME AND EACH SCREEN (migration 0149).
 *
 * The owner, 2026-09-28: «في صور الأقسام الفرعية والأقسام الرئيسية اجعل هنالك
 * صورتين أيضا فيما يخص الوضع الداكن والوضع الفاتح وتكون الأبعاد متجاوبة مع
 * جميع الأجهزة … أربع صور اثنين وضع داكن لقياسين اثنين وضع فاتح لقياسين».
 *
 * Every section, main or sub, draws two pictures, and each is a SET of four:
 *
 *              large screen            phone (< 640 px)
 *   card       image_url               mobile_image_url          dark
 *              light_image_url         light_mobile_image_url    light
 *   banner     hero_image_url          hero_mobile_image_url     dark
 *              hero_light_image_url    hero_light_mobile_image_url  light
 *
 * The CARD is the home tile (src/lib/homeLayout.ts `resolveBento`); the BANNER
 * is the explorer's rows and the top of the section's own page
 * (src/lib/catalog/explorerModel.ts `authoredPhoto`).
 *
 * Every slot is optional, so one rule decides what fills an empty one, and it
 * is the same rule everywhere:
 *
 *   1. THE SETS IN THE CALLER'S ORDER — a banner's own pictures before the
 *      card's. A banner is composed for a strip; a card picture stretched
 *      across one is the fallback for a section with no banner at all, not
 *      for a banner missing one theme (the rule 0142 set, and a test holds).
 *   2. Within a set, THE THEME ON SCREEN FIRST. A dark picture on the cream
 *      theme is the "dark island" the owner had removed from the page; a
 *      light one on the dark theme is its mirror.
 *   3. Then the screen's own size before the other — a picture composed for a
 *      phone is still that section, in that theme, when the large one is
 *      missing, and the CSS crops it to the frame.
 *
 * Nothing here fetches: the four answers are computed at once and the
 * renderers pick one with the theme (known before the first paint) and a
 * `<source media>` for the phone, so the browser downloads exactly one file.
 */

export type PictureTheme = 'light' | 'dark';
export type PictureScreen = 'large' | 'phone';

/** One picture's four files; '' where nothing was uploaded. */
export interface PictureSet {
  dark: string;
  light: string;
  darkPhone: string;
  lightPhone: string;
}

/**
 * "A phone" — below Tailwind's `sm` (640 px), the width at which the banner
 * rows change proportion (src/components/catalog/CategoryRowBanners.tsx
 * `ROW_BANNER_SIZE`). One definition, so the admin's advice and the
 * storefront's `<source media>` can never disagree about what a phone is.
 */
export const PHONE_MEDIA = '(max-width: 639px)';

/** A section as the storefront receives it: any of the eight may be missing (an older Worker, a cached answer). */
export interface SectionPictureFields {
  image_url?: string | null;
  light_image_url?: string | null;
  mobile_image_url?: string | null;
  light_mobile_image_url?: string | null;
  hero_image_url?: string | null;
  hero_light_image_url?: string | null;
  hero_mobile_image_url?: string | null;
  hero_light_mobile_image_url?: string | null;
}

const clean = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/** The card's set: the home tile (0100 + 0149). */
export function cardSet(node: SectionPictureFields): PictureSet {
  return {
    dark: clean(node.image_url),
    light: clean(node.light_image_url),
    darkPhone: clean(node.mobile_image_url),
    lightPhone: clean(node.light_mobile_image_url),
  };
}

/** The banner's set: the explorer rows and the page's hero (0136 + 0142 + 0149). */
export function bannerSet(node: SectionPictureFields): PictureSet {
  return {
    dark: clean(node.hero_image_url),
    light: clean(node.hero_light_image_url),
    darkPhone: clean(node.hero_mobile_image_url),
    lightPhone: clean(node.hero_light_mobile_image_url),
  };
}

function slot(set: PictureSet, theme: PictureTheme, screen: PictureScreen): string {
  if (theme === 'light') return screen === 'phone' ? set.lightPhone : set.light;
  return screen === 'phone' ? set.darkPhone : set.dark;
}

const otherTheme = (t: PictureTheme): PictureTheme => (t === 'light' ? 'dark' : 'light');
const otherScreen = (s: PictureScreen): PictureScreen => (s === 'phone' ? 'large' : 'phone');

/** Where a picture came from: which of the caller's sets, and which of its four slots. */
export interface PictureOrigin {
  set: number;
  theme: PictureTheme;
  screen: PictureScreen;
  file: string;
}

/**
 * The slot `theme` on `screen` draws from `sets` (best first), or null — the
 * rule in the header. The admin's dialog uses the origin to say what an empty
 * slot shows instead; the storefront only needs the file (`pickPicture`).
 */
export function pickPictureOrigin(
  sets: readonly PictureSet[],
  theme: PictureTheme,
  screen: PictureScreen
): PictureOrigin | null {
  for (let i = 0; i < sets.length; i++) {
    for (const t of [theme, otherTheme(theme)]) {
      for (const s of [screen, otherScreen(screen)]) {
        const file = slot(sets[i], t, s);
        if (file) return { set: i, theme: t, screen: s, file };
      }
    }
  }
  return null;
}

/** The one file `theme` on `screen` draws from `sets` (best first), or ''. */
export function pickPicture(sets: readonly PictureSet[], theme: PictureTheme, screen: PictureScreen): string {
  return pickPictureOrigin(sets, theme, screen)?.file ?? '';
}

/**
 * All four answers — what a renderer needs, since the theme and the screen are
 * only known in the browser. Either every field is filled or none is: one
 * uploaded picture answers all four.
 */
export function resolvePictures(sets: readonly PictureSet[]): PictureSet {
  return {
    dark: pickPicture(sets, 'dark', 'large'),
    light: pickPicture(sets, 'light', 'large'),
    darkPhone: pickPicture(sets, 'dark', 'phone'),
    lightPhone: pickPicture(sets, 'light', 'phone'),
  };
}

/** A resolved set in the shape the photo components take — only what differs is carried. */
export interface PictureSources {
  /** The dark theme's picture on a large screen: always set. */
  src: string;
  /** The light theme's, when it is not `src`. */
  lightSrc?: string;
  /** The dark theme's on a phone, when it is not `src`. */
  mobileSrc?: string;
  /** The light theme's on a phone, when it is not the light theme's large one. */
  lightMobileSrc?: string;
}

/** `resolvePictures` → the components' props, or null when the section has no picture at all. */
export function pictureSources(resolved: PictureSet): PictureSources | null {
  if (!resolved.dark) return null;
  const light = resolved.light || resolved.dark;
  return {
    src: resolved.dark,
    ...(light !== resolved.dark ? { lightSrc: light } : {}),
    ...(resolved.darkPhone && resolved.darkPhone !== resolved.dark ? { mobileSrc: resolved.darkPhone } : {}),
    ...(resolved.lightPhone && resolved.lightPhone !== light ? { lightMobileSrc: resolved.lightPhone } : {}),
  };
}

/**
 * The two files one theme draws, from a photo's props: the large screen's,
 * and the phone's (the large one when there is no phone picture). The ONE
 * place the components turn props into files, so `PromoPhoto` and
 * `CropPhoto` cannot drift apart.
 */
export function themedFiles(p: PictureSources, theme: PictureTheme): { large: string; phone: string } {
  const large = theme === 'light' && p.lightSrc ? p.lightSrc : p.src;
  const phone = (theme === 'light' ? p.lightMobileSrc : p.mobileSrc) || large;
  return { large, phone };
}
