/**
 * THE TRANSLATIONS, ASSEMBLED INTO COMMITTED PARTS (docs/bambu-import/I18N-DESIGN.md §D "Return path", §E).
 *
 *   npx tsx scripts/bambu-import/i18n-assemble.ts --in <scratchpad>/i18n \
 *     --data data/bambu-import --out data/bambu-import/translations [--accept-seeds] [--no-authored]
 *
 * 1. Reads `strings.json` and, for each `batches/batch-NNN.json`, the
 *    translators' `batches/batch-NNN.out.json` — `[{ h, ar, ckb, status }]`,
 *    `status` exactly `reviewed`, `needs_review` or `keep` (the English stays:
 *    ar and ckb are the English), a reviewer having signed it off. Any other
 *    status — none, a typo, `draft`, `machine` — refuses that row (STATUS).
 * 2. Every row is normalized (packages/catalog/src/bambuImport/i18n.ts
 *    `normalizeSource`) and checked with `validateTranslationRow` — the names
 *    and the identity terms included, exactly as the CI data test and the
 *    Worker's loader check it. Every refusal is printed by batch, key and code
 *    (never the text) and the row is left out: that string stays English.
 * 3. `--accept-seeds`: a string with no translator row takes the local
 *    dictionary's seed as `machine` when the seed passes the same check.
 *    The registry's own words for a heading the content blocks carry
 *    (strings.json `authored`) are part p000 unless `--no-authored`.
 * 4. Writes `pNNN.json` for batch NNN (rows in batch order, keys in order,
 *    products sorted, one row per line). A part this run owns (p000 and its
 *    batches' numbers) that ends up empty is REMOVED, so a withdrawn batch
 *    leaves nothing loadable behind; a part file that holds a string of no
 *    batch of this run belongs to another round and is never overwritten (a
 *    problem: the extraction of a later round numbers its batches after the
 *    committed parts, `--existing`).
 * 5. A later round's `linked` strings (committed earlier, used by products of
 *    this round): their products are added to the committed row in its part,
 *    so those products get its ref when the part is loaded again.
 * 6. Regenerates `index.json` over every part file present, then checks the
 *    directory as CI does. A coverage line says how many strings stay English.
 *
 * Deterministic: the same inputs write the same bytes. Nothing is fetched.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { normalizeSource, serializeTranslationPart, validateTranslationRow, type TranslationRow, type TmKind, type TmStatus } from '@levonis/catalog/bambuImport/i18n';
import { loadReviewedBundle } from './discover';
import { checkTranslationsDir, IDENTITY, indexOf, manifestProductIds, serializeIndex, translationNames } from './i18nData';
import type { StringsFile } from './i18n-strings';

export interface AssembleOptions {
  inDir: string;
  dataDir: string;
  outDir: string;
  acceptSeeds?: boolean;
  authored?: boolean;
}

export interface AssembleReport {
  parts: Array<{ part: string; rows: number }>;
  /** Part files this run owned that ended up empty, removed. */
  removed: string[];
  /** Committed parts a later round's `linked` products were added to. */
  relinked: Array<{ part: string; rows: number; products: number }>;
  strings: number;
  translated: number;
  keep: number;
  needsReview: number;
  seeds: number;
  authored: number;
  english: number;
  refused: Array<{ batch: string; h: string; code: string }>;
  problems: string[];
}

/** The statuses a translator's row may carry (`machine` is the dictionary's seed, never a translator's). */
const OUT_STATUSES: ReadonlySet<string> = new Set<TmStatus>(['reviewed', 'needs_review', 'keep']);

interface OutRow {
  h: string;
  ar: string;
  ckb: string;
  status: string;
}

function readOut(path: string): OutRow[] {
  if (!existsSync(path)) return [];
  const v = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  if (!Array.isArray(v)) throw new Error(`${path} is not a list`);
  return v.map((r) => {
    const o = (r ?? {}) as Record<string, unknown>;
    return { h: String(o.h ?? ''), ar: String(o.ar ?? ''), ckb: String(o.ckb ?? ''), status: typeof o.status === 'string' ? o.status : '' };
  });
}

/** The rows of a committed part file (empty when it is absent or unreadable). */
function partRows(path: string): TranslationRow[] {
  if (!existsSync(path)) return [];
  try {
    const v = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    return Array.isArray(v) ? (v as TranslationRow[]) : [];
  } catch {
    return [];
  }
}

