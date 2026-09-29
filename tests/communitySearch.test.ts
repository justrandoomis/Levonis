/**
 * UNIFIED SEARCH AND DISCOVERY (docs/COMMUNITY_ECOSYSTEM.md §9.3, Phase 3)
 * over the real routes — and every promise of its as an attack:
 *
 *   · a hidden project, a draft, a private post, a suspended shop, a private
 *     product, a draft or private request and a closed creator page are in
 *     NO section and NO suggestion — the sections are the lists' own SQL;
 *   · `types` narrows and the other sections do not run (total null);
 *   · a total never counts past 200; a term never exceeds 60 characters;
 *   · a suggestion is a NAME: never an email, a phone, a bio, a private title;
 *   · a blocked author is absent for the viewer and present for a guest; a
 *     muted author is absent for the muter; a blocked MERCHANT is gone from
 *     the stores, the products, the suggestions, «قد يعجبك» and the lists
 *     themselves, both ways of the block;
 *   · trending counts public posts only;
 *   · «قد يعجبك» never returns its own anchor, 404s an anchor the viewer may
 *     not see, and refuses a malformed one;
 *   · a guest's search, suggestion and recommendation are cached at the edge
 *     for 60 s under a canonical key (an unknown parameter mints nothing) and
 *     a member's is never stored; 120 searches a minute, then 429;
 *   · Arabic and Latin both match — name_ar through LIKE, and through the
 *     catalogue index with diacritics folded.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { freshDb, asD1, stubApp, get, json, pending, type StubUser, type Mount } from './fixtures/app';
import { communityRoutes } from '../worker/routes/community';
import { communityPostRoutes } from '../worker/routes/communityPosts';
import { communitySocialRoutes } from '../worker/routes/communitySocial';
import { cacheKeyUrl, communitySearchRoutes } from '../worker/routes/communitySearch';
import { toSearchDoc } from '../worker/lib/search/document';
import { planSearchIndex } from '../worker/lib/search/store';

const SARA: StubUser = { id: 'sara', role: 'customer', email: 'sara@x.co', username: 'sara' };
const EVE: StubUser = { id: 'eve', role: 'customer', email: 'eve@x.co', username: 'evedragon' };
const OMAR: StubUser = { id: 'omar', role: 'customer', email: 'omar@x.co', username: 'omar' };

const mount: Mount = (a) => {
  a.route('/api/community', communityRoutes);
  a.route('/api/community', communityPostRoutes);
  a.route('/api/community', communitySocialRoutes);
  a.route('/api/community', communitySearchRoutes);
};

const ago = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();

async function seed(): Promise<DatabaseSync> {
  const raw = freshDb();
  const db = asD1(raw);
  raw.exec(`
    INSERT INTO users (id,name,email,password_hash,role,username,phone_e164,bio,creator_public) VALUES
      ('sara','Sara Kareem','sara@x.co','h','customer','sara','+9647700000009','Dragon lover, prints at home',1),
      ('eve','Eve Dragon','eve@x.co','h','customer','evedragon',NULL,'',0),
      ('omar','Omar','omar@x.co','h','customer','omar',NULL,'',1),
      ('ali','Ali','ali@x.co','h','merchant','ali',NULL,'',0),
      ('kim','Kim','kim@x.co','h','merchant','kim',NULL,'',0),
      ('bad','Bad','bad@x.co','h','merchant','bad',NULL,'',0),
      ('sus','Sus','sus@x.co','h','merchant','sus',NULL,'',0),
      ('boss','Boss','boss@x.co','h','admin','boss',NULL,'',0);
    INSERT INTO community_merchants (id,user_id,name,status,rating_avg_x100,rating_count,completed_orders) VALUES
      ('m_ali','ali','Ali 3D','active',480,12,9),
      ('m_kim','kim','Kim Prints','active',450,3,2),
      ('m_bad','bad','Bad Dragon Shop','active',0,0,0),
      ('m_sus','sus','Dragon Sus Merchant','suspended',0,0,0);
    INSERT INTO merchant_stores (id,merchant_id,user_id,slug,name,status,governorate,categories,accepts_custom_requests) VALUES
      ('s_ali','m_ali','ali','dragonforge','Dragon Forge','active','Baghdad','["figures","toys"]',1),
      ('s_kim','m_kim','kim','kimprints','Dragon Kim','active','Basra','["toys"]',0),
      ('s_bad','m_bad','bad','baddragon','Dragon Suspended Store','suspended','Baghdad','["toys"]',1);
    INSERT INTO community_products (id,merchant_id,store_id,slug,name,name_ar,status,lifecycle,price_iqd,stock,track_stock,category,material,audience_user_id) VALUES
      ('cp_pub','m_ali','s_ali','dragon-vase','Dragon vase','مزهرية التنين','active','active',25000,5,1,'decor','PLA',NULL),
      ('cp_priv','m_ali','s_ali','dragon-gift','Dragon private gift','هدية التنين','active','active',30000,1,1,'decor','PLA','eve'),
      ('cp_hidden','m_ali','s_ali','dragon-hidden','Dragon hidden vase','','hidden','hidden',25000,5,1,'decor','PLA',NULL),
      ('cp_kim','m_kim','s_kim','dragon-kim-vase','Dragon Kim vase','','active','active',20000,5,1,'decor','PETG',NULL),
      ('cp_bad','m_bad','s_bad','dragon-bad','Dragon of a suspended store','','active','active',20000,5,1,'decor','PLA',NULL);
    INSERT INTO products (id,slug,name,name_ar,price_iqd,status) VALUES
      ('p_pla','pla-dragon-red','PLA Dragon Red 1kg','خيط تنين أحمر 1 كغ',22000,'active'),
      ('p_hidmat','pla-dragon-hidden','PLA Dragon Hidden','',22000,'hidden'),
      ('p_a1','bambu-a1','Bambu Lab A1','بامبو A1',450000,'active'),
      ('p_dprinter','dragon-printer','Dragon Printer X','طابعة التنين',900000,'active');
    INSERT INTO product_catalogs (product_id,catalog_id,position) VALUES
      ('p_pla','cat_materials_fdm',1),('p_hidmat','cat_materials_fdm',2),('p_a1','cat_printers_fdm',1),('p_dprinter','cat_printers_fdm',2);
    INSERT INTO brands (id,slug,name_ar,name_en,active) VALUES
      ('brd_dragon','dragon-filaments','خيوط التنين','Dragon Filaments',1),
      ('brd_off','dragon-off','','Dragon Off',0);
    INSERT INTO community_posts (id,author_id,kind,title,body,state,visibility,printer_product_id,material_product_id,tags,published_at,like_count,admin_hidden_at) VALUES
      ('po_sara','sara','project','Dragon articulated','Printed in two colours.','published','public','p_a1','p_pla','["dragon","pla"]','${ago(1)}',5,NULL),
      ('po_hidden','sara','project','Dragon hidden by Levonis','x','published','public',NULL,NULL,'["dragon"]','${ago(1)}',0,'${ago(0)}'),
      ('po_draft','sara','project','Dragon draft','x','draft','public',NULL,NULL,'["dragon"]',NULL,0,NULL),
      ('po_private','sara','project','Dragon private','x','published','private',NULL,NULL,'["dragon"]','${ago(1)}',0,NULL),
      ('po_omar','omar','project','Dragon twin','x','published','public',NULL,NULL,'["dragon"]','${ago(2)}',1,NULL),
      ('po_kobra','omar','project','Kobra bracket','x','published','public','p_a1',NULL,'["bracket"]','${ago(3)}',0,NULL);
    INSERT INTO community_likes (user_id,post_id) VALUES ('eve','po_sara');
    INSERT INTO community_requests (id,customer_id,title,description,status,state,visibility) VALUES
      ('req_pub','eve','Dragon stand','A stand for a dragon','open','open','public'),
      ('req_draft','eve','Dragon SECRETDRAFT stand','x','closed','draft','public'),
      ('req_priv','eve','Dragon SECRETPRIVATE stand','x','open','open','private'),
      ('req_sara','sara','Dragon stand by sara','x','open','open','public'),
      ('req_done','eve','Done job','x','closed','completed','public');
    INSERT INTO community_offers (id,request_id,merchant_id,store_id,price_iqd,completion_days,state) VALUES
      ('off_done','req_done','m_kim','s_kim',10000,2,'accepted');
    INSERT INTO community_orders (id,request_id,offer_id,customer_id,merchant_id,store_id,state,price_iqd,platform_fee_iqd,merchant_receivable_iqd,completed_at) VALUES
      ('co_done','req_done','off_done','eve','m_kim','s_kim','completed',10000,0,10000,'${ago(2)}');
    INSERT INTO follows (user_id,merchant_id) VALUES ('eve','m_ali'),('omar','m_ali');
    INSERT OR REPLACE INTO admin_settings (key,value) VALUES ('communityGate','{"open":true}');
  `);
  // The catalogue index, as a product save writes it.
  for (const [id, name, name_ar] of [
    ['p_pla', 'PLA Dragon Red 1kg', 'خيط تنين أحمر 1 كغ'],
    ['p_a1', 'Bambu Lab A1', 'بامبو A1'],
    ['p_dprinter', 'Dragon Printer X', 'طابعة التنين'],
    ['p_hidmat', 'PLA Dragon Hidden', ''],
  ]) {
    await db.batch(planSearchIndex(db, toSearchDoc({ id, name, name_ar })));
  }
  return raw;
}
const as = (raw: DatabaseSync, user: StubUser | null) => stubApp(asD1(raw), user, mount);
const ids = (rows: Array<{ id: string }>) => rows.map((r) => r.id);
const search = async (raw: DatabaseSync, user: StubUser | null, qs: string) => {
  const res = await get(as(raw, user), `/api/community/search?${qs}`);
  assert.equal(res.status, 200, JSON.stringify(await json(res.clone())));
  return json(res);
};

/** `caches.default` as the live zone behaves: a hit comes back with max-age inflated to the zone's TTL. */
function zoneCache() {
  const store = new Map<string, Response>();
  return {
    store,
    async match(req: Request) {
      const stored = store.get(req.url);
      if (!stored) return undefined;
      const copy = stored.clone();
      const headers = new Headers(copy.headers);
      headers.set('Cache-Control', (headers.get('Cache-Control') ?? '').replace(/max-age=\d+/, 'max-age=14400'));
      headers.set('CF-Cache-Status', 'HIT');
      return new Response(copy.body, { status: copy.status, headers });
    },
    async put(req: Request, res: Response) {
      store.set(req.url, res);
    },
    async delete(req: Request) {
      return store.delete(req.url);
    },
  };
}
async function withZoneCache(run: (cache: ReturnType<typeof zoneCache>) => Promise<void>) {
  const scope = globalThis as { caches?: unknown };
  const cache = zoneCache();
  scope.caches = { default: cache };
  try {
    await run(cache);
  } finally {
    delete scope.caches;
  }
}

