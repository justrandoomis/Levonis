import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  BRAND_SLOTS,
  MAIN_PAGE_PREFIX,
  SERVICE_SLOTS,
  SITE_MEDIA_SLOTS,
  findSiteMediaSlot,
  isSiteMediaObject,
  mintSiteMediaObject,
  normalizeSiteMedia,
  resolveSiteMedia,
  siteMediaKey,
} from '../worker/lib/siteMedia';
import {
  isAnonymousPublicMediaKey,
  isRewritableMediaKey,
  isSafeMediaKey,
} from '../worker/lib/mediaStorage';
import {
  PLATFORM_ICONS,
  PLATFORM_ICON_REVISION,
  ROOT_FAVICON,
  SITE_LOGO_KEY,
  SITE_LOGO_SHARE_URL,
  SITE_LOGO_SLOT,
  SITE_LOGO_URL,
  SITE_LOGO_VERSIONED_URL,
  SITE_ORIGIN,
  resolveSiteLogoUrl,
} from '../src/lib/siteLogo';

/**
 * The seven marks the owner asked for, spelled as the OBJECTS IN THE BUCKET
 * are spelled — `Bamabulab.webp` included. If someone "corrects" that to
 * `Bambulab.webp` the strip silently renders seven broken images, because the
 * file under the corrected name does not exist. This test is the tripwire.
 */
test('the seeded brand defaults name the objects that are actually in R2', () => {
  assert.deepEqual(
    BRAND_SLOTS.map((s) => s.defaultObject),
    ['Bamabulab.webp', 'Creality.webp', 'Qidi.webp', 'Biqu.webp', 'Bigtreetech.webp', 'Esun.webp', 'Antinsky.webp']
  );
  assert.equal(BRAND_SLOTS.length, 7);
});

test('every brand default resolves to a key an anonymous visitor may fetch', () => {
  // The home page is the first thing a signed-out visitor sees. A brand mark
  // that needs a session is not a private asset, it is a broken one.
  for (const slot of BRAND_SLOTS) {
    const key = siteMediaKey(slot.defaultObject);
    assert.ok(isSafeMediaKey(key), `${key} is not a safe media key`);
    assert.ok(isAnonymousPublicMediaKey(key), `${key} would not be served to a signed-out visitor`);
  }
});

test('resolve marks defaults and uploads apart, and gives every slot a url or an empty string', () => {
  const fresh = resolveSiteMedia({});
  assert.equal(fresh.length, SITE_MEDIA_SLOTS.length);

  const bambu = fresh.find((m) => m.slot === 'brand-bambulab')!;
  assert.equal(bambu.url, `/files/${MAIN_PAGE_PREFIX}Bamabulab.webp`);
  assert.equal(bambu.custom, false);

  // Service slots now ship WITH a seeded default, because the owner uploaded an
  // icon for every one of the eleven cards. The drawn lucide icon is still the
  // fallback, but it is now the storefront's onError latch that falls back to
  // it — a missing object in R2 — and no longer an empty url here. Pinning the
  // seeded url is what stops a "reset to default" quietly blanking a card.
  for (const s of SERVICE_SLOTS) {
    assert.equal(fresh.find((m) => m.slot === s.slot)!.url, `/files/${MAIN_PAGE_PREFIX}${s.defaultObject}`);
  }

  const edited = resolveSiteMedia({ 'brand-bambulab': 'brand-bambulab-ab12cd.webp' });
  const replaced = edited.find((m) => m.slot === 'brand-bambulab')!;
  assert.equal(replaced.url, `/files/${MAIN_PAGE_PREFIX}brand-bambulab-ab12cd.webp`);
  assert.equal(replaced.custom, true);
  // Replacing one slot must not disturb its neighbours.
  assert.equal(edited.find((m) => m.slot === 'brand-creality')!.url, `/files/${MAIN_PAGE_PREFIX}Creality.webp`);
});

