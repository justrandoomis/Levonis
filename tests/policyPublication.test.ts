import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { newSqlite, SqliteD1, createTableSql, ROOT } from './fixtures/d1';
import { policyPublicationBatch, isPolicyPublicationConflict, type PolicyPublicationRow } from '../worker/lib/policyPublication';
import { policyDocHash } from '../worker/lib/policyOps';

function fixture() {
  const raw = newSqlite();
  raw.exec('CREATE TABLE users(id TEXT PRIMARY KEY); CREATE TABLE orders(id TEXT PRIMARY KEY);');
  raw.exec(createTableSql('0003_final_phase.sql','policy_documents'));
  raw.exec(createTableSql('0003_final_phase.sql','policy_acceptances'));
  raw.exec(readFileSync(join(ROOT, 'migrations/0070_policy_publication_acceptance.sql'), 'utf8'));
  const rows: PolicyPublicationRow[] = ['ar','en'].map((lang) => ({id:`p2_${lang}`,key:'terms',version:2,lang:lang as 'ar'|'en',title:'Title',body:'Reviewed body',hash:'draft-hash',status:'draft'}));
  const seed = (r: PolicyPublicationRow) => raw.prepare('INSERT INTO policy_documents(id,key,version,lang,title,body,hash,status) VALUES(?,?,?,?,?,?,?,?)').run(r.id,r.key,r.version,r.lang,r.title,r.body,r.hash,r.status);
  seed({...rows[0],id:'p1_ar',version:1,hash:'accepted-old-hash',body:'Accepted old body',status:'published'});
  rows.forEach(seed);
  return {raw,rows,seed,db:new SqliteD1(raw) as unknown as D1Database};
}

test('publish atomically hashes every locale and preserves archived accepted text', async () => {
  const {raw,rows,db} = fixture();
  try {
    const batch = await policyPublicationBatch(db,'terms',2,rows);
    await db.batch(batch.statements);
    const all = await db.prepare('SELECT * FROM policy_documents ORDER BY version, lang').all<PolicyPublicationRow>();
    assert.equal(all.results.length,3);
    assert.equal(all.results[0].status,'archived');
    assert.equal(all.results[0].body,'Accepted old body'); assert.equal(all.results[0].hash,'accepted-old-hash');
    for (const r of all.results.slice(1)) { assert.equal(r.status,'published'); assert.equal(r.hash,await policyDocHash(r.key,r.version,r.lang,r.title,r.body)); }
  } finally {raw.close();}
});

for (const change of ['edit','delete','add-locale','newer-published','same-published'] as const) {
  test(`concurrent ${change} aborts the whole batch without archiving the accepted version`, async () => {
    const {raw,rows,seed,db} = fixture();
    try {
      const batch = await policyPublicationBatch(db,'terms',2,rows);
      if (change === 'edit') raw.prepare("UPDATE policy_documents SET body='Unreviewed edit' WHERE id='p2_en'").run();
      if (change === 'delete') raw.prepare("DELETE FROM policy_documents WHERE id='p2_en'").run();
      if (change === 'add-locale') seed({...rows[0],id:'p2_ckb',lang:'ckb'});
      if (change === 'newer-published') seed({...rows[0],id:'p3_ar',version:3,status:'published'});
      if (change === 'same-published') raw.prepare("UPDATE policy_documents SET status='published' WHERE id='p2_en'").run();
      await assert.rejects(db.batch(batch.statements),isPolicyPublicationConflict);
      assert.equal((await db.prepare("SELECT status FROM policy_documents WHERE id='p1_ar'").first<{status:string}>())?.status,'published');
      assert.equal((await db.prepare("SELECT status FROM policy_documents WHERE id='p2_ar'").first<{status:string}>())?.status,'draft');
      assert.equal((await db.prepare("SELECT COUNT(*) n FROM policy_documents WHERE id LIKE 'polguard_%'").first<{n:number}>())?.n,0);
    } finally {raw.close();}
  });
}
test('publication requires an Arabic draft source',async () => {
  const {raw,rows,db}=fixture();
  try {await assert.rejects(policyPublicationBatch(db,'terms',2,[rows[1]]),/Arabic source/);} finally {raw.close();}
});

test('new publications record server dates and leave historical unknown dates untouched', async () => {
  const {raw,rows,db}=fixture();
  try {
    const p=await policyPublicationBatch(db,'terms',2,rows);
    await db.batch(p.statements);
    const current=await db.prepare("SELECT published_at,effective_at FROM policy_documents WHERE id='p2_ar'").first<{published_at:string;effective_at:string}>();
    assert.ok(current && Number.isFinite(Date.parse(current.published_at)));
    assert.equal(current.published_at,current.effective_at);
    const old=await db.prepare("SELECT published_at,effective_at FROM policy_documents WHERE id='p1_ar'").first<{published_at:null;effective_at:null}>();
    assert.equal(old?.published_at,null); assert.equal(old?.effective_at,null);
  } finally {raw.close();}
});
