/**
 * THE INSTALLED APP'S IDENTITY — one pure function, no I/O.
 *
 * A web app manifest is not a page. The browser reads it ONCE, at install
 * time, and what it reads is baked into the home screen: the name under the
 * icon, the icon itself, the colour of the splash screen, the URL the app
 * opens on. There is no second chance and no error a customer can see — a
 * manifest that is malformed, or that 500s, simply makes the site
 * "not installable", silently, in every browser at once.
 *
 * So this module holds no Hono, no D1, no env and no fetch. It takes an
 * already-loaded identity and returns a plain object. That is the whole
 * contract, and it exists so the decisions below can be tested exhaustively
 * without a database: the truncation rule, the icon rule, the fallbacks.
 *
 * WHY THE MANIFEST IS PER-HOST AT ALL. `ali3d.levonis-iq.com` and
 * `levonis-iq.com` are the same built bundle on two different origins
 * (`src/App.tsx` hands the whole application to `StorefrontApp` when the
 * hostname is a store). A single static `public/manifest.webmanifest` would
 * therefore install every merchant's shop on its customers' phones as
 * "LEVONIS", with LEVONIS's mark — the shop's own brand replaced by the
 * platform's, on the customer's home screen, permanently. The manifest has to
 * answer with the identity of the host that asked for it, which is why it is
 * a Worker route (`worker/routes/manifest.ts`) and not a file in `public/`.
 *
 * NOTHING HERE MAY THROW. The caller is a route whose only correct failure
 * mode is "serve the platform manifest anyway"; a builder that threw on a
 * surprising row would turn one bad store name into an uninstallable site.
 * Every field is read defensively and every unusable value falls back.
 */

/**
 * What a manifest is built from. Deliberately NOT `StoreRow`: this module
 * must stay usable — and testable — without the merchant schema, and the four
 * fields below are the only ones an installed app's identity is made of.
 *
 * Every field is optional and every field is `unknown`-tolerant on purpose.
 * The caller is a database row, and a database row is not a promise.
 */
export interface ManifestIdentity {
  /** `merchant_stores.name`. Blank, missing or whitespace-only means "the platform". */
  name?: string | null;
  /** `merchant_stores.tagline`, if it says something. Becomes `description`. */
  tagline?: string | null;
  /**
   * `merchant_stores.logo_key` — an R2 key, NOT a URL. Rendered as
   * `/files/<key>`, exactly as `worker/routes/storefront.ts` renders it.
   */
  logoKey?: string | null;
}

export interface WebManifestIcon {
  src: string;
  /**
   * Optional, and its absence is a statement. See `storeLogoIcon` — we emit a
   * size only when we actually know it, which for the platform PNGs is always
   * and for a merchant's uploaded logo is never.
   */
  sizes?: string;
  type: string;
  purpose: 'any' | 'maskable';
}

export interface WebManifestShortcut {
  name: string;
  short_name: string;
  url: string;
  icons: WebManifestIcon[];
}

export interface WebManifest {
  id: string;
  name: string;
  short_name: string;
  description: string;
  lang: string;
  dir: 'rtl';
  start_url: string;
  scope: string;
  display: 'standalone';
  background_color: string;
  theme_color: string;
  categories: string[];
  icons: WebManifestIcon[];
  shortcuts: WebManifestShortcut[];
}

/** The platform's own identity, used on the apex, on system hosts and on every fallback. */
export const PLATFORM_NAME = 'LEVONIS';
export const PLATFORM_DESCRIPTION =
  'ليفونيس — متجر الطباعة ثلاثية الأبعاد: طابعات، خيوط، قطع جاهزة وطلبات طباعة حسب الطلب.';

/**
 * THE DOCUMENT'S BLACK, NOT THE THEME TOKEN'S.
 *
 * `index.html` paints `#000000` — the page background, the `theme-color` meta
 * and the pre-CSS inline style all agree on it. Tailwind's `@theme` block in
 * `src/index.css` deliberately SOFTENS `--color-canvas` to `#0b0c0f`, so
 * `bg-black` in a class name is not this colour. The splash screen the
 * launcher paints from `background_color` sits next to the real document, not
 * next to a Tailwind surface, so it must be the document's black or the app
 * flashes a lighter rectangle on every cold start.
 */
