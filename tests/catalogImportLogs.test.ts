/**
 * NOTHING PRIVATE LEAVES THE IMPORT IN CLEAR (Bambu import spec §A.8).
 *
 * The repository is public, so are its Actions logs and artifacts. A recorded
 * run (open, then the queue: one product COMPLETE, one refused by the Worker)
 * goes through the real runner against a fake Worker that PLANTS private
 * values in every free-text field it answers — a hidden product's name and
 * slug, a draft product's SKU, an inactive catalog's name — while the pages
 * carry real `source_url`s and a manifest row carries a planted
 * `canonical_url`. None of them, and not the job token, may appear in the
 * log, the job summary, the step outputs or any file that is not sealed.
 * Every artifact must be sealed, and the private material it holds opens only
 * with the one-time key.
 *
 * Run: node --import tsx --test tests/catalogImportLogs.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPrivateKey } from 'node:crypto';
import { TOKEN, World } from './fixtures/bambuImportWorld';
import { ImportLog, scrub } from '../scripts/bambu-import/log';
import { renderSummary } from '../scripts/bambu-import/summary';
import { fileSealer } from '../scripts/bambu-import/run';
// @ts-expect-error - plain ESM helper run by workflow 60 and in the sandbox, no types
import { unsealBuffer, generateSealKeys } from '../scripts/bambu-import/seal.mjs';

const PLANTED = ['PLANTED-HIDDEN-NAME', 'planted-hidden-slug', 'PLANTED-DRAFT-SKU', 'PLANTED-INACTIVE-CATALOG'];
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

test('a recorded run with planted private values: none reaches the log, the summary, the outputs or an unsealed file', async () => {
  const w = new World({ planted: PLANTED });
  try {
    w.bundle.rows[0].canonical_url = CANONICAL;
    // The second product is refused by the Worker with a message that names private things.
    w.inject(/\/items\/580876092009701376\/stage$/, 9, () => json(400, { code: 'IMPORT_REVIEWED_SCOPE_REFUSED', message: `merge into ${PLANTED.join(' ')} at ${CANONICAL}` }));
    assert.equal(await w.importer({ mode: 'open', runId: '' }).main(), 0);
    assert.equal(await w.importer().main(), 0);
    assert.equal(w.item('filament-buffer').state, 'COMPLETE');
    assert.equal(w.item('ams-2-pro').blocker_code, 'REVIEWED_SCOPE_REFUSED');

    // The private values really travelled through the runner (otherwise this test proves nothing).
    const manifestCall = w.calls.find((c) => c.path === '/manifest')!;
    assert.ok(JSON.stringify(manifestCall.body).includes(CANONICAL), 'the planted canonical_url reached the Worker');
    const stage = w.calls.find((c) => c.path.endsWith('/stage'))!;
    assert.ok(JSON.stringify(stage.body).includes('store.bblcdn.com'), 'source URLs travel in the payload');

    const log = w.logLines.join('\n');
    const summary = readFileSync(w.summaryFile, 'utf8');
    const outputs = JSON.stringify(w.outputs);
    for (const [where, text] of [['log', log], ['summary', summary], ['outputs', outputs]] as const) {
      for (const secret of [TOKEN, ...PLANTED, ...PROVENANCE]) assert.ok(!text.includes(secret), `${secret} appears in the ${where}`);
      assert.doesNotMatch(text, /[0-9a-f]{64}/, `no 64-hex value (a token or a hash) in the ${where}`);
    }
    // The log says what happened, in codes and counts.
    assert.match(log, /#2 ams-2-pro BLOCKED: BLOCKED REVIEWED_SCOPE_REFUSED; the queue stops here/);
    assert.match(log, /COMPLETE: https:\/\/levonis-iq\.com\/product\/bambu-filament-buffer/);
    assert.match(summary, /partial/);

    // Every file the job left is sealed; the private material is inside, and opens only with the one-time key.
    const files = filesUnder(join(w.dir, 'out'));
    assert.ok(files.length >= 3);
    const key = createPrivateKey(w.keys.privateKeyPem);
    let privateInside = false;
    for (const file of files) {
      assert.match(file, /\.sealed$/);
      const bytes = readFileSync(file);
      assert.equal(bytes.subarray(0, 6).toString(), 'LVSEAL');
      const raw = new TextDecoder('latin1').decode(bytes);
      for (const secret of [TOKEN, ...PLANTED, ...PROVENANCE]) assert.ok(!raw.includes(secret), `${secret} in the sealed bytes of ${file}`);
      const clear = new TextDecoder().decode(unsealBuffer(key, bytes) as Uint8Array);
      if (clear.includes('store.bblcdn.com') || clear.includes('PLANTED-HIDDEN-NAME')) privateInside = true;
      assert.ok(!clear.includes(TOKEN), 'the token is not even in a sealed artifact');
    }
    assert.ok(privateInside, 'the sealed reports keep the owner-only material for the agent');
    const other = generateSealKeys() as { privateKeyPem: string };
    assert.throws(() => unsealBuffer(createPrivateKey(other.privateKeyPem), readFileSync(files[0])), /sealed to key/);
  } finally {
    w.dispose();
  }
});

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

test('the summary: §H.3 counts only, "partial" names the BLOCKED items, never «تم» or "100 %"', () => {
  const base = { mode: 'run', runId: 'cir_0123456789abcdef01234567', siteOrigin: 'https://levonis-iq.com', withdrawn: [] as string[], more: false };
  const status = {
    run: { id: 'cir_0123456789abcdef01234567', state: 'running' },
    counts: { COMPLETE: 3, BLOCKED: 1 },
    current: null,
    next: null,
    last_verified_url: 'https://us.store.bambulab.com/products/a1',
    progress: { complete_count: 3, discovered_total: 4, created_count: 'PLANTED-HIDDEN-NAME', blocker: 'PLANTED-DRAFT-SKU', current_product: 'planted hidden slug', missing_info_by_reason: { not_found_in_checked_sources: 12, 'PLANTED-INACTIVE-CATALOG': 3 } },
  };
  const partial = renderSummary({ ...base, status, items: [{ position: 4, handle: 'ams-2-pro', outcome: 'blocked', code: 'ACCESS_CHALLENGE' }], blocked: [{ handle: 'ams-2-pro', code: 'ACCESS_CHALLENGE' }] });
  assert.match(partial, /The run is \*\*partial\*\*/);
  assert.match(partial, /- BLOCKED `ams-2-pro` ACCESS_CHALLENGE/);
  assert.match(partial, /3 of 4 items complete\./);
  assert.match(partial, /\| missing_info_by_reason \| not_found_in_checked_sources 12 \|/);
  for (const secret of [...PLANTED, 'planted hidden slug', 'us.store.bambulab.com']) assert.ok(!partial.includes(secret), secret);
  const done = renderSummary({ ...base, status: { ...status, counts: { COMPLETE: 4 }, progress: { complete_count: 4, discovered_total: 4 } }, items: [], blocked: [], closedState: 'closed' });
  assert.doesNotMatch(done, /partial|100 ?%|تم/);
  assert.match(done, /4 of 4 items complete\./);
  assert.match(done, /closed/);
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
