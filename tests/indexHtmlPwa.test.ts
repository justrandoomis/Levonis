/**
 * THE FIVE LINES IN THE HEAD THAT DECIDE WHETHER THE SHOP CAN BE INSTALLED.
 *
 * Every failure this file pins is SILENT. Not one of them throws, logs an
 * error a customer would see, or shows up in a screenshot:
 *
 *   - a `<link rel="manifest">` that is missing means no install prompt, on
 *     any browser, ever. Chromium simply never fires the event and there is
 *     nothing to notice.
 *   - an `apple-touch-icon` pointing at a WebP is the bug the owner can see
 *     on their own phone today: iOS does not accept the format here, does not
 *     fall back to another link, and uses a SCREENSHOT OF THE PAGE as the
 *     home-screen icon instead. The document says nothing about it.
 *   - an icon href that does not exist in `dist/` is worse than a 404,
 *     because it is not a 404: `not_found_handling: "single-page-application"`
 *     answers a missing path with `index.html`, HTTP 200, `text/html`. The
 *     browser is handed the SPA shell where it asked for a PNG and draws a
 *     blank square. That is why the hrefs below are checked against the
 *     filesystem rather than only against each other.
 *
 * `public/` is copied byte-for-byte into `dist/` by Vite (there is no
 * `publicDir` override in vite.config.ts), so "exists in public/" is exactly
 * "will be served". These files are ordinary static assets — `/icons/*` is
 * deliberately NOT in `run_worker_first`, so the asset layer answers them
 * without the Worker being involved at all.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PLATFORM_ICON_FOR_ROLE, STORE_ICON_PATHS } from '../worker/lib/storeIcons';

const SHELL = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

/**
 * The shell WITHOUT its comments. `index.html` explains every line it carries
 * at length, and those explanations name the very tags and attributes this
 * file searches for — including the ones that must NOT be present. Asserting
 * against the raw text would make a prose paragraph indistinguishable from
 * markup, so the parsing below reads what the browser reads.
 */
const MARKUP = SHELL.replace(/<!--[\s\S]*?-->/g, '');

/** The value of one meta tag as the browser would read it, or null. */
function meta(name: string): string | null {
  const tag = new RegExp(`<meta\\s+name="${name}"[^>]*>`, 'i').exec(MARKUP);
  if (!tag) return null;
  return /content="([^"]*)"/i.exec(tag[0])?.[1] ?? null;
}

/** Every `<link>` in the document, as { rel, href, type, sizes }. */
function links(): Array<Record<string, string>> {
  return [...MARKUP.matchAll(/<link\b[^>]*>/gi)].map(([tag]) => {
    const attrs: Record<string, string> = {};
    for (const [, key, value] of tag.matchAll(/([a-z-]+)="([^"]*)"/gi)) attrs[key.toLowerCase()] = value;
    return attrs;
  });
}

/** A root-relative href resolved to the file that will serve it. */
function publicFile(href: string): string {
  return fileURLToPath(new URL(`../public${href}`, import.meta.url));
}

// --------------------------------------------------------------- the manifest

test('the document points at the manifest, or no browser ever offers the install', () => {
  const manifest = links().filter((l) => (l.rel || '').toLowerCase() === 'manifest');
  assert.equal(manifest.length, 1, 'exactly one manifest link');
  // RELATIVE, and that is the whole point of the Worker route behind it. One
  // deployment serves every store: ali3d.levonis-iq.com runs this same
  // document, and a relative href makes each host ask its OWN origin, so a
  // merchant's shop installs as that merchant rather than as LEVONIS.
  assert.equal(manifest[0].href, '/manifest.webmanifest');
  assert.ok(!/^https?:/i.test(manifest[0].href), 'an absolute URL would install every store as the apex');
});

// ------------------------------------------------------------------ the icons

test('NO apple-touch-icon is a WebP — iOS silently uses a screenshot instead', () => {
  const apple = links().filter((l) => (l.rel || '').toLowerCase().startsWith('apple-touch-icon'));
  assert.ok(apple.length >= 1, 'iOS reads THIS link and not the manifest for the home screen');
  for (const link of apple) {
    assert.ok(
      !/\.webp(\?|$)/i.test(link.href || ''),
      `apple-touch-icon points at ${link.href}; iOS does not accept WebP here and falls back to a page screenshot`
    );
  }
});

