/** Local Miniflare fixture only. Never mounted by worker/index.ts or deployed. */
import { Hono } from 'hono';
import type { AppContext } from '../../worker/lib/types';
import { HttpError } from '../../worker/lib/http';
import { classifyHost } from '../../worker/lib/hosts';
import { templateRoutes } from '../../worker/routes/template';
import { deleteProductPermanently, productSchema, productDependencyGraph } from '../../worker/lib/productDeletion';
import { scanProductOrphans } from '../../worker/lib/productOrphans';

const app = new Hono<AppContext>();
app.use('*', async (c,next) => {
  c.set('host',classifyHost('levonis-iq.com','levonis-iq.com'));
  c.set('user',{id:'owner',role:'admin',email:'owner@test.com',admin_scope:null} as never);
  await next();
});
app.onError((error,c)=>c.json({error:error.message,...(error instanceof HttpError ? {code:error.code,details:error.details} : {})},500));
app.post('/sql',async c=>{
  const statements=await c.req.json<Array<{sql:string;args?:unknown[]}>>();
  return c.json(await c.env.DB.batch(statements.map(s=>c.env.DB.prepare(s.sql).bind(...s.args??[]))));
});
app.post('/r2',async c=>{
  const {key,bytes}=await c.req.json<{key:string;bytes:number[]}>();
  await c.env.BUCKET.put(key,new Uint8Array(bytes),{httpMetadata:{contentType:'image/webp'}});
  return c.json({ok:true});
});
app.get('/r2',async c=>c.json(await c.env.BUCKET.list({prefix:'products/'})));
app.post('/delete/:id',async c=>c.json(await deleteProductPermanently(c.env,c.req.param('id'),'owner')));
app.get('/counts/:id',async c=>{
  const result:Record<string,number>={};
  for(const dep of productDependencyGraph(await productSchema(c.env.DB))) result[dep.table]=Number((await c.env.DB.prepare(`SELECT COUNT(*) n FROM "${dep.table}" WHERE ${dep.predicate}`).bind(c.req.param('id')).first<{n:number}>())?.n ?? -1);
  return c.json(result);
});
app.get('/orphans',async c=>c.json(await scanProductOrphans(c.env,'owner')));
app.route('/api/admin/template',templateRoutes);
export default app;