// =================================================================== search

test('every section is its list\'s own rule: the hidden, the draft, the private, the suspended and the closed page are in none of them', async () => {
  const raw = await seed();
  const out = await search(raw, null, 'q=Dragon');
  assert.equal(out.success, true);
  assert.equal(out.q, 'Dragon');
  assert.equal(typeof out.took_ms, 'number');
  const s = out.sections;
  assert.deepEqual(Object.keys(s), ['projects', 'stores', 'creators', 'products', 'requests', 'materials', 'brands'], 'the owner\'s order');

  assert.deepEqual(ids(s.projects.rows), ['po_sara', 'po_omar'], 'not the hidden, the draft or the private post');
  assert.equal(s.projects.total, 2);
  assert.deepEqual(s.projects.rows[0].viewer, { liked: false, saved: false }, 'a guest\'s flags');
  assert.equal(s.projects.rows[0].author.username, 'sara', 'the page exists, so the card may link to it');
  assert.equal(s.projects.more, '/community/projects?q=Dragon');

  assert.deepEqual(ids(s.stores.rows).sort(), ['m_ali', 'm_kim'], 'not the suspended store, not the suspended merchant');
  assert.equal(s.stores.total, 2);
  assert.equal(s.stores.rows[0].following, false);
  assert.equal(s.stores.more, '/community?tab=stores&q=Dragon');

  assert.deepEqual(ids(s.creators.rows), ['sara'], 'Eve Dragon has no page (D4): closed from every side');
  assert.equal(s.creators.total, 1);
  assert.equal(s.creators.rows[0].url, '/u/sara');
  assert.equal(s.creators.more, '/community?tab=creators&q=Dragon');

  assert.deepEqual(ids(s.products.rows).sort(), ['cp_kim', 'cp_pub'], 'not the private product (0152: status hidden), not the hidden one, not the suspended store\'s');
  assert.equal(s.products.total, 2);
  assert.equal(s.products.rows.find((p: { id: string }) => p.id === 'cp_pub').url, '/community/store/dragonforge/p/dragon-vase');
  assert.equal(s.products.more, '/community?tab=foryou&list=products&q=Dragon');

  assert.deepEqual(ids(s.requests.rows).sort(), ['req_pub', 'req_sara'], 'not the draft, not the private request');
  assert.equal(s.requests.total, 2);
  assert.equal(s.requests.more, '/community?tab=requests&q=Dragon', 'the tab that reads ?q= — the board page keeps its term in local state');
  for (const r of s.requests.rows) assert.ok(!('notes' in r) && !('customer_id' in r), 'the board\'s whitelist, nothing more');

  assert.deepEqual(ids(s.materials.rows), ['p_pla'], 'the materials subtree only — not the dragon printer, not the hidden filament');
  assert.equal(s.materials.total, 1);
  assert.deepEqual(s.materials.rows[0], { id: 'p_pla', slug: 'pla-dragon-red', name: 'PLA Dragon Red 1kg', name_ar: 'خيط تنين أحمر 1 كغ', imageUrl: null, href: '/product/pla-dragon-red' });
  assert.equal(s.materials.more, '/products?search=Dragon&category=cat_materials');

  assert.deepEqual(ids(s.brands.rows), ['brd_dragon'], 'not the inactive brand');
  assert.equal(s.brands.rows[0].href, '/products?brand=dragon-filaments');
  assert.equal(s.brands.total, 1);

  // Nothing private leaves in any card.
  const text = JSON.stringify(out);
  assert.ok(!text.includes('@x.co'), 'no email');
  assert.ok(!text.includes('+964'), 'no phone');
  assert.ok(!text.includes('SECRET'), 'no private request');

  // The catalogue's LIKE fallback finds the same material when the index is empty.
  raw.exec('DELETE FROM search_tokens');
  const fallback = await search(raw, null, 'q=Dragon&types=materials');
  assert.deepEqual(ids(fallback.sections.materials.rows), ['p_pla']);
  assert.equal(fallback.sections.materials.total, 1);
});

