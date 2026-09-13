import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { newSqlite, SqliteD1, ROOT, createTableSql } from './fixtures/d1';
import { preparePolicyAcceptance, isPolicyAcceptanceConflict, policyDocHash } from '../worker/lib/policyOps';
import type { Env } from '../worker/lib/types';

async function fixture() {
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

test('consent pins the actual displayed locale and Arabic fallback and commits with the order', async () => {
  const {raw,env,en,accepted}=await fixture();
  try {
    const prepared=await preparePolicyAcceptance(env,'u','order:o1',accepted,{locale:'en',orderId:'o1'});
    assert.equal(raw.prepare('SELECT COUNT(*) n FROM policy_acceptances').get()?.n,0);
    await env.DB.batch([env.DB.prepare("INSERT INTO orders VALUES ('o1')"),...prepared.statements]);
    const rows=await env.DB.prepare('SELECT * FROM policy_acceptances ORDER BY policy_key').all<Record<string,unknown>>();
    assert.equal(rows.results.length,2);
    const terms=rows.results.find(r=>r.policy_key==='terms')!;
    const privacy=rows.results.find(r=>r.policy_key==='privacy')!;
    assert.equal(terms.document_id,en.id); assert.equal(terms.hash,en.hash); assert.equal(terms.locale,'en');
    assert.equal(privacy.locale,'ar'); assert.equal(privacy.requested_locale,'en');
    assert.equal(terms.order_id,'o1'); assert.equal(terms.event,'checkout.policy.accepted');
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

test('the first-ever checkout policy cannot bypass consent during an in-flight checkout', async () => {
  const {raw,env,seed}=await fixture();
  try {
    raw.prepare("UPDATE policy_documents SET status='archived'").run();
    const p=await preparePolicyAcceptance(env,'u','order:o1',[],{orderId:'o1'});
    await seed('terms',2,'ar');
    await assert.rejects(env.DB.batch([env.DB.prepare("INSERT INTO orders VALUES ('o1')"),...p.statements]),isPolicyAcceptanceConflict);
    assert.equal(raw.prepare('SELECT COUNT(*) n FROM orders').get()?.n,0);
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
