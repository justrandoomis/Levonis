/**
 * THE MAIN PAGE'S OWN PICTURES, AND WHO IS ALLOWED TO REPLACE THEM.
 *
 * Brand logos and service icons are not user content and not catalogue
 * content: they are a handful of fixed images the shop's owner controls, they
 * change perhaps twice a year, and every visitor loads all of them on the
 * first screen. That combination is what this module is for.
 *
 * WHY A SEPARATE PREFIX. `buildMediaKey` produces four segments —
 * `domain/entity/kind/object.ext` — and every prefix it can produce is scoped
 * to an owner or an entity. These files have neither: there is one Bambu Lab
 * logo for the whole site. They live under `UiUx/MainPage/`, which
 * `isAnonymousPublicMediaKey` already serves to signed-out visitors (the
 * case-insensitive `ui(ux)?/` rule), so a brand mark is fetchable by the
 * person who has not signed in — which is every first-time visitor, and
 * exactly the audience a brand strip is for.
 *
 * WHY EVERY UPLOAD GETS A NEW OBJECT NAME. `/files/*` serves public keys with
 * `Cache-Control: public, max-age=31536000, immutable`. Writing a replacement
 * over the SAME key would leave every browser and every Cloudflare POP that
 * already has the old bytes serving them for a year, with no way to purge from
 * here — the owner would swap a logo, see the old one, and have no recourse.
 * So an upload mints `<slot>-<token>.webp` and the pointer in `mainPageMedia`
 * moves to it. The URL changes, so the cache is bypassed by construction, and
 * `immutable` stays truthful.
 *
 * WHY THE DEFAULTS NAME FILES THAT ARE ALREADY THERE. The seven brand marks
 * were uploaded to this prefix by hand before any of this existed. Pointing
 * the defaults at those exact object names — including `Bamabulab.webp`, whose
 * spelling is not the brand's — means the strip renders correctly with an
 * empty `mainPageMedia` setting and no migration. The first admin upload for a
 * slot replaces the default and the misspelling stops mattering.
 */

import { isSafeMediaKey } from './mediaStorage';

export const MAIN_PAGE_PREFIX = 'UiUx/MainPage/';

/** The only format admin site media may be stored in, per the owner's rule. */
export const SITE_MEDIA_MIME = 'image/webp';
export const SITE_MEDIA_MAX_BYTES = 2 * 1024 * 1024;

export type SiteMediaGroup = 'brand' | 'service' | 'banner' | 'home';

export interface SiteMediaSlot {
  /** Stable id. Also the filename stem an upload is minted under. */
  slot: string;
  group: SiteMediaGroup;
  /**
   * Shown in the admin list — AND, for a brand slot, it is now the only
   * accessible name the storefront has for that mark.
   *
   * This comment used to say "not user-facing on the storefront", and that
   * stopped being true when the brand belt dropped its captions: the logo's
   * `alt` is this string (src/components/home/Strips.tsx), so a screen reader
   * reads it aloud and nothing else names the link. Changing a brand slot's
   * label is therefore a user-facing edit, and it must stay a brand's actual
   * name rather than a note to whoever maintains the list.
   */
  label: string;
  /**
   * The object name inside MAIN_PAGE_PREFIX to use when the owner has not
   * uploaded anything for this slot. Empty means "no image; fall back to
   * whatever the surface drew before".
   */
  defaultObject: string;
  /**
   * Where the storefront sends someone who taps it.
   *
   * A router PATH (`/compare`, optionally with a query string) for everything
   * that lives inside this application, and an absolute URL for the one card
   * that does not — LEVO Studio runs on its own subdomain. Empty means the
   * surface decides, which is still the case for the banner slots.
   *
   * This is not decoration for the admin list: tests/serviceSlots.test.ts
   * resolves every service link against the route table in src/App.tsx and
   * fails the build if one of them would 404. That check is the whole reason
   * the destination is data here instead of a string buried in a component.
   */
  link?: string;
  /**
   * `home` slots only: the home picture this is one half of (`hero`,
   * `bento-printers`, `editorial-materials`, …) and which theme it is for.
   * See HOME_PHOTO_SLOTS.
   */
  target?: HomePhotoTarget;
  theme?: 'light' | 'dark';
}

