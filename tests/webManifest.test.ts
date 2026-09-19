/**
 * THE MANIFEST IS READ ONCE, AT INSTALL TIME, BY A BROWSER THAT REPORTS
 * NOTHING TO ANYONE.
 *
 * Every other surface in this application fails loudly: a broken API answers
 * with an error code, a broken page throws in a console somebody is looking
 * at. A broken manifest just means the install prompt never appears — on every
 * device, in every browser, with the site otherwise working perfectly. There
 * is no customer report to be had beyond "I couldn't add it to my phone", and
 * no log line at all.
 *
 * So this file is deliberately paranoid about the four things that produce
 * exactly that silence:
 *
 *   1. the route not being reachable, because the asset layer answered first
 *      (wrangler.jsonc's run_worker_first);
 *   2. the wrong Content-Type, which `nosniff` turns from a warning into a
 *      refusal;
 *   3. an icon that 404s, which makes Android refuse the install outright;
 *   4. the builder throwing, or emitting an empty `short_name`, on a store row
 *      nobody thought about.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { APEX, MERCHANT_HOST, asD1, ctx, freshDb } from './fixtures/app';
import worker from '../worker/index';
import { buildWebManifest, PLATFORM_NAME, type WebManifest } from '../worker/lib/webManifest';
import { MANIFEST_CONTENT_TYPE } from '../worker/routes/manifest';

const repo = (p: string) => new URL(`../${p}`, import.meta.url);

// --------------------------------------------------------- the pure builder

test('with no identity at all it is the platform, and it is a valid manifest', () => {
  for (const identity of [undefined, null, {}, { name: '' }, { name: '   ' }]) {
    const m = buildWebManifest(identity as never);
    assert.equal(m.name, PLATFORM_NAME, JSON.stringify(identity));
    assert.equal(m.short_name, PLATFORM_NAME);
    assert.equal(m.id, '/');
    assert.equal(m.start_url, '/');
    assert.equal(m.scope, '/');
    assert.equal(m.display, 'standalone');
    assert.equal(m.lang, 'ar');
    assert.equal(m.dir, 'rtl');
    assert.equal(m.background_color, '#000000');
    assert.equal(m.theme_color, '#000000');
    assert.deepEqual(m.categories, ['shopping']);
    assert.ok(m.description.length > 0);
  }
});

test('the black is the document’s #000000, never the softened Tailwind canvas', () => {
  // `src/index.css` redefines --color-canvas to #0b0c0f on purpose, so a
  // manifest copied from a Tailwind token would paint a lighter splash screen
  // than the page it launches. index.html's theme-color is the reference.
  const shell = readFileSync(repo('index.html'), 'utf8');
  assert.match(shell, /<meta name="theme-color" content="#000000"/);
  const m = buildWebManifest();
  assert.equal(m.theme_color, '#000000');
  assert.equal(m.background_color, '#000000');
});

test('no orientation is declared, because the app has a desktop layout too', () => {
  // Forcing "portrait" would give desktop Chrome and Edge a tall narrow window
  // for a layout that already works at every width.
  assert.equal(Object.prototype.hasOwnProperty.call(buildWebManifest(), 'orientation'), false);
});

test('a merchant identity replaces the name, the short name and the description', () => {
  const m = buildWebManifest({ name: 'Ali 3D', tagline: 'طباعة ثلاثية الأبعاد في أربيل', logoKey: null });
  assert.equal(m.name, 'Ali 3D');
  assert.equal(m.short_name, 'Ali 3D');
  assert.equal(m.description, 'طباعة ثلاثية الأبعاد في أربيل');
});

test('a merchant with no tagline still gets a sentence, naming their own shop', () => {
  // ASSERTED WHOLE, NOT WITH `includes`. An `includes('متجر علي')` check passed
  // happily while the sentence read «متجر متجر علي على منصة LEVONIS» — the noun
  // doubled, because most shops here are already named «متجر X». The full string
  // is the only assertion that can see that, and this is the exact name that
  // exposed it.
  const m = buildWebManifest({ name: 'متجر علي', tagline: '', logoKey: null });
  assert.equal(m.description, 'متجر علي على منصة ليفونيس');

  // A bare name still gets the noun — that is what the prefix is for.
  assert.equal(
    buildWebManifest({ name: 'علي', tagline: '', logoKey: null }).description,
    'متجر علي على منصة ليفونيس'
  );

  // The other nouns merchants actually use, none of which may double either.
  for (const name of ['محل الرافدين', 'شركة بغداد', 'مؤسسة النهرين', 'ورشة الموصل']) {
    assert.equal(
      buildWebManifest({ name, tagline: '', logoKey: null }).description,
      `${name} على منصة ليفونيس`
    );
  }

  // The brand is spelled in Arabic in this sentence on purpose: a Latin run in
  // the middle of an Arabic line flips direction mid-sentence, and a manifest
  // description has no surrounding page to steady it.
  assert.ok(!m.description.includes(PLATFORM_NAME));
});

test('a long name is cut at a word boundary, never mid-word, and never to nothing', () => {
  const m = buildWebManifest({ name: 'Baghdad Additive Manufacturing Works' });
  assert.equal(m.name, 'Baghdad Additive Manufacturing Works');
  assert.equal(m.short_name, 'Baghdad');
  // The invariant that matters, whatever the cut: a prefix of the full name,
  // ending where a word ends.
  assert.ok(m.short_name.length > 0);
  assert.ok(m.name.startsWith(m.short_name));
  assert.equal(m.name[m.short_name.length], ' ', 'the cut landed inside a word');
});

test('a long ARABIC name is cut at a word boundary too', () => {
  const name = 'متجر علي للطباعة ثلاثية الأبعاد';
  const m = buildWebManifest({ name });
  assert.ok(m.short_name.length > 0);
  assert.ok(name.startsWith(m.short_name));
  // The character after the cut is the space we cut on — the word is whole.
  assert.equal(name[m.short_name.length], ' ');
  assert.ok(Array.from(m.short_name).length <= 12);
});

test('a single word longer than the budget is kept whole rather than emptied', () => {
  // There is no boundary to cut at. A fragment would be wrong and an empty
  // short_name renders as a blank label under the icon in some launchers, so
  // the launcher is left to elide it itself.
  const m = buildWebManifest({ name: 'Supercalifragilistic' });
  assert.equal(m.short_name, 'Supercalifragilistic');
  const arabic = buildWebManifest({ name: 'الطباعةالثلاثيةالأبعاد' });
  assert.equal(arabic.short_name, 'الطباعةالثلاثيةالأبعاد');
});

test('a name that is only whitespace is the platform, not an app called nothing', () => {
  const m = buildWebManifest({ name: '   \t  ', tagline: 'ignored', logoKey: 'merchants/u1/public/a.webp' });
  assert.equal(m.name, PLATFORM_NAME);
  assert.equal(m.short_name, PLATFORM_NAME);
  // And no store logo rode in on a store that does not exist.
  assert.ok(m.icons.every((i) => i.src.startsWith('/icons/')));
});

test('bidi overrides and zero-width characters never reach a home screen label', () => {
  // U+202E reorders everything after it. On a home screen there is no
  // surrounding page to notice, which is what makes it worth stripping.
  const m = buildWebManifest({ name: 'Ali\u202e3D\u200b Shop' });
  assert.ok(!/[\u200b-\u200f\u202a-\u202e\u2066-\u2069]/.test(m.name));
  assert.ok(!/[\u200b-\u200f\u202a-\u202e\u2066-\u2069]/.test(m.short_name));
  assert.ok(!/[\n\r\t]/.test(buildWebManifest({ name: 'Ali\n3D' }).name));
});

test('an over-long or surrogate-bearing name is clamped without splitting a character', () => {
  const m = buildWebManifest({ name: `${'ا'.repeat(80)}` });
  assert.ok(Array.from(m.name).length <= 60);
  // A UTF-16 slice would cut a surrogate pair in half here and emit a lone
  // surrogate, which JSON.stringify accepts and a launcher draws as a
  // replacement glyph in the app's name forever.
  const emoji = buildWebManifest({ name: `${'🖨'.repeat(80)}` });
  assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(emoji.name));
  assert.ok(Array.from(emoji.name).length <= 60);
  assert.equal(JSON.parse(JSON.stringify(emoji)).name, emoji.name);
});

// --------------------------------------------------------------- the icons

test('a merchant with no logo gets exactly the four platform icons', () => {
  const m = buildWebManifest({ name: 'Ali 3D', logoKey: null });
  assert.deepEqual(
    m.icons.map((i) => `${i.src} ${i.sizes} ${i.purpose}`),
    [
      '/icons/icon-192.png 192x192 any',
      '/icons/icon-512.png 512x512 any',
      '/icons/maskable-192.png 192x192 maskable',
      '/icons/maskable-512.png 512x512 maskable',
    ]
  );
});

test('a merchant logo is an EXTRA entry, typed from its stored extension, with no invented size', () => {
  const m = buildWebManifest({ name: 'Ali 3D', logoKey: 'merchants/u1/public/abc123.webp' });
  assert.equal(m.icons.length, 5);
  assert.deepEqual(m.icons[0], { src: '/files/merchants/u1/public/abc123.webp', type: 'image/webp', purpose: 'any' });
  // `sizes: "any"` means SCALABLE in the manifest spec. Claiming it for a
  // raster logo invites a browser to stretch a small WebP across a 512px tile.
  assert.equal(m.icons[0].sizes, undefined);
  // Never maskable: a merchant logo has no guaranteed safe zone.
  assert.ok(m.icons.every((i) => i.purpose !== 'maskable' || i.src.startsWith('/icons/maskable-')));
  // The platform icons are still all there, so installability never depends
  // on the merchant having uploaded anything.
  assert.equal(m.icons.filter((i) => i.src.startsWith('/icons/')).length, 4);
});

test('the logo type follows the key, because the key follows the sniffed MIME', () => {
  const t = (key: string) => buildWebManifest({ name: 'S', logoKey: key }).icons[0].type;
  assert.equal(t('merchants/u1/public/a.png'), 'image/png');
  assert.equal(t('merchants/u1/public/a.jpg'), 'image/jpeg');
  assert.equal(t('merchants/u1/public/a.jpeg'), 'image/jpeg');
  assert.equal(t('merchants/u1/public/a.avif'), 'image/avif');
  assert.equal(t('community/u1/a.webp'), 'image/webp');
  // The delivery path form, which older rows and imports hold.
  assert.equal(
    buildWebManifest({ name: 'S', logoKey: '/files/merchants/u1/public/a.webp' }).icons[0].src,
    '/files/merchants/u1/public/a.webp'
  );
});

test('a logo key we cannot name honestly, or cannot serve at all, is dropped', () => {
  const dropped = [
    'merchants/u1/public/a.svg',            // not in the sniffer's set: no honest type
    'merchants/u1/public/a',                // no extension at all
    'https://evil.example/logo.png',        // not ours
    '//evil.example/logo.png',
    'data:image/png;base64,AAAA',
    'merchants/u1/private/a.webp',          // /files/ would refuse it anonymously
    'receipts/u1/a.webp',
    'merchants/u1/public/../../etc/a.webp',
    'merchants/u1/public/a b.webp',
    '',
    `merchants/u1/public/${'a'.repeat(300)}.webp`,
  ];
  for (const logoKey of dropped) {
    const m = buildWebManifest({ name: 'Ali 3D', logoKey });
    assert.equal(m.icons.length, 4, logoKey);
    assert.ok(m.icons.every((i) => i.src.startsWith('/icons/')), logoKey);
  }
});

test('every /icons/ file the builder can ever name exists on disk', () => {
  /**
   * THE ASSERTION NOTHING ELSE CAN MAKE.
   *
   * `public/icons/*` is copied verbatim to `dist/icons/*` by Vite's default
   * publicDir, and `dist/` is not in `run_worker_first`, so a missing icon is
   * answered by the asset layer with index.html at HTTP 200 and
   * Content-Type: text/html — not a 404. Android then refuses the install
   * because it cannot decode the icon, and says so to nobody. A renamed or
   * deleted PNG would break installation everywhere and no other test in this
   * repository would notice.
   */
  const named = new Set<string>();
  for (const m of [buildWebManifest(), buildWebManifest({ name: 'Ali 3D', logoKey: 'merchants/u1/public/a.webp' })]) {
    for (const i of m.icons) named.add(i.src);
    for (const s of m.shortcuts) for (const i of s.icons) named.add(i.src);
  }
  const local = [...named].filter((src) => src.startsWith('/icons/'));
  assert.ok(local.length >= 4, 'the platform icons must be named by src, not built at runtime');
  for (const src of local) {
    assert.ok(existsSync(repo(`public${src}`)), `${src} is named in the manifest but absent from public/`);
  }
});

