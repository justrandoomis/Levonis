/**
 * THE TRANSLATION MEMORY'S COMMITTED DATA (docs/bambu-import/I18N-DESIGN.md
 * §A.3, §E): data/bambu-import/translations/ holds one part file per
 * translation batch (`pNNN.json`, never bundled, ≤ 1 MB) and `index.json`
 * (bundled into the Worker: each part's SHA-256, row count and size).
 *
 * One set of rules for the assembler (scripts/bambu-import/i18n-assemble.ts),
 * the extraction (scripts/bambu-import/i18n-strings.ts) and the CI data test
 * (tests/catalogTranslationsData.test.ts):
 *
 *   - `translationNames`: the names a translation keeps verbatim — the
 *     manifest's titles of two words or more (a one-word title such as
 *     «Brush» is an ordinary word in a sentence; a one-word material code is
 *     kept by the code and identity rules), the compat-targets labels,
 *     compounds and requirement targets, the registry's models and «Bambu Lab»;
 *   - `manifestProductIds`: the product ids a ref may name — a create's
 *     deterministic `p_…` and a merge's reviewed id;
 *   - `checkTranslationsDir`: the index lists exactly the part files present,
 *     each entry's SHA-256, rows and bytes match, each file ≤ 1 MB and written
 *     as the assembler writes it; every row passes `validateTranslationRow`
 *     with the names and the identity terms; `h` and `en` are unique across
 *     parts; every product is a manifest product.
 *
 * Nothing here prints and nothing reaches a network.
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { serializeTranslationPart, validateTranslationRow, type TranslationRow } from '@levonis/catalog/bambuImport/i18n';
import { MODELS } from '@levonis/catalog/bambuImport/registry/models';
import { IDENTITY_TERMS } from '../../worker/lib/translate/dictionary';
import { newProductIdOf } from '../../worker/lib/catalogImport/reviewed';
import type { ReviewedBundle } from './discover';

export const TRANSLATIONS_DIR = 'data/bambu-import/translations';
export const PART_FILE = /^p[0-9]{3,}\.json$/;
export const PART_MAX_BYTES = 1024 * 1024;

export interface TranslationsIndexFile {
  version: 1;
  parts: Record<string, { sha256: string; rows: number; bytes: number }>;
}

export const sha256Hex = (s: string | Uint8Array): string => createHash('sha256').update(typeof s === 'string' ? Buffer.from(s, 'utf8') : s).digest('hex');

export const IDENTITY: ReadonlySet<string> = new Set(IDENTITY_TERMS);

/** The names a translation keeps verbatim (see the header). */
export function translationNames(bundle: Pick<ReviewedBundle, 'rows' | 'targets'>): Set<string> {
  const out = new Set<string>(['Bambu Lab']);
  for (const r of bundle.rows) {
    const t = String(r.title ?? '').trim();
    if (t && t.split(/\s+/).length >= 2) out.add(t);
  }
  const targets = (bundle.targets ?? {}) as unknown as Record<string, unknown>;
  for (const key of ['labels', 'compounds', 'requirement_targets']) {
    const v = targets[key];
    if (v && typeof v === 'object' && !Array.isArray(v)) for (const k of Object.keys(v)) if (k.trim()) out.add(k.trim());
  }
  for (const m of MODELS) out.add(m.token);
  return out;
}

/** Every product id a ref may name: a create's deterministic id, a merge's reviewed id. */
export function manifestProductIds(bundle: Pick<ReviewedBundle, 'rows' | 'matches'>): Set<string> {
  const out = new Set<string>();
  for (const r of bundle.rows) {
    out.add(newProductIdOf(r.source_product_id));
    const m = bundle.matches.get(r.source_product_id);
    if (m && m.levonis_product_id) out.add(String(m.levonis_product_id));
  }
  return out;
}

