#!/usr/bin/env node
/**
 * THE BAMBU IMPORT, DRY RUN AGAINST A LOCAL WORKER (import spec §K.2 step 10
 * (b) in the sandbox, (c) as workflow 60 `mode=dryrun`).
 *
 * The real Worker under `wrangler dev --local` with a FRESH `--persist-to`
 * database (every migration applied the way D1 applies them), the real
 * importer (scripts/bambu-import/run.ts) in `open` then `run` mode against it,
 * a local stand-in for the store serving the committed fixture pages
 * (tests/fixtures/bambu/filament-buffer.page.html and ams-2-pro.page.html),
 * robots.txt and the sitemaps, and Playwright in Arabic, English and Sorani,
 * phone and desktop, light and dark.
 *
 *   - The reviewed bundle is a fixture bundle (the two fixture rows, the P0
 *     taxonomy, identity and media files, the fixture compat-targets, an empty
 *     matches file, a minimal reviewed curated file for the curated row). The
 *     Worker bundles data/bambu-import/ at build time, so the run happens in a
 *     TEMPORARY COPY of worker/ beside that bundle: the repository's own
 *     data/bambu-import/ is never touched.
 *   - A run row with the SHA-256 of a fresh token is inserted into the local
 *     database (what cf.mjs `open` does live); each job gets a 0600 token file.
 *   - Images: `--images double` (the sandbox, which cannot reach the CDN)
 *     serves every store.bblcdn.com path from the local stand-in through the
 *     dev-only var CATALOG_IMPORT_MEDIA_ORIGIN, which the ops endpoint must
 *     honour only under `wrangler dev --local` (an integration item) — a
 *     picture of its own per path (`standInPng`), so the Worker's collapse of
 *     byte-identical gallery images (§C.4 step 1) does not fold a gallery
 *     into one;
 *     `--images real` (the runner) lets the local Worker fetch the real CDN.
 *   - LOCAL ONLY for the browser: every request to a host other than
 *     127.0.0.1 is aborted and counted, and the run fails unless that count
 *     is 0 and no page error was thrown. The importer too: with a local site
 *     origin its own requests reach 127.0.0.1 only (run.ts localOnlyFetch:
 *     a document check, a tracker or a wiki page is refused unsent and
 *     counted), and every job must log that count.
 *   - The importer runs as a child that does not block this process
 *     (runChild): the stand-in is served from here. One log per job.
 *   - No Cloudflare credential: the script refuses to start when one is in its
 *     environment.
 *
 * Pass conditions (results.json): every fixture item COMPLETE; a full re-run
 * writes zero rows; no guard hit (IMPORT_FINANCIAL_WRITE_REFUSED); every
 * imported product has price 0 / no cost / stock NULL / no package columns and
 * `stock_decision = 'not_configured'`; 0 blocked browser requests.
 *
 * How to run (one heavy process; run it alone):
 *   npm run build            # or pass --build
 *   OUT_DIR=/tmp/e2e-bambu node scripts/e2e-bambu-import.mjs [--images double|real] [--seal <public key> --out <dir>]
 *
 * With --seal every result file and screenshot leaves only sealed (workflow
 * 60); without it they are written in clear to OUT_DIR (the sandbox only).
 * Env: OUT_DIR, PORT (default 8857), STORE_PORT (default 8858), CHROMIUM_PATH,
 * PLAYWRIGHT_MODULE, KEEP_DEV=1.
 */