test('`types` narrows: the other sections do not run and say so with total null; unknown names are ignored; an empty term runs nothing', async () => {
  const raw = await seed();
  const out = await search(raw, null, 'q=Dragon&types=projects,brands,bogus');
  const s = out.sections;
  assert.equal(s.projects.total, 2);
  assert.equal(s.brands.total, 1);
  for (const name of ['stores', 'creators', 'products', 'requests', 'materials']) {
    assert.deepEqual(s[name].rows, [], `${name} did not run`);
    assert.equal(s[name].total, null, `${name} has no total`);
    assert.equal(typeof s[name].more, 'string', `${name} still says where its list is`);
  }
  const empty = await search(raw, null, 'q=');
  for (const name of Object.keys(empty.sections)) {
    assert.deepEqual(empty.sections[name].rows, []);
    assert.equal(empty.sections[name].total, null);
  }
});

test('a total is bounded: 250 matching projects count as 200, and a section reads at most 12 rows', async () => {
  const raw = await seed();
  const ins = raw.prepare(
    "INSERT INTO community_posts (id,author_id,kind,title,body,state,visibility,tags,published_at) VALUES (?, 'omar', 'project', ?, '', 'published', 'public', '[]', ?)"
  );
  for (let i = 0; i < 250; i += 1) ins.run(`bulk_${i}`, `Bulk dragon ${i}`, ago(4 + i / 100));
  const out = await search(raw, null, 'q=dragon&types=projects&limit=12');
  assert.equal(out.sections.projects.rows.length, 12);
  assert.equal(out.sections.projects.total, 200, 'COUNT over a LIMIT 200 subquery');
  assert.equal((await get(as(raw, null), '/api/community/search?q=dragon&limit=13')).status, 400, 'limit past 12 is refused');
  assert.equal((await search(raw, null, 'q=dragon&types=projects')).sections.projects.rows.length, 5, 'the default limit');
});

