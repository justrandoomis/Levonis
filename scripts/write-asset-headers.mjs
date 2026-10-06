#!/usr/bin/env node
/**
 * Writes dist/_headers — the security headers for everything the asset layer
 * serves — from worker/lib/securityPolicy.ts, so the page and the API carry
 * ONE policy text. Runs as the last step of `npm run build`.
 *
 * wrangler.jsonc runs the Worker only for /api/* and /files/*; index.html,
 * every SPA route and /assets/* are answered by Workers Static Assets before
 * the Worker runs, so the middleware in lib/http.ts never reaches them. The
 * asset layer honours this file instead.
 *
 * EARLY HINTS (P2b, docs/MERCHANT_PLATFORM_V2.md §B.2). The catch-all rule
 * also carries a `Link` header naming the entry stylesheet and the Arabic
 * font as preloads — read from Vite's manifest, because the stylesheet's name
 * carries its hash. Once the owner switches Early Hints on, Cloudflare turns
 * that header into a 103 and both start one round trip before the document.
 * Every other rule unsets it, for the reason every other rule unsets
 * everything: a later rule APPENDS. The Worker sets the same line on the
 * documents it rewrites (worker/index.ts `assetWithPreview`).
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { assetHeadersFile } from '../worker/lib/securityPolicy.ts';
import { stampServiceWorker } from './stamp-service-worker.mjs';

/**
 * THE SAME THREE LINES AS worker/lib/socialPreview.ts (`ARABIC_FONT_PRELOAD`,
 * `entryStylesheets`, `earlyHintsLink`), spelled again here on purpose: this
 * script runs under plain `node`, which resolves only what securityPolicy.ts
 * needs (nothing), while socialPreview.ts imports half the worker through
 * extensionless paths that only tsx/wrangler resolve. The duplication is
 * pinned equal by tests/documentPreloads.test.ts, so the Worker's Link and
 * the asset layer's Link cannot drift apart.
 */
export const ARABIC_FONT_PRELOAD = '/fonts/cairo/cairo-v31-arabic.woff2';
export const entryStylesheets = (manifest) => (manifest?.['index.html']?.css ?? []).map((css) => `/${css}`);
export function earlyHintsLink(styles, font = ARABIC_FONT_PRELOAD) {
  // Vite emits crossorigin stylesheets: the hint must use the same fetch mode
  // or Chromium downloads the render-blocking CSS twice.
  const parts = styles.map((href) => `<${href}>; rel=preload; as=style; crossorigin`);
  if (font) parts.push(`<${font}>; rel=preload; as=font; crossorigin`);
  return parts.join(', ');
}

/** The `Link` line for the catch-all, or null when the manifest is not there to name the stylesheet. */
export function earlyHintsLine(manifestPath = 'dist/.vite/manifest.json') {
  if (!existsSync(manifestPath)) return null;
  try {
    const styles = entryStylesheets(JSON.parse(readFileSync(manifestPath, 'utf8')));
    return styles.length ? earlyHintsLink(styles) : null;
  } catch {
    return null;
  }
}

/**
 * Add `Link: …` to the first (catch-all) rule and `! Link` to every rule after
 * it. Pure over the generated text, so the test can feed it a fixture.
 */
export function withEarlyHints(text, link) {
  if (!link) return text;
  const out = [];
  let rule = 0;
  let pending = false;
  for (const line of text.split('\n')) {
    const isPath = line.startsWith('/');
    if (isPath) {
      rule += 1;
      out.push(line);
      if (rule > 1) out.push('  ! Link');
      pending = rule === 1;
      continue;
    }
    // The catch-all's body ends at its first blank line: the Link goes last in it.
    if (pending && line.trim() === '') {
      out.push(`  Link: ${link}`);
      pending = false;
    }
    out.push(line);
  }
  if (pending) out.push(`  Link: ${link}`);
  return out.join('\n');
}

// Run as a script: write the file. Imported (tests/documentPreloads.test.ts): only the functions above.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!existsSync('dist/index.html')) {
    console.error('write-asset-headers: dist/index.html is missing — run vite build first');
    process.exit(1);
  }
  const link = earlyHintsLine();
  const text = withEarlyHints(assetHeadersFile(), link);
  writeFileSync('dist/_headers', text);
  stampServiceWorker();
  console.log(
    `write-asset-headers: dist/_headers written (${text.split('\n').length - 1} lines${link ? ', with the Early Hints Link' : ', no manifest — no Early Hints Link'})`
  );
}