const BLACK = '#000000';

/**
 * A launcher shows roughly twelve characters under an icon before it elides.
 *
 * This is a budget, not a limit: `short_name` is advisory and no browser
 * refuses a longer one. It is enforced here because the alternative is the
 * launcher choosing where to cut, and a launcher cuts by pixel width in the
 * middle of a word — which in Arabic breaks the connected form of the letters
 * and can leave a fragment that reads as a different word entirely.
 */
const SHORT_NAME_BUDGET = 12;

/**
 * `merchant_stores.name` is written through `str(body.name, 'name', { max: 60 })`
 * (`worker/routes/merchant.ts`), so 60 is the shape of the data. It is
 * re-applied here rather than assumed because this function must also survive
 * a row that predates that validator or arrived by import.
 */
const NAME_MAX = 60;
/**
 * The tagline that becomes `description` is written through
 * `{ max: 140 }`, so no store the current write path produced can reach this
 * bound. The headroom is for rows that predate that validator or arrived by
 * import — clamping prose is a cosmetic loss, and an unbounded string in a
 * document every installing browser downloads is not.
 */
const DESCRIPTION_MAX = 200;

/**
 * CHARACTERS THAT MOVE OTHER CHARACTERS.
 *
 * A store name is merchant-supplied text that is about to be written under an
 * icon on a stranger's home screen, where there is no surrounding page to give
 * it context and no way to inspect it. U+202E RIGHT-TO-LEFT OVERRIDE and its
 * neighbours reorder everything that follows them, which is the oldest
 * display-spoofing trick there is: in an interface that is already RTL, an
 * override is invisible and its effect is not.
 *
 * Zero-width characters are stripped for the adjacent reason — they let two
 * different names render identically, and they defeat the word-boundary search
 * below by looking like a letter to `length` and like nothing to the eye.
 *
 * C0/C1 controls go too: a newline inside a manifest string is legal JSON and
 * an illegible app name.
 */
// Every character below is written as a \u escape rather than pasted: the
// pasted form is invisible in a diff, so an editor that silently dropped one
// would leave a guard that reads as present and is not.
// eslint-disable-next-line no-control-regex -- the C0/C1 range is the point.
const UNSAFE_TEXT = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g;

/**
 * THE SENTENCE A SHOP GETS WHEN IT HAS WRITTEN NO TAGLINE, and it is a
 * generated string in a language with a definite article, so it needs care.
 *
 * The obvious form, `متجر ${name} على منصة LEVONIS`, stutters for the commonest
 * shop-name shape on this platform. Iraqi merchants overwhelmingly name
 * themselves «متجر X», «محل X», «شركة X» or «مؤسسة X» — the noun is already in
 * the name — so prefixing another one produced «متجر متجر علي على منصة LEVONIS»
 * for a real, ordinary store. Chromium shows this string in its install dialog
 * and some launchers print it under the app, so it is read by the customer at
 * the exact moment they are deciding whether this shop is a real one.
 *
 * The noun is therefore added only when the name does not already open with
 * one. The list is the four that actually occur; it is a readability fix, not
 * a parser, and a name that slips past it reads as «متجر <name>» — which is
 * correct, merely wordier, and never wrong the way the double noun was.
 *
 * The brand is written «ليفونيس» rather than `PLATFORM_NAME`. Latin letters in
 * the middle of an Arabic sentence flip the run direction mid-line, and this
 * string has no surrounding page to steady it; the Arabic spelling is the one
 * PLATFORM_DESCRIPTION two constants above already uses for the same reason.
 */
const NAME_ALREADY_HAS_A_NOUN = /^(?:متجر|محل|شركة|مؤسسة|معمل|ورشة)\s/;

function storeDescription(name: string): string {
  const subject = NAME_ALREADY_HAS_A_NOUN.test(name) ? name : `متجر ${name}`;
  return `${subject} على منصة ليفونيس`;
}

