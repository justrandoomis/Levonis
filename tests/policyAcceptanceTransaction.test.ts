import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { newSqlite, SqliteD1, ROOT, createTableSql } from './fixtures/d1';
import { preparePolicyAcceptance, isPolicyAcceptanceConflict, policyDocHash } from '../worker/lib/policyOps';
import { resetPolicyCorpusMemo } from '../worker/lib/policySync';
import type { Env } from '../worker/lib/types';

async function fixture() {
  // A new database is a new archive: `ensurePolicyCorpus` memoises a completed
  // mirror per isolate, and this file builds one database per test.
  resetPolicyCorpusMemo();
  const raw = newSqlite();
  raw.exec("CREATE TABLE users(id TEXT PRIMARY KEY); INSERT INTO users VALUES ('u'); CREATE TABLE orders(id TEXT PRIMARY KEY);");
  raw.exec(createTableSql('0003_final_phase.sql', 'policy_documents'));
  raw.exec(createTableSql('0003_final_phase.sql', 'policy_acceptances'));
  raw.exec(readFileSync(join(ROOT, 'migrations/0070_policy_publication_acceptance.sql'), 'utf8'));
  const seed = async (key: string, version: number, lang: string) => {
    const id = `${key}_${version}_${lang}`;
    const hash = await policyDocHash(key,version,lang,'Title',`Body ${lang}`);
    raw.prepare('INSERT INTO policy_documents (id,key,version,lang,title,body,hash,status) VALUES (?,?,?,?,?,?,?,?)')
      .run(id,key,version,lang,'Title',`Body ${lang}`,hash,'published');
    return {id,hash};
  };
  const ar = await seed('terms',1,'ar'); const en = await seed('terms',1,'en');
  await seed('privacy',1,'ar');
  const env = {DB:new SqliteD1(raw)} as unknown as Env;
  const accepted=[{key:'terms',version:1},{key:'privacy',version:1}];
  return {raw,env,seed,ar,en,accepted};
}

/**
 * WHAT CHANGED HERE. This test used to assert an ARABIC FALLBACK: the fixture
 * seeded `privacy` in Arabic only, so a customer reading in English had their
 * consent recorded against the Arabic row. That fallback can no longer happen
 * for a registry document — policy text moved into worker/lib/policies/, every
 * document is published in all three languages, and `preparePolicyAcceptance`
 * mirrors the whole corpus into the archive before it binds anything. So the
 * English reader now pins the ENGLISH text, which is the better outcome and
 * the one the reader page also relies on.
 *
 * The `lang IN (?, 'ar')` fallback in the query is deliberately left in place
 * and is deliberately NOT exercised here: it is the safety net for an archive
 * whose rows predate a translation, and there is no longer a way to reach that
 * state through the registry. See the report accompanying this change.
 */
test('consent pins the locale actually displayed and commits with the order', async () => {
  const {raw,env,en,accepted}=await fixture();
  try {
    const prepared=await preparePolicyAcceptance(env,'u','order:o1',accepted,{locale:'en',orderId:'o1'});
    assert.equal(raw.prepare('SELECT COUNT(*) n FROM policy_acceptances').get()?.n,0);
    await env.DB.batch([env.DB.prepare("INSERT INTO orders VALUES ('o1')"),...prepared.statements]);
    const rows=await env.DB.prepare('SELECT * FROM policy_acceptances ORDER BY policy_key').all<Record<string,unknown>>();
    assert.equal(rows.results.length,2);
    const terms=rows.results.find(r=>r.policy_key==='terms')!;
    const privacy=rows.results.find(r=>r.policy_key==='privacy')!;
    // The hand-seeded row wins over the mirror (INSERT OR IGNORE), so this
    // still proves consent binds to the exact archived text, not to a re-hash.
    assert.equal(terms.document_id,en.id); assert.equal(terms.hash,en.hash); assert.equal(terms.locale,'en');
    // Seeded in Arabic only, yet recorded in English: the mirror published the
    // English text before consent was bound to it.
    assert.equal(privacy.locale,'en'); assert.equal(privacy.requested_locale,'en');
    assert.equal(terms.order_id,'o1'); assert.equal(terms.event,'checkout.policy.accepted');
    // And the archive now holds what the registry says it should.
    const langs=raw.prepare("SELECT lang FROM policy_documents WHERE key='privacy' ORDER BY lang").all() as {lang:string}[];
    assert.deepEqual(langs.map(r=>r.lang),['ar','ckb','en']);
  } finally {raw.close();}
});

