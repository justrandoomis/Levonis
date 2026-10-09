/**
 * THE POLICY HASH LEDGER — no published text changes without a new version
 * (owner decision 7, 2026-10-09; DECISIONS row 190).
 *
 * worker/lib/policySync.ts mirrors each (key, version, lang) into the archive
 * ONCE and never touches it again: when the archive already holds a row for a
 * version, the sync skips it. So a document edited in code WITHOUT a version
 * bump is a silent split — the site serves the new words while every
 * acceptance recorded from then on points at an archive row (and a hash)
 * holding the old ones. Nothing in the worker can notice; this file does.
 *
 * tests/fixtures/policyHashes.json maps `key@version:lang` to the
 * `policyDocHash` of the PUBLISHED text (facts filled, withheld clauses
 * removed — the exact bytes the archive stores and an acceptance names):
 *   - every current (key, version, lang) must be in it, so a bump forces a
 *     new entry, written down in review;
 *   - an entry for a current version must still hash the same, so an edit
 *     without a bump fails — and so does a change to ./facts.ts that reaches
 *     a document, which ./facts.ts says is a publication too;
 *   - entries for superseded versions stay as history. The code no longer
 *     holds their text, so they cannot be re-hashed here; they record what
 *     the archive's `hash` column should hold for them. The ledger starts
 *     with the versions current before purchase 6, faq 5, membership 5 and
 *     price_protection 4.
 *
 * Adding a version: bump it in its module, run this file, and copy the
 * `key@version:lang → hash` lines the failure prints into the fixture.
 *
 * Run: node --import tsx --test tests/policyHashLedger.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { POLICY_DOCUMENTS, POLICY_KEYS } from '../worker/lib/policies';
import { POLICY_LANGS, policyDocHash } from '../worker/lib/policies/types';
import { ensurePolicyCorpus, resetPolicyCorpusMemo } from '../worker/lib/policySync';
import { asD1, freshDb } from './fixtures/app';
import { ROOT } from './fixtures/d1';

const LEDGER_PATH = join(ROOT, 'tests', 'fixtures', 'policyHashes.json');
const LEDGER = JSON.parse(readFileSync(LEDGER_PATH, 'utf8')) as Record<string, string>;
const ENTRY = /^([a-z_]+)@([1-9]\d*):(ar|en|ckb)$/;

async function currentHashes(): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const doc of POLICY_DOCUMENTS) {
    for (const lang of POLICY_LANGS) {
      out.set(`${doc.key}@${doc.version}:${lang}`, await policyDocHash(doc.key, doc.version, lang, doc.title[lang], doc.body[lang]));
    }
  }
  return out;
}

test('the ledger is well formed: one sha-256 per key@version:lang, registry keys only, every version in all three languages', () => {
  const entries = Object.entries(LEDGER);
  assert.ok(entries.length >= POLICY_DOCUMENTS.length * POLICY_LANGS.length, `only ${entries.length} entries`);
  const byVersion = new Map<string, Set<string>>();
  for (const [id, hash] of entries) {
    const m = ENTRY.exec(id);
    assert.ok(m, `${id}: not key@version:lang`);
    assert.match(hash, /^[0-9a-f]{64}$/, `${id}: not a sha-256`);
    assert.ok((POLICY_KEYS as readonly string[]).includes(m[1]), `${id}: no such document`);
    const doc = POLICY_DOCUMENTS.find((d) => d.key === m[1])!;
    assert.ok(Number(m[2]) <= doc.version, `${id}: a version the code has never published (current is ${doc.version})`);
    const v = `${m[1]}@${m[2]}`;
    if (!byVersion.has(v)) byVersion.set(v, new Set());
    byVersion.get(v)!.add(m[3]);
  }
  for (const [v, langs] of byVersion) assert.deepEqual([...langs].sort(), [...POLICY_LANGS].sort(), `${v}: not all three languages`);
});

test('every current version is in the ledger — a version bump writes its entries down', async () => {
  const missing: string[] = [];
  for (const [id, hash] of await currentHashes()) if (!(id in LEDGER)) missing.push(`  "${id}": "${hash}",`);
  assert.deepEqual(missing, [], `add these lines to tests/fixtures/policyHashes.json:\n${missing.join('\n')}`);
});

test('every ledger entry for a current version still hashes the same — an edit without a version bump fails', async () => {
  const drifted: string[] = [];
  for (const [id, hash] of await currentHashes()) {
    if (id in LEDGER && LEDGER[id] !== hash) drifted.push(`${id}: ledger ${LEDGER[id].slice(0, 12)}…, text now ${hash.slice(0, 12)}…`);
  }
  assert.deepEqual(
    drifted,
    [],
    'the published text changed under a version the archive may already hold: bump the version in its module (and in every document a changed fact reaches) instead of editing it in place'
  );
});

test('the ledger is what the archive stores: a fresh sync writes exactly these hashes', async () => {
  const raw = freshDb();
  resetPolicyCorpusMemo();
  await ensurePolicyCorpus(asD1(raw));
  resetPolicyCorpusMemo();
  const rows = raw
    .prepare("SELECT key, version, lang, hash FROM policy_documents WHERE status = 'published'")
    .all() as Array<{ key: string; version: number; lang: string; hash: string }>;
  assert.equal(rows.length, POLICY_DOCUMENTS.length * POLICY_LANGS.length);
  for (const r of rows) assert.equal(r.hash, LEDGER[`${r.key}@${Number(r.version)}:${r.lang}`], `${r.key}@${r.version}:${r.lang}`);
});

test('the four documents decision 7 reworded moved to new versions, and their previous versions stay in the ledger', () => {
  const MOVED: ReadonlyArray<[string, number]> = [['purchase', 6], ['faq', 5], ['membership', 5], ['price_protection', 4]];
  for (const [key, version] of MOVED) {
    assert.equal(POLICY_DOCUMENTS.find((d) => d.key === key)!.version, version, key);
    for (const lang of POLICY_LANGS) {
      assert.ok(`${key}@${version}:${lang}` in LEDGER, `${key}@${version}:${lang}`);
      assert.ok(`${key}@${version - 1}:${lang}` in LEDGER, `${key}@${version - 1}:${lang} left the ledger`);
      assert.notEqual(LEDGER[`${key}@${version}:${lang}`], LEDGER[`${key}@${version - 1}:${lang}`], `${key}/${lang}: the new version is the old text`);
    }
  }
});
