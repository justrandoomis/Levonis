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

export type SiteMediaGroup = 'brand' | 'service' | 'banner';

export interface SiteMediaSlot {
  /** Stable id. Also the filename stem an upload is minted under. */
  slot: string;
  group: SiteMediaGroup;
  /** Shown in the admin list. Not user-facing on the storefront. */
  label: string;
  /**
   * The object name inside MAIN_PAGE_PREFIX to use when the owner has not
   * uploaded anything for this slot. Empty means "no image; fall back to
   * whatever the surface drew before".
   */
  defaultObject: string;
  /** Where the storefront sends someone who taps it, for brand marks. */
  link?: string;
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
 * One slot per card on the home services rail. `defaultObject` is empty for
 * all of them on purpose: until the owner uploads something, ServicesGrid
 * keeps drawing its lucide icon, which is a deliberate design and not a
 * placeholder. An upload turns that card into an image card.
 *
 * The ids match ServicesGrid's `data-service` attributes exactly, so the
 * storefront looks a card's image up by the id it already has.
 */
export const SERVICE_SLOTS: readonly SiteMediaSlot[] = [
  { slot: 'service-studio', group: 'service', label: 'Studio', defaultObject: '' },
  { slot: 'service-warranty', group: 'service', label: 'Warranty', defaultObject: '' },
  { slot: 'service-tools', group: 'service', label: 'Tools', defaultObject: '' },
  { slot: 'service-bundles', group: 'service', label: 'Bundles', defaultObject: '' },
  { slot: 'service-community', group: 'service', label: 'Community', defaultObject: '' },
  { slot: 'service-rewards', group: 'service', label: 'Rewards', defaultObject: '' },
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

export const SITE_MEDIA_SLOTS: readonly SiteMediaSlot[] = [
  ...BRAND_SLOTS,
  ...SERVICE_SLOTS,
  ...BANNER_SLOTS,
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
    };
  });
}