import { createRequire } from 'node:module';
import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { cpSync, createWriteStream, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { deflateSync } from 'node:zlib';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { splitStatements } from './lib/sql-split.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURES = join(ROOT, 'tests', 'fixtures', 'bambu');
export const FIXTURE_HANDLES = ['filament-buffer', 'ams-2-pro'];
const UNPRICED = { ar: 'السعر غير متوفر حالياً', en: 'Price not available yet', ckb: 'نرخ هێشتا بەردەست نییە' };

// ------------------------------------------------------------------ arguments (pure)

export function parseArgs(argv) {
  const out = { build: false, images: 'double', seal: '', out: '' };
  for (let at = 0; at < argv.length; at++) {
    const a = argv[at];
    if (a === '--build') out.build = true;
    else if (a === '--images') out.images = argv[++at] ?? '';
    else if (a === '--seal') out.seal = argv[++at] ?? '';
    else if (a === '--out') out.out = argv[++at] ?? '';
    else throw new Error(`unknown argument ${JSON.stringify(a)}`);
  }
  if (!['double', 'real'].includes(out.images)) throw new Error('--images is double or real');
  if (out.seal && !/^[A-Za-z0-9_-]{43}$/.test(out.seal)) throw new Error('--seal is a one-time public key');
  if (out.seal && !out.out) throw new Error('--seal needs --out');
  return out;
}

/** Refused when any Cloudflare credential is present: the dry run never references one (§K.2 10 (c)). */
export function refuseCredentials(env) {
  const found = Object.keys(env).filter((k) => /^CLOUDFLARE_|^CF_API|^WRANGLER_.*TOKEN/.test(k) && env[k]);
  if (found.length) throw new Error(`a Cloudflare credential is in the environment (${found.join(', ')}): the dry run never uses one`);
}

// ------------------------------------------------------------------ the fixture bundle (pure)

const sha256 = (data) => createHash('sha256').update(data).digest('hex');

/** The manifest rows of the fixture items: the P0 rows as reviewed, queue positions 1…n. */
export function fixtureRows(p0Manifest, amsRow) {
  const byHandle = new Map((p0Manifest.rows ?? []).map((r) => [r.handle, r]));
  const rows = [];
  for (const handle of FIXTURE_HANDLES) {
    const row = handle === 'ams-2-pro' ? { ...amsRow } : byHandle.get(handle);
    if (!row) throw new Error(`no manifest row for ${handle}`);
    delete row._meta;
    rows.push({ ...row, queue_position: rows.length + 1, audit_classes: row.audit_classes ?? [] });
  }
  return rows;
}

/** A reviewed curated file that only states what was searched: enough for the curated gate. */
export function minimalCurated(handle) {
  return { handle, schema: 2, curated_by: 'e2e-fixture', reviewed_by: 'e2e-fixture', curated_at: '2026-10-15', searched: [], specs: [], hex: [], relations: [], in_the_box: [], documents: [], not_published: [] };
}

/** Every reviewed file of the fixture bundle, as text (path relative to data/bambu-import/ → contents). */
export function fixtureBundle({ p0Dir = join(ROOT, 'docs', 'bambu-import', 'p0'), fixtures = FIXTURES } = {}) {
  const read = (path) => JSON.parse(readFileSync(path, 'utf8'));
  const rows = fixtureRows(read(join(p0Dir, 'manifest.json')), read(join(fixtures, 'ams-2-pro.manifest-row.json')));
  const files = {
    'manifest.json': { version: 1, source: 'bambu_us', status: 'E2E FIXTURE', rows },
    'taxonomy-map.json': read(join(p0Dir, 'taxonomy-map.json')),
    'existing-matches.json': { version: 1, status: 'E2E FIXTURE', entries: [] },
    'compat-targets.json': read(join(fixtures, 'compat-targets.json')),
    'identity-map.json': read(join(p0Dir, 'identity-map.json')),
    'media-overrides.json': read(join(p0Dir, 'media-overrides.json')),
    'search-synonyms.json': read(join(p0Dir, 'search-synonyms.json')),
  };
  const text = Object.fromEntries(Object.entries(files).map(([k, v]) => [k, `${JSON.stringify(v, null, 2)}\n`]));
  const curatedIndex = {};
  for (const row of rows.filter((r) => r.curated === true)) {
    const body = `${JSON.stringify(minimalCurated(row.handle), null, 2)}\n`;
    text[`curated/${row.handle}.json`] = body;
    curatedIndex[row.handle] = sha256(body);
  }
  text['curated/index.json'] = `${JSON.stringify({ files: curatedIndex }, null, 2)}\n`;
  return { rows, text };
}

/** The run row cf.mjs `open` would create, with the hash of the given token (§B.3). */
export function runRowSql(runId, tokenHash, expiresAt, manifestTotal) {
  if (!/^cir_[0-9a-f]{24}$/.test(runId) || !/^[0-9a-f]{64}$/.test(tokenHash) || !/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(expiresAt)) throw new Error('a malformed run row');
  return `INSERT INTO catalog_import_runs (id, source, state, token_sha256, token_expires_at, github_run_id, manifest_total) VALUES ('${runId}', 'bambu_us', 'open', '${tokenHash}', '${expiresAt}', 'e2e', ${Number(manifestTotal) | 0})`;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const pngChunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};

/**
 * A small valid PNG (8×8, one RGB colour taken from the SHA-256 of the CDN path) the media stand-in answers: the
 * Worker stores media under a content-addressed key and collapses byte-identical gallery images into one (§C.4
 * step 1), so one picture for every path would collapse every gallery into a single image. Distinct paths get
 * distinct pixels (so distinct WebP bytes after conversion); the same path always gets the same bytes, as the CDN
 * gives them.
 */
export function standInPng(path) {
  const [r, g, b] = createHash('sha256').update(String(path)).digest();
  const size = 8;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: RGB
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: size }, () => [r, g, b]).flat())]);
  const raw = Buffer.concat(Array.from({ length: size }, () => row));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), pngChunk('IHDR', ihdr), pngChunk('IDAT', deflateSync(raw)), pngChunk('IEND', Buffer.alloc(0))]);
}

