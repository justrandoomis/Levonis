/**
 * NOTHING PRIVATE LEAVES THE IMPORT IN CLEAR (Bambu import spec §A.8).
 *
 * The repository is public, so are its Actions logs and artifacts. A recorded
 * run (open, then the queue: one product COMPLETE, one refused by the Worker;
 * then close; and a withdrawal) goes through the real runner against a fake
 * Worker that PLANTS a private value in EVERY field it answers — a hidden
 * product's name and slug, a draft product's SKU, an inactive catalog's key —
 * while the pages carry real `source_url`s and a manifest row carries a
 * planted `canonical_url`. Each value is planted ON ITS OWN, in the very shape
 * of the fields that are filtered by shape (a lower-case slug where a handle
 * goes, an UPPER_SNAKE SKU where a code or a stage goes, a snake_case key
 * where a reason goes), so a shape filter alone cannot pass this test. None
 * of them, and not the job token, may appear in the log, the job summary, the
 * step outputs or any file that is not sealed. Every artifact must be sealed,
 * and the private material it holds opens only with the one-time key. The
 * real process entry (`main()`, with GITHUB_OUTPUT, GITHUB_STEP_SUMMARY and
 * the file sealer) is run once per value too, through a local server.
 *
 * Run: node --import tsx --test tests/catalogImportLogs.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPrivateKey } from 'node:crypto';
import { ROOT } from './fixtures/d1';
import { SITE, TOKEN, World } from './fixtures/bambuImportWorld';
import { ImportLog, scrub, TEMPLATES } from '../scripts/bambu-import/log';
import { renderSummary } from '../scripts/bambu-import/summary';
import { fileSealer } from '../scripts/bambu-import/run';
// @ts-expect-error - plain ESM helper run by workflow 60 and in the sandbox, no types
import { unsealBuffer, generateSealKeys } from '../scripts/bambu-import/seal.mjs';

/** Each planted on its own: free text, and the shapes of a handle, a code or stage, a reason or finance key. */
const PLANTED = ['PLANTED-HIDDEN-NAME', 'planted-hidden-slug', 'PLANTED_DRAFT_SKU', 'planted_inactive_catalog', 'PLANTED HIDDEN NAME'];
const CANONICAL = 'https://us.store.bambulab.com/products/PLANTED-CANONICAL-URL';
/** Owner-only provenance that must never be printed (the fixture pages' image hosts, the store itself). */
const PROVENANCE = ['store.bblcdn.com', 'us.store.bambulab.com', 'PLANTED-CANONICAL-URL', 'cdn.shopify.com'];
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function filesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...filesUnder(path));
    else out.push(path);
  }
  return out;
}

/** Asserts that no planted value, provenance or the token is in `text`. */
function clean(where: string, text: string, planted: string): void {
  for (const secret of [TOKEN, planted, ...PROVENANCE]) assert.ok(!text.includes(secret), `${secret} appears in the ${where}`);
  assert.doesNotMatch(text, /[0-9a-f]{64}/, `no 64-hex value (a token or a hash) in the ${where}`);
}

/** Every file under `dir` is sealed, carries nothing in clear, and opens only with the one-time key. */
function allSealed(dir: string, privateKeyPem: string, planted: string): boolean {
  const files = filesUnder(dir);
  const key = createPrivateKey(privateKeyPem);
  let privateInside = false;
  for (const file of files) {
    assert.match(file, /\.sealed$/);
    const bytes = readFileSync(file);
    assert.equal(bytes.subarray(0, 6).toString(), 'LVSEAL');
    const raw = new TextDecoder('latin1').decode(bytes);
    for (const secret of [TOKEN, planted, ...PROVENANCE]) assert.ok(!raw.includes(secret), `${secret} in the sealed bytes of ${file}`);
    const clear = new TextDecoder().decode(unsealBuffer(key, bytes) as Uint8Array);
    if (clear.includes('store.bblcdn.com') || clear.includes(planted)) privateInside = true;
    assert.ok(!clear.includes(TOKEN), 'the token is not even in a sealed artifact');
  }
  return privateInside;
}