test('a stored value is re-validated on the way out, not trusted', () => {
  // mainPageMedia round-trips through a JSON settings row. Anything that got
  // in by another path must not become a URL the storefront renders.
  const hostile = normalizeSiteMedia({
    'brand-qidi': '../../../etc/passwd',
    'brand-biqu': 'logo.png',
    'brand-esun': 'sub/dir/logo.webp',
    'brand-antinsky': '',
    'not-a-slot': 'whatever.webp',
    'brand-creality': 'creality-9f3a.webp',
  });
  assert.deepEqual(hostile, { 'brand-creality': 'creality-9f3a.webp' });
});

test('only a bare .webp filename is accepted as an object name', () => {
  assert.ok(isSiteMediaObject('Bamabulab.webp'));
  assert.ok(isSiteMediaObject('brand-qidi-0a1b2c.webp'));
  assert.ok(!isSiteMediaObject('logo.png'), 'the owner asked for webp only');
  assert.ok(!isSiteMediaObject('a/b.webp'), 'no directories');
  assert.ok(!isSiteMediaObject('../b.webp'), 'no traversal');
  assert.ok(!isSiteMediaObject('.hidden.webp'), 'must start alphanumeric');
  assert.ok(!isSiteMediaObject(''));
  assert.ok(!isSiteMediaObject(null));
});

test('a minted name is unique per upload, safe, and still a webp', () => {
  // Every upload must land on a NEW key: /files/* stamps public objects
  // `immutable` for a year, so overwriting one would leave caches serving the
  // old logo with no way to purge them from the app.
  const first = mintSiteMediaObject('brand-bambulab', 'A1b2C3d4E5f6');
  const second = mintSiteMediaObject('brand-bambulab', 'Z9y8X7w6V5u4');
  assert.notEqual(first, second);
  for (const name of [first, second]) {
    assert.ok(isSiteMediaObject(name), `${name} is not a valid object name`);
    assert.ok(isAnonymousPublicMediaKey(siteMediaKey(name)));
  }
  // A hostile slot id cannot escape the prefix even though the route already
  // rejects unknown slots.
  assert.ok(isSiteMediaObject(mintSiteMediaObject('../../evil', 'abc123')));
});

test('service slot ids match the ids ServicesGrid already renders', () => {
  // The storefront looks a card's image up as `service-${card.id}` using the
  // id it already puts in data-service. Renaming either side silently stops
  // the lookup matching, so the pairing is asserted here.
  assert.deepEqual(
    SERVICE_SLOTS.map((s) => s.slot),
    [
      'service-studio', 'service-compare', 'service-tools', 'service-bundles', 'service-mystery',
      'service-tradein', 'service-used', 'service-rewards', 'service-warranty', 'service-community',
      'service-support',
    ]
  );
});

test('slots are unique and every one is findable by id', () => {
  const ids = SITE_MEDIA_SLOTS.map((s) => s.slot);
  assert.equal(new Set(ids).size, ids.length, 'duplicate slot id');
  for (const id of ids) assert.ok(findSiteMediaSlot(id));
  assert.equal(findSiteMediaSlot('nope'), null);
  assert.equal(findSiteMediaSlot(42), null);
});

// --------------------------------------------------------------- the logo
//
// THE SITE'S OWN MARK IS SITE MEDIA TOO, AND IT IS THE ONE PIECE OF IT THAT
// HAS NO SLOT.
//
// The owner replaced `UiUx/Logo/Logo.webp` in the bucket and the site kept
// drawing the old mark, because the logo resolves along three independent
// paths and only one of them asks R2: the WebP icon link and the share card
// in index.html. The other two are the seven PNGs committed under
// `public/icons/` — a FORK, generated by hand from the R2 object — and the
// bare strings that used to spell the key out in four places.
//
// src/lib/siteLogo.ts is now the single place the mark is named. index.html
// cannot import it (the shell is parsed before any module runs and nothing
// templates it), and worker/lib/webManifest.ts will not import it (that
// module keeps a no-imports property, and the Worker cannot read `src/`
// anyway). These tests are what stands in for those imports: they hold the
// shell, the generator script and the manifest's icon list to the module, so
// a rename cannot leave one of them pointing at an asset that no longer
// exists — which would not even 404, because `not_found_handling:
// "single-page-application"` answers a missing asset with the SPA shell at
// HTTP 200 and the browser draws a blank square.