/** The local stand-in for the store and its CDN: request path → { status, type, body } (pure). */
export function storeAnswer(path, pages) {
  if (path === '/robots.txt') return { status: 200, type: 'text/plain', body: 'User-agent: *\nDisallow: /cart\nDisallow: /*filter*\n' };
  if (path === '/sitemap.xml') return { status: 200, type: 'application/xml', body: '<?xml version="1.0"?><sitemapindex><sitemap><loc>http://127.0.0.1/sitemap_products_1.xml</loc></sitemap></sitemapindex>' };
  if (path === '/sitemap_products_1.xml') {
    const locs = Object.keys(pages).map((h) => `<url><loc>https://us.store.bambulab.com/products/${h}</loc></url>`).join('');
    return { status: 200, type: 'application/xml', body: `<?xml version="1.0"?><urlset>${locs}</urlset>` };
  }
  if (path === '/sitemap_collections_1.xml') return { status: 200, type: 'application/xml', body: '<?xml version="1.0"?><urlset></urlset>' };
  const m = /^\/products\/([a-z0-9-]+)$/.exec(path);
  if (m && pages[m[1]]) return { status: 200, type: 'text/html; charset=utf-8', body: pages[m[1]] };
  if (isCdnPath(path)) return { status: 200, type: 'image/png', body: standInPng(path) };
  return { status: 404, type: 'text/plain', body: 'not found' };
}

/** A store.bblcdn.com path the stand-in serves: what the WORKER fetches through CATALOG_IMPORT_MEDIA_ORIGIN (§C.4). */
export const isCdnPath = (path) => /^\/(?:s\d+|cdn|files)\//.test(path) || /\.(png|jpe?g|webp|media)$/i.test(path);

export const IMPORT_UA = 'Mozilla/5.0 (compatible; LevonisCatalogImport/1.0; +https://levonis-iq.com)';

/**
 * The stand-in's hits, judged (pure): the importer's own (pages, robots.txt, sitemaps) carry the import's
 * User-Agent and its product pages are at least 11 s apart. The CDN paths are the Worker's media fetches, under
 * the Worker's own User-Agent: not the importer's requests, so not judged by its rules.
 */
export function storeHitFailures(hits) {
  const failures = [];
  const importer = hits.filter((h) => !isCdnPath(h.path));
  for (const h of importer) if (h.ua !== IMPORT_UA) failures.push(`${h.path}: User-Agent ${h.ua ? JSON.stringify(h.ua.slice(0, 80)) : '(none)'}`);
  const pages = importer.filter((h) => h.path.startsWith('/products/'));
  for (let i = 1; i < pages.length; i++) {
    const gap = pages[i].at - pages[i - 1].at;
    if (gap < 11_000) failures.push(`${pages[i].path}: ${gap} ms after ${pages[i - 1].path}`);
  }
  return failures;
}