// ----------------------------------------------------------- the shortcuts

test('every shortcut points at a path the SPA actually declares, on BOTH shells', () => {
  /**
   * A shortcut to a path only the main site declares would, on a merchant
   * subdomain, fall through `StorefrontApp`'s catch-all and render the shop's
   * front page — a shortcut that silently does nothing. So the route table is
   * read from the app rather than restated here.
   */
  const app = readFileSync(repo('src/App.tsx'), 'utf8');
  const storefront = app.slice(app.indexOf('function StorefrontApp'));
  const m = buildWebManifest();
  assert.ok(m.shortcuts.length >= 3);
  for (const s of m.shortcuts) {
    assert.ok(s.name.length > 0 && s.short_name.length > 0, s.url);
    assert.ok(s.icons.length > 0, s.url);
    assert.ok(app.includes(`<Route path="${s.url}"`), `${s.url} is not a route in src/App.tsx`);
    assert.ok(storefront.includes(`<Route path="${s.url}"`), `${s.url} is not a route on a merchant host`);
  }
});

// ------------------------------------------------- the route, through the real Worker

function seed(raw: DatabaseSync, over: Partial<{ name: string; tagline: string; logo: string | null }> = {}) {
  raw.exec(`INSERT INTO users (id,name,email,password_hash) VALUES ('u1','A','a@x.co','h')`);
  raw.prepare(`INSERT INTO community_merchants (id,user_id,name) VALUES ('m1','u1',?)`).run(over.name ?? 'Ali 3D');
  raw
    .prepare(
      `INSERT INTO merchant_stores (id,merchant_id,user_id,slug,name,tagline,logo_key)
       VALUES ('s1','m1','u1','somestore',?,?,?)`
    )
    .run(over.name ?? 'Ali 3D', over.tagline ?? '', over.logo === undefined ? 'merchants/u1/public/abc.webp' : over.logo);
}