const SHELL = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
/** The shell as the BROWSER reads it. Its comments discuss these very paths. */
const SHELL_MARKUP = SHELL.replace(/<!--[\s\S]*?-->/g, '');
const GENERATOR = readFileSync(new URL('../scripts/build-pwa-icons.mjs', import.meta.url), 'utf8');
const MANIFEST = readFileSync(new URL('../worker/lib/webManifest.ts', import.meta.url), 'utf8');

function shellMeta(attr: 'property' | 'name', key: string): string | null {
  const tag = new RegExp(`<meta\\s+${attr}="${key}"[^>]*>`, 'i').exec(SHELL_MARKUP);
  return tag ? /content="([^"]*)"/i.exec(tag[0])?.[1] ?? null : null;
}

test('the shop mark has ONE spelling — the shell repeats the module, it does not invent', () => {
  assert.equal(SITE_LOGO_URL, `/files/${SITE_LOGO_KEY}`);
  // The shell names the object UNDER ITS REVISION: the Worker reads the key
  // from the path, so the query only changes what URL-keyed caches (the
  // browser's favicon store, Telegram's and WhatsApp's link previews) see.
  assert.equal(SITE_LOGO_VERSIONED_URL, `${SITE_LOGO_URL}?v=${PLATFORM_ICON_REVISION}`);
  assert.equal(SITE_LOGO_SHARE_URL, `${SITE_ORIGIN}${SITE_LOGO_VERSIONED_URL}`);

  // THE TAB ICON NO LONGER NAMES THE R2 LOGO (merchant platform W2-D). The
  // shell is shared by every store's host, so its icon links are per-host
  // Worker paths (`/store-icon/*`: the store's own PNG on its host, the
  // platform's committed PNG elsewhere — tests/indexHtmlPwa.test.ts owns
  // them); a WebP link to the platform logo beside them put the LEVONIS mark
  // in the tab of a merchant's shop. The mark itself is still named once:
  // below, in the share card.
  assert.equal(/<link\s+rel="icon"\s+type="image\/webp"/i.exec(SHELL_MARKUP), null, 'a platform-only WebP tab icon is back');

  // The share card, absolute because a relative og:image is silently dropped.
  assert.equal(shellMeta('property', 'og:image'), SITE_LOGO_SHARE_URL);
  assert.equal(shellMeta('name', 'twitter:image'), SITE_LOGO_SHARE_URL);

  // And no FOURTH copy: every /files/ path in the shell is this one.
  for (const [, path] of SHELL_MARKUP.matchAll(/(?:https:\/\/[a-z0-9.-]+)?(\/files\/[^"'\s]*)/gi)) {
    assert.equal(path, SITE_LOGO_VERSIONED_URL, `index.html names ${path}, which src/lib/siteLogo.ts does not`);
  }
});

test('the logo key is anonymously fetchable AND rewritable, which is what replacing it in place needs', () => {
  // A social crawler and a first-time visitor both arrive with no session.
  assert.ok(isSafeMediaKey(SITE_LOGO_KEY));
  assert.ok(isAnonymousPublicMediaKey(SITE_LOGO_KEY), 'the shop logo would need a session');
  // And it must be recognised as a key a human replaces under a live name:
  // the minted keys keep `immutable` for a year, and this one must not, or a
  // replaced logo stays replaced-in-R2 and old-on-screen for that year.
  assert.ok(
    isRewritableMediaKey(SITE_LOGO_KEY),
    'the logo would be served `immutable` — the exact bug that cost a year of a stale mark'
  );
});

test('the committed PNG icons are a fork of THIS object, and every reference names a file that exists', () => {
  // The generator reads the canonical key. If someone repoints it at another
  // object, the fork stops being a fork of the logo and nothing else notices.
  assert.ok(
    GENERATOR.includes(SITE_LOGO_KEY),
    'scripts/build-pwa-icons.mjs no longer generates the icons from the shop logo'
  );

  const forked = Object.values(PLATFORM_ICONS);
  for (const [role, href] of Object.entries(PLATFORM_ICONS)) {
    assert.ok(href.startsWith('/icons/'), href);
    // `public/` is copied byte-for-byte into `dist/`, so "in public/" is "served".
    assert.ok(
      existsSync(fileURLToPath(new URL(`../public${href}`, import.meta.url))),
      `${href} is named by src/lib/siteLogo.ts but is not in public/`
    );
    // The generator must actually write it, or it is a path nobody maintains.
    // It reads the NAMES from src/lib/siteLogo.ts and keeps its own table of
    // what each ROLE is (tile size, how much of it the mark fills).
    assert.match(GENERATOR, new RegExp(`\\b${role}: \\{ size: \\d+, fraction: [\\d.]+ \\}`), `${role} (${href}) is not produced by the generator`);
  }

  // Every PNG icon the shell asks for is one of the forked seven.
  for (const [, href] of SHELL_MARKUP.matchAll(/href="(\/icons\/[^"]*)"/gi)) {
    assert.ok(forked.includes(href as (typeof forked)[number]), `index.html points at ${href}, which the fork does not contain`);
  }
  // And so is every icon the manifest hands Android — a manifest icon that
  // 404s makes Android refuse to install the site while reporting nothing.
  for (const [, href] of MANIFEST.matchAll(/src: '(\/icons\/[^']*)'/g)) {
    assert.ok(forked.includes(href as (typeof forked)[number]), `webManifest.ts points at ${href}, which the fork does not contain`);
  }
});

/**
 * A NEW MARK IS A NEW URL.
 *
 * The owner replaced the logo and kept seeing the old one, and the committed
 * PNGs were not even stale — regenerating them from the live object gives the
 * same bytes. What was stale was every cache keyed on a name that never
 * changed: `/icons/*` is served for a week and answered from Cloudflare's edge,
 * the service worker precached it, the browser keeps a tab icon per URL, and
 * Android re-fetches an installed app's icon through its HTTP cache to decide
 * whether it changed. So each icon's NAME carries the revision of the logo it
 * was cut from, and the generator refuses new pixels under an old revision.
 */
test('every icon name carries the logo revision, and the folder holds nothing else', () => {
  assert.match(PLATFORM_ICON_REVISION, /^[0-9a-f]{8}$/, 'the revision is 8 hex digits of the logo\'s SHA-256');
  const names = Object.values(PLATFORM_ICONS).map((href) => href.slice('/icons/'.length));
  for (const name of names) {
    assert.ok(name.endsWith(`.${PLATFORM_ICON_REVISION}.png`), `${name} does not carry .${PLATFORM_ICON_REVISION}.png`);
  }
  // An unversioned or previous-revision PNG left in the folder is a stale mark
  // something may still point at. The generator deletes them; this holds it.
  const onDisk = readdirSync(fileURLToPath(new URL('../public/icons', import.meta.url))).filter((f) => f.endsWith('.png'));
  assert.deepEqual([...onDisk].sort(), [...names].sort());

  // The generator checks the live logo against the revision before writing a
  // byte, and reads both the revision and the names out of the module.
  assert.match(GENERATOR, /createHash\('sha256'\)\.update\(src\)/);
  assert.match(GENERATOR, /if \(logo\.revision !== revision\) \{/);
  assert.match(GENERATOR, /export const PLATFORM_ICON_REVISION = /);

  // And the service worker precaches exactly these names.
  const sw = readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8');
  const precache = /const PRECACHE_URLS = \[([\s\S]*?)\];/.exec(sw)?.[1] ?? '';
  assert.deepEqual(
    [...precache.matchAll(/'([^']+)'/g)].map((m) => m[1]).sort(),
    Object.values(PLATFORM_ICONS).slice().sort()
  );
});

test('/favicon.ico is a real ICO of the mark, not the SPA shell', () => {
  // Every client with no <link> to read — crawlers, bookmark tools, a browser
  // on a bare origin — asks for exactly this path, and the SPA fallback used
  // to answer it with index.html at 200.
  assert.equal(ROOT_FAVICON, '/favicon.ico');
  const ico = readFileSync(new URL(`../public${ROOT_FAVICON}`, import.meta.url));
  const view = new DataView(ico.buffer, ico.byteOffset, ico.byteLength);
  assert.equal(view.getUint16(0, true), 0, 'reserved');
  assert.equal(view.getUint16(2, true), 1, 'type 1 = icon');
  const count = view.getUint16(4, true);
  const sizes: number[] = [];
  for (let i = 0; i < count; i += 1) {
    const entry = 6 + i * 16;
    const size = view.getUint8(entry) || 256;
    const length = view.getUint32(entry + 8, true);
    const offset = view.getUint32(entry + 12, true);
    sizes.push(size);
    // Each image is a PNG, and it lies inside the file.
    assert.ok(offset + length <= ico.length, `image ${i} runs past the end of the file`);
    assert.deepEqual([...ico.subarray(offset, offset + 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  }
  assert.deepEqual(sizes, [16, 32, 48]);
  assert.match(GENERATOR, /const FAVICON_ICO = 'public\/favicon\.ico';/);
});

test('the settings-driven reader prefers an uploaded logo and falls back to the fixed key', () => {
  // Nothing sends a `logo` slot yet — worker/lib/siteMedia.ts has no such
  // slot — so every caller gets the fixed key today. The fallback is the
  // behaviour that must not change when the slot lands.
  assert.equal(resolveSiteLogoUrl(), SITE_LOGO_URL);
  assert.equal(resolveSiteLogoUrl(null), SITE_LOGO_URL);
  assert.equal(resolveSiteLogoUrl([]), SITE_LOGO_URL);
  assert.equal(resolveSiteLogoUrl([{ slot: 'brand-qidi', url: '/files/UiUx/MainPage/Qidi.webp' }]), SITE_LOGO_URL);
  // '' is how a resolved slot says "not set", and it must not blank the mark.
  assert.equal(resolveSiteLogoUrl([{ slot: SITE_LOGO_SLOT, url: '' }]), SITE_LOGO_URL);

  // A minted upload wins, and a minted name is the whole point: the URL
  // changes with the bytes, so no browser is holding a year-long promise
  // about it and the owner never needs a purge again.
  const minted = `/files/${MAIN_PAGE_PREFIX}${mintSiteMediaObject(SITE_LOGO_SLOT, 'A1b2C3d4')}`;
  assert.equal(resolveSiteLogoUrl([{ slot: SITE_LOGO_SLOT, url: minted }]), minted);
});

test('no file in src/ spells a logo path for itself — siteLogo.ts is the only one allowed to', () => {
  // The three-paths bug started as four literals. This is the tripwire for the
  // fifth: a quoted `/icons/...` or `/files/UiUx/...` anywhere else in the
  // client is a second place that decides what the mark is called, and it will
  // be the one nobody updates. Prose is exempt — the register of this codebase
  // is long comments that name the paths they are explaining, so the scan
  // looks for a QUOTED path (a string a bundler will ship), not a mention.
  const offenders: string[] = [];
  const root = fileURLToPath(new URL('../src', import.meta.url));
  const allowed = fileURLToPath(new URL('../src/lib/siteLogo.ts', import.meta.url));

  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = `${dir}/${entry.name}`;
      if (entry.isDirectory()) {
        walk(full);
      } else if (/\.tsx?$/.test(entry.name) && full !== allowed) {
        const source = readFileSync(full, 'utf8');
        for (const [, literal] of source.matchAll(/['"](\/icons\/[^'"]*|\/files\/UiUx\/[^'"]*)['"]/g)) {
          offenders.push(`${full.slice(root.length + 1)} → ${literal}`);
        }
      }
    }
  };
  walk(root);

  assert.deepEqual(
    offenders,
    [],
    `import the name from src/lib/siteLogo.ts instead:\n  ${offenders.join('\n  ')}`
  );
});
