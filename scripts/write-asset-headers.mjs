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
 */
import { existsSync, writeFileSync } from 'node:fs';
import { assetHeadersFile } from '../worker/lib/securityPolicy.ts';

if (!existsSync('dist/index.html')) {
  console.error('write-asset-headers: dist/index.html is missing — run vite build first');
  process.exit(1);
}
const text = assetHeadersFile();
writeFileSync('dist/_headers', text);
console.log(`write-asset-headers: dist/_headers written (${text.split('\n').length - 1} lines)`);