/** The importer's own end-of-job line in a local dry run (run.ts main(), localOnlyFetch): its count, or null. */
export function localOnlyCount(log) {
  const m = /local dry run: (\d+) requests to a host other than 127\.0\.0\.1 refused, never sent/.exec(log);
  return m ? Number(m[1]) : null;
}

/** What the database must show after the run (pure over query results). */
export function judge({ items, products, refs, guardEvents, rerunWrites }) {
  const failures = [];
  for (const i of items) if (i.processing_state !== 'COMPLETE') failures.push(`item ${i.handle} is ${i.processing_state}`);
  for (const p of products) {
    if (Number(p.price_iqd) !== 0) failures.push(`${p.id}: a price`);
    for (const col of ['product_cost_iqd', 'prime_price_iqd', 'pro_price_iqd', 'original_price_iqd', 'stock', 'net_weight_g', 'package_weight_g', 'package_width_mm', 'package_depth_mm', 'package_height_mm']) {
      if (p[col] !== null && p[col] !== undefined) failures.push(`${p.id}: ${col} is set`);
    }
  }
  for (const r of refs) if (r.stock_decision !== 'not_configured') failures.push(`${r.product_id}: stock decision ${r.stock_decision}`);
  if (guardEvents > 0) failures.push(`${guardEvents} guard hits`);
  if (rerunWrites > 0) failures.push(`a full re-run wrote ${rerunWrites} rows`);
  return failures;
}

/**
 * A child process run WITHOUT blocking this one. The store and CDN stand-in
 * the importer talks to, and the pipe that drains `wrangler dev`'s output, are
 * served by THIS process's event loop: a synchronous spawn would starve them,
 * and every store request of the importer would end STORE_UNREACHABLE.
 * Resolves with the exit status (null when killed at `timeoutMs`), the signal
 * and both outputs.
 */
export function runChild(command, argv, { cwd, env, timeoutMs }) {
  return new Promise((resolveRun) => {
    let stdout = '';
    let stderr = '';
    let done = false;
    const finish = (status, signal) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolveRun({ status, signal, stdout, stderr });
    };
    const child = spawn(command, argv, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
    child.stdout.setEncoding('utf8').on('data', (c) => {
      stdout += c;
    });
    child.stderr.setEncoding('utf8').on('data', (c) => {
      stderr += c;
    });
    child.on('error', (e) => {
      stderr += `${e instanceof Error ? e.message : String(e)}\n`;
      finish(null, null);
    });
    child.on('close', (status, signal) => finish(status, signal));
  });
}

// ------------------------------------------------------------------ the run