/**
 * THE ICON LINKS ARE PER HOST NOW (merchant platform W2-D), AND THIS IS THE
 * DELIBERATE UPDATE OF WHAT THESE TESTS PIN.
 *
 * They pinned `/icons/*.png` — files in public/ — and that was the defect on
 * every merchant host: this document is shared, so iOS «إضافة إلى الشاشة
 * الرئيسية» on ali3d.levonis-iq.com installed the LEVONIS mark under the
 * shop's name. Each icon link now names a stable `/store-icon/<name>` path
 * the Worker answers per Host (worker/routes/manifest.ts `storeIconRoute`):
 * the store's own PNG rendition on its host, the platform's committed PNG
 * everywhere else. What "will actually be served" therefore means for them:
 * a name the route knows, a platform fallback that exists as a real PNG, and
 * the path in `run_worker_first` in all three environments — without that
 * last one the asset layer answers with index.html at 200.
 */
test('every icon href in the document is served — a per-host Worker path with a real PNG behind it', () => {
  const iconRels = ['icon', 'apple-touch-icon', 'apple-touch-icon-precomposed', 'shortcut icon', 'mask-icon'];
  const icons = links().filter((l) => iconRels.includes((l.rel || '').toLowerCase()));
  assert.ok(icons.length >= 3, 'the Apple icon and the tab icons');

  const wrangler = readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8');
  const blocks = wrangler.match(/"run_worker_first"\s*:\s*\[[^\]]*\]/g) ?? [];
  assert.equal(blocks.length, 3);
  for (const block of blocks) assert.ok(block.includes('"/store-icon/*"'), `/store-icon/* missing from ${block}`);

  for (const link of icons) {
    const href = link.href || '';
    assert.ok(href.startsWith('/store-icon/'), `${href} is not per host — on a merchant's shop it would show the platform's icon`);
    const role = STORE_ICON_PATHS[href.slice('/store-icon/'.length)];
    assert.ok(role, `${href} is not a name the Worker's icon route answers`);
    // The platform fallback behind it is a committed PNG — the eight-byte
    // signature, not an HTML shell or a renamed WebP.
    const file = publicFile(PLATFORM_ICON_FOR_ROLE[role]);
    assert.ok(existsSync(file), `${PLATFORM_ICON_FOR_ROLE[role]} (the fallback for ${href}) is not in public/`);
    assert.deepEqual([...readFileSync(file).subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], `${href}`);
  }
});

test('the iOS home-screen icon is the 180x180 PNG, per host, declared with its size', () => {
  const apple = links().find((l) => (l.rel || '').toLowerCase() === 'apple-touch-icon');
  assert.ok(apple, 'an apple-touch-icon link');
  assert.equal(apple?.href, '/store-icon/apple-touch.png');
  assert.equal(STORE_ICON_PATHS['apple-touch.png'], 'apple180', 'the 180 px rendition — the size iOS asks for');
  // iOS chooses between several apple-touch-icon links by comparing `sizes`;
  // a link without one is only the fallback.
  assert.equal(apple?.sizes, '180x180');
  assert.equal(links().filter((l) => (l.rel || '').toLowerCase().startsWith('apple-touch-icon')).length, 1);
});

test('the tab icons are PNG, per host: 32 px for the tab, 192 px for tiles that ask for more', () => {
  const tabIcons = links().filter((l) => (l.rel || '').toLowerCase() === 'icon');
  assert.ok(tabIcons.every((l) => (l.type || '') === 'image/png'), 'every tab icon is a PNG every browser decodes');
  assert.deepEqual(tabIcons.map((l) => l.sizes).sort(), ['192x192', '32x32']);
  assert.deepEqual(tabIcons.map((l) => l.href).sort(), ['/store-icon/192.png', '/store-icon/favicon-32.png']);
});