/** The index the assembler writes for these part texts (name → exact text). */
export function indexOf(parts: ReadonlyMap<string, string>): TranslationsIndexFile {
  const names = [...parts.keys()].sort();
  return {
    version: 1,
    parts: Object.fromEntries(
      names.map((n) => {
        const text = parts.get(n)!;
        return [n, { sha256: sha256Hex(text), rows: (JSON.parse(text) as unknown[]).length, bytes: Buffer.byteLength(text, 'utf8') }];
      })
    ),
  };
}

/** The index file's exact text. */
export const serializeIndex = (index: TranslationsIndexFile): string => `${JSON.stringify(index, null, 2)}\n`;

export interface CheckContext {
  names: ReadonlySet<string>;
  productIds: ReadonlySet<string>;
}

/** Every problem of a translations directory (empty: it is valid). */
export function checkTranslationsDir(dir: string, ctx: CheckContext): string[] {
  const problems: string[] = [];
  const indexPath = join(dir, 'index.json');
  if (!existsSync(indexPath)) return ['index.json is missing'];
  let index: TranslationsIndexFile;
  try {
    index = JSON.parse(readFileSync(indexPath, 'utf8')) as TranslationsIndexFile;
  } catch {
    return ['index.json is not JSON'];
  }
  if (!index || index.version !== 1 || !index.parts || typeof index.parts !== 'object') return ['index.json is not { version: 1, parts }'];
  const files = readdirSync(dir).filter((f) => f !== 'index.json');
  for (const f of files) if (!PART_FILE.test(f)) problems.push(`${f}: not a part file name`);
  const present = files.filter((f) => PART_FILE.test(f)).map((f) => f.replace(/\.json$/, '')).sort();
  const listed = Object.keys(index.parts).sort();
  if (JSON.stringify(present) !== JSON.stringify(listed)) problems.push(`index.json lists [${listed.join(', ')}] but the directory holds [${present.join(', ')}]`);
  const hashes = new Map<string, string>();
  const english = new Map<string, string>();
  for (const name of present) {
    const bytes = readFileSync(join(dir, `${name}.json`));
    const text = new TextDecoder().decode(bytes);
    const entry = index.parts[name];
    if (bytes.byteLength > PART_MAX_BYTES) problems.push(`${name}: ${bytes.byteLength} bytes, over 1 MB`);
    let rows: unknown[];
    try {
      rows = JSON.parse(text) as unknown[];
    } catch {
      problems.push(`${name}: not JSON`);
      continue;
    }
    if (!Array.isArray(rows)) {
      problems.push(`${name}: not a list`);
      continue;
    }
    if (entry) {
      if (entry.sha256 !== sha256Hex(bytes)) problems.push(`${name}: sha256 differs from index.json`);
      if (entry.rows !== rows.length) problems.push(`${name}: ${rows.length} rows, index.json says ${entry.rows}`);
      if (entry.bytes !== bytes.byteLength) problems.push(`${name}: ${bytes.byteLength} bytes, index.json says ${entry.bytes}`);
    }
    const valid: TranslationRow[] = [];
    rows.forEach((r, i) => {
      const v = validateTranslationRow(r, { names: ctx.names, identity: IDENTITY });
      if (!v.ok) {
        problems.push(`${name} row ${i}: ${v.code}`);
        return;
      }
      valid.push(v.row);
      const at = `${name} row ${i}`;
      if (hashes.has(v.row.h)) problems.push(`${at}: h repeats ${hashes.get(v.row.h)}`);
      else hashes.set(v.row.h, at);
      if (english.has(v.row.en)) problems.push(`${at}: en repeats ${english.get(v.row.en)}`);
      else english.set(v.row.en, at);
      for (const p of v.row.products) if (!ctx.productIds.has(p)) problems.push(`${at}: product ${p} is not a manifest product`);
    });
    if (valid.length === rows.length && serializeTranslationPart(valid) !== text) problems.push(`${name}: not written as the assembler writes a part (one row per line, keys in order, LF)`);
  }
  return problems;
}
