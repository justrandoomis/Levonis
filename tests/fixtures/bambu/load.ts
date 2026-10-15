/**
 * Loaders for the Bambu import fixtures (spec §K.2 step 4): the 8 audit-class
 * samples (identity, options, gallery, description element and JSON-LD, with
 * every money, stock and promotion key removed at capture), the trimmed
 * `filament-buffer` and `ams-2-pro` pages (real flight data, ≤ 200 KB, with
 * forbidden values replaced by `PLANTED-<key>` so a test can prove none is
 * ever read), the option structure (options, variants and gallery only) of
 * the AMS 2 Pro (with its real manifest row), the CyberBrick time-lapse kit
 * and the PTFE tubes, and the real P0 compat-targets.json (DRAFT of
 * 2026-10-15, copied verbatim).
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

export type SampleHandle = (typeof SAMPLE_HANDLES)[number] | 'ams-2-pro.options' | 'cyberbrick-timelapse-kit.options' | 'ptfe-tubes.options';

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

/** A trimmed real page by handle (`<handle>.page.html`). */
export function pageOf(handle: 'filament-buffer' | 'ams-2-pro'): PageExtraction {
  return extractPage(readFileSync(join(BAMBU_FIXTURES, `${handle}.page.html`), 'utf8'));
}

/** A JSON fixture by file name (a manifest row, compat-targets.json …). */
export function fixtureJson<T = unknown>(file: string): T {
  return JSON.parse(readFileSync(join(BAMBU_FIXTURES, file), 'utf8')) as T;
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
