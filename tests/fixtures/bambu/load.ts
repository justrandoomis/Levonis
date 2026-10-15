/**
 * Loaders for the Bambu import fixtures (spec §K.2 step 4): the 8 audit-class
 * samples (identity, options, gallery, description element and JSON-LD, with
 * every money, stock and promotion key removed at capture), the trimmed
 * `filament-buffer` page (real flight data, ≤ 200 KB, with forbidden values
 * replaced by `PLANTED-<key>` so a test can prove none is ever read), and the
 * AMS 2 Pro option structure (options, variants and gallery only).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from '../d1';
import { extractionFromSample, extractPage, type Extraction, type PageExtraction } from '../../../packages/catalog/src/bambuImport/extract';

export const BAMBU_FIXTURES = join(ROOT, 'tests', 'fixtures', 'bambu');

/** The 8 audit-class samples, by handle. */
export const SAMPLE_HANDLES = [
  'a1',
  'ams-2-pro-feeder-unit',
  'bambu-hotend-a1-a2',
  'bambu-textured-pei-plate',
  'build-plate-combo',
  'h2d',
  'pla-basic-filament',
  'refurbished-bambu-lab-h2d-3d-printer',
] as const;

export type SampleHandle = (typeof SAMPLE_HANDLES)[number] | 'ams-2-pro.options';

export function sampleJson(handle: SampleHandle): { product: unknown; description: unknown; jsonld: unknown } {
  return JSON.parse(readFileSync(join(BAMBU_FIXTURES, `${handle}.json`), 'utf8'));
}

export function sample(handle: SampleHandle): Extraction {
  return extractionFromSample(sampleJson(handle)).extraction;
}

export function pageHtml(): string {
  return readFileSync(join(BAMBU_FIXTURES, 'filament-buffer.page.html'), 'utf8');
}

export function page(): PageExtraction {
  return extractPage(pageHtml());
}

/**
 * A deep recording Proxy: every property READ (get) of an own string key is
 * logged with its key name; nested objects are wrapped on the way out.
 * Object.keys and `in` are not reads of a value.
 */
export function recording<T>(value: T, log: Set<string>): T {
  const cache = new WeakMap<object, unknown>();
  const wrap = (v: unknown): unknown => {
    if (!v || typeof v !== 'object') return v;
    const hit = cache.get(v as object);
    if (hit) return hit;
    const p = new Proxy(v as object, {
      get(target, key, receiver) {
        const out = Reflect.get(target, key, receiver);
        if (typeof key === 'string' && Object.prototype.hasOwnProperty.call(target, key) && !(Array.isArray(target) && (key === 'length' || /^\d+$/.test(key)))) {
          log.add(key);
        }
        return wrap(out);
      },
    });
    cache.set(v as object, p);
    return p;
  };
  return wrap(value) as T;
}