/** A D1 that counts how many statements were prepared, so "no read" can be asserted. */
function counting(db: D1Database) {
  const reads = { n: 0 };
  const proxy = new Proxy(db, {
    get(target, prop, receiver) {
      if (prop === 'prepare') {
        return (sql: string) => {
          reads.n += 1;
          return (target as D1Database).prepare(sql);
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });
  return { db: proxy as D1Database, reads };
}

function envFor(db: unknown) {
  return {
    DB: db,
    STORE_ROOT_DOMAIN: APEX,
    APP_ORIGIN: `https://${APEX}`,
    INITIAL_ADMIN_EMAIL: 'boss@x.co',
    EXTRA_ALLOWED_ORIGINS: '',
    ASSETS: { fetch: async () => new Response('<!doctype html><html></html>', { headers: { 'content-type': 'text/html' } }) },
  } as never;
}

const fetchManifest = (host: string, env: unknown) =>
  worker.fetch(
    new Request(`https://${host}/manifest.webmanifest`, { headers: { Host: host, 'CF-Connecting-IP': '9.9.9.9' } }),
    env as never,
    ctx
  );

async function manifestOf(res: Response): Promise<WebManifest> {
  const text = await res.text();
  // JSON.parse, not res.json(): the failure this guards against is the SPA
  // shell arriving here as text/html, and the parse error is the assertion.
  return JSON.parse(text) as WebManifest;
}

test('the apex is answered with the platform manifest, and without touching the database', async () => {
  const raw = freshDb();
  seed(raw);
  const { db, reads } = counting(asD1(raw));
  const res = await fetchManifest(APEX, envFor(db));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), MANIFEST_CONTENT_TYPE);
  const m = await manifestOf(res);
  assert.equal(m.name, PLATFORM_NAME);
  assert.equal(reads.n, 0, 'the apex has no store to look up and must not pay for a query');
});

test('the Content-Type is exactly application/manifest+json, because nosniff leaves no fallback', async () => {
  const raw = freshDb();
  const res = await fetchManifest(APEX, envFor(asD1(raw)));
  assert.match(res.headers.get('content-type') ?? '', /^application\/manifest\+json; ?charset=utf-8$/i);
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.match(res.headers.get('cache-control') ?? '', /^public, max-age=\d+$/);
  // Two different URLs, not one URL with a varying header — see the note in
  // worker/routes/manifest.ts.
  assert.equal(res.headers.get('vary'), null);
});

test('a merchant host installs as the MERCHANT, with the merchant’s own logo', async () => {
  const raw = freshDb();
  seed(raw, { name: 'متجر علي', tagline: 'طباعة ثلاثية الأبعاد' });
  const res = await fetchManifest(MERCHANT_HOST, envFor(asD1(raw)));
  assert.equal(res.status, 200);
  const m = await manifestOf(res);
  assert.equal(m.name, 'متجر علي');
  assert.equal(m.description, 'طباعة ثلاثية الأبعاد');
  assert.equal(m.icons[0].src, '/files/merchants/u1/public/abc.webp');
  // Same origin, so `/` is still the right id and the right start_url.
  assert.equal(m.id, '/');
  assert.equal(m.start_url, '/');
});

test('a paused or suspended store keeps its own identity', async () => {
  const raw = freshDb();
  seed(raw, { name: 'متجر علي' });
  raw.exec(`UPDATE merchant_stores SET status = 'suspended' WHERE id = 's1'`);
  const m = await manifestOf(await fetchManifest(MERCHANT_HOST, envFor(asD1(raw))));
  assert.equal(m.name, 'متجر علي', 'relabelling an installed app over a trading state is not this route’s job');
});

test('an unknown subdomain falls back to the platform, at 200', async () => {
  const raw = freshDb();
  seed(raw);
  const res = await fetchManifest(`nosuchstore.${APEX}`, envFor(asD1(raw)));
  assert.equal(res.status, 200);
  assert.equal((await manifestOf(res)).name, PLATFORM_NAME);
});

test('a system subdomain is the platform, and reads nothing', async () => {
  const raw = freshDb();
  seed(raw);
  const { db, reads } = counting(asD1(raw));
  const m = await manifestOf(await fetchManifest(`studio.${APEX}`, envFor(db)));
  assert.equal(m.name, PLATFORM_NAME);
  assert.equal(reads.n, 0);
});

test('a foreign or spoofed Host is the platform, not a merchant', async () => {
  const raw = freshDb();
  seed(raw);
  for (const host of ['levonis.example.net', 'somestore.evil.example']) {
    const res = await fetchManifest(host, envFor(asD1(raw)));
    assert.equal(res.status, 200, host);
    assert.equal((await manifestOf(res)).name, PLATFORM_NAME, host);
  }
});

test('a database that throws still returns 200 and a valid platform manifest', async () => {
  /**
   * The failure this route exists to survive. D1 unavailable, mid-migration,
   * or the binding absent in a preview deployment — a 500 here would report
   * "not installable" on every device at once, with nothing a customer could
   * describe beyond the button being gone.
   */
  const broken = {
    prepare() {
      throw new Error('D1_ERROR: network');
    },
  };
  const res = await fetchManifest(MERCHANT_HOST, envFor(broken));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), MANIFEST_CONTENT_TYPE);
  assert.equal((await manifestOf(res)).name, PLATFORM_NAME);
});