/**
 * Text as it may appear in a manifest, or `''`.
 *
 * `Array.from` rather than `slice`, because a name may contain an emoji: a
 * UTF-16 `slice` can cut a surrogate pair in half and produce a lone surrogate,
 * which `JSON.stringify` will happily emit and the browser will render as a
 * replacement glyph in the app's name forever.
 */
function cleanText(raw: unknown, max: number): string {
  if (typeof raw !== 'string') return '';
  const collapsed = raw.replace(UNSAFE_TEXT, ' ').replace(/\s+/g, ' ').trim();
  const chars = Array.from(collapsed);
  return (chars.length <= max ? collapsed : chars.slice(0, max).join('')).trim();
}

/**
 * A launcher-sized name, cut only at a word boundary.
 *
 * THE CASE WITH NO BOUNDARY IS THE INTERESTING ONE. A single word longer than
 * the budget — common in Arabic and Kurdish compounds — has nowhere to cut.
 * Cutting it anyway produces a fragment, and returning `''` produces a manifest
 * whose `short_name` is empty, which some launchers render as a blank label
 * under the icon. So the word is kept whole and the launcher elides it itself,
 * with its own ellipsis, in its own font. `name` is already clamped to
 * `NAME_MAX`, so "whole" is bounded.
 */
function shortNameFrom(name: string): string {
  const chars = Array.from(name);
  if (chars.length <= SHORT_NAME_BUDGET) return name;
  // One character past the budget, so a space sitting exactly on the boundary
  // is found and the word before it is kept in full.
  const head = chars.slice(0, SHORT_NAME_BUDGET + 1).join('');
  const boundary = head.lastIndexOf(' ');
  if (boundary > 0) return head.slice(0, boundary).trim();
  const firstSpace = name.indexOf(' ');
  return firstSpace > 0 ? name.slice(0, firstSpace) : name;
}

/**
 * THE PLATFORM ICONS ARE THE ONLY ONES WHOSE PIXELS ARE KNOWN.
 *
 * `public/icons/` is committed artwork (`scripts/build-pwa-icons.mjs`), copied
 * verbatim to `dist/icons/` by Vite's default `publicDir`, so both the byte
 * size and the MIME type are facts at build time rather than guesses at
 * request time. `tests/webManifest.test.ts` asserts every one of these files
 * exists on disk, because a manifest icon that 404s is the single failure that
 * makes Android refuse to install a site while reporting nothing to the owner.
 *
 * `any` and `maskable` are separate entries, never one `"any maskable"` entry.
 * The maskable art is inset to about 56% of the tile so a circular Android
 * mask cannot clip the mark; the `any` art fills about 80% because nothing
 * crops it. One entry claiming both purposes forces a browser to use the same
 * pixels for both jobs, and one of the two then looks wrong.
 */