/** strings.json + the translators' outputs → the committed parts and index (see the header). */
export function assemble(opts: AssembleOptions): AssembleReport {
  const bundle = loadReviewedBundle(opts.dataDir);
  const names = translationNames(bundle);
  const ctx = { names, identity: IDENTITY };
  const strings = JSON.parse(readFileSync(join(opts.inDir, 'strings.json'), 'utf8')) as StringsFile;
  const byH = new Map(strings.strings.map((s) => [s.h, s]));
  const report: AssembleReport = {
    parts: [],
    removed: [],
    relinked: [],
    strings: strings.strings.length,
    translated: 0,
    keep: 0,
    needsReview: 0,
    seeds: 0,
    authored: 0,
    english: 0,
    refused: [],
    problems: [],
  };
  mkdirSync(opts.outDir, { recursive: true });
  const covered = new Set<string>();

  /**
   * Writes a part this run owns — or removes it when it ends up empty. `mine` is every key this run may put in it:
   * a part file holding any other key belongs to another round and is left as it is (a problem). p000 (`mine`
   * null) is every run's: the extraction lists every authored heading of the whole corpus each time.
   */
  const write = (part: string, rows: TranslationRow[], mine: ReadonlySet<string> | null) => {
    const path = join(opts.outDir, `${part}.json`);
    const foreign = mine ? partRows(path).filter((r) => !mine.has(String(r?.h ?? ''))) : [];
    if (foreign.length) {
      report.problems.push(`${part}: holds ${foreign.length} string(s) of no batch of this run (another round's part); not overwritten`);
      return;
    }
    if (!rows.length) {
      if (existsSync(path)) {
        rmSync(path);
        report.removed.push(part);
      }
      return;
    }
    writeFileSync(path, serializeTranslationPart(rows));
    report.parts.push({ part, rows: rows.length });
  };
  const validated = (batch: string, raw: Omit<TranslationRow, 'products' | 'status'> & { status: string; products: string[] }): TranslationRow | null => {
    const row = { ...raw, ar: normalizeSource(raw.ar), ckb: normalizeSource(raw.ckb), products: [...new Set(raw.products)].sort() };
    const v = validateTranslationRow(row, ctx);
    if (v.ok) return v.row;
    report.refused.push({ batch, h: row.h.slice(0, 12), code: v.code });
    return null;
  };

  // p000: the registry's own words for the headings the content blocks carry (removed with --no-authored).
  {
    const rows: TranslationRow[] = [];
    if (opts.authored !== false) {
      for (const a of strings.authored ?? []) {
        const r = validated('authored', { h: a.h, en: a.en, ar: a.ar, ckb: a.ckb, kind: a.kind, status: 'reviewed', products: a.products });
        if (r) rows.push(r);
      }
    }
    report.authored = rows.length;
    write('p000', rows, null);
  }

  const batchDir = join(opts.inDir, 'batches');
  const batchFiles = existsSync(batchDir) ? readdirSync(batchDir).filter((f) => /^batch-\d{3,}\.json$/.test(f)).sort() : [];
  for (const f of batchFiles) {
    const num = /^batch-(\d{3,})\.json$/.exec(f)![1];
    const batch = JSON.parse(readFileSync(join(batchDir, f), 'utf8')) as { strings: Array<{ h: string; en: string; kind: TmKind; dict: { ar: string; ckb: string } | null }> };
    const outs = new Map(readOut(join(batchDir, `batch-${num}.out.json`)).map((r) => [r.h, r]));
    const rows: TranslationRow[] = [];
    for (const s of batch.strings) {
      const entry = byH.get(s.h);
      if (!entry) {
        report.problems.push(`batch-${num}: a string not in strings.json`);
        continue;
      }
      const out = outs.get(s.h);
      let row: TranslationRow | null = null;
      if (out && !OUT_STATUSES.has(out.status)) {
        report.refused.push({ batch: `batch-${num}`, h: s.h.slice(0, 12), code: 'STATUS' });
      } else if (out) {
        row = validated(`batch-${num}`, { h: entry.h, en: entry.en, ar: out.ar, ckb: out.ckb, kind: entry.kind, status: out.status, products: entry.products });
        if (row?.status === 'keep') report.keep += 1;
        else if (row?.status === 'needs_review') report.needsReview += 1;
        else if (row) report.translated += 1;
      } else if (opts.acceptSeeds && entry.dict) {
        row = validated(`batch-${num}`, { h: entry.h, en: entry.en, ar: entry.dict.ar, ckb: entry.dict.ckb, kind: entry.kind, status: 'machine', products: entry.products });
        if (row) report.seeds += 1;
      }
      if (row) {
        rows.push(row);
        // A `keep` or `needs_review` row is stored, never shown: that string still reads in English.
        if (row.status === 'reviewed' || row.status === 'machine') covered.add(row.h);
      }
    }
    for (const h of outs.keys()) if (!batch.strings.some((s) => s.h === h)) report.problems.push(`batch-${num}: an output row for a string of another batch`);
    write(`p${num}`, rows, new Set(batch.strings.map((s) => s.h)));
  }
  report.english = strings.strings.filter((s) => !covered.has(s.h)).length;

  // A later round: the products that use a string an earlier round committed join that row (their refs).
  const linkedByPart = new Map<string, Array<{ h: string; products: string[] }>>();
  for (const l of strings.linked ?? []) {
    const list = linkedByPart.get(l.part) ?? [];
    list.push({ h: l.h, products: l.products });
    linkedByPart.set(l.part, list);
  }
  for (const [part, links] of [...linkedByPart].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const path = join(opts.outDir, `${part}.json`);
    if (report.parts.some((x) => x.part === part)) {
      report.problems.push(`${part}: linked strings name a part this run wrote`);
      continue;
    }
    const rows = partRows(path);
    const byKey = new Map(rows.map((r) => [r.h, r]));
    let added = 0;
    for (const l of links) {
      const r = byKey.get(l.h);
      if (!r) {
        report.problems.push(`${part}: a linked string is not in it`);
        continue;
      }
      const before = r.products.length;
      r.products = [...new Set([...r.products, ...l.products])].sort();
      added += r.products.length - before;
    }
    if (added) {
      writeFileSync(path, serializeTranslationPart(rows));
      report.relinked.push({ part, rows: links.length, products: added });
    }
  }

  // The index over every part file present, then the directory checked as CI checks it.
  const parts = new Map(
    readdirSync(opts.outDir)
      .filter((f) => /^p[0-9]{3,}\.json$/.test(f))
      .sort()
      .map((f) => [f.replace(/\.json$/, ''), readFileSync(join(opts.outDir, f), 'utf8')] as const)
  );
  writeFileSync(join(opts.outDir, 'index.json'), serializeIndex(indexOf(parts)));
  report.problems.push(...checkTranslationsDir(opts.outDir, { names, productIds: manifestProductIds(bundle) }));
  return report;
}