test('a term past 60 characters is refused with SEARCH_QUERY_TOO_LONG, on the search and on the suggestions', async () => {
  const raw = await seed();
  const long = encodeURIComponent('د'.repeat(61));
  for (const path of ['/api/community/search?q=', '/api/community/search/suggest?q=']) {
    const res = await get(as(raw, null), `${path}${long}`);
    assert.equal(res.status, 400);
    assert.equal((await json(res)).code, 'SEARCH_QUERY_TOO_LONG');
  }
  const ok = await get(as(raw, null), `/api/community/search?q=${encodeURIComponent('د'.repeat(60))}`);
  assert.equal(ok.status, 200, 'sixty is the bound, in characters — Arabic is two bytes each and still fits');
});

// ============================================================== suggestions

test('suggestions are names only — a store, a creator, a project, a product, a tag — never an email, a phone, a bio or a private request; two characters minimum', async () => {
  const raw = await seed();
  const short = await json(await get(as(raw, null), '/api/community/search/suggest?q=D'));
  assert.deepEqual(short, { success: true, suggestions: [], completion: null });

  const out = await json(await get(as(raw, null), '/api/community/search/suggest?q=Dra'));
  assert.equal(out.success, true);
  assert.ok(out.suggestions.length > 0 && out.suggestions.length <= 8);
  for (const s of out.suggestions) {
    assert.ok(['project', 'store', 'creator', 'product', 'tag'].includes(s.type), s.type);
    assert.equal(typeof s.href, 'string');
    assert.ok(!s.text.includes('@') && !s.text.includes('+964') && !s.text.includes('SECRET'), s.text);
  }
  const byType = (t: string) => out.suggestions.filter((s: { type: string }) => s.type === t).map((s: { text: string }) => s.text);
  assert.deepEqual(byType('project'), ['Dragon articulated', 'Dragon twin'], 'public titles only — not the hidden, draft or private post');
  assert.deepEqual(byType('store').sort(), ['Dragon Forge', 'Dragon Kim'], 'live stores only, by their store name');
  assert.deepEqual(byType('creator'), [], 'Sara\'s BIO says dragon and her name does not; Eve Dragon has no page');
  assert.deepEqual(byType('tag'), ['dragon']);
  assert.ok(byType('product').includes('PLA Dragon Red 1kg'), JSON.stringify(byType('product')));
  assert.ok(!byType('product').includes('PLA Dragon Hidden'));
  assert.equal(out.suggestions.find((s: { type: string }) => s.type === 'tag').href, '/community/projects?tag=dragon');
  assert.equal(out.suggestions.find((s: { type: string }) => s.type === 'store').href.startsWith('/community/store/m_'), true);
  assert.equal(out.completion, 'Dragon', 'the grey word completes the word being typed');

  // A creator's NAME does suggest — and a closed page still never does.
  const sara = await json(await get(as(raw, null), '/api/community/search/suggest?q=sar'));
  assert.deepEqual(sara.suggestions.filter((s: { type: string }) => s.type === 'creator'), [{ text: 'Sara Kareem', type: 'creator', href: '/u/sara' }]);
  const eve = await json(await get(as(raw, null), '/api/community/search/suggest?q=eve'));
  assert.deepEqual(eve.suggestions.filter((s: { type: string }) => s.type === 'creator'), []);
});

// ==================================================================== blocks

test('a blocked author is absent for the viewer — projects, creator, requests — and present for a guest; a mute hides the muted maker\'s projects', async () => {
  const raw = await seed();
  raw.exec("INSERT INTO user_blocks (user_id, blocked_id) VALUES ('omar', 'sara'); INSERT INTO user_mutes (user_id, muted_id) VALUES ('eve', 'omar')");
  const guest = (await search(raw, null, 'q=Dragon')).sections;
  assert.deepEqual(ids(guest.projects.rows), ['po_sara', 'po_omar']);
  assert.deepEqual(ids(guest.creators.rows), ['sara']);
  assert.deepEqual(ids(guest.requests.rows).sort(), ['req_pub', 'req_sara']);

  const omar = (await search(raw, OMAR, 'q=Dragon')).sections;
  assert.deepEqual(ids(omar.projects.rows), ['po_omar'], 'the blocked author\'s project is gone');
  assert.equal(omar.projects.total, 1, 'and out of the number');
  assert.deepEqual(ids(omar.creators.rows), [], 'and her page');
  assert.deepEqual(ids(omar.requests.rows), ['req_pub'], 'and her request — both ways of a block, in SQL');
  assert.equal(omar.requests.total, 1);

  // From the other side the same silence.
  const sara = (await search(raw, SARA, 'q=Dragon')).sections;
  assert.deepEqual(ids(sara.projects.rows), ['po_sara']);
  assert.deepEqual(ids(sara.requests.rows).sort(), ['req_pub', 'req_sara']);

  const eve = (await search(raw, EVE, 'q=Dragon')).sections;
  assert.deepEqual(ids(eve.projects.rows), ['po_sara'], 'a mute hides quietly');
  assert.deepEqual(ids(eve.requests.rows).sort(), ['req_pub', 'req_sara'], 'requests know no mute');

  // Suggestions follow the same rule for the viewer.
  const omarSuggest = await json(await get(as(raw, OMAR), '/api/community/search/suggest?q=Dragon a'));
  assert.deepEqual(omarSuggest.suggestions.filter((s: { type: string }) => s.type === 'project'), []);
  const guestSuggest = await json(await get(as(raw, null), '/api/community/search/suggest?q=Dragon a'));
  assert.deepEqual(guestSuggest.suggestions.filter((s: { type: string }) => s.type === 'project').map((s: { text: string }) => s.text), ['Dragon articulated']);
});