async function run() {
  const args = parseArgs(process.argv.slice(2));
  refuseCredentials(process.env);
  const OUT = resolve(args.out || process.env.OUT_DIR || join(tmpdir(), 'e2e-bambu-import'));
  const PORT = Number(process.env.PORT || 8857);
  const STORE_PORT = Number(process.env.STORE_PORT || 8858);
  const BASE = `http://127.0.0.1:${PORT}`;
  const STORE = `http://127.0.0.1:${STORE_PORT}`;
  const WORK = mkdtempSync(join(tmpdir(), 'levonis-bambu-e2e-'));
  const PERSIST = join(WORK, 'persist');
  const WRANGLER = process.env.WRANGLER || join(ROOT, 'node_modules/.bin/wrangler');
  mkdirSync(OUT, { recursive: true });
  const results = { started_at: new Date().toISOString(), checks: [], blocked: [], page_errors: [] };
  const check = (name, ok, detail) => results.checks.push({ name, ok: !!ok, ...(detail === undefined ? {} : { detail }) });
  let sealBuffer = null;
  if (args.seal) ({ sealBuffer } = await import('./bambu-import/seal.mjs'));
  const emit = (name, data) => {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(typeof data === 'string' ? data : JSON.stringify(data, null, 2));
    if (sealBuffer) writeFileSync(join(OUT, `${name}.sealed`), sealBuffer(args.seal, buf), { mode: 0o600, flag: 'wx' });
    else writeFileSync(join(OUT, name), buf);
  };

  if (args.build) execFileSync('npm', ['run', 'build'], { cwd: ROOT, stdio: 'inherit' });
  if (!existsSync(join(ROOT, 'dist/index.html'))) throw new Error('dist/ is missing: run `npm run build` first, or pass --build');

  // 1. A temporary Worker tree beside the fixture bundle (the repository is never written).
  const bundle = fixtureBundle();
  const tree = join(WORK, 'tree');
  mkdirSync(tree);
  cpSync(join(ROOT, 'worker'), join(tree, 'worker'), { recursive: true });
  for (const f of ['wrangler.jsonc', 'package.json', 'tsconfig.json']) if (existsSync(join(ROOT, f))) cpSync(join(ROOT, f), join(tree, f));
  for (const d of ['node_modules', 'dist', 'packages', 'services', 'migrations']) if (existsSync(join(ROOT, d))) symlinkSync(join(ROOT, d), join(tree, d));
  for (const [file, body] of Object.entries(bundle.text)) {
    mkdirSync(dirname(join(tree, 'data', 'bambu-import', file)), { recursive: true });
    writeFileSync(join(tree, 'data', 'bambu-import', file), body);
  }

  // 2. A fresh local database at the newest migration, and the run row.
  execFileSync(WRANGLER, ['d1', 'execute', 'levonis-db', '--local', '--persist-to', PERSIST, '--command', 'SELECT 1'], { cwd: tree, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: '1' } });
  const dbDir = join(PERSIST, 'v3/d1/miniflare-D1DatabaseObject');
  const dbFile = join(dbDir, readdirSync(dbDir).find((f) => f.endsWith('.sqlite') && f !== 'metadata.sqlite'));
  const db = new DatabaseSync(dbFile);
  db.exec('CREATE TABLE IF NOT EXISTS d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP)');
  for (const f of readdirSync(join(ROOT, 'migrations')).filter((n) => n.endsWith('.sql')).sort()) {
    db.exec('BEGIN');
    for (const s of splitStatements(readFileSync(join(ROOT, 'migrations', f), 'utf8'))) db.exec(s);
    db.exec('COMMIT');
    db.prepare('INSERT INTO d1_migrations (name) VALUES (?)').run(f);
  }
  const runId = `cir_${randomBytes(12).toString('hex')}`;
  const mintToken = () => {
    const token = randomBytes(32).toString('hex');
    const file = join(WORK, `token-${randomBytes(4).toString('hex')}`);
    writeFileSync(file, `${token}\n`, { mode: 0o600 });
    return { file, hash: sha256(token) };
  };
  const first = mintToken();
  db.exec(runRowSql(runId, first.hash, new Date(Date.now() + 6 * 3600_000).toISOString(), bundle.rows.length));
  db.close();

  // 3. The store and CDN stand-in, then the Worker.
  const pages = Object.fromEntries(FIXTURE_HANDLES.map((h) => [h, readFileSync(join(FIXTURES, `${h}.page.html`), 'utf8')]));
  const storeHits = [];
  const store = createServer((req, res) => {
    const path = new URL(req.url ?? '/', STORE).pathname;
    storeHits.push({ path, ua: req.headers['user-agent'] ?? '', at: Date.now() });
    const a = storeAnswer(path, pages);
    res.writeHead(a.status, { 'content-type': a.type });
    res.end(a.body);
  });
  await new Promise((r) => store.listen(STORE_PORT, '127.0.0.1', r));
  const devLog = createWriteStream(join(WORK, 'wrangler-dev.log'));
  const dev = spawn(
    WRANGLER,
    ['dev', '--local', '--persist-to', PERSIST, '--ip', '127.0.0.1', '--port', String(PORT), '--show-interactive-dev-session=false', ...(args.images === 'double' ? ['--var', `CATALOG_IMPORT_MEDIA_ORIGIN:${STORE}`] : [])],
    { cwd: tree, env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: '1', NO_UPDATE_NOTIFIER: '1' }, stdio: ['ignore', 'pipe', 'pipe'] }
  );
  dev.stdout.pipe(devLog);
  dev.stderr.pipe(devLog);
  try {
    let up = false;
    for (let i = 0; i < 240 && !up; i++) {
      try {
        up = (await fetch(`${BASE}/api/settings/public`)).status < 500;
      } catch {
        await new Promise((r) => setTimeout(r, 500));
      }
    }
    check('wrangler dev answers on 127.0.0.1', up);
    if (!up) throw new Error('wrangler dev did not answer in 120 s');

    // 4. The importer: open, then run until the queue is empty, then a full re-run.
    const seal = args.seal || (await import('./bambu-import/seal.mjs')).generateSealKeys().publicKey;
    const jobs = [];
    const importer = async (mode, tokenFile) => {
      const outputs = join(WORK, `outputs-${mode}-${randomBytes(3).toString('hex')}`);
      writeFileSync(outputs, '');
      const result = await runChild(process.execPath, ['--import', 'tsx', join(ROOT, 'scripts/bambu-import/run.ts')], {
        cwd: ROOT,
        timeoutMs: 60 * 60_000,
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          IN_MODE: mode,
          IN_RUN_ID: mode === 'open' ? '' : runId,
          IN_MAX_ITEMS: '0',
          IN_RESUME: 'false',
          IN_CHAIN: 'false',
          IN_CHAIN_COUNT: '0',
          IN_ITEM: '',
          IN_SEAL_PUBKEY: seal,
          DEADLINE_EPOCH: String(Math.floor(Date.now() / 1000) + 330 * 60),
          IMPORT_TOKEN_FILE: tokenFile,
          IMPORT_SITE_ORIGIN: BASE,
          IMPORT_STORE_ORIGIN: STORE,
          IMPORT_DATA_DIR: join(tree, 'data', 'bambu-import'),
          IMPORT_OUT_DIR: join(WORK, `sealed-${mode}`),
          GITHUB_OUTPUT: outputs,
          PLAYWRIGHT_MODULE: process.env.PLAYWRIGHT_MODULE ?? '',
          CHROMIUM_PATH: process.env.CHROMIUM_PATH ?? '',
        },
      });
      // One log per job (a re-run must not write over the run it re-runs).
      jobs.push({ mode, refused: localOnlyCount(result.stdout) });
      writeFileSync(join(WORK, `importer-${jobs.length}-${mode}.log`), `${result.stdout}\n${result.stderr}`);
      return { status: result.status, outputs: readFileSync(outputs, 'utf8') };
    };
    const opened = await importer('open', first.file);
    check('mode open: hello, manifest, taxonomy, protected snapshot', opened.status === 0);
    const rowCount = () => {
      const r = new DatabaseSync(dbFile, { readOnly: true });
      try {
        return ['products', 'product_option_values', 'product_variants', 'product_images', 'product_spec_values', 'product_documents', 'product_relations']
          .map((t) => Number(r.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n))
          .reduce((a, b) => a + b, 0);
      } finally {
        r.close();
      }
    };
    const setToken = () => {
      const t = mintToken();
      const w = new DatabaseSync(dbFile);
      w.exec(`UPDATE catalog_import_runs SET token_sha256 = '${t.hash}' WHERE id = '${runId}'`);
      w.close();
      return t.file;
    };
    const ran = await importer('run', setToken());
    check('mode run: the queue ran to its end', ran.status === 0 && /more=false/.test(ran.outputs) && /blocked=false/.test(ran.outputs), ran.outputs);
    const before = rowCount();
    const again = await importer('run', setToken());
    const rerunWrites = rowCount() - before;
    check('a full re-run: nothing left to do', again.status === 0 && /more=false/.test(again.outputs));

    // 5. The database (read-only) and the store's view of the importer.
    const r = new DatabaseSync(dbFile, { readOnly: true });
    const items = r.prepare('SELECT handle, processing_state FROM catalog_import_items WHERE run_id = ?').all(runId);
    const refs = r.prepare('SELECT product_id, stock_decision FROM product_source_refs WHERE import_run_id = ?').all(runId);
    const products = refs.length
      ? r.prepare(`SELECT id, price_iqd, product_cost_iqd, prime_price_iqd, pro_price_iqd, original_price_iqd, stock, net_weight_g, package_weight_g, package_width_mm, package_depth_mm, package_height_mm, slug FROM products WHERE id IN (SELECT value FROM json_each(?))`).all(JSON.stringify(refs.map((x) => x.product_id)))
      : [];
    const guardEvents = Number(r.prepare("SELECT COUNT(*) AS n FROM catalog_import_events WHERE run_id = ? AND code = 'IMPORT_FINANCIAL_WRITE_REFUSED'").get(runId).n);
    r.close();
    const failures = judge({ items, products, refs, guardEvents, rerunWrites });
    check(`every fixture item COMPLETE (${items.length}/${FIXTURE_HANDLES.length}), no money, stock not configured, no guard hit, re-run writes 0`, failures.length === 0 && items.length === FIXTURE_HANDLES.length, failures);
    const hitFailures = storeHitFailures(storeHits);
    check('store pages at least 11 s apart, with the import User-Agent', hitFailures.length === 0, hitFailures.slice(0, 10));
    check('the importer sent nothing off 127.0.0.1 (every job held to it, its refusals counted)', jobs.every((j) => j.refused !== null), jobs);

    // 6. The pages in ar / en / ckb, phone and desktop, light and dark.
    const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || '/opt/node22/lib/node_modules/playwright/index.js');
    const executablePath = process.env.CHROMIUM_PATH || (existsSync('/opt/pw-browsers/chromium-1194/chrome-linux/chrome') ? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' : undefined);
    const browser = await chromium.launch({ ...(executablePath ? { executablePath } : {}), args: ['--no-sandbox'] });
    try {
      for (const p of products) {
        for (const lang of ['ar', 'en', 'ckb']) {
          for (const [view, width] of [['phone', 390], ['desktop', 1280]]) {
            for (const scheme of ['light', 'dark']) {
              const ctx = await browser.newContext({ viewport: { width, height: 900 }, colorScheme: scheme, serviceWorkers: 'block' });
              await ctx.route('**/*', (route) => {
                const u = route.request().url();
                if (u.startsWith(BASE) || u.startsWith('data:') || u.startsWith('blob:')) return route.continue();
                results.blocked.push(u.slice(0, 160));
                return route.abort('blockedbyclient');
              });
              await ctx.addInitScript((l) => {
                try {
                  localStorage.setItem('levo_lang', l);
                } catch {
                  /* storage blocked */
                }
              }, lang);
              const page = await ctx.newPage();
              page.on('pageerror', (e) => results.page_errors.push(String(e).slice(0, 300)));
              await page.goto(`${BASE}/product/${p.slug}`, { waitUntil: 'domcontentloaded' });
              await page.waitForTimeout(1500);
              const text = await page.locator('body').innerText();
              if (view === 'phone' && scheme === 'light') check(`${p.slug} ${lang}: «${UNPRICED[lang]}»`, text.includes(UNPRICED[lang]));
              emit(`shot-${p.slug}-${lang}-${view}-${scheme}.png`, await page.screenshot({ fullPage: true }));
              await ctx.close();
            }
          }
        }
      }
    } finally {
      await browser.close();
    }
    check('no request left 127.0.0.1', results.blocked.length === 0, results.blocked.slice(0, 10));
    check('no page error', results.page_errors.length === 0, results.page_errors.slice(0, 5));
  } finally {
    if (!process.env.KEEP_DEV) dev.kill('SIGINT');
    store.close();
    results.finished_at = new Date().toISOString();
    results.ok = results.checks.every((c) => c.ok);
    emit('results.json', results);
    if (!process.env.KEEP_DEV) rmSync(WORK, { recursive: true, force: true });
  }
  process.stdout.write(`e2e-bambu-import: ${results.checks.filter((c) => c.ok).length}/${results.checks.length} checks passed\n`);
  return results.ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().then(
    (code) => {
      process.exitCode = code;
    },
    (err) => {
      process.stderr.write(`e2e-bambu-import: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exitCode = 1;
    }
  );
}
