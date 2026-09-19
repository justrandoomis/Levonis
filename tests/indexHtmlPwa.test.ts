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

test('every icon href in the document is a file that will actually be served', () => {
  const iconRels = ['icon', 'apple-touch-icon', 'apple-touch-icon-precomposed', 'shortcut icon', 'mask-icon'];
  const icons = links().filter((l) => iconRels.includes((l.rel || '').toLowerCase()));
  assert.ok(icons.length >= 3, 'the WebP tab icon plus the PNG fallbacks and the Apple one');

  for (const link of icons) {
    const href = link.href || '';
    // `/files/*` is the Worker's R2 route, not a static file — it is checked
    // by tests/socialPreview.test.ts and is not this file's business.
    if (href.startsWith('/files/')) continue;
    assert.ok(href.startsWith('/'), `${href} must be root-relative`);
    const file = publicFile(href);
    assert.ok(
      existsSync(file),
      `${href} is declared in index.html but is not in public/ — a missing asset is answered with index.html at HTTP 200, so the browser gets HTML where it asked for an image and draws nothing`
    );
    // And it is genuinely a PNG, not an HTML shell or a renamed WebP. The
    // eight-byte PNG signature.
    const head = readFileSync(file).subarray(0, 8);
    assert.deepEqual(
      [...head],
      [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
      `${href} is not a PNG`
    );
  }
});

test('the iOS home-screen icon is the 180x180 PNG, declared with its size', () => {
  const apple = links().find((l) => (l.rel || '').toLowerCase() === 'apple-touch-icon');
  assert.ok(apple, 'an apple-touch-icon link');
  assert.equal(apple?.href, '/icons/apple-touch-icon.png');
  assert.ok(existsSync(publicFile('/icons/apple-touch-icon.png')));
  // iOS chooses between several apple-touch-icon links by comparing `sizes`;
  // a link without one is only the fallback.
  assert.equal(apple?.sizes, '180x180');
});

test('the PNG favicons are there for the browsers that never shipped WebP favicons', () => {
  const pngIcons = links().filter(
    (l) => (l.rel || '').toLowerCase() === 'icon' && (l.type || '') === 'image/png'
  );
  const sizes = pngIcons.map((l) => l.sizes).sort();
  assert.deepEqual(sizes, ['16x16', '32x32']);
  for (const icon of pngIcons) assert.ok(existsSync(publicFile(icon.href)), icon.href);
});

test('the WebP tab icon is kept, not replaced', () => {
  // Removing it would be a behaviour change nobody asked for, and
  // tests/socialPreview.test.ts pins the shop having a tab icon of its own.
  assert.match(MARKUP, /<link rel="icon" type="image\/webp" href="\/files\/UiUx\/Logo\/Logo\.webp"/i);
});

// ------------------------------------------------------------- the Apple meta

test('the legacy Apple meta tags are present — they are the only iOS install path', () => {
  // Safari on iOS fires no `beforeinstallprompt` and reads no `display` field
  // from the manifest. Without these three, a home-screen entry opens in a
  // browser tab with a visible address bar, which is not an app.
  assert.equal(meta('mobile-web-app-capable'), 'yes');
  assert.equal(meta('apple-mobile-web-app-capable'), 'yes');
  assert.equal(meta('apple-mobile-web-app-title'), 'LEVONIS');
});

test('the status bar is opaque black, and that is a decision rather than a default', () => {
  // `black-translucent` extends the web view UNDER the clock and leaves the
  // page to pad itself with env(safe-area-inset-top). The main header does
  // that; the full-screen shells (Settings, both checkouts, admin) draw their
  // own sticky bar with no top inset, so translucency would slide them under
  // the status bar on every notched iPhone.
  assert.equal(meta('apple-mobile-web-app-status-bar-style'), 'black');
});

test('the page is still black, and the manifest must agree with it', () => {
  // The document's real black is #000000 — the Tailwind token `--color-black`
  // is a softened #0b0c0f and is NOT what the browser chrome is painted.
  assert.equal(meta('theme-color'), '#000000');
  assert.match(MARKUP, /background-color: #000/);
  assert.match(MARKUP, /<html lang="ar" dir="rtl"/);
  assert.match(MARKUP, /viewport-fit=cover/);
});

test('no iOS splash-screen links, deliberately', () => {
  // iOS matches `apple-touch-startup-image` by exact device resolution and
  // orientation, so covering the phones people own means ~30 links and ~30
  // generated PNGs that go stale with every new iPhone. Without them iOS
  // paints the manifest's background_color, which is the same #000000 this
  // page already paints. The correct splash screen is the free one.
  assert.ok(
    !/apple-touch-startup-image/i.test(MARKUP),
    'read the comment above this link block in index.html before adding these'
  );
});