/**
 * The seven marks the owner asked for, in the order they should appear.
 *
 * `defaultObject` is transcribed from what is actually in the bucket, NOT from
 * the brand's own spelling — see the header note about `Bamabulab.webp`.
 */
export const BRAND_SLOTS: readonly SiteMediaSlot[] = [
  { slot: 'brand-bambulab', group: 'brand', label: 'Bambu Lab', defaultObject: 'Bamabulab.webp', link: '/products?search=Bambu%20Lab' },
  { slot: 'brand-creality', group: 'brand', label: 'Creality', defaultObject: 'Creality.webp', link: '/products?search=Creality' },
  { slot: 'brand-qidi', group: 'brand', label: 'QIDI', defaultObject: 'Qidi.webp', link: '/products?search=QIDI' },
  { slot: 'brand-biqu', group: 'brand', label: 'BIQU', defaultObject: 'Biqu.webp', link: '/products?search=BIQU' },
  { slot: 'brand-bigtreetech', group: 'brand', label: 'BIGTREETECH', defaultObject: 'Bigtreetech.webp', link: '/products?search=BIGTREETECH' },
  { slot: 'brand-esun', group: 'brand', label: 'eSUN', defaultObject: 'Esun.webp', link: '/products?search=eSUN' },
  { slot: 'brand-antinsky', group: 'brand', label: 'Antinsky', defaultObject: 'Antinsky.webp', link: '/products?search=Antinsky' },
] as const;

/**
 * ONE SLOT PER CARD ON THE HOME SERVICES RAIL — ELEVEN, IN THE OWNER'S ORDER.
 *
 * WHY THESE NOW CARRY A DEFAULT AND A LINK, WHEN THEY CARRIED NEITHER.
 *
 * `defaultObject: ''` was correct for exactly as long as the bucket held no
 * service artwork: an empty url means "keep drawing the lucide icon", which is
 * a deliberate design and not a hole. The owner has since uploaded the marks
 * to `UiUx/MainPage/` and named which belongs to which service, so the honest
 * default is no longer "nothing" — it is the file that is actually there. A
 * slot whose default stayed empty while its image sat in R2 would mean the
 * owner has to re-upload, through the admin panel, a file already in the
 * bucket, and would keep the rail looking unfinished until they did.
 *
 * THE CASE IS TRANSCRIBED FROM THE BUCKET, NOT GUESSED. `UiUx/MainPage/` has
 * been spelled three ways across this codebase's history and an exact-match
 * rule on the wrong one sent the site's own logo to the private bucket
 * (worker/lib/mediaStorage.ts documents that live bug at length). The object
 * NAMES inside the prefix get no such case-insensitive rescue — R2 keys are
 * byte-exact — so `LevoStudio.webp` written as `Levostudio.webp` is a 404 and
 * a broken tile. Every name below was read off a live listing of the prefix.
 *
 * `service-community` IS THE ONE EXCEPTION AND IT IS DELIBERATE. The owner's
 * list names `Community.webp`, but that object is not in the bucket: a GET for
 * it — and for every plausible re-spelling — answers 404 while its ten
 * neighbours answer 200. The slot still carries the name the owner intends,
 * because the moment the file is uploaded under it the card lights up with no
 * code change; until then ServicesGrid's image `onError` falls back to the
 * drawn icon, so a missing object costs a fallback rather than a broken image.
 * Do not "fix" this by blanking the default — that would silently discard the
 * owner's naming decision and make the upload a code change again.
 *
 * WHY A LINK LIVES HERE AT ALL. A service card's destination used to exist
 * only inside ServicesGrid, so the admin list could show the owner an icon
 * with no way to see, or check, where tapping it goes. The brand slots already
 * carried `link` for the same reason. tests/serviceSlots.test.ts fails if any
 * path below is not a route App.tsx actually serves — a list of links nobody
 * verifies is how a storefront comes to promise a page it does not have.
 *
 * The ids are the contract with the storefront: ServicesGrid looks a card's
 * image up as `service-${card.id}` using the id it already puts in
 * `data-service`, and `mainPageMedia` stores uploads under these exact
 * strings. The six that existed before keep their ids unchanged, so no stored
 * upload is orphaned by this edit.
 */
