import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { readFileSync } from 'node:fs';
import { newSqlite, SqliteD1 } from './fixtures/d1';
import { chatRoutes } from '../worker/routes/chats';
import { HttpError, originCheck } from '../worker/lib/http';
import type { AppContext } from '../worker/lib/types';

function setup(user: string | null = 'me', role = 'customer') {
  const raw=newSqlite();
  raw.exec(`CREATE TABLE chat_participants(chat_id TEXT,user_id TEXT,PRIMARY KEY(chat_id,user_id));
    INSERT INTO chat_participants VALUES ('c','me'),('c','peer');
    CREATE TABLE rate_limits(key TEXT PRIMARY KEY,window_start INTEGER,count INTEGER);
    -- The write door also asks whether this is a store order's thread (review S3); 'c' is not.
    CREATE TABLE chats(id TEXT PRIMARY KEY,order_id TEXT); INSERT INTO chats VALUES ('c',NULL);
    CREATE TABLE orders(id TEXT PRIMARY KEY,user_id TEXT,merchant_id TEXT);
    CREATE TABLE community_merchants(id TEXT PRIMARY KEY,user_id TEXT);`);
  raw.exec(readFileSync(new URL('../migrations/0071_chat_typing_presence.sql',import.meta.url),'utf8'));
  const app=new Hono<AppContext>();
  app.use('*', async(c,next)=>{c.env={DB:new SqliteD1(raw)} as never; c.set('user', user ? {id:user,role} as never : null);await next();});
  app.use('*',originCheck()); app.route('/api/chats',chatRoutes);
  app.onError((e,c)=>{if(e instanceof HttpError)return c.json({success:false,code:e.code},e.status as 400);throw e;});
  const post=(body:unknown,origin?:string)=>app.request('https://levonis.test/api/chats/c/typing',{
    method:'POST',headers:{'Content-Type':'application/json',...(origin?{Origin:origin}:{})},body:JSON.stringify(body)});
  return {raw,app,post};
}
for(const [user,role,status] of [[null,'customer',401],['stranger','customer',403],['admin','admin',403]] as const) {
  test(`presence requires participant membership (${user??'anonymous'} gets ${status})`,async()=>{
    const {raw,app,post}=setup(user,role);try {
      assert.equal((await post({typing:true})).status,status);
      assert.equal((await app.request('/api/chats/c/typing')).status,status);
      assert.equal(raw.prepare('SELECT COUNT(*) n FROM chat_typing_presence').get()!.n,0);
    }finally{raw.close();}
  });
}
test('presence identity/time are server-owned, input is boolean, reads are noncacheable and remote only',async()=>{
  const {raw,app,post}=setup();try {
    assert.equal((await post({typing:'yes'})).status,400);
    assert.equal((await post({typing:true,userId:'peer',expiresAt:9999999999999})).status,200);
    const own=raw.prepare('SELECT user_id,expires_at_ms FROM chat_typing_presence').get()!;
    assert.equal(own.user_id,'me'); assert.ok(Number(own.expires_at_ms)<Date.now()+8000);
    const response=await app.request('/api/chats/c/typing');assert.equal(response.headers.get('cache-control'),'private, no-store');
    assert.equal((await response.json() as {typing:boolean}).typing,false);
    raw.prepare('INSERT INTO chat_typing_presence VALUES (?,?,?)').run('c','peer',Date.now()+6000);
    assert.equal((await (await app.request('/api/chats/c/typing')).json() as {typing:boolean}).typing,true);
    assert.equal((await post({typing:false})).status,200);
    assert.equal(raw.prepare("SELECT COUNT(*) n FROM chat_typing_presence WHERE user_id='me'").get()!.n,0);
  }finally{raw.close();}
});
test('presence mutations retain cross-origin rejection and authenticated throttling',async()=>{
  const {raw,post}=setup();try {
    assert.equal((await post({typing:true},'https://evil.test')).status,403);
    const now=Math.floor(Date.now()/1000);raw.prepare('INSERT INTO rate_limits VALUES (?,?,?)').run('chat-typing:u:me',now-now%60,90);
    assert.equal((await post({typing:true})).status,429);
  }finally{raw.close();}
});
