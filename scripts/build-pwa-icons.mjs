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
 *
 * The background is the site's own black. It is painted in rather than left
 * transparent because a transparent icon is composited on whatever the
 * launcher chooses — white, on most Android launchers — and this logo is gold.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
let sharp;
try {
  sharp = require('sharp');
} catch {
  console.error('build-pwa-icons: this script needs `sharp`. Install it first:  npm i -D sharp');
  process.exit(1);
}

const SOURCE = process.env.LOGO_URL ?? 'https://levonis-iq.com/files/UiUx/Logo/Logo.webp';
const OUT = 'public/icons';
const BLACK = { r: 0, g: 0, b: 0, alpha: 1 };

/** The mark, trimmed of its transparent margin, scaled to `fraction` of `size`, centred on black. */
async function icon(src, size, fraction, file) {
  const inner = Math.round(size * fraction);
  const mark = await sharp(src)
    .trim()
    .resize(inner, inner, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();
  const png = await sharp({ create: { width: size, height: size, channels: 4, background: BLACK } })
    .composite([{ input: mark, gravity: 'centre' }])
    .png({ compressionLevel: 9 })
    .toBuffer();
  writeFileSync(`${OUT}/${file}`, png);
  console.log(`build-pwa-icons: ${OUT}/${file} (${size}×${size}, mark at ${Math.round(fraction * 100)}%, ${png.length} B)`);
}

const res = await fetch(SOURCE);
if (!res.ok) {
  console.error(`build-pwa-icons: ${SOURCE} answered ${res.status}`);
  process.exit(1);
}
const src = Buffer.from(await res.arrayBuffer());
mkdirSync(OUT, { recursive: true });

// `any`: the mark fills the tile, because nothing will crop it.
await icon(src, 192, 0.8, 'icon-192.png');
await icon(src, 512, 0.8, 'icon-512.png');
// `maskable`: inset so the whole mark survives a circular mask (safe zone is
// the centred circle of 80% diameter — 0.8/√2 ≈ 0.56 for a square mark).
await icon(src, 192, 0.56, 'maskable-192.png');
await icon(src, 512, 0.56, 'maskable-512.png');
// iOS draws its own rounded rectangle over the full tile.
await icon(src, 180, 0.78, 'apple-touch-icon.png');
await icon(src, 32, 0.92, 'favicon-32.png');
await icon(src, 16, 0.92, 'favicon-16.png');