test('a blocked MERCHANT is gone for the viewer — the store, its products, the store suggestion, «قد يعجبك» and the lists themselves — both ways, and present for a guest', async () => {
  const raw = await seed();
  raw.exec("INSERT INTO user_blocks (user_id, blocked_id) VALUES ('sara', 'ali')");
  const tags = (out: Record<string, unknown>, t: string) => (out.suggestions as Array<{ type: string; text: string }>).filter((s) => s.type === t).map((s) => s.text);

  const guest = (await search(raw, null, 'q=Dragon')).sections;
  assert.deepEqual(ids(guest.stores.rows).sort(), ['m_ali', 'm_kim']);
  assert.deepEqual(ids(guest.products.rows).sort(), ['cp_kim', 'cp_pub']);

  // Sara blocked Ali: one payload, one answer — no creator, no shop, no product, no suggestion of his.
  const sara = (await search(raw, SARA, 'q=Dragon')).sections;
  assert.deepEqual(ids(sara.stores.rows), ['m_kim'], 'the blocked merchant\'s store is gone');
  assert.equal(sara.stores.total, 1, 'and out of the number');
  assert.deepEqual(ids(sara.products.rows), ['cp_kim'], 'and his products');
  assert.equal(sara.products.total, 1);
  assert.ok(!JSON.stringify(sara).includes('Dragon Forge'), 'his store\'s name is nowhere in the payload');
  const saraAli = (await search(raw, SARA, 'q=Ali')).sections;
  assert.deepEqual(ids(saraAli.stores.rows), [], 'not by the merchant\'s own name either');
  assert.deepEqual(ids(saraAli.creators.rows), []);
  const saraSuggest = await json(await get(as(raw, SARA), '/api/community/search/suggest?q=Dragon F'));
  assert.deepEqual(tags(saraSuggest, 'store'), [], 'no «Dragon Forge» suggestion');
  const guestSuggest = await json(await get(as(raw, null), '/api/community/search/suggest?q=Dragon F'));
  assert.deepEqual(tags(guestSuggest, 'store'), ['Dragon Forge']);

  // From the other side the same silence: Ali, blocked by Sara, still meets no… Sara has no shop; the block is symmetric on the shop he has.
  raw.exec("DELETE FROM user_blocks; INSERT INTO user_blocks (user_id, blocked_id) VALUES ('ali', 'sara')");
  const blockedBy = (await search(raw, SARA, 'q=Dragon')).sections;
  assert.deepEqual(ids(blockedBy.stores.rows), ['m_kim'], 'a merchant who blocked the viewer is gone too');
  assert.deepEqual(ids(blockedBy.products.rows), ['cp_kim']);

  // «قد يعجبك»: a blocked shop is no anchor (404, as a blocked author\'s post) and is never a row.
  assert.equal((await get(as(raw, SARA), '/api/community/recommend?for=store:m_ali')).status, 404);
  assert.equal((await get(as(raw, SARA), '/api/community/recommend?for=store:s_ali')).status, 404, 'by its store id too');
  assert.equal((await get(as(raw, SARA), '/api/community/recommend?for=product:cp_pub')).status, 404);
  const storesForSara = await json(await get(as(raw, SARA), '/api/community/recommend?for=store:m_kim'));
  assert.deepEqual(ids(storesForSara.rows), [], 'Ali\'s shop shares «toys» and is not offered');
  const productsForSara = await json(await get(as(raw, SARA), '/api/community/recommend?for=product:cp_kim'));
  assert.deepEqual(ids(productsForSara.rows), [], 'nor his vase');
  assert.deepEqual(ids((await json(await get(as(raw, null), '/api/community/recommend?for=store:m_kim'))).rows), ['m_ali'], 'a guest still sees the shop');
  assert.deepEqual(ids((await json(await get(as(raw, null), '/api/community/recommend?for=product:cp_kim'))).rows), ['cp_pub']);

  // The lists' own SQL says the same, so the overlay and the tab agree.
  const merchants = await json(await get(as(raw, SARA), '/api/community/merchants'));
  assert.deepEqual(ids(merchants.merchants), ['m_kim'], 'GET /merchants: no blocked shop (and no sanctioned one, as before)');
  assert.equal(merchants.total, 1, 'the count agrees');
  const products = await json(await get(as(raw, SARA), '/api/community/products'));
  assert.deepEqual(ids(products.products), ['cp_kim'], 'GET /products: none of his');
  assert.equal(products.total, 1);
  assert.deepEqual(ids((await json(await get(as(raw, null), '/api/community/merchants'))).merchants).sort(), ['m_ali', 'm_kim'], 'a guest\'s directory is unchanged');
  assert.deepEqual(ids((await json(await get(as(raw, EVE), '/api/community/products'))).products).sort(), ['cp_kim', 'cp_pub'], 'an unblocked member sees the feed as before (her private gift is status hidden by 0152\'s trigger, as always)');
});