for (const planted of PLANTED) {
  test(`a recorded run with ${JSON.stringify(planted)} planted in every Worker field: it reaches no log, summary, output or unsealed file`, async () => {
    const w = new World({ planted });
    try {
      w.bundle.rows[0].canonical_url = CANONICAL;
      // The second product is refused by the Worker with a message that names private things.
      w.inject(/\/items\/580876092009701376\/stage$/, 9, () => json(400, { code: 'IMPORT_REVIEWED_SCOPE_REFUSED', message: `merge into ${planted} at ${CANONICAL}` }));
      const summaries: string[] = [];
      const job = async (over: Parameters<World['importer']>[0]) => {
        const code = await w.importer(over).main();
        summaries.push(readFileSync(w.summaryFile, 'utf8'));
        return code;
      };
      assert.equal(await job({ mode: 'open', runId: '' }), 0);
      assert.equal(await job({}), 0);
      assert.equal(w.item('filament-buffer').state, 'COMPLETE');
      assert.equal(w.item('ams-2-pro').blocker_code, 'REVIEWED_SCOPE_REFUSED');
      // close: the sitemaps, the sweep, the snapshot after, and a /run/finish whose state is the planted value.
      await job({ mode: 'close' });
      assert.ok(w.calls.some((c) => c.path === '/run/finish'), 'close reached /run/finish');

      // The private values really travelled through the runner (otherwise this test proves nothing).
      const manifestCall = w.calls.find((c) => c.path === '/manifest')!;
      assert.ok(JSON.stringify(manifestCall.body).includes(CANONICAL), 'the planted canonical_url reached the Worker');
      const stage = w.calls.find((c) => c.path.endsWith('/stage'))!;
      assert.ok(JSON.stringify(stage.body).includes('store.bblcdn.com'), 'source URLs travel in the payload');

      const log = w.logLines.join('\n');
      for (const [where, text] of [['log', log], ['outputs', JSON.stringify(w.outputs)], ...summaries.map((t, i) => [`summary of job ${i + 1}`, t])] as const) clean(where, text, planted);
      // The log says what happened, in codes and counts; the summary names the reviewed handle, not the Worker's text.
      assert.match(log, /#2 ams-2-pro BLOCKED: BLOCKED REVIEWED_SCOPE_REFUSED; the queue stops here/);
      assert.match(log, /COMPLETE: https:\/\/levonis-iq\.com\/product\/bambu-filament-buffer/);
      assert.match(log, /run finished: state \[\?\]/, 'a finish state outside the fixed list prints the marker');
      assert.match(summaries[1], /\| current_product \| (?:filament-buffer|ams-2-pro) \|/);
      assert.match(summaries[1], /\| missing_info_by_reason \| not_applicable 2 \|/);
      assert.match(summaries[1], /\| finance_protection \| guard_hits 0, snapshots\.before 1 \|/);
      assert.match(summaries.at(-1)!, /partial/);

      // Every file the job left is sealed; the private material is inside, and opens only with the one-time key.
      assert.ok(filesUnder(join(w.dir, 'out')).length >= 3);
      assert.ok(allSealed(join(w.dir, 'out'), w.keys.privateKeyPem, planted), 'the sealed reports keep the owner-only material for the agent');
      const other = generateSealKeys() as { privateKeyPem: string };
      assert.throws(() => unsealBuffer(createPrivateKey(other.privateKeyPem), readFileSync(filesUnder(join(w.dir, 'out'))[0])), /sealed to key/);
    } finally {
      w.dispose();
    }
    // A withdrawal: the Worker answers the planted value as the state.
    const g = new World({
      planted,
      handles: ['filament-buffer'],
      items: { '6945416380552': { state: 'BLOCKED', last_completed: '', blocker_code: 'SOURCE_WITHDRAWN' } },
      storePage: () => new Response('gone', { status: 410 }),
      sitemapExclude: ['filament-buffer'],
    });
    try {
      await g.importer({ mode: 'withdraw', item: '6945416380552' }).main();
      assert.equal(callsToWithdraw(g), 1, 'the withdrawal reached the Worker');
      assert.match(g.logLines.join('\n'), /withdrawn at the source: state \[\?\]/);
      clean('withdraw log', g.logLines.join('\n'), planted);
      clean('withdraw summary', readFileSync(g.summaryFile, 'utf8'), planted);
    } finally {
      g.dispose();
    }
  });
}

const callsToWithdraw = (w: World) => w.calls.filter((c) => /\/withdraw$/.test(c.path)).length;

/** The fake world behind a local HTTP server: the importer's real process talks to it as to the live site. */
async function serve(w: World): Promise<{ origin: string; close: () => Promise<void> }> {
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const headers = Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(', ') : String(v ?? '')]));
      const body = chunks.length ? Buffer.concat(chunks).toString('utf8') : undefined;
      w.fetch(`${SITE}${req.url}`, { method: req.method, headers, body })
        .then(async (answer) => {
          const out: Record<string, string> = {};
          answer.headers.forEach((value, key) => (out[key] = value));
          res.writeHead(answer.status, out);
          res.end(Buffer.from(await answer.arrayBuffer()));
        })
        .catch(() => res.writeHead(500).end());
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as { port: number }).port;
  return { origin: `http://127.0.0.1:${port}`, close: () => new Promise((resolve) => server.close(() => resolve())) };
}