export const SERVICE_SLOTS: readonly SiteMediaSlot[] = [
  /**
   * The Studio is a SEPARATE APPLICATION on its own subdomain, so this one
   * link is an absolute URL and not a router path. The raw origin is pinned to
   * `STUDIO_URL` in src/translations.ts by tests/serviceSlots.test.ts rather
   * than left to drift: the store still navigates to it through that constant
   * (docs/STUDIO_PLAN.md decision 6 — a plain full-page `<a>`, never an
   * iframe), and this copy exists only so the admin list and the link audit
   * can see where the card goes. The Worker cannot import from src/.
   */
  { slot: 'service-studio', group: 'service', label: 'ليفو استوديو', defaultObject: 'LevoStudio.webp', link: 'https://studio.levonis-iq.com' },
  { slot: 'service-compare', group: 'service', label: 'المقارنة', defaultObject: 'Compare.webp', link: '/compare' },
  { slot: 'service-tools', group: 'service', label: 'أدوات الطباعة', defaultObject: 'Tools.webp', link: '/tools' },
  { slot: 'service-bundles', group: 'service', label: 'الباقات', defaultObject: 'Bundle.webp', link: '/bundles' },
  /**
   * «الفلامنت العشوائي» is not a page of its own and must not become one: the
   * mystery offers are already a FILTER on the bundles page (`?kind=mystery`,
   * a chip Bundles.tsx reads out of the query string), and inventing a second
   * surface for the same rows is how two listings of one thing start
   * disagreeing about stock. The query string is part of the destination, so
   * the link audit checks the PATH and ignores the search — see the test.
   */
  { slot: 'service-mystery', group: 'service', label: 'الفلامنت العشوائي', defaultObject: 'Randoms.webp', link: '/bundles?kind=mystery' },
  { slot: 'service-tradein', group: 'service', label: 'استبدل القديمة بجديدة', defaultObject: 'Replace.webp', link: '/trade-in' },
  { slot: 'service-used', group: 'service', label: 'مستعمل ومجدّد و Open Box', defaultObject: 'Used.webp', link: '/used-printers' },
  { slot: 'service-rewards', group: 'service', label: 'النقاط والمكافآت', defaultObject: 'Reward.webp', link: '/points' },
  { slot: 'service-warranty', group: 'service', label: 'الضمان والصيانة', defaultObject: 'Warranty.webp', link: '/warranty' },
  { slot: 'service-community', group: 'service', label: 'المجتمع', defaultObject: 'Community.webp', link: '/community' },
  { slot: 'service-support', group: 'service', label: 'الدعم', defaultObject: 'Support.webp', link: '/support' },
] as const;

/**
 * Spare slots for main-page artwork that is not a brand or a service card.
 * The hero carousel keeps its own `homeBanners` setting — this is for the
 * fixed decorative images around it, so the owner has somewhere to put a
 * WebP without inventing a key.
 */
export const BANNER_SLOTS: readonly SiteMediaSlot[] = [
  { slot: 'banner-1', group: 'banner', label: 'Main page image 1', defaultObject: '' },
  { slot: 'banner-2', group: 'banner', label: 'Main page image 2', defaultObject: '' },
  { slot: 'banner-3', group: 'banner', label: 'Main page image 3', defaultObject: '' },
] as const;

/**
 * THE HOME PAGE'S OWN PHOTOGRAPHS — ONE FOR EACH THEME.
 *
 * The owner (2026-09-26): «أجعل الصورة يمكن تغييرها من قسم تعديل اللوحة
 * الرئيسية للأدمن حيث يضع صورتين تناسب الثيم الفاتح والثيم الداكن». Every
 * picture the home page draws full-bleed — the hero's visual, the six bento
 * tiles, the two editorial banners — gets a PAIR of slots here, `-light` and
 * `-dark`, in the same `mainPageMedia` map as the brand marks. No new store and
 * no migration: the map is already a slot → object pointer, the sweeper in
 * worker/lib/mediaRefs.ts already walks every value of it, and the slot table
 * below is the allow-list the upload route checks a slot name against.
 *
 * The storefront resolves a pair in src/lib/homeLayout.ts `ownerPhoto`: the
 * current theme's picture, else the other one for both themes, else the
 * automatic product photograph it drew before. An empty default means exactly
 * that fallback, so nothing changes until the owner uploads.
 *
 * Unlike a brand mark these are photographs, so an upload may arrive as PNG
 * or JPEG and is converted to WebP on the server (`convertToWebp`); the owner's
 * WebP rule still holds for what is STORED.
 */
