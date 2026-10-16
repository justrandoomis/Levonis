/**
 * THE TRANSLATION MEMORY'S LOADER, RUNNER SIDE (docs/bambu-import/I18N-DESIGN.md
 * §A.4; workflow 60 mode `translations`).
 *
 *   node --import tsx scripts/bambu-import/translations.ts \
 *     --data data/bambu-import/translations --site https://levonis-iq.com \
 *     --token-file "$RUNNER_TEMP/import-token" --run cir_<24 hex>
 *
 * 1. `/hello`: the door answers for this run, and the live database has 0196.
 * 2. For each part of the committed `index.json`, in name order: the file is
 *    read as UTF-8, its SHA-256 checked against the index here first (a part
 *    edited after the index was written never leaves the runner), then posted
 *    through the ops client (`loadTranslations`). The Worker proves it again
 *    against ITS bundled index and row by row, writes it in one batch and
 *    purges the products it changed; a part its ledger holds is skipped.
 * 3. The log carries part names and counts — never a string of a part. A
 *    refusal stops the job with exit 1 and its code.
 *
 * The token file is read and deleted at once (0600, minted by cf.mjs). No
 * Cloudflare credential exists here: the import door is the only way in.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Deadline, parseDeadlineEpoch, realClock } from './deadline';
import { OpsClient, OpsError, type TranslationsAnswer } from './opsClient';
import { sha256Hex, type TranslationsIndexFile } from './i18nData';
import { SITE_ORIGIN, takeToken } from './run';
import type { FetchLike } from './fetch';

const LOCAL_ORIGIN = /^http:\/\/127\.0\.0\.1:\d{2,5}$/;
const RUN_ID = /^cir_[0-9a-f]{24}$/;
const PART = /^p[0-9]{3,}$/;

export interface TranslationsConfig {
  dataDir: string;
  siteOrigin: string;
  tokenFile: string;
  runId: string;
}

export class TranslationsConfigError extends Error {}

/** `--data`, `--site`, `--token-file`, `--run`: each validated; the site is the live site or a local dry run. */
export function configFromArgs(argv: readonly string[], env: NodeJS.ProcessEnv, root: string): TranslationsConfig {
  const given: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 2) {
    const k = argv[i];
    const v = argv[i + 1];
    if (!['--data', '--site', '--token-file', '--run'].includes(k) || v === undefined || k in given) throw new TranslationsConfigError('usage: --data <dir> --site <origin> --token-file <file> --run <cir_…>');
    given[k] = v;
  }
  const siteOrigin = (given['--site'] ?? SITE_ORIGIN).replace(/\/+$/, '');
  if (siteOrigin !== SITE_ORIGIN && !LOCAL_ORIGIN.test(siteOrigin)) throw new TranslationsConfigError('the site origin is the live site or a local dry run, nothing else');
  const runId = given['--run'] ?? '';
  if (!RUN_ID.test(runId)) throw new TranslationsConfigError('--run is cir_ followed by 24 lowercase hex characters');
  const tokenFile = given['--token-file'] ?? env.IMPORT_TOKEN_FILE ?? '';
  if (!tokenFile) throw new TranslationsConfigError('--token-file is required');
  return { dataDir: resolve(root, given['--data'] ?? 'data/bambu-import/translations'), siteOrigin, tokenFile, runId };
}

/** The committed index, and each part's text checked against it. */
export function readParts(dataDir: string): Array<{ part: string; text: string }> {
  const indexPath = join(dataDir, 'index.json');
  if (!existsSync(indexPath)) throw new TranslationsConfigError('index.json is missing');
  const index = JSON.parse(readFileSync(indexPath, 'utf8')) as TranslationsIndexFile;
  if (!index || index.version !== 1 || !index.parts || typeof index.parts !== 'object') throw new TranslationsConfigError('index.json is not { version: 1, parts }');
  const out: Array<{ part: string; text: string }> = [];
  for (const part of Object.keys(index.parts).sort()) {
    if (!PART.test(part)) throw new TranslationsConfigError('index.json names a part outside p<digits>');
    const bytes = readFileSync(join(dataDir, `${part}.json`));
    if (sha256Hex(bytes) !== index.parts[part].sha256) throw new TranslationsConfigError(`${part}: the file differs from index.json`);
    out.push({ part, text: new TextDecoder().decode(bytes) });
  }
  return out;
}

