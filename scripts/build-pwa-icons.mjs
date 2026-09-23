#!/usr/bin/env node
/**
 * THE APP ICONS, MADE ONCE AND COMMITTED — NOT MADE DURING THE BUILD.
 *
 * `public/icons/*.png` are binaries in the repository, and this script is how
 * they were produced. It is NOT part of `npm run build`, on purpose:
 *
 *   - the source logo lives in R2 behind `/files/UiUx/Logo/Logo.webp`, so a
 *     build step would put a network fetch of the LIVE site on the critical
 *     path of every build, including CI and including a build made while the
 *     site is down;
 *   - `sharp` is not a declared dependency of this project (it arrives only as
 *     a transitive one), so a build that needed it would break the first time
 *     the tree was installed without it.
 *
 * Run it by hand when the logo changes:  node scripts/build-pwa-icons.mjs
 *
 * THE FILE NAMES CARRY THE LOGO'S OWN DIGEST, and the script refuses to write
 * new pixels under an old name. The first time the mark was replaced, the
 * PNGs were regenerated under the SAME names (`icon-192.png`), and a fixed
 * name is a promise every cache in between is entitled to keep: `/icons/*` is
 * served `max-age=604800`, Cloudflare's edge answered it `HIT`, and the
 * service worker's precache holds it until its VERSION moves. So the names
 * are now `icon-192.<rev>.png`, where `<rev>` is the first eight hex digits
 * of the SHA-256 of the logo bytes they were cut from
 * (`PLATFORM_ICON_REVISION` in src/lib/siteLogo.ts). New bytes are a new URL
 * that no cache anywhere has ever seen.
 *
 * When the logo in R2 changes, this script stops and prints the new
 * revision. Rename the icons to it in the four places that name them — the
 * failing assertions in tests/siteMedia.test.ts list them: src/lib/siteLogo.ts,
 * index.html, worker/lib/webManifest.ts and public/sw.js — bump `VERSION` in
 * public/sw.js, run this again, and commit the new files. The old ones are
 * deleted by the run, so the folder never carries a stale mark.
 *
 * WHY EACH SIZE EXISTS, because every one of them is a different platform
 * refusing to use the others:
 *
 *   icon-192 / icon-512      the two sizes the manifest must carry for Chrome,
 *                            Edge, Samsung Internet and Huawei Browser to
 *                            consider the site installable at all.
 *   maskable-192 / -512      Android 8+ masks the icon to the launcher's own
 *                            shape. An `any` icon is letterboxed into a white
 *                            rounded square; a `maskable` one is drawn edge to
 *                            edge, which is why the mark is inset here to sit
 *                            inside the 80%-diameter safe circle the spec
 *                            defines.
 *   apple-touch-icon         iOS reads THIS and not the manifest for the home
 *                            screen. It must be PNG: the document previously
 *                            pointed this link at the WebP logo, a format iOS
 *                            does not accept here, so an iPhone that added the
 *                            site to its home screen got a screenshot of the
 *                            page as its icon.
 *   favicon-16 / -32         a PNG tab icon beside the existing WebP one, for
 *                            the browsers that never shipped WebP favicons.
 *   /favicon.ico             16, 32 and 48 in one ICO, at the site ROOT. Every
 *                            browser, crawler and bookmark tool that has no
 *                            <link> to read asks for exactly this path, and it
 *                            used to be answered with the SPA's HTML at 200
 *                            (`not_found_handling: "single-page-application"`).
 *                            It is the one icon whose name can never carry a
 *                            revision, so it is served with the document's
 *                            revalidating Cache-Control rather than the
 *                            icons' week (worker/lib/securityPolicy.ts).
 *
 * The background is the site's own black. It is painted in rather than left
 * transparent because a transparent icon is composited on whatever the
 * launcher chooses — white, on most Android launchers — and this mark was
 * drawn for a black ground.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
let sharp;
try {
  sharp = require('sharp');
} catch {
  console.error('build-pwa-icons: this script needs `sharp`. Install it first:  npm i -D sharp');
  process.exit(1);
}

const SITE_LOGO_KEY = 'UiUx/Logo/Logo.webp';
const SOURCE = process.env.LOGO_URL ?? `https://levonis-iq.com/files/${SITE_LOGO_KEY}`;
const OUT = 'public/icons';
const FAVICON_ICO = 'public/favicon.ico';
const BLACK = { r: 0, g: 0, b: 0, alpha: 1 };

/**
 * What each icon IS — its tile size and how much of the tile the mark fills —
 * keyed by the role name src/lib/siteLogo.ts uses in `PLATFORM_ICONS`. The
 * PATHS are read from that module rather than repeated here, so there is one
 * place a name is spelled.
 *
 *   any       the mark fills the tile, because nothing will crop it.
 *   maskable  inset so the whole mark survives a circular mask (the safe zone
 *             is the centred circle of 80% diameter — 0.8/√2 ≈ 0.56 for a
 *             square mark).
 *   apple     iOS draws its own rounded rectangle over the full tile.
 */
const ROLES = {
  any192: { size: 192, fraction: 0.8 },
  any512: { size: 512, fraction: 0.8 },
  maskable192: { size: 192, fraction: 0.56 },
  maskable512: { size: 512, fraction: 0.56 },
  appleTouch: { size: 180, fraction: 0.78 },
  favicon32: { size: 32, fraction: 0.92 },
  favicon16: { size: 16, fraction: 0.92 },
};
const ICO_SIZES = [16, 32, 48];

