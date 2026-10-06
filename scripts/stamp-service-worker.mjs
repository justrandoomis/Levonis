import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** A regular frontend deploy must change the worker bytes too, so browsers
 * can offer its update. Content-derived, not a clock or commit: rebuilding
 * identical assets is identical, and the existing cache names stay intact. */
export function stampedServiceWorker(source, html, manifest) {
  const build = createHash('sha256').update(html).update('\0').update(manifest).digest('hex').slice(0, 20);
  return `${source.trimEnd()}\n\n// Frontend build identity; cache versions remain policy-owned.\nself.__LEVONIS_BUILD__ = '${build}';\n`;
}

export function stampServiceWorker(dist = 'dist', source = 'public/sw.js') {
  const result = stampedServiceWorker(
    readFileSync(source, 'utf8'),
    readFileSync(join(dist, 'index.html'), 'utf8'),
    readFileSync(join(dist, '.vite/manifest.json'), 'utf8'),
  );
  writeFileSync(join(dist, 'sw.js'), result);
}