test('missing or stale consent is refused without writing any acceptance', async () => {
  const {raw,env}=await fixture();
  try {
    await assert.rejects(preparePolicyAcceptance(env,'u','order:o1',[{key:'terms',version:0}]),/review and accept/);
    assert.equal(raw.prepare('SELECT COUNT(*) n FROM policy_acceptances').get()?.n,0);
  } finally {raw.close();}
});

test('a failed order transaction leaves no order or detached consent', async () => {
  const {raw,env,accepted}=await fixture();
  try {
    const p=await preparePolicyAcceptance(env,'u','order:o1',accepted,{orderId:'o1'});
    await assert.rejects(env.DB.batch([env.DB.prepare("INSERT INTO orders VALUES ('o1')"),...p.statements,env.DB.prepare("INSERT INTO orders VALUES ('o1')")]));
    assert.equal(raw.prepare('SELECT COUNT(*) n FROM policy_acceptances').get()?.n,0);
    assert.equal(raw.prepare('SELECT COUNT(*) n FROM orders').get()?.n,0);
  } finally {raw.close();}
});

test('a policy published between quote verification and commit rolls the whole order back', async () => {
  const {raw,env,seed,accepted}=await fixture();
  try {
    const p=await preparePolicyAcceptance(env,'u','order:o1',accepted,{orderId:'o1'});
    await seed('terms',2,'ar');
    raw.prepare("UPDATE policy_documents SET status='archived' WHERE key='terms' AND version=1").run();
    await assert.rejects(env.DB.batch([env.DB.prepare("INSERT INTO orders VALUES ('o1')"),...p.statements]),isPolicyAcceptanceConflict);
    assert.equal(raw.prepare('SELECT COUNT(*) n FROM policy_acceptances').get()?.n,0);
    assert.equal(raw.prepare('SELECT COUNT(*) n FROM orders').get()?.n,0);
  } finally {raw.close();}
});

/**
 * WHAT CHANGED HERE. This test used to describe a deployment on which NOTHING
 * had been published yet: it archived every row, and `getRequiredCheckoutPolicies`
 * — which read the database — then required nothing, so an order with an empty
 * `policyAcceptance` was prepared successfully and only the in-flight guard
 * stopped it once a policy appeared.
 *
 * That state no longer exists. The required set is the CODE registry, so
 * consent is required on every deployment including one whose database was
 * reset, and an empty acceptance is refused outright before any statement is
 * built. The assertion is therefore stronger than the one it replaces: there
 * is no window to bypass, rather than a window that is guarded.
 */
test('consent cannot be bypassed by an empty archive — the requirement is the code, not the table', async () => {
  const {raw,env}=await fixture();
  try {
    raw.prepare("UPDATE policy_documents SET status='archived'").run();
    await assert.rejects(
      preparePolicyAcceptance(env,'u','order:o1',[],{orderId:'o1'}),
      /review and accept/
    );
    assert.equal(raw.prepare('SELECT COUNT(*) n FROM orders').get()?.n,0);
    assert.equal(raw.prepare('SELECT COUNT(*) n FROM policy_acceptances').get()?.n,0);
  } finally {raw.close();}
});

test('database refuses edits and deletion of previously published text but permits archiving', async () => {
  const {raw}=await fixture();
  try {
    for (const sql of ["UPDATE policy_documents SET body='changed' WHERE id='terms_1_ar'", "DELETE FROM policy_documents WHERE id='terms_1_ar'", "UPDATE policy_documents SET status='draft' WHERE id='terms_1_ar'"]) {
      assert.throws(()=>raw.exec(sql),/POLICY_IMMUTABLE/);
    }
    raw.prepare("UPDATE policy_documents SET status='archived' WHERE id='terms_1_ar'").run();
    assert.throws(()=>raw.exec("UPDATE policy_documents SET status='published' WHERE id='terms_1_ar'"),/POLICY_IMMUTABLE/);
  } finally {raw.close();}
});