export const HOME_PHOTO_TARGETS = [
  { target: 'hero', label: 'الواجهة الرئيسية (الهيرو)' },
  // The bento's six squares by POSITION, not by section — the owner decides
  // which section each one opens (worker/lib/homeBento.ts), and the picture
  // belongs to the square.
  { target: 'bento-large', label: 'تسوق حسب الفئة — المربع الكبير' },
  { target: 'bento-top-1', label: 'تسوق حسب الفئة — المستطيل العلوي الأول' },
  { target: 'bento-top-2', label: 'تسوق حسب الفئة — المستطيل العلوي الثاني' },
  { target: 'bento-bottom-1', label: 'تسوق حسب الفئة — المربع السفلي الأول' },
  { target: 'bento-bottom-2', label: 'تسوق حسب الفئة — المربع السفلي الثاني' },
  { target: 'bento-bottom-3', label: 'تسوق حسب الفئة — المربع السفلي الثالث' },
  { target: 'editorial-multicolor', label: 'بانر «اطبع بأكثر من لون»' },
  { target: 'editorial-materials', label: 'بانر «مواد الطباعة»' },
] as const;

export type HomePhotoTarget = (typeof HOME_PHOTO_TARGETS)[number]['target'];

export const HOME_PHOTO_SLOTS: readonly SiteMediaSlot[] = HOME_PHOTO_TARGETS.flatMap(({ target, label }) =>
  (['light', 'dark'] as const).map(
    (theme): SiteMediaSlot => ({
      slot: `home-${target}-${theme}`,
      group: 'home',
      label: `${label} — ${theme === 'light' ? 'الثيم الفاتح' : 'الثيم الداكن'}`,
      defaultObject: '',
      target,
      theme,
    })
  )
);

/** A photograph slot may take a PNG or JPEG and have it converted; this caps the SOURCE. */
export const HOME_PHOTO_MAX_SOURCE_BYTES = 12 * 1024 * 1024;
/** …and this the WebP that is actually stored. */
export const HOME_PHOTO_MAX_BYTES = 4 * 1024 * 1024;

export const SITE_MEDIA_SLOTS: readonly SiteMediaSlot[] = [
  ...BRAND_SLOTS,
  ...SERVICE_SLOTS,
  ...BANNER_SLOTS,
  ...HOME_PHOTO_SLOTS,
] as const;

const BY_SLOT = new Map(SITE_MEDIA_SLOTS.map((s) => [s.slot, s]));

export function findSiteMediaSlot(slot: unknown): SiteMediaSlot | null {
  return typeof slot === 'string' ? BY_SLOT.get(slot) ?? null : null;
}

/**
 * An object name is a bare filename inside the prefix — no directories, no
 * traversal, and it must survive `isSafeMediaKey` once joined to the prefix.
 * Stored values come from this module's own writes, but they round-trip
 * through a JSON settings row an admin can also edit, so they are re-checked
 * on the way out rather than trusted.
 */
export function isSiteMediaObject(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 120 &&
    /^[A-Za-z0-9][A-Za-z0-9._-]*\.webp$/.test(value) &&
    isSafeMediaKey(MAIN_PAGE_PREFIX + value)
  );
}

export function siteMediaKey(object: string): string {
  return MAIN_PAGE_PREFIX + object;
}

/**
 * The object name a fresh upload is stored under. `token` is supplied by the
 * caller (a request-scoped id) rather than generated here, so this stays a
 * pure function and the unit tests do not have to stub randomness.
 */
export function mintSiteMediaObject(slot: string, token: string): string {
  const stem = slot.replace(/[^A-Za-z0-9-]/g, '').slice(0, 40) || 'media';
  const suffix = token.replace(/[^A-Za-z0-9]/g, '').slice(0, 16).toLowerCase() || 'v';
  return `${stem}-${suffix}.webp`;
}