/** `PLATFORM_ICON_REVISION` and `PLATFORM_ICONS`, out of the TypeScript. */
function readSiteLogo() {
  const source = readFileSync('src/lib/siteLogo.ts', 'utf8');
  const revision = /export const PLATFORM_ICON_REVISION = '([0-9a-f]{8})';/.exec(source)?.[1];
  const block = /export const PLATFORM_ICONS = \{([\s\S]*?)\} as const;/.exec(source)?.[1];
  if (!revision || !block) {
    console.error('build-pwa-icons: could not read PLATFORM_ICON_REVISION / PLATFORM_ICONS from src/lib/siteLogo.ts');
    process.exit(1);
  }
  const paths = Object.fromEntries([...block.matchAll(/(\w+):\s*'(\/icons\/[^']+)'/g)].map((m) => [m[1], m[2]]));
  for (const role of Object.keys(ROLES)) {
    if (!paths[role]) {
      console.error(`build-pwa-icons: src/lib/siteLogo.ts has no PLATFORM_ICONS.${role}`);
      process.exit(1);
    }
  }
  return { revision, paths };
}

/**
 * The mark, trimmed of its margin, scaled to `fraction` of `size`, centred on black.
 *
 * `trim()` WITHOUT ARGUMENTS TRIMS THE WRONG THING ON AN OPAQUE SOURCE. It
 * removes a border matching the top-left pixel, which on a transparent PNG is
 * the alpha margin and on a logo already composited onto black is the black —
 * which is what we want, but only because the background happens to BE the
 * brand colour. Stating the threshold makes that deliberate rather than
 * accidental: a future logo on a white card would otherwise be trimmed to
 * nothing, or not at all, depending on a pixel nobody looked at.
 */
async function tile(src, size, fraction) {
  const inner = Math.round(size * fraction);
  const mark = await sharp(src)
    .trim({ threshold: 10 })
    .resize(inner, inner, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();
  return sharp({ create: { width: size, height: size, channels: 4, background: BLACK } })
    .composite([{ input: mark, gravity: 'centre' }])
    .png({ compressionLevel: 9 })
    .toBuffer();
}

/**
 * An ICO holding PNG images — the form every browser since IE9 and every
 * Windows since Vista reads. The container is six bytes of header, sixteen
 * per image of directory, then the PNGs back to back; `sharp` does not write
 * it, and it is too small a format to take a dependency for.
 */
function ico(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(images.length, 4);
  let offset = 6 + 16 * images.length;
  const entries = images.map(({ size, png }) => {
    const entry = Buffer.alloc(16);
    entry.writeUInt8(size >= 256 ? 0 : size, 0); // width (0 means 256)
    entry.writeUInt8(size >= 256 ? 0 : size, 1); // height
    entry.writeUInt8(0, 2); // no palette
    entry.writeUInt8(0, 3); // reserved
    entry.writeUInt16LE(1, 4); // colour planes
    entry.writeUInt16LE(32, 6); // bits per pixel
    entry.writeUInt32LE(png.length, 8);
    entry.writeUInt32LE(offset, 12);
    offset += png.length;
    return entry;
  });
  return Buffer.concat([header, ...entries, ...images.map((i) => i.png)]);
}

const res = await fetch(SOURCE);
if (!res.ok) {
  console.error(`build-pwa-icons: ${SOURCE} answered ${res.status}`);
  process.exit(1);
}
const src = Buffer.from(await res.arrayBuffer());
const digest = createHash('sha256').update(src).digest('hex');
const revision = digest.slice(0, 8);
console.log(`build-pwa-icons: ${SOURCE} — ${src.length} B, sha256 ${digest}, etag ${res.headers.get('etag') ?? '(none)'}`);

const logo = readSiteLogo();
if (logo.revision !== revision) {
  console.error(
    `build-pwa-icons: the logo changed. Its revision is now ${revision}; src/lib/siteLogo.ts says ${logo.revision}.\n` +
      `  Rename the icons from .${logo.revision}.png to .${revision}.png in src/lib/siteLogo.ts (and set\n` +
      `  PLATFORM_ICON_REVISION), index.html, worker/lib/webManifest.ts and public/sw.js, bump VERSION in\n` +
      '  public/sw.js, then run this again. New pixels under an old name are exactly what every cache keeps.'
  );
  process.exit(1);
}

mkdirSync(OUT, { recursive: true });
const written = new Set();
for (const [role, { size, fraction }] of Object.entries(ROLES)) {
  const path = logo.paths[role];
  if (!path.endsWith(`.${revision}.png`)) {
    console.error(`build-pwa-icons: PLATFORM_ICONS.${role} (${path}) does not carry the revision .${revision}.png`);
    process.exit(1);
  }
  const png = await tile(src, size, fraction);
  const file = `public${path}`;
  writeFileSync(file, png);
  written.add(path.slice('/icons/'.length));
  console.log(`build-pwa-icons: ${file} (${size}×${size}, mark at ${Math.round(fraction * 100)}%, ${png.length} B)`);
}

// The previous revision's files go, so the folder never ships a stale mark
// that something might still be pointing at.
for (const name of readdirSync(OUT)) {
  if (name.endsWith('.png') && !written.has(name)) {
    unlinkSync(`${OUT}/${name}`);
    console.log(`build-pwa-icons: removed ${OUT}/${name} (not the current revision)`);
  }
}

const favicon = ico(await Promise.all(ICO_SIZES.map(async (size) => ({ size, png: await tile(src, size, 0.92) }))));
writeFileSync(FAVICON_ICO, favicon);
console.log(`build-pwa-icons: ${FAVICON_ICO} (${ICO_SIZES.join('/')}, ${favicon.length} B)`);