export function main(argv = process.argv.slice(2)): number {
  const flags = new Set<string>(argv.filter((a) => a === '--accept-seeds' || a === '--no-authored'));
  const rest = argv.filter((a) => !flags.has(a));
  const given: Record<string, string> = {};
  for (let i = 0; i < rest.length; i += 2) given[rest[i]] = rest[i + 1] ?? '';
  const root = resolve(new URL('../../', import.meta.url).pathname);
  if (!given['--in']) {
    process.stderr.write('usage: i18n-assemble.ts --in <dir with strings.json and batches/> [--data data/bambu-import] [--out data/bambu-import/translations] [--accept-seeds] [--no-authored]\n');
    return 2;
  }
  const r = assemble({
    inDir: resolve(given['--in']),
    dataDir: resolve(root, given['--data'] || 'data/bambu-import'),
    outDir: resolve(root, given['--out'] || 'data/bambu-import/translations'),
    acceptSeeds: flags.has('--accept-seeds'),
    authored: !flags.has('--no-authored'),
  });
  for (const x of r.refused) process.stdout.write(`[i18n-assemble] refused ${x.batch} ${x.h}… ${x.code}\n`);
  for (const p of r.problems) process.stdout.write(`[i18n-assemble] problem: ${p}\n`);
  for (const p of r.removed) process.stdout.write(`[i18n-assemble] removed ${p} (no row left)\n`);
  for (const p of r.relinked) process.stdout.write(`[i18n-assemble] linked ${p.products} product(s) to ${p.rows} committed row(s) of ${p.part}\n`);
  process.stdout.write(
    `[i18n-assemble] parts ${r.parts.length}; strings ${r.strings}: translated ${r.translated}, keep ${r.keep}, needs_review ${r.needsReview}, dictionary seeds ${r.seeds}, authored ${r.authored}; still English ${r.english}; refused ${r.refused.length}\n`
  );
  return r.problems.length ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main();