export interface ResolvedSiteMedia {
  slot: string;
  group: SiteMediaGroup;
  label: string;
  link: string;
  /** `/files/...` path, or '' when the slot has neither an upload nor a default. */
  url: string;
  /** True when the URL comes from an admin upload rather than the seeded default. */
  custom: boolean;
  /** `home` slots only — see HOME_PHOTO_SLOTS. */
  target?: string;
  theme?: 'light' | 'dark';
}

/** The stored shape of the `mainPageMedia` setting: slot id → object name. */
export function normalizeSiteMedia(value: unknown): Record<string, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  const out: Record<string, string> = {};
  for (const [slot, object] of Object.entries(value as Record<string, unknown>)) {
    if (!BY_SLOT.has(slot)) continue;
    if (!isSiteMediaObject(object)) continue;
    out[slot] = object;
  }
  return out;
}

/**
 * Every slot, with the URL the storefront should actually use. Slots with no
 * image at all are included with an empty url so the admin list can offer them
 * and the storefront can tell "not set" from "set to nothing".
 */
export function resolveSiteMedia(stored: unknown): ResolvedSiteMedia[] {
  const map = normalizeSiteMedia(stored);
  return SITE_MEDIA_SLOTS.map((s) => {
    const object = map[s.slot] || s.defaultObject;
    return {
      slot: s.slot,
      group: s.group,
      label: s.label,
      link: s.link ?? '',
      url: object ? `/files/${siteMediaKey(object)}` : '',
      custom: Boolean(map[s.slot]),
      ...(s.target ? { target: s.target, theme: s.theme } : {}),
    };
  });
}

// ===========================================================================
//  A SECTION'S OWN PICTURE
// ===========================================================================

/**
 * THE SAME PREFIX, A DIFFERENT KIND OF OWNER.
 *
 * Everything above is a SLOT: a fixed position in code, one per brand mark and
 * one per service card, whose id the storefront hard-codes. A section is a
 * ROW — the owner creates, renames and deletes them from the admin panel —
 * so its picture cannot be a slot and is stored on the row itself
 * (`catalogs.image_key`, migration 0100).
 *
 * It shares `UiUx/MainPage/` because it is the same kind of file and it hangs
 * on the same screen: artwork the shop owns, that every signed-out visitor
 * loads on the first paint, and that `isAnonymousPublicMediaKey` already
 * serves without a session. A key under any other prefix would ask a
 * first-time visitor to sign in to see a category card.
 *
 * WHAT IS STORED IS THE WHOLE KEY, not the bare object name the slots use:
 * `catalogs.image_key` is walked by the media sweeper as an ordinary text
 * column, and a filename with no prefix matches nothing in the bucket. See
 * migration 0100 and worker/lib/mediaRefs.ts.
 */

/**
 * The object a fresh catalog cover is written under.
 *
 * NEVER a stable name derived from the catalog alone. `/files/*` stamps public
 * keys `immutable` for a year, so a second upload for the same section must
 * land on a different key or the browsers that already hold the first one keep
 * drawing it. `token` is supplied by the caller for the same reason it is in
 * `mintSiteMediaObject` — so this stays pure and the tests need no stub.
 */
export function mintCatalogImageObject(catalogId: string, token: string): string {
  const stem = String(catalogId).replace(/[^A-Za-z0-9-]/g, '').slice(0, 40) || 'section';
  const suffix = String(token).replace(/[^A-Za-z0-9]/g, '').slice(0, 16).toLowerCase() || 'v';
  return `catalog-${stem}-${suffix}.webp`;
}

/**
 * Is this a key a section cover may actually be stored at?
 *
 * The column round-trips through D1 and is read back by the storefront, so it
 * is re-checked on the way OUT rather than trusted: it must sit inside
 * `UiUx/MainPage/`, be a WebP (the owner's standing rule for site artwork),
 * and survive `isSafeMediaKey` — which is what rejects a traversal, an
 * absolute URL, or a key pointed at somebody's private upload.
 */
export function isCatalogImageKey(value: unknown): value is string {
  if (typeof value !== 'string' || !value.startsWith(MAIN_PAGE_PREFIX)) return false;
  const object = value.slice(MAIN_PAGE_PREFIX.length);
  return isSiteMediaObject(object);
}

/** The `/files/...` path for a stored cover, or '' when there is no usable one. */
export function catalogImageUrl(key: unknown): string {
  return isCatalogImageKey(key) ? `/files/${key}` : '';
}
