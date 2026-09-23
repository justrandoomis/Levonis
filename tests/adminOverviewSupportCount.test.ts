/**
 * THE DASHBOARD HAS TO SAY SOMEBODY IS WAITING.
 *
 * «الدعم والتذاكر» shipped as its own sidebar entry with its own queue, and
 * the overview — the screen the owner opens first — said nothing about it at
 * all. `src/components/AdminOverview.tsx` contained zero occurrences of
 * 'ticket' or 'support', so the only way to learn that a customer was waiting
 * was to remember the tab existed and go and look. A queue nobody is told
 * about is a queue nobody staffs, which is the same report that moved the
 * console out of the memberships panel in the first place.
 *
 * The count is deliberately narrow: `open` and `waiting_staff` are the two
 * states where the ball is on the shop's side (migration 0010).
 * `waiting_customer` is not — the shop has answered — and a badge that counts
 * tickets nobody can act on is a badge people learn to ignore.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { asD1, freshDb, stubApp } from './fixtures/app';
import { ROOT } from './fixtures/d1';
import { adminRoutes } from '../worker/routes/admin';

const ADMIN = { id: 'boss', role: 'admin' as const, email: 'boss@x.co' };
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

/**
 * Comments are stripped before any of the wiring assertions below run. A
 * sidebar entry that has been commented OUT still contains the text of a
 * sidebar entry, so a bare `match` on the source is satisfied by exactly the
 * thing it is supposed to catch — which is how a "the screen exists" test
 * stays green over a screen nobody can reach.
 */
const stripComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

function seed() {
  const raw = freshDb();
  raw.exec(`
    INSERT INTO users (id,name,email,password_hash,role) VALUES
      ('boss','Admin','boss@x.co','h','admin'),
      ('c1','Sara','s@x.co','h','customer');
    INSERT INTO support_tickets (id, user_id, subject, state) VALUES
      ('t1','c1','الطباعة خربانة','open'),
      ('t2','c1','وين طلبي','waiting_staff'),
      ('t3','c1','شكراً','waiting_customer'),
      ('t4','c1','انتهى','resolved');
  `);
  return { raw, db: asD1(raw) };
}

const app = (db: D1Database) => stubApp(db, ADMIN, (a) => a.route('/api/admin', adminRoutes));

test('the overview counts only the tickets waiting on the shop', async () => {
  const { db } = seed();
  const res = await app(db).request('/api/admin/overview');
  assert.equal(res.status, 200);
  const body = (await res.json()) as { stats: Record<string, number> };
  assert.equal(
    body.stats.support_tickets_waiting,
    2,
    'open + waiting_staff; waiting_customer and resolved are not a queue'
  );
});

test('an empty queue reads zero rather than missing', async () => {
  const raw = freshDb();
  raw.exec("INSERT INTO users (id,name,email,password_hash,role) VALUES ('boss','Admin','boss@x.co','h','admin');");
  const res = await app(asD1(raw)).request('/api/admin/overview');
  const body = (await res.json()) as { stats: Record<string, number> };
  assert.equal(body.stats.support_tickets_waiting, 0);
});

/**
 * And the number reaches a human. A count the server computes and no screen
 * renders is the same as no count — which is precisely what the previous
 * round shipped on the client half of another lane.
 */
test('the dashboard renders the count, and the card opens the queue it counts', () => {
  const overview = stripComments(read('src/components/AdminOverview.tsx'));
  assert.match(overview, /support_tickets_waiting: number;/, 'the stat is typed');
  assert.match(overview, /support_tickets_waiting: 0,/, 'and has an empty-state default');
  // Printed as part of the console's total: tickets + order-chat messages +
  // complaints, the same three counts the sidebar badge shows.
  assert.match(
    overview,
    /\(stats\.support_tickets_waiting \|\| 0\) \+\s*\(stats\.support_chats_unread \|\| 0\) \+\s*\(stats\.support_complaints_open \|\| 0\)/,
    'and is printed, with the other two queues beside it'
  );
  assert.match(
    overview,
    /onNavigateTab\('support'\)/,
    'the card is a door into the queue, not just a number'
  );
});

/**
 * «شكاوى الأسعار» — the other surface that existed only on the server.
 * `/api/admin/price-reports` was mounted in worker/index.ts and src/ referenced
 * NEITHER the list nor the decision; the only caller anywhere in the app was
 * the customer's POST in CheaperElsewhereSheet.tsx.
 */
test('the price-report queue has a screen, a sidebar entry and a mount', () => {
  const admin = stripComments(read('src/pages/Admin.tsx'));
  assert.match(admin, /id: 'price_reports'/, 'it is in the sidebar');
  assert.match(admin, /\| 'price_reports'/, 'and in the tab union, so the entry can actually be selected');
  assert.match(admin, /activeTab === 'price_reports' && <PriceReportsPanel \/>/, 'and something mounts');

  const panel = stripComments(read('src/components/adminPriceReports/PriceReportsPanel.tsx'));
  assert.match(panel, /api\.get<[\s\S]*?>\(\s*`\/api\/admin\/price-reports/, 'the list is read');
  assert.match(panel, /api\.patch\(`\/api\/admin\/price-reports\/\$\{report\.id\}`/, 'and the decision is written');
  // The server's own note says nothing follows these URLs. This screen keeps
  // that true: it renders the link, it never requests it.
  assert.match(panel, /rel="noreferrer noopener"/);
  assert.ok(
    !/fetch\(|api\.get\(\s*r\.url|api\.get\(\s*report\.url/.test(panel),
    'the competitor link is text, never something this app fetches'
  );
});
