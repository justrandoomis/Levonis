import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { newSqlite, SqliteD1 } from './fixtures/d1';
import { setChatTyping, remoteChatTyping, CHAT_TYPING_TTL_MS } from '../worker/lib/chatPresence';

function fixture() {
  const raw=newSqlite();
  raw.exec(`CREATE TABLE chat_participants(chat_id TEXT,user_id TEXT,PRIMARY KEY(chat_id,user_id));
    INSERT INTO chat_participants VALUES ('c','me'),('c','other'),('elsewhere','third');`);
  raw.exec(readFileSync(new URL('../migrations/0071_chat_typing_presence.sql',import.meta.url),'utf8'));
  return {raw,db:new SqliteD1(raw) as unknown as D1Database};
}
test('only the OTHER participant activates typing; another conversation stays private',async()=>{
  const {raw,db}=fixture(); try {
    await setChatTyping(db,'c','me',true,1000); assert.deepEqual(await remoteChatTyping(db,'c','me',1000),{typing:false,remainingMs:0});
    await setChatTyping(db,'elsewhere','third',true,1000); assert.equal((await remoteChatTyping(db,'c','me',1000)).typing,false);
    await setChatTyping(db,'c','other',true,1000); assert.deepEqual(await remoteChatTyping(db,'c','me',1000),{typing:true,remainingMs:CHAT_TYPING_TTL_MS});
  } finally {raw.close();}
});
test('typing expiry, explicit stop and heartbeat update are bounded by server time',async()=>{
  const {raw,db}=fixture(); try {
    await setChatTyping(db,'c','other',true,1000);
    assert.equal((await remoteChatTyping(db,'c','me',7999)).remainingMs,1);
    assert.equal((await remoteChatTyping(db,'c','me',8000)).typing,false);
    await setChatTyping(db,'c','other',true,9000);
    assert.equal((await remoteChatTyping(db,'c','me',9000)).remainingMs,7000);
    await setChatTyping(db,'c','other',false,9500);
    assert.equal((await remoteChatTyping(db,'c','me',9500)).typing,false);
    assert.equal(raw.prepare('SELECT COUNT(*) n FROM chat_typing_presence').get()!.n,0);
  } finally {raw.close();}
});
test('departed participants cascade and nonparticipant presence cannot be stored',async()=>{
  const {raw,db}=fixture(); try {
    await assert.rejects(setChatTyping(db,'c','stranger',true,1),/FOREIGN KEY/);
    await setChatTyping(db,'c','other',true,1); raw.prepare("DELETE FROM chat_participants WHERE user_id='other'").run();
    assert.equal((await remoteChatTyping(db,'c','me',2)).typing,false);
  } finally {raw.close();}
});
test('new presence writes prune expired records and migration is rerunnable',async()=>{
  const {raw,db}=fixture(); try {
    await setChatTyping(db,'elsewhere','third',true,1); await setChatTyping(db,'c','other',true,8000);
    assert.equal(raw.prepare('SELECT COUNT(*) n FROM chat_typing_presence').get()!.n,1);
    raw.exec(readFileSync(new URL('../migrations/0071_chat_typing_presence.sql',import.meta.url),'utf8'));
    assert.equal(raw.prepare('SELECT COUNT(*) n FROM chat_typing_presence').get()!.n,1);
  } finally {raw.close();}
});