test('a tag unique to a blocked author\'s post is not suggested to the blocker — the suggestion would lead to an empty page — and the tag lane reads the trending window only', async () => {
  const raw = await seed();
  raw.exec("INSERT INTO user_blocks (user_id, blocked_id) VALUES ('omar', 'sara')");
  const tagsOf = async (user: StubUser | null, q: string) =>
    (await json(await get(as(raw, user), `/api/community/search/suggest?q=${encodeURIComponent(q)}`))).suggestions.filter((s: { type: string }) => s.type === 'tag').map((s: { text: string }) => s.text);
  assert.deepEqual(await tagsOf(null, 'pl'), ['pla'], 'a guest is offered the tag: «pla» is on Sara\'s public post');
  assert.deepEqual(await tagsOf(OMAR, 'pl'), [], 'Omar blocked her: the tag is not offered to him');
  assert.deepEqual(await tagsOf(OMAR, 'dra'), ['dragon'], 'a tag he can still find (his own post carries it) is');
  assert.deepEqual(await tagsOf(EVE, 'br'), ['bracket'], 'Eve, who blocked and muted nobody, is offered Omar\'s tag');
  raw.exec("INSERT INTO user_mutes (user_id, muted_id) VALUES ('eve', 'omar')");
  assert.deepEqual(await tagsOf(EVE, 'br'), [], '«bracket» is only on Omar\'s post, whom Eve muted');
  assert.deepEqual(await tagsOf(null, 'br'), ['bracket']);

  // Older than the trending window, a tag is no suggestion (the walk over json_each is bounded by time).
  raw.exec(`UPDATE community_posts SET published_at = '${ago(40)}' WHERE id = 'po_kobra'`);
  assert.deepEqual(await tagsOf(null, 'br'), []);
});

// ================================================================== trending

test('trending is computed from what exists: public posts only for the tags, orders + follows for the stores, likes for the creators; cached five minutes for everyone', async () => {
  const raw = await seed();
  const res = await get(as(raw, null), '/api/community/trending');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('Cache-Control'), 'public, max-age=300');
  const out = await json(res);
  assert.deepEqual(out.tags, [{ tag: 'dragon', count: 2 }, { tag: 'bracket', count: 1 }, { tag: 'pla', count: 1 }], 'the hidden, draft and private posts do not count');
  assert.deepEqual(ids(out.projects), ['po_sara', 'po_omar', 'po_kobra']);
  assert.deepEqual(out.projects[0].viewer, { liked: false, saved: false });
  assert.deepEqual(ids(out.stores), ['m_ali', 'm_kim'], 'two new follows beat one completed order; nothing of a sanctioned shop');
  assert.equal(out.stores[0].following, false);
  assert.deepEqual(ids(out.creators), ['sara', 'omar'], 'a like in the window first, then followers; no page, no rail');
  assert.deepEqual(out.totals, { merchants: 2 }, 'the directory\'s count for the colophon, once for everybody');
  // The same answer, with the same lifetime, for a member: it holds nothing of theirs.
  const mine = await get(as(raw, EVE), '/api/community/trending');
  assert.equal(mine.headers.get('Cache-Control'), 'public, max-age=300');
  assert.deepEqual(await json(mine), out);
});

// ================================================================= recommend

test('«قد يعجبك» for a post: shared tags weigh 3, the material 2, the printer 1; never the anchor; 404 for an anchor the viewer may not see; 400 for a malformed one', async () => {
  const raw = await seed();
  const out = await json(await get(as(raw, null), '/api/community/recommend?for=post:po_sara'));
  assert.equal(out.success, true);
  assert.equal(out.for, 'post:po_sara');
  assert.equal(out.kind, 'projects');
  assert.deepEqual(ids(out.rows), ['po_omar', 'po_kobra'], 'the tag match before the printer match; the hidden and draft dragons absent');
  assert.deepEqual(out.rows[0].viewer, { liked: false, saved: false });

  for (const anchor of ['post:po_hidden', 'post:po_draft', 'post:po_private', 'post:nope']) {
    const res = await get(as(raw, null), `/api/community/recommend?for=${anchor}`);
    assert.equal(res.status, 404, anchor);
    assert.equal((await json(res)).code, 'NOT_FOUND');
  }
  // The author may stand beside their own draft.
  const own = await get(as(raw, SARA), '/api/community/recommend?for=post:po_draft');
  assert.equal(own.status, 200);
  assert.deepEqual(ids((await json(own)).rows), ['po_sara', 'po_omar'], 'the tag «dragon»: her own public piece and Omar\'s, newest first');

  // An UNLISTED piece may be read by whoever holds the link, but it is in no
  // list — so it anchors nothing for anyone but its author (a guest\'s answer
  // would be stored in the shared cache under the id).
  raw.exec("UPDATE community_posts SET visibility = 'unlisted' WHERE id = 'po_omar'");
  assert.equal((await get(as(raw, null), '/api/community/recommend?for=post:po_omar')).status, 404, 'a guest: not an anchor');
  assert.equal((await get(as(raw, EVE), '/api/community/recommend?for=post:po_omar')).status, 404, 'a member: not an anchor');
  assert.equal((await get(as(raw, OMAR), '/api/community/recommend?for=post:po_omar')).status, 200, 'its author: yes');
  assert.deepEqual(ids((await json(await get(as(raw, null), '/api/community/recommend?for=post:po_sara'))).rows), ['po_kobra'], 'and it is no longer a row');
  raw.exec("UPDATE community_posts SET visibility = 'public' WHERE id = 'po_omar'");

  // Only the last 180 days are looked at: an old neighbour is not offered.
  raw.exec(`UPDATE community_posts SET published_at = '${ago(200)}' WHERE id = 'po_kobra'`);
  assert.deepEqual(ids((await json(await get(as(raw, null), '/api/community/recommend?for=post:po_sara'))).rows), ['po_omar']);
  raw.exec(`UPDATE community_posts SET published_at = '${ago(3)}' WHERE id = 'po_kobra'`);

  // Across a block the anchor does not exist, and the blocked author is never recommended.
  raw.exec("INSERT INTO user_blocks (user_id, blocked_id) VALUES ('omar', 'sara')");
  assert.equal((await get(as(raw, OMAR), '/api/community/recommend?for=post:po_sara')).status, 404);
  const omarSees = await json(await get(as(raw, OMAR), '/api/community/recommend?for=post:po_kobra'));
  assert.deepEqual(ids(omarSees.rows), [], 'po_sara shares the printer but its author is blocked');
  const guestSees = await json(await get(as(raw, null), '/api/community/recommend?for=post:po_kobra'));
  assert.deepEqual(ids(guestSees.rows), ['po_sara']);

  for (const bad of ['', 'post', 'user:sara', 'post:', 'post:has space', `post:${'x'.repeat(61)}`]) {
    const res = await get(as(raw, null), `/api/community/recommend?for=${encodeURIComponent(bad)}`);
    assert.equal(res.status, 400, bad);
    assert.equal((await json(res)).code, 'RECOMMEND_ANCHOR_INVALID');
  }
  assert.equal((await get(as(raw, null), '/api/community/recommend?for=post:po_sara&limit=13')).status, 400);
});