export interface LoaderDeps {
  client: Pick<OpsClient, 'hello' | 'loadTranslations'>;
  log: (line: string) => void;
}

/** /hello, then every part in order. 0 when every part loaded or was skipped; 1 at the first refusal. */
export async function loadAll(cfg: Pick<TranslationsConfig, 'runId'>, parts: ReadonlyArray<{ part: string; text: string }>, deps: LoaderDeps): Promise<number> {
  try {
    const hello = await deps.client.hello();
    if (hello.run.id !== cfg.runId) {
      deps.log('::error::[translations] the door answers for another run');
      return 1;
    }
    if (hello.migrations_present['0196'] !== true) {
      deps.log('::error::[translations] the live database has no translation tables (migration 0196): deploy through workflow 7 first');
      return 1;
    }
    const total = { parts: 0, skipped: 0, inserted: 0, updated: 0, unchanged: 0, refs: 0, purged: 0 };
    for (const { part, text } of parts) {
      const a: TranslationsAnswer = await deps.client.loadTranslations(part, text);
      total.parts += 1;
      if (a.skipped) total.skipped += 1;
      total.inserted += a.inserted;
      total.updated += a.updated;
      total.unchanged += a.unchanged;
      total.refs += a.refs_added;
      total.purged += a.purged_products;
      deps.log(
        `[translations] ${part}: ${a.skipped ? 'skipped (already loaded)' : `rows ${a.rows}, inserted ${a.inserted}, updated ${a.updated}, unchanged ${a.unchanged}, refs ${a.refs_added}, purged ${a.purged_products}${a.purge_truncated ? ' (more age out within 15 minutes)' : ''}`}`
      );
    }
    deps.log(`[translations] done: ${total.parts} parts (${total.skipped} skipped), inserted ${total.inserted}, updated ${total.updated}, unchanged ${total.unchanged}, refs ${total.refs}, purged ${total.purged}`);
    return 0;
  } catch (err) {
    const code = err instanceof OpsError ? err.code : 'TRANSLATIONS_LOADER_FAILED';
    deps.log(`::error::[translations] ${/^[A-Z0-9_]{2,60}$/.test(code) ? code : 'TRANSLATIONS_LOADER_FAILED'}`);
    return 1;
  }
}

export async function main(argv = process.argv.slice(2), env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const root = resolve(new URL('../../', import.meta.url).pathname);
  const log = (line: string) => process.stdout.write(`${line}\n`);
  let cfg: TranslationsConfig;
  let token: string;
  let parts: Array<{ part: string; text: string }>;
  try {
    cfg = configFromArgs(argv, env, root);
    token = takeToken(cfg.tokenFile);
    parts = readParts(cfg.dataDir);
  } catch (err) {
    log(`::error::[translations] ${err instanceof Error && /^[\w ,;:.'()<>…-]{1,200}$/.test(err.message) ? err.message : 'the loader configuration is invalid'}`);
    return 2;
  }
  const network: FetchLike = (url, init) => fetch(url, init);
  const deadline = new Deadline(env.DEADLINE_EPOCH ? parseDeadlineEpoch(env.DEADLINE_EPOCH) : Date.now() + 60 * 60_000, realClock);
  const client = new OpsClient({ siteOrigin: cfg.siteOrigin, token, fetch: network, clock: realClock, deadline });
  log(`[translations] ${parts.length} parts in index.json`);
  return loadAll(cfg, parts, { client, log });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    () => {
      process.stdout.write('::error::[translations] the loader stopped unexpectedly\n');
      process.exitCode = 1;
    }
  );
}