test('a missing DB binding is survivable too', async () => {
  const res = await fetchManifest(MERCHANT_HOST, envFor(undefined));
  assert.equal(res.status, 200);
  assert.equal((await manifestOf(res)).name, PLATFORM_NAME);
});

// ------------------------------------------- the routing that makes it reachable

test('all three run_worker_first arrays carry the manifest, or the route is dead code', () => {
  /**
   * Without the entry, `not_found_handling: "single-page-application"` has the
   * asset layer answer this URL with index.html at HTTP 200 and
   * Content-Type: text/html, before the Worker exists for the request. The
   * browser reports "Manifest: Line: 1, column: 1, Syntax error" and nothing
   * else. Editing only the top-level block leaves staging and dark broken,
   * which is why the count is asserted as well as the contents.
   */
  const wrangler = readFileSync(repo('wrangler.jsonc'), 'utf8');
  const blocks = wrangler.match(/"run_worker_first"\s*:\s*\[[^\]]*\]/g) ?? [];
  assert.equal(blocks.length, 3, 'top-level, staging and dark each declare it');
  for (const block of blocks) {
    assert.ok(block.includes('"/manifest.webmanifest"'), block);
  }
});

test('wrangler.jsonc is still parseable after the edit', () => {
  const parsed = JSON.parse(stripJsonc(readFileSync(repo('wrangler.jsonc'), 'utf8'))) as {
    assets: { run_worker_first: string[] };
    env: Record<string, { assets: { run_worker_first: string[] } }>;
  };
  assert.ok(parsed.assets.run_worker_first.includes('/manifest.webmanifest'));
  for (const [name, block] of Object.entries(parsed.env)) {
    if (!block.assets) continue;
    assert.ok(block.assets.run_worker_first.includes('/manifest.webmanifest'), name);
  }
});

test('worker/index.ts mounts the route above the SPA fallback', () => {
  const index = readFileSync(repo('worker/index.ts'), 'utf8');
  const mount = index.indexOf("app.get('/manifest.webmanifest', webManifestRoute)");
  assert.ok(mount > 0, 'the route is not mounted');
  assert.ok(mount < index.indexOf('app.notFound('), 'a route registered after notFound never runs');
  // The session JOIN is skipped: an installed app’s name cannot depend on
  // who is asking, so paying a sessions x users read for it is pure cost.
  assert.match(index, /path === '\/manifest\.webmanifest'/);
});

/** Comments and trailing commas out, respecting string literals. */
function stripJsonc(src: string): string {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === '"') {
      let j = i + 1;
      while (j < src.length) {
        if (src[j] === '\\') j += 2;
        else if (src[j] === '"') break;
        else j += 1;
      }
      out += src.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (ch === '/' && src[i + 1] === '/') {
      const end = src.indexOf('\n', i);
      i = end === -1 ? src.length : end;
      continue;
    }
    if (ch === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      i = end === -1 ? src.length : end + 2;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out.replace(/,(\s*[}\]])/g, '$1');
}