test('«قد يعجبك» for a store and for a product: other visible stores by place or category, other stores\' products by category or material; a private product is no anchor', async () => {
  const raw = await seed();
  const store = await json(await get(as(raw, null), '/api/community/recommend?for=store:m_ali'));
  assert.equal(store.kind, 'stores');
  assert.deepEqual(ids(store.rows), ['m_kim'], 'shares «toys»; the suspended store shares Baghdad and is not offered');
  assert.equal(store.rows[0].following, false);
  const byStoreId = await json(await get(as(raw, null), '/api/community/recommend?for=store:s_kim'));
  assert.deepEqual(ids(byStoreId.rows), ['m_ali'], 'a store id names the same shop');
  assert.equal((await get(as(raw, null), '/api/community/recommend?for=store:m_bad')).status, 404, 'a sanctioned shop is no anchor');
  assert.equal((await get(as(raw, null), '/api/community/recommend?for=store:m_sus')).status, 404);

  const product = await json(await get(as(raw, null), '/api/community/recommend?for=product:cp_pub'));
  assert.equal(product.kind, 'products');
  assert.deepEqual(ids(product.rows), ['cp_kim'], 'same category, another store; never the private or hidden product, never the same shop\'s');
  assert.equal(product.rows[0].store.slug, 'kimprints');
  for (const anchor of ['product:cp_priv', 'product:cp_hidden', 'product:cp_bad']) {
    assert.equal((await get(as(raw, EVE), `/api/community/recommend?for=${anchor}`)).status, 404, anchor);
  }
});

// ==================================================================== caching

test('a guest\'s suggestion, search and recommendation are cached at the edge for 60 s and re-stamped on a hit; a member\'s answer is private, never stored', async () => {
  const raw = await seed();
  await withZoneCache(async (cache) => {
    const miss = await get(as(raw, null), '/api/community/search/suggest?q=Dra');
    assert.equal(miss.status, 200);
    assert.equal(miss.headers.get('Cache-Control'), 'public, max-age=60');
    await Promise.all(pending);
    assert.equal(cache.store.size, 1, 'stored under the request URL');

    const hit = await get(as(raw, null), '/api/community/search/suggest?q=Dra');
    assert.equal(hit.headers.get('CF-Cache-Status'), 'HIT');
    assert.equal(hit.headers.get('Cache-Control'), 'public, max-age=60', 'the route\'s lifetime, not the zone\'s four hours');
    assert.equal(await hit.text(), await miss.text());

    const mine = await get(as(raw, EVE), '/api/community/search/suggest?q=Dra');
    assert.equal(mine.headers.get('Cache-Control'), 'private, no-store');
    assert.equal(mine.headers.get('CF-Cache-Status'), null, 'a member is never served the shared copy');
    await Promise.all(pending);
    assert.equal(cache.store.size, 1, 'and never fills it');

    const recommend = await get(as(raw, null), '/api/community/recommend?for=post:po_sara');
    assert.equal(recommend.headers.get('Cache-Control'), 'public, max-age=60');
    await Promise.all(pending);
    assert.equal(cache.store.size, 2);
    assert.equal((await get(as(raw, SARA), '/api/community/recommend?for=post:po_sara')).headers.get('Cache-Control'), 'private, no-store');

    // A 404 is not stored.
    await get(as(raw, null), '/api/community/recommend?for=post:po_hidden');
    await Promise.all(pending);
    assert.equal(cache.store.size, 2);

    // A guest's search is the same for every guest: shared for a minute.
    const searchMiss = await get(as(raw, null), '/api/community/search?q=Dragon');
    assert.equal(searchMiss.headers.get('Cache-Control'), 'public, max-age=60');
    await Promise.all(pending);
    assert.equal(cache.store.size, 3);
    const searchHit = await get(as(raw, null), '/api/community/search?q=Dragon');
    assert.equal(searchHit.headers.get('CF-Cache-Status'), 'HIT');
    assert.equal(searchHit.headers.get('Cache-Control'), 'public, max-age=60');
    assert.deepEqual(ids((await json(searchHit)).sections.projects.rows), ['po_sara', 'po_omar']);
    const memberSearch = await get(as(raw, EVE), '/api/community/search?q=Dragon');
    assert.equal(memberSearch.headers.get('Cache-Control'), 'private, no-store');
    assert.equal(memberSearch.headers.get('CF-Cache-Status'), null);
    await Promise.all(pending);
    assert.equal(cache.store.size, 3, 'a member\'s search never reaches the cache');
  });
});