for (const planted of PLANTED) {
  test(`the real main() in mode open with ${JSON.stringify(planted)} planted: GITHUB_OUTPUT, GITHUB_STEP_SUMMARY, stdout and every file it leaves are clean`, async () => {
    const w = new World({ planted });
    const job = mkdtempSync(join(tmpdir(), 'levonis-runner-main-'));
    const site = await serve(w);
    try {
      const tokenFile = join(job, 'import-token');
      writeFileSync(tokenFile, `${TOKEN}\n`, { mode: 0o600 });
      mkdirSync(join(job, 'out'), { mode: 0o700 });
      const output = join(job, 'github_output');
      const summary = join(job, 'step_summary');
      writeFileSync(output, '');
      writeFileSync(summary, '');
      const child = spawn(process.execPath, ['--import', 'tsx', join(ROOT, 'scripts/bambu-import/run.ts')], {
        cwd: ROOT,
        env: {
          PATH: process.env.PATH ?? '',
          HOME: job,
          IN_MODE: 'open',
          IN_RUN_ID: '',
          IN_MAX_ITEMS: '0',
          IN_RESUME: 'false',
          IN_CHAIN: 'false',
          IN_CHAIN_COUNT: '0',
          IN_ITEM: '',
          IN_SEAL_PUBKEY: w.keys.publicKey,
          DEADLINE_EPOCH: String(Math.floor(Date.now() / 1000) + 330 * 60),
          IMPORT_TOKEN_FILE: tokenFile,
          IMPORT_RUN_FILE: join(job, 'import-run'),
          IMPORT_SITE_ORIGIN: site.origin,
          IMPORT_DATA_DIR: join(w.dir, 'data'),
          IMPORT_OUT_DIR: join(job, 'out'),
          GITHUB_OUTPUT: output,
          GITHUB_STEP_SUMMARY: summary,
          GITHUB_RUN_ID: '123',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (c: Buffer) => (stdout += c.toString()));
      child.stderr.on('data', (c: Buffer) => (stderr += c.toString()));
      const code = await new Promise<number | null>((resolve) => child.on('close', resolve));
      assert.equal(code, 0, `${stdout}\n${stderr}`);
      assert.match(readFileSync(output, 'utf8'), /^more=false\nblocked=false\nrun_id=cir_[0-9a-f]{24}\n$/);
      assert.ok(readFileSync(summary, 'utf8').length > 0, 'the summary was written');
      assert.ok(w.calls.some((c) => c.path === '/run/protect-snapshot'), 'the open mode ran against the planted Worker');
      assert.match(stdout, /local dry run: 0 requests to a host other than 127\.0\.0\.1 refused, never sent/, 'a local site: the importer\'s requests were held to 127.0.0.1');
      clean('stdout', stdout, planted);
      clean('stderr', stderr, planted);
      // Every file the job left in its temporary directory: the token file is gone, the rest is clean or sealed.
      const left = filesUnder(job);
      assert.ok(!left.includes(tokenFile), 'the importer deleted the token file');
      for (const file of left) {
        if (file.startsWith(join(job, 'out'))) continue;
        clean(file, readFileSync(file, 'utf8'), planted);
      }
      assert.deepEqual(readdirSync(join(job, 'out')), ['open-report.json.sealed']);
      assert.ok(allSealed(join(job, 'out'), w.keys.privateKeyPem, planted));
    } finally {
      await site.close();
      w.dispose();
      rmSync(job, { recursive: true, force: true });
    }
  });
}

test('the logger prints only values of their own shape; exceptions are scrubbed', () => {
  const lines: string[] = [];
  const log = new ImportLog((l) => lines.push(l), { siteOrigin: 'https://levonis-iq.com' });
  log.addSecret(TOKEN);
  log.item(7, 'PLANTED HIDDEN NAME', 'VALIDATING', 'blocked', { code: 'PLANTED-DRAFT-SKU' });
  log.item(7, 'pla-basic-filament', 'VALIDATING', 'blocked', { code: 'PAYLOAD_REFUSED' });
  log.info('complete', { url: 'https://us.store.bambulab.com/products/a1' });
  log.info('complete', { url: 'https://levonis-iq.com/product/bambu-a1' });
  log.info('complete', { url: 'https://levonis-iq.com/product/../admin' });
  log.info('extracted', { groups: 'PLANTED-HIDDEN-NAME', values: 3, variants: true, images: Number.NaN });
  log.info('ops_error', { call: 'write', code: 'IMPORT_LEASE_LOST', status: 409 });
  log.exception('WRITING', new Error(`failed with Bearer ${TOKEN} at https://store.bblcdn.com/x.png id ${'f'.repeat(40)} ${TOKEN}`));
  log.exception('WRITING', 'PLANTED-HIDDEN-NAME');
  assert.deepEqual(lines.slice(0, 7), [
    '[import] #7 [?] VALIDATING: BLOCKED [?]; the queue stops here',
    '[import] #7 pla-basic-filament VALIDATING: BLOCKED PAYLOAD_REFUSED; the queue stops here',
    '[import] COMPLETE: [?]',
    '[import] COMPLETE: https://levonis-iq.com/product/bambu-a1',
    '[import] COMPLETE: [?]',
    '[import] extracted: [?] groups, 3 values, yes variants, [?] images',
    '[import] ops write: IMPORT_LEASE_LOST (HTTP 409)',
  ]);
  assert.equal(lines[7], '::error::[import] WRITING: Error: failed with Bearer [redacted] at https://[redacted] id [hex] [masked]');
  assert.equal(lines[8], '::error::[import] WRITING: Error: PLANTED-HIDDEN-NAME', 'a non-Error is printed only as scrubbed text (nothing of ours throws one)');
  assert.equal(scrub('x'.repeat(400)).length, 300);
});

test('the content pass\'s log lines (§O.6) carry counts, codes, the run id and a moot word only: every other value prints the marker', () => {
  const keys = ['delta_content_plan', 'delta_content_code', 'delta_content_registered', 'content_plan', 'content_moot', 'content_attached', 'content_seen'] as const;
  for (const k of keys) {
    const names = [...TEMPLATES[k].matchAll(/\{([a-z_]+)\}/g)].map((x) => x[1]);
    assert.ok(names.length > 0, k);
    // A placeholder is a count, or one of the shaped words (a run id, an error code, a moot word): never text.
    for (const n of names) assert.ok(!['url', 'handle', 'name', 'title', 'key', 'id', 'sid', 'slug', 'text'].includes(n), `${k}: {${n}}`);
  }
  const lines: string[] = [];
  const log = new ImportLog((l) => lines.push(l), { siteOrigin: 'https://levonis-iq.com' });
  log.info('delta_content_code', { code: 'IMAGE_CONVERT_FAILED', failed: 3 });
  log.info('delta_content_code', { code: 'https://store.bblcdn.com/a.png', failed: 'content:abc' as never });
  log.item(4, 'ams-2-pro', 'EXTRACTING', 'content_moot', { what: 'source_gone' });
  log.item(4, 'ams-2-pro', 'EXTRACTING', 'content_moot', { what: 'products/import/gallery/x.webp' });
  log.item(4, 'ams-2-pro', 'WRITING', 'content_attached', {
    attached: 3,
    blocks: 2,
    box: 1,
    already_present: 0,
    owner_removed: 0,
    owner_edited: 0,
    not_imported: 0,
    source_changed: 0,
    not_stored: 0,
    not_on_page: 0,
    product_not_public: 2,
    identity_changed: 0,
    source_gone: 0,
  });
  log.info('delta_content_plan', { run: 'cir_0123456789abcdef01234567', content_failed_total: 358, content_items: 189 });
  assert.equal(lines[0], '[import] content pass: 3 of the pictures to put back failed with IMAGE_CONVERT_FAILED');
  assert.equal(lines[1], '[import] content pass: [?] of the pictures to put back failed with [?]');
  assert.match(lines[2], /the page reads source_gone;/);
  assert.match(lines[3], /the page reads \[\?\];/);
  // Every outcome of the attach, so the plan's "fetched again" are accounted for whatever the fresh read found.
  assert.equal(
    lines[4],
    '[import] #4 ams-2-pro WRITING: content pass: 3 put back (2 description, 1 in the box); already there 0, removed by the owner 0, edited 0, not written by the import 0, store page changed 0, not stored 0, no longer on the page 0, product not public 2, page no longer this product 0, store page gone 0'
  );
  assert.match(lines[5], /^\[import\] content pass from run cir_0123456789abcdef01234567: 358 description and in-the-box pictures failed in the closed run; 189 items/);
  // A delta item that completed on a product not verified public: no address at all.
  log.item(4, 'ams-2-pro', 'COMPLETE', 'complete_unnamed');
  assert.equal(lines[6], '[import] #4 ams-2-pro COMPLETE: COMPLETE (a delta item whose product was not verified public: its address is not printed)');
});

test('the summary\'s content line: the job\'s per-picture outcomes summed, codes and counts only, in the three languages', () => {
  const text = renderSummary({
    mode: 'run',
    runId: 'cir_0123456789abcdef01234567',
    siteOrigin: 'https://levonis-iq.com',
    status: null,
    items: [],
    blocked: [],
    withdrawn: [],
    more: true,
    content: { items: 2, counts: { attached: 3, owner_edited: 2, not_stored: 0, 'https://x': 4, product_not_public: 1 } },
  });
  const line = text.split('\n').find((l) => l.startsWith('Description and in-the-box pictures, this job'))!;
  assert.equal(
    line,
    'Description and in-the-box pictures, this job — صور الوصف ومحتويات العلبة في هذه المهمة — وێنەکانی وەسف و ناوەڕۆکی سندوق لەم کارەدا: 2 items, 6 pictures: attached 3, owner_edited 2, product_not_public 1.'
  );
});

test('the summary: §H.3 counts only, "partial" names the BLOCKED items, never «تم» or "100 %"', () => {
  const base = { mode: 'run', runId: 'cir_0123456789abcdef01234567', siteOrigin: 'https://levonis-iq.com', withdrawn: [] as string[], more: false };
  // Each Worker field holds a private value of that field's OWN shape: a shape filter alone would print it.
  const status = {
    run: { id: 'cir_0123456789abcdef01234567', state: 'running' },
    counts: { COMPLETE: 3, BLOCKED: 1 },
    current: { source_product_id: '580876092009701376', handle: 'bambu-lab-a1-mini-owner-hidden', queue_position: 4, state: 'BLOCKED', last_completed_stage: 'VALIDATING' },
    next: null,
    // The Worker names its held items; the summary names them only from the reviewed manifest (run.ts writeSummary).
    held: [{ source_product_id: '580876092009701377', queue_position: 6, hold_code: 'PLANTED_DRAFT_SKU' }],
    last_verified_url: 'https://us.store.bambulab.com/products/a1',
    progress: {
      complete_count: 3,
      discovered_total: 4,
      created_count: 'PLANTED-HIDDEN-NAME',
      blocker: 'PLANTED_DRAFT_SKU',
      failed_stage: 'PLANTED_DRAFT_SKU',
      current_product: 'planted-hidden-slug',
      missing_info_by_reason: { not_found_in_checked_sources: 12, planted_inactive_catalog: 3 },
      finance_protection: { guard_hits: 0, planted_inactive_catalog: 1, snapshots: { before: 3, planted_inactive_catalog: 4 } },
    },
  };
  const handleOf = (sid: string) => (sid === '580876092009701376' ? 'ams-2-pro' : null);
  const partial = renderSummary({
    ...base,
    status,
    handleOf,
    items: [{ position: 4, handle: 'ams-2-pro', outcome: 'blocked', code: 'ACCESS_CHALLENGE' }, { position: 5, handle: 'a1', outcome: 'blocked', code: 'PLANTED_DRAFT_SKU' }],
    blocked: [{ handle: 'ams-2-pro', code: 'ACCESS_CHALLENGE' }, { handle: 'a1', code: 'PLANTED_DRAFT_SKU' }],
  });
  assert.match(partial, /The run is \*\*partial\*\*/);
  assert.match(partial, /- BLOCKED `ams-2-pro` ACCESS_CHALLENGE/);
  assert.match(partial, /3 of 4 items complete\./);
  assert.match(partial, /\| current_product \| ams-2-pro \|/, 'the reviewed handle of the id, never the Worker\'s text');
  assert.match(partial, /\| blocker \| - \|/);
  assert.match(partial, /\| failed_stage \| - \|/);
  assert.match(partial, /\| missing_info_by_reason \| not_found_in_checked_sources 12 \|/);
  assert.match(partial, /\| finance_protection \| guard_hits 0, snapshots\.before 3 \|/);
  for (const secret of [...PLANTED, 'bambu-lab-a1-mini-owner-hidden', 'us.store.bambulab.com']) assert.ok(!partial.includes(secret), secret);
  // An id outside the reviewed manifest names no product at all.
  assert.match(renderSummary({ ...base, status, handleOf: () => null, items: [], blocked: [] }), /\| current_product \| - \|/);
  assert.match(renderSummary({ ...base, status: { ...status, progress: { ...status.progress, blocker: 'ACCESS_CHALLENGE', failed_stage: 'VALIDATING' } }, handleOf, items: [], blocked: [] }), /\| failed_stage \| VALIDATING \|[\s\S]*\| blocker \| ACCESS_CHALLENGE \|/);
  const done = renderSummary({ ...base, status: { ...status, counts: { COMPLETE: 4 }, progress: { complete_count: 4, discovered_total: 4 } }, items: [], blocked: [], closedState: 'closed' });
  assert.doesNotMatch(done, /partial|100 ?%|تم/);
  assert.match(done, /4 of 4 items complete\./);
  assert.match(done, /closed/);
  // Held by the reviewed manifest: named by its handle and its code, never counted as done, and the run is partial.
  const held = renderSummary({ ...base, status: { ...status, counts: { COMPLETE: 4, DISCOVERED: 2 }, progress: { complete_count: 4, discovered_total: 6 } }, items: [], blocked: [], held: [{ handle: 'cyberbrick-timelapse-kit', code: 'OWNER_HIDDEN' }, { handle: 'a1', code: 'PLANTED_DRAFT_SKU' }], closedState: 'partial' });
  assert.match(held, /The run is \*\*partial\*\*/);
  assert.match(held, /2 items are held by the reviewed manifest/);
  assert.match(held, /- HELD `cyberbrick-timelapse-kit` OWNER_HIDDEN/);
  assert.match(held, /- HELD `a1` \n|- HELD `a1` $/m, 'a code outside the fixed lists prints nothing');
  assert.ok(!held.includes('PLANTED_DRAFT_SKU'));
});

test("the importer's sealer writes only <name>.sealed, never over a file, never a name it does not know", () => {
  const dir = mkdtempSync(join(tmpdir(), 'levonis-sealer-'));
  try {
    const keys = generateSealKeys() as { publicKey: string; privateKeyPem: string };
    const seal = fileSealer(join(dir, 'out'), keys.publicKey);
    const data = Buffer.from('private: PLANTED-HIDDEN-NAME');
    seal('item-0001.json', data);
    assert.ok(data.every((b: number) => b === 0), 'the clear buffer is wiped once sealed');
    assert.deepEqual(readdirSync(join(dir, 'out')), ['item-0001.json.sealed']);
    assert.equal((unsealBuffer(createPrivateKey(keys.privateKeyPem), readFileSync(join(dir, 'out', 'item-0001.json.sealed'))) as Buffer).toString(), 'private: PLANTED-HIDDEN-NAME');
    assert.throws(() => seal('item-0001.json', Buffer.from('again')), /EEXIST/);
    assert.throws(() => seal('../escape', Buffer.from('x')), /artifact name/);
    assert.throws(() => seal('PLANTED HIDDEN NAME', Buffer.from('x')), /artifact name/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