const PLATFORM_ICONS: readonly WebManifestIcon[] = [
  { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
  { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
  { src: '/icons/maskable-192.png', sizes: '192x192', type: 'image/png', purpose: 'maskable' },
  { src: '/icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
];

/**
 * The key shapes `/files/` serves to an anonymous visitor, and nothing else.
 *
 * This mirrors `isAnonymousPublicMediaKey` (`worker/lib/mediaStorage.ts`)
 * rather than importing it, so this module keeps its "no imports" property.
 * It is a syntax guard, not an authorisation: `/files/` re-checks the key
 * itself and answers 404 for anything it does not recognise, exactly as it
 * does for the same `/files/<logo_key>` URL that `worker/routes/storefront.ts`
 * already puts in the storefront page.
 */
const PUBLIC_LOGO_KEY = /^(?:community\/[^/\s]+\/[^/\s]+|merchants\/[^/\s]+\/(?:public|logos|covers)\/[^/\s]+)$/;

/**
 * The stored extension is the honest MIME.
 *
 * `storeMedia` builds every key as `<id>.<extensionFor(mime)>` from the MIME
 * the bytes were SNIFFED as, never the one the browser claimed, and it stores
 * that same MIME as the R2 object's `contentType`. So the extension on the key
 * and the `Content-Type` `/files/` will serve cannot disagree. Uploads are
 * converted to WebP where the Images binding allows it and stored under their
 * true type where it does not — which is precisely why this is a table and not
 * a hardcoded `image/webp`.
 */
const LOGO_TYPES: Readonly<Record<string, string>> = {
  webp: 'image/webp',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  avif: 'image/avif',
};

/**
 * The merchant's own logo as an EXTRA icon entry — with no `sizes`, on purpose.
 *
 * THE DECISION, AND THE ONE THAT WAS REJECTED. `sizes: "any"` is not a polite
 * "unknown"; in the manifest specification it means SCALABLE, and it is there
 * for vector art. Claiming it for a raster logo invites a browser to prefer
 * this entry over the 512-pixel PNG and then stretch a 96-pixel WebP across a
 * launcher tile — a permanently blurry icon on a customer's home screen, which
 * is worse than the platform mark. A wrong `sizes` is worse than no entry, and
 * no `sizes` is the one statement that is true: an R2 key carries no pixel
 * dimensions. (`file_objects.width/height` sometimes does, but that column is
 * best-effort — `recordMediaObject` swallows its own failure by design and not
 * every upload path supplies dimensions — so a second read would answer
 * "unknown" often enough to need this branch anyway.)
 *
 * WHAT THAT COSTS. Chromium picks an icon by declared size, so it will keep
 * choosing the platform PNGs; this entry is for the browsers that read the
 * bytes, and it is a true statement in all of them. The day merchant logo
 * dimensions are recorded reliably, adding `sizes` here is a one-line change
 * and the entry starts winning.
 *
 * `purpose: 'any'`, never `maskable`: a merchant logo has no guaranteed safe
 * zone, so a circular mask would crop their mark.
 */
function storeLogoIcon(logoKey: unknown): WebManifestIcon | null {
  const raw = typeof logoKey === 'string' ? logoKey.trim() : '';
  if (!raw || raw.length > 200) return null;
  // Accept the delivery path too: the store columns hold keys, but older rows
  // and imports have been seen holding `/files/<key>`.
  const key = raw.startsWith('/files/') ? raw.slice('/files/'.length) : raw;
  if (key.includes('..') || key.includes('\\') || !PUBLIC_LOGO_KEY.test(key)) return null;
  const dot = key.lastIndexOf('.');
  const type = dot > 0 ? LOGO_TYPES[key.slice(dot + 1).toLowerCase()] : undefined;
  // An unrecognised extension means we cannot name the type honestly, and an
  // icon entry with a wrong `type` is dropped by some browsers and trusted by
  // others. Neither is worth guessing for.
  if (!type) return null;
  return { src: `/files/${key}`, type, purpose: 'any' };
}

/**
 * THREE ROUTES A RETURNING CUSTOMER ACTUALLY HAS.
 *
 * Read off `src/App.tsx` rather than invented. `/products`, `/cart` and
 * `/orders` are declared in BOTH route tables — the normal shell and
 * `StorefrontApp`, the one that takes over the whole application on a merchant
 * subdomain — so the same three shortcuts are correct on every host this route
 * answers for. A shortcut to a path that exists on only one of them would open
 * the storefront's catch-all instead, which renders the shop's front page and
 * looks like the shortcut did nothing.
 *
 * Deliberately NOT a category link. `/products?category=<slug>` is real, but
 * the slug is a taxonomy row this module cannot see, and a shortcut to a
 * category that was renamed opens an empty result page.
 *
 * `icon-192` is reused as every shortcut's icon: a shortcut with no icon gets
 * a generic launcher glyph, and there is no per-shortcut artwork in the repo.
 */
const SHORTCUT_ICONS: WebManifestIcon[] = [
  { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
];

function shortcuts(): WebManifestShortcut[] {
  return [
    { name: 'المنتجات', short_name: 'المنتجات', url: '/products', icons: [...SHORTCUT_ICONS] },
    { name: 'سلة التسوق', short_name: 'السلة', url: '/cart', icons: [...SHORTCUT_ICONS] },
    { name: 'طلباتي', short_name: 'طلباتي', url: '/orders', icons: [...SHORTCUT_ICONS] },
  ];
}

/**
 * Build the manifest for one host's identity.
 *
 * Pass nothing, `null`, or an identity whose name is blank, and you get the
 * platform's manifest — which is what the apex, the system subdomains, an
 * unresolved storefront and every database failure all need.
 */
export function buildWebManifest(identity?: ManifestIdentity | null): WebManifest {
  let name = '';
  let tagline = '';
  let logo: WebManifestIcon | null = null;
  try {
    name = cleanText(identity?.name, NAME_MAX);
    tagline = cleanText(identity?.tagline, DESCRIPTION_MAX);
    logo = name ? storeLogoIcon(identity?.logoKey) : null;
  } catch {
    // An identity is a database row, and this function's whole promise is that
    // it returns a manifest. A getter that throws, a proxy, a row shaped like
    // nothing we expect — all of them become the platform manifest rather than
    // an uninstallable site.
    name = '';
    tagline = '';
    logo = null;
  }

  const isStore = name.length > 0;
  const displayName = isStore ? name : PLATFORM_NAME;
  const description = tagline || (isStore ? storeDescription(name) : PLATFORM_DESCRIPTION);

  return {
    /**
     * `id` IS WHAT KEEPS AN INSTALLED APP THE SAME APP.
     *
     * A browser identifies an installed application by (origin, `id`). Without
     * an explicit `id` it falls back to `start_url`, so the day `start_url`
     * changes every existing installation is orphaned and the next visit
     * offers to install a second copy beside the first.
     *
     * `'/'` on every host, including a merchant's — and that is not a
     * collision, because the slug is already in the ORIGIN. `ali3d` and the
     * apex are two different origins, therefore two different applications,
     * already. Putting the slug in the `id` as well would add nothing and
     * would orphan the merchant's installed app the day they change their
     * address, which `worker/routes/merchant.ts` supports doing.
     */
    id: '/',
    name: displayName,
    short_name: shortNameFrom(displayName),
    description,
    // Arabic-first and RTL, the same two facts `index.html` declares on <html>.
    // A launcher reads these to lay out the app's name and its splash screen.
    lang: 'ar',
    dir: 'rtl',
    /**
     * HOME, NOT THE PAGE THE VISITOR HAPPENED TO BE ON.
     *
     * The manifest is fetched from whatever page the browser first sees, so a
     * `start_url` built from the current path would mean two customers who
     * installed from two different pages own two different applications — and
     * an app launched into `/orders/<id>` opens on an order that may since have
     * been deleted, or on `/checkout` with an empty cart. Home is the only URL
     * that is correct for every installation, forever.
     *
     * Relative, not absolute: the browser resolves it against the manifest's
     * own URL, which is already this host. `trustedOrigin()` would be the wrong
     * helper here — on a merchant host with no APP_ORIGIN it deliberately
     * returns the ROOT domain, which would launch the merchant's installed app
     * into the platform's front page.
     */
    start_url: '/',
    scope: '/',
    display: 'standalone',
    background_color: BLACK,
    theme_color: BLACK,
    categories: ['shopping'],
    /**
     * NO `orientation`. This is a phone-first store, but it is not a
     * phone-only one: the SPA has a real desktop layout (breakpoint classes
     * throughout `src/`, and `src/components/compare/useIsWide.ts` exists to
     * drive a wide-screen table), and a manifest is installable from desktop
     * Chrome and Edge too. `orientation: "portrait"` there produces a tall
     * narrow window on a monitor, and on a tablet it locks a layout that
     * already works in both directions. Omitting the field lets the device
     * decide, which is what it does today in the browser.
     */
    icons: logo ? [logo, ...PLATFORM_ICONS] : [...PLATFORM_ICONS],
    shortcuts: shortcuts(),
  };
}