test('the cache key is canonical: the origin, the path and the route\'s own parameters, sorted — an unknown or reordered parameter mints no second entry', async () => {
  const raw = await seed();
  await withZoneCache(async (cache) => {
    for (let i = 0; i < 5; i += 1) await get(as(raw, null), `/api/community/trending?x=${i}`);
    await Promise.all(pending);
    assert.equal(cache.store.size, 1, 'five unknown parameters, one entry');
    assert.deepEqual([...cache.store.keys()], ['http://localhost/api/community/trending']);
    assert.equal((await get(as(raw, null), '/api/community/trending?utm_source=x')).headers.get('CF-Cache-Status'), 'HIT');

    await get(as(raw, null), '/api/community/search/suggest?q=Dra&foo=1');
    await get(as(raw, null), '/api/community/search/suggest?foo=2&q=Dra');
    await get(as(raw, null), '/api/community/search?types=brands&q=Dragon&limit=3');
    await get(as(raw, null), '/api/community/search?limit=3&q=Dragon&types=brands&z=9');
    await get(as(raw, null), '/api/community/recommend?limit=6&for=post:po_sara&noise=1');
    await Promise.all(pending);
    assert.deepEqual(
      [...cache.store.keys()].sort(),
      [
        'http://localhost/api/community/recommend?for=post%3Apo_sara&limit=6',
        'http://localhost/api/community/search/suggest?q=Dra',
        'http://localhost/api/community/search?limit=3&q=Dragon&types=brands',
        'http://localhost/api/community/trending',
      ]
    );
    // A different declared value is a different answer, and a different entry.
    await get(as(raw, null), '/api/community/search/suggest?q=Drag');
    await Promise.all(pending);
    assert.equal(cache.store.size, 5);
    assert.equal(cacheKeyUrl('https://levonis.iq/api/community/search?b=2&a=1&q=x', ['q', 'a']), 'https://levonis.iq/api/community/search?a=1&q=x');
  });
});

// ================================================================= rate limit

test('120 searches a minute per address, then 429', async () => {
  const raw = await seed();
  const a = as(raw, null);
  const ip = { 'CF-Connecting-IP': '9.9.9.9' };
  for (let i = 0; i < 120; i += 1) {
    const res = await get(a, '/api/community/search?q=zz&types=brands', ip);
    assert.equal(res.status, 200, `request ${i + 1}`);
  }
  const over = await get(a, '/api/community/search?q=zz&types=brands', ip);
  assert.equal(over.status, 429);
  assert.equal((await json(over)).code, 'RATE_LIMITED');
  assert.equal((await get(a, '/api/community/search/suggest?q=zz', ip)).status, 429, 'one bucket for the whole door');
  assert.equal((await get(a, '/api/community/search?q=zz&types=brands', { 'CF-Connecting-IP': '8.8.8.8' })).status, 200, 'another address is another bucket');
});

// ================================================================== languages

test('Arabic and Latin both match: name_ar through LIKE, and through the catalogue index with the diacritics folded', async () => {
  const raw = await seed();
  const arabic = (await search(raw, null, `q=${encodeURIComponent('التنين')}`)).sections;
  assert.deepEqual(ids(arabic.products.rows), ['cp_pub'], '«مزهرية التنين» by its Arabic name');
  assert.deepEqual(ids(arabic.brands.rows), ['brd_dragon'], '«خيوط التنين»');
  assert.equal(arabic.products.more, `/community?tab=foryou&list=products&q=${encodeURIComponent('التنين')}`);

  // «تَنين» carries a fatha the shop never writes; the index folds it away.
  const folded = (await search(raw, null, `q=${encodeURIComponent('تَنين')}&types=materials`)).sections;
  assert.deepEqual(ids(folded.materials.rows), ['p_pla'], 'the material\'s name_ar through the index');
  const latin = (await search(raw, null, 'q=dragon&types=materials,projects')).sections;
  assert.deepEqual(ids(latin.materials.rows), ['p_pla']);
  assert.deepEqual(ids(latin.projects.rows), ['po_sara', 'po_omar'], 'case does not matter');

  const suggest = await json(await get(as(raw, null), `/api/community/search/suggest?q=${encodeURIComponent('تني')}`));
  const products = suggest.suggestions.filter((s: { type: string }) => s.type === 'product').map((s: { text: string }) => s.text);
  assert.ok(products.includes('خيط تنين أحمر 1 كغ'), `an Arabic query is completed by the Arabic name: ${JSON.stringify(suggest)}`);
});