test('no platform-only icon link is left beside the per-host ones', () => {
  // The WebP `rel="icon"` pointed at the platform logo in R2. A browser picks
  // among several `rel="icon"` links by its own rules (by `sizes` in
  // Chromium, by document order elsewhere), so a platform link beside the
  // per-host ones would put the LEVONIS mark in some browsers' tab on a
  // merchant's shop. The share card still names the logo — that is og:image,
  // and tests/siteMedia.test.ts holds it.
  assert.doesNotMatch(MARKUP, /<link[^>]+rel="(?:icon|apple-touch-icon)"[^>]+href="\/(?:files|icons)\//i);
});

// ------------------------------------------------------------- the Apple meta

test('the legacy Apple meta tags are present — they are the only iOS install path', () => {
  // Safari on iOS fires no `beforeinstallprompt` and reads no `display` field
  // from the manifest. Without these two, a home-screen entry opens in a
  // browser tab with a visible address bar, which is not an app.
  assert.equal(meta('mobile-web-app-capable'), 'yes');
  assert.equal(meta('apple-mobile-web-app-capable'), 'yes');
});

test('NO apple-mobile-web-app-title — it would name every merchant shop LEVONIS', () => {
  // THIS ASSERTION USED TO BE `assert.equal(meta(...), 'LEVONIS')`, and it was
  // pinning the defect in place.
  //
  // iOS prefers this tag over the manifest's `short_name` for the home-screen
  // label, and index.html is ONE SHARED DOCUMENT — the asset layer serves the
  // same bytes on the apex and on every merchant subdomain (only `/product/*`
  // is rewritten, by assetWithPreview). So the tag labelled every shop's
  // installed icon "LEVONIS", which is precisely what worker/routes/manifest.ts
  // builds a per-host manifest to prevent, and it did it on the one platform
  // where the customer had just been walked through five manual steps.
  //
  // Absent, modern iOS falls back to the per-host `short_name`, and older iOS
  // falls back to <title> — which src/components/pwa/HostAppleIdentity.tsx sets
  // to the merchant's name while a storefront is on screen.
  assert.equal(meta('apple-mobile-web-app-title'), null);
  assert.ok(
    !/apple-mobile-web-app-title/i.test(MARKUP.replace(/<!--[\s\S]*?-->/g, '')),
    'apple-mobile-web-app-title is back; read the comment in index.html before restoring it'
  );
});

test('the status bar is opaque — never translucent — and it takes the theme’s ground', () => {
  // `black-translucent` extends the web view UNDER the clock and leaves the
  // page to pad itself with env(safe-area-inset-top). The main header does
  // that; the full-screen shells (Settings, both checkouts, admin) draw their
  // own sticky bar with no top inset, so translucency would slide them under
  // the status bar on every notched iPhone. The app has two themes now
  // (src/index.css): the markup ships `default` (the light theme is the
  // default) and the pre-paint theme script rewrites it to `black` for a
  // reader who chose dark, before iOS reads it.
  assert.equal(meta('apple-mobile-web-app-status-bar-style'), 'default');
  assert.ok(!/black-translucent/.test(MARKUP.replace(/<!--[\s\S]*?-->/g, '')));
  assert.match(MARKUP, /apple-mobile-web-app-status-bar-style"\]'\);if\(m\)[^<]*if\(b\)b\.setAttribute\('content',d\?'black':'default'\)/);
});

test('the first frame is painted in the theme’s own ground, and the browser chrome agrees', () => {
  // Light (#ece6da, ivory) unless the reader chose dark (#0b0c0f); the inline
  // theme script rewrites theme-color before anything paints
  // (tests/themeSystem.test.ts pins that script and its CSP hash).
  assert.equal(meta('theme-color'), '#ece6da');
  assert.match(MARKUP, /html, body \{ background-color: #ece6da; margin: 0; \}/);
  assert.match(MARKUP, /html\[data-theme="dark"\], html\[data-theme="dark"\] body \{ background-color: #0b0c0f; \}/);
  assert.match(MARKUP, /<html lang="ar" dir="rtl"/);
  assert.match(MARKUP, /viewport-fit=cover/);
});

test('no iOS splash-screen links, deliberately', () => {
  // iOS matches `apple-touch-startup-image` by exact device resolution and
  // orientation, so covering the phones people own means ~30 links and ~30
  // generated PNGs that go stale with every new iPhone. Without them iOS
  // paints the manifest's background_color, which is the same ground (ivory, #ece6da) this
  // page already paints. The correct splash screen is the free one.
  assert.ok(
    !/apple-touch-startup-image/i.test(MARKUP),
    'read the comment above this link block in index.html before adding these'
  );
});
