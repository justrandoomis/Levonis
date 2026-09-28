/**
 * THE REQUEST BOARD (/requests, «كل الطلبات») — paged without losing a
 * request, searchable on the server, and a failure said (review of Levo
 * Community, 2026-09-28).
 *
 * `GET /api/marketplace/requests` paged by a bare `created_at`: a request that
 * shared its second with the last one on a page was never shown. It now pages
 * by (created_at, id) like the community feeds (worker/lib/feedCursor.ts) and
 * takes the community page's own visibility rule and search
 * (worker/lib/requestBoard.ts). The request's page now says where it goes and
 * when it was published and closes.
 *
 * Run: node --import tsx --test tests/requestBoard.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { freshDb, asD1, stubApp, get, json, type StubUser } from './fixtures/app';
import { marketplaceRoutes } from '../worker/routes/marketplace';
import { feedCursor, nextFeedCursor } from '../worker/lib/feedCursor';

const ROOT = join(import.meta.dirname, '..');
const code = (p: string) => readFileSync(join(ROOT, p), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const VIEWER: StubUser = { id: 'v', role: 'customer', email: 'v@x.co' };
const SAME = '2026-09-20T10:00:00.000Z';

function seed() {
  const raw = freshDb();
  raw.exec(`
    INSERT INTO users (id,name,email,password_hash,role) VALUES ('buyer','Sara','s@x.co','h','customer'), ('v','V','v@x.co','h','customer');
    INSERT INTO community_requests (id,customer_id,title,description,state,status,visibility,created_at) VALUES
      ('r1','buyer','Shelf bracket','PETG, twelve of them','receiving_offers','open','public','${SAME}'),
      ('r2','buyer','Gear for a mixer','nylon','receiving_offers','open','public','${SAME}'),
      ('r3','buyer','Cosplay helmet','painted','open','open','public','${SAME}'),
      ('r0','buyer','Older bracket','ABS','open','open','public','2026-09-19T10:00:00.000Z'),
      ('rp','buyer','Private bracket','hidden','open','open','private','2026-09-21T10:00:00.000Z'),
      ('rd','buyer','Draft bracket','not yet','draft','open','public','2026-09-21T10:00:00.000Z');
    INSERT OR REPLACE INTO admin_settings (key,value) VALUES ('communityGate','{"open":true}');
  `);
  return raw;
}

const app = (raw: ReturnType<typeof freshDb>) => stubApp(asD1(raw), VIEWER, (a) => a.route('/api/marketplace', marketplaceRoutes));
const ids = (b: Record<string, unknown>) => (b.requests as Array<{ id: string }>).map((r) => r.id);

test('three requests in the same second across a page boundary: every one is shown once', async () => {
  const raw = seed();
  const page1 = await json(await get(app(raw), '/api/marketplace/requests?limit=2'));
  assert.deepEqual(ids(page1), ['r3', 'r2']);
  assert.equal(page1.next_cursor, `${SAME}|r2`);
  const page2 = await json(await get(app(raw), `/api/marketplace/requests?limit=2&cursor=${encodeURIComponent(page1.next_cursor)}`));
  assert.deepEqual(ids(page2), ['r1', 'r0'], 'r1 shares r2\'s second — the bare timestamp skipped it');
  const page3 = await json(await get(app(raw), `/api/marketplace/requests?limit=2&cursor=${encodeURIComponent(page2.next_cursor)}`));
  assert.deepEqual(ids(page3), []);
  assert.equal(page3.next_cursor, null);
  // An old client's bare timestamp still reads as «strictly older».
  const legacy = await json(await get(app(raw), `/api/marketplace/requests?cursor=${encodeURIComponent(SAME)}`));
  assert.deepEqual(ids(legacy), ['r0']);
  assert.deepEqual(feedCursor(`${SAME}|r2`), { at: SAME, id: 'r2' });
  assert.equal(nextFeedCursor([{ created_at: SAME, id: 'x' }], 2), null, 'a short page is the last');
});

test('the board searches title and description on the server — only what the board shows', async () => {
  const raw = seed();
  const found = await json(await get(app(raw), '/api/marketplace/requests?q=bracket'));
  assert.deepEqual(ids(found).sort(), ['r0', 'r1'], 'not the private request, not the draft');
  const byWords = await json(await get(app(raw), '/api/marketplace/requests?q=nylon'));
  assert.deepEqual(ids(byWords), ['r2']);
  const wild = await json(await get(app(raw), `/api/marketplace/requests?q=${encodeURIComponent('%')}`));
  assert.deepEqual(ids(wild), [], 'a % is a character, not a wildcard');
});

test('the page: a search box that keeps the keyboard, «المزيد» that says it failed, and the request\'s place and dates', () => {
  const page = code('src/pages/Requests.tsx');
  assert.match(page, /if \(q\) p\.set\('q', q\);/);
  assert.match(page, /return \(\s*<div className="space-y-3">\s*\{search\}\s*\{body\}/, 'one frame for every state');
  assert.match(page, /setMoreError\(true\);/);
  assert.doesNotMatch(page, /\} catch \{\s*setCursor\(null\);/, 'a failed page no longer hides the rest of the board');
  assert.match(page, /label=\{loc\('المحافظة', 'Governorate', 'پارێزگا'\)\}/);
  assert.match(page, /\{open && formatDate\(current\.expires_at, lang\) && \(/);
  assert.match(page, /\{offersLabel\(r\.offer_count, lang\)\}/, '«5 عروض», not «5 عرض»');
  const board = code('worker/routes/marketplace.ts');
  assert.match(board, /WHERE \$\{requestBoardVisible\('\?1', '\?2'\)\}/, 'the community page\'s own rule');
  assert.match(board, /ORDER BY r\.created_at DESC, r\.id DESC LIMIT \?7/);
});
