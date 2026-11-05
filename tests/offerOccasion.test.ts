/**
 * THE SALE'S OCCASION — THE MIGRATION AND THE ADMIN DOOR (DECISIONS row 294; migration 0224;
 * docs/ux/PRODUCT-DISCOUNT.md §16).
 *
 * The owner names a discount's occasion in the product form's «تخفيض السعر» card or the «العروض الخاصة»
 * tab; both write the SAME `offer_windows` row through `PUT /api/admin/offers/:id`. Against the real
 * routes and migrations:
 *   - 0224 adds two defaulted, shape-checked columns and a partial index; every old row reads none;
 *   - a save that names an occasion stores it, answers it and audits it inside its batch; a save that
 *     does not name it keeps it (the tab's, the card's, a bundle's and a mystery offer's saves alike);
 *     '' clears it; a custom name keeps its Arabic, English and Sorani;
 *   - refused, in three languages, writing nothing: an unknown key, a custom name without its Arabic,
 *     too long or copying the Arabic, an occasion on a sale that prices nothing — named, or kept by a save
 *     that switches the price off — and on a composition; the preview prices its rows anyway and says the
 *     sentence beside them;
 *   - deploy-ahead (a database before 0224): an ordinary save works, a save naming an occasion is a
 *     409, the list filters to nothing, no customer payload names one;
 *   - the tab's list filters by occasion (one key through 0224's partial index) and pages past its 200.
 *
 * Run: node --import tsx --test tests/offerOccasion.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { all, count, hasColumn, row } from './fixtures/app';
import { discountWorld, PID, SHAPES, seedShapes } from './fixtures/productDiscount';
import { offerWindowStatements, subjectOf } from '../worker/lib/offers';
import { OFFER_DOOR_SENTENCES } from '../worker/routes/offers';
import { OFFER_OCCASION_REFUSALS } from '../packages/contracts/src/offerRefusals';
import { REFUSAL_STRINGS } from '../src/lib/refusalStrings';

const percent = (p: number, extra: Record<string, unknown> = {}) => ({ offer_price_mode: 'discount_percent', discount_percent: p, ends_at: '2099-01-01T00:00', ...extra });
const codeOf = (r: { body: Record<string, unknown> }) => String(r.body.code ?? '');
const stored = (raw: Parameters<typeof row>[0], id = PID) =>
  row<{ badge: string; badge_text: string }>(raw, "SELECT badge, badge_text FROM offer_windows WHERE subject_type = 'product' AND subject_id = ?", id);

/* ------------------------------------------------------------ the migration -- */

test('0224: two defaulted columns with a SHAPE check (never a list), a partial index; every old row reads no occasion', async () => {
  const w = await discountWorld();
  assert.ok(hasColumn(w.raw, 'offer_windows', 'badge') && hasColumn(w.raw, 'offer_windows', 'badge_text'));
  assert.ok(all<{ name: string }>(w.raw, "PRAGMA index_list('offer_windows')").some((i) => i.name === 'idx_offer_windows_badge'));
  const insert = (badge: string, text = '') =>
    w.raw.prepare("INSERT INTO offer_windows (subject_type, subject_id, id, badge, badge_text) VALUES ('product', ?, ?, ?, ?)").run(`s_${badge}_${text.length}`, `ofw_${badge}_${text.length}`, badge, text);
  // The CHECK is a shape: a key the code does not know yet is a valid row (an older Worker reads it as none).
  for (const ok of ['black_friday', 'a_future_occasion', 'custom', 'x2']) insert(ok);
  insert('custom', JSON.stringify({ ar: 'عيد الحب' }));
  for (const bad of ['Black Friday', 'black-friday', 'x', 'a'.repeat(33)]) assert.throws(() => insert(bad), /CHECK constraint failed/, bad);
  for (const bad of ['not json', '[1,2]', `{"ar":"${'ح'.repeat(400)}"}`]) assert.throws(() => insert('custom', bad), /CHECK constraint failed/, bad);
  // A database with sales on it before 0224: they read no occasion once it lands.
  const { dbThrough } = await import('./fixtures/app');
  const old = dbThrough('0223');
  old.exec("INSERT INTO offer_windows (subject_type, subject_id, id, offer_price_mode, discount_percent) VALUES ('product', 'p_old', 'ofw_old', 'discount_percent', 10)");
  assert.equal(hasColumn(old, 'offer_windows', 'badge'), false);
  old.exec(readFileSync('migrations/0224_offer_occasions.sql', 'utf8'));
  assert.deepEqual({ ...row<Record<string, unknown>>(old, "SELECT badge, badge_text FROM offer_windows WHERE subject_id = 'p_old'") }, { badge: '', badge_text: '' });
});

/* ---------------------------------------------------------------- the door -- */

test('PUT names an occasion: stored, answered and audited in the batch; a save that does not name it keeps it; "" clears it', async () => {
  const w = await discountWorld();
  const saved = await w.saveOffer(w.owner, percent(10, { badge: 'black_friday', expected_updated_at: null }));
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.equal(saved.body.offer.badge, 'black_friday');
  assert.equal(saved.body.offer.badge_text, null);
  assert.deepEqual({ ...stored(w.raw) }, { badge: 'black_friday', badge_text: '' });
  const audit = JSON.parse(row<{ detail: string }>(w.raw, "SELECT detail FROM audit_log WHERE action = 'offer.update' ORDER BY rowid DESC LIMIT 1")!.detail);
  assert.equal(audit.after.badge, 'black_friday', 'the audit row says which occasion the sale is for');
  assert.equal((await w.readOffer(w.owner)).body.offer.badge, 'black_friday', 'the card and the tab read it back');

  // An older client's save names none (this deploy's card, inline field and tab always do): the occasion stays.
  const kept = await w.saveOffer(w.owner, percent(15));
  assert.equal(kept.status, 200, JSON.stringify(kept.body));
  assert.equal(kept.body.offer.badge, 'black_friday');
  assert.equal(stored(w.raw)!.badge, 'black_friday');
  const keptAudit = JSON.parse(row<{ detail: string }>(w.raw, "SELECT detail FROM audit_log WHERE action = 'offer.update' ORDER BY rowid DESC LIMIT 1")!.detail);
  assert.equal(keptAudit.before.badge, 'black_friday');
  assert.equal(keptAudit.after.badge, 'black_friday', 'the audit says the occasion the row keeps');

  // Another occasion replaces it — one sale per product — and '' clears it.
  assert.equal((await w.saveOffer(w.owner, percent(15, { badge: 'ramadan' }))).body.offer.badge, 'ramadan');
  const cleared = await w.saveOffer(w.owner, percent(15, { badge: '' }));
  assert.equal(cleared.body.offer.badge, '');
  assert.equal(stored(w.raw)!.badge, '');

  // The owner's own name: Arabic required, English and Sorani optional and kept as typed (trimmed).
  const own = await w.saveOffer(w.owner, percent(12, { badge: 'custom', badge_text: { ar: '  عيد   الحب ', en: 'Valentine', ckb: '' } }));
  assert.equal(own.status, 200, JSON.stringify(own.body));
  assert.deepEqual(own.body.offer.badge_text, { ar: 'عيد الحب', en: 'Valentine' });
  assert.deepEqual(JSON.parse(stored(w.raw)!.badge_text), { ar: 'عيد الحب', en: 'Valentine' });
  // A preset never stores a name, even when one was posted.
  await w.saveOffer(w.owner, percent(12, { badge: 'winter', badge_text: { ar: 'شتاء' } }));
  assert.deepEqual({ ...stored(w.raw) }, { badge: 'winter', badge_text: '' });
});

test('refused, in three languages, writing nothing: unknown key, a bad custom name, a sale that prices nothing, a composition', async () => {
  const w = await discountWorld();
  await seedShapes(w);
  const cases: Array<[string, number, () => ReturnType<typeof w.saveOffer>]> = [
    ['OFFER_OCCASION_UNKNOWN', 400, () => w.saveOffer(w.owner, percent(10, { badge: 'blackfriday' }))],
    ['OFFER_OCCASION_UNKNOWN', 400, () => w.saveOffer(w.owner, percent(10, { badge: 'Black Friday' }))],
    ['OFFER_OCCASION_NAME', 400, () => w.saveOffer(w.owner, percent(10, { badge: 'custom' }))],
    ['OFFER_OCCASION_NAME', 400, () => w.saveOffer(w.owner, percent(10, { badge: 'custom', badge_text: { en: 'Valentine' } }))],
    ['OFFER_OCCASION_NAME', 400, () => w.saveOffer(w.owner, percent(10, { badge: 'custom', badge_text: { ar: 'ح'.repeat(33) } }))],
    ['OFFER_OCCASION_NAME', 400, () => w.saveOffer(w.owner, percent(10, { badge: 'custom', badge_text: { ar: 'عيد الحب', ckb: 'عيد الحب' } }))],
    ['OFFER_OCCASION_NAME', 400, () => w.saveOffer(w.owner, percent(10, { badge: 'custom', badge_text: { ar: 'عيد الحب', en: 'عيد الحب' } }))],
    ['OFFER_OCCASION_NEEDS_PRICE', 400, () => w.saveOffer(w.owner, { offer_price_mode: '', ends_at: '2099-01-01T00:00', badge: 'black_friday' })],
    ['OFFER_OCCASION_ORDINARY_ONLY', 400, () => w.saveOffer(w.owner, percent(10, { badge: 'black_friday' }), SHAPES.bundle)],
  ];
  const audits = count(w.raw, 'SELECT COUNT(*) AS n FROM audit_log');
  for (const [code, status, run] of cases) {
    const r = await run();
    assert.equal(codeOf(r), code, `${code}: ${JSON.stringify(r.body).slice(0, 300)}`);
    assert.equal(r.status, status, code);
    const said = (r.body.details as { errors?: Array<Record<string, string>> } | undefined)?.errors?.[0];
    assert.ok(said && said.ar && said.en && said.ckb, `${code}: three sentences`);
    assert.notEqual(said.ckb, said.ar, `${code}: the Sorani is not the Arabic`);
  }
  assert.equal(count(w.raw, 'SELECT COUNT(*) AS n FROM offer_windows'), 0, 'nothing was written by any refusal');
  assert.equal(count(w.raw, 'SELECT COUNT(*) AS n FROM audit_log'), audits, 'and nothing audited');
  // A Latin name may be the same in every language: it is no copy of the Arabic.
  assert.equal((await w.saveOffer(w.owner, percent(10, { badge: 'custom', badge_text: { ar: 'Mega Sale', en: 'Mega Sale', ckb: 'Mega Sale' } }))).status, 200);
  // The client tables carry the very sentences the door says.
  for (const code of Object.keys(OFFER_OCCASION_REFUSALS)) {
    assert.deepEqual({ ...(OFFER_DOOR_SENTENCES as Record<string, object>)[code] }, { ...REFUSAL_STRINGS[code] }, code);
  }
});

test('a save that does not name the occasion but leaves the sale pricing nothing is refused: no label on a window that lowers nothing', async () => {
  const w = await discountWorld({ costFirst: false });
  assert.equal((await w.saveOffer(w.owner, percent(10, { badge: 'black_friday' }))).status, 200);
  // An older tab (or a direct call) switches the price off and names no occasion: refused, in three languages.
  const off = await w.saveOffer(w.owner, { offer_price_mode: '', ends_at: '2099-01-01T00:00' });
  assert.equal(off.status, 400, JSON.stringify(off.body).slice(0, 300));
  assert.equal(codeOf(off), 'OFFER_OCCASION_NEEDS_PRICE');
  const said = off.body.details.errors[0];
  assert.ok(said.ar && said.en && said.ckb && said.ckb !== said.ar);
  assert.deepEqual({ ...stored(w.raw) }, { badge: 'black_friday', badge_text: '' }, 'nothing written');
  assert.equal(row<{ discount_percent: number }>(w.raw, 'SELECT discount_percent FROM offer_windows WHERE subject_id = ?', PID)!.discount_percent, 10);
  // The preview says it beside its rows; the tab's filter never lists a priceless window under an occasion.
  const p = await w.previewOffer(w.owner, { offer_price_mode: '', ends_at: '2099-01-01T00:00' });
  assert.deepEqual(p.body.issues.map((i: { code: string }) => i.code), ['OFFER_OCCASION_NEEDS_PRICE']);
  assert.ok((await w.call(w.owner, 'GET', '/api/admin/offers?badge=black_friday')).body.offers.every((o: { offer_price_mode: string }) => o.offer_price_mode !== ''));
  // Clearing the occasion in the same save is an ordinary save: a countdown with no price and no label.
  const cleared = await w.saveOffer(w.owner, { offer_price_mode: '', ends_at: '2099-01-01T00:00', badge: '' });
  assert.equal(cleared.status, 200, JSON.stringify(cleared.body).slice(0, 300));
  assert.deepEqual({ ...stored(w.raw) }, { badge: '', badge_text: '' });
  // And a priceless window that carries no occasion saves as it always has, the field named or not.
  assert.equal((await w.saveOffer(w.owner, { offer_price_mode: '', ends_at: '2099-01-01T00:00' })).status, 200);
  // A database before 0224 has nothing to keep: the same save works there.
  const old = await discountWorld({ through: '0223', costFirst: false });
  assert.equal((await old.saveOffer(old.owner, percent(10))).status, 200);
  assert.equal((await old.saveOffer(old.owner, { offer_price_mode: '', ends_at: '2099-01-01T00:00' })).status, 200);
});

test('the tab’s filter by one occasion reads 0224’s partial index', async () => {
  const w = await discountWorld({ costFirst: false });
  const src = readFileSync('worker/routes/offers.ts', 'utf8');
  assert.match(src, /where \+= " AND w\.badge <> '' AND w\.badge = \?";/, 'the door names the index’s WHERE beside the key');
  const plan = (where: string) =>
    all<{ detail: string }>(w.raw, `EXPLAIN QUERY PLAN SELECT w.* FROM offer_windows w LEFT JOIN products p ON p.id = w.subject_id WHERE w.subject_type = 'product' ${where} ORDER BY w.updated_at DESC, w.subject_id ASC LIMIT 201 OFFSET 0`, 'black_friday')
      .map((r) => r.detail)
      .join(' | ');
  assert.match(plan("AND w.badge <> '' AND w.badge = ?"), /USING INDEX idx_offer_windows_badge \(badge=\?\)/);
  assert.doesNotMatch(plan('AND w.badge = ?'), /idx_offer_windows_badge/, 'a bound key alone cannot take a partial index — why the door spells it out');
});

test('the preview prices the sale while the occasion is being named, and says why the name is not yet saveable', async () => {
  const w = await discountWorld();
  const p = await w.previewOffer(w.owner, percent(10, { badge: 'custom', badge_text: { ar: '' } }));
  assert.equal(p.status, 200);
  assert.equal(p.body.refused, undefined, 'the rows keep their after prices');
  assert.deepEqual(p.body.rows.map((r: Record<string, unknown>) => r.state), ['lowered', 'lowered', 'lowered', 'lowered']);
  assert.deepEqual(p.body.issues.map((i: { code: string }) => i.code), ['OFFER_OCCASION_NAME']);
  const fine = await w.previewOffer(w.owner, percent(10, { badge: 'black_friday' }));
  assert.deepEqual(fine.body.issues, []);
  assert.equal(count(w.raw, 'SELECT COUNT(*) AS n FROM offer_windows'), 0, 'a preview writes nothing');
});

test('a bundle’s and a mystery offer’s save never clear an occasion: their statements are the ones before 0224', async () => {
  const w = await discountWorld();
  await w.saveOffer(w.owner, percent(10, { badge: 'eid_al_adha' }));
  // The two composition editors call the writer without an occasion (worker/routes/adminBundles.ts, mystery.ts).
  for (const file of ['worker/routes/adminBundles.ts', 'worker/routes/mystery.ts']) {
    const src = readFileSync(file, 'utf8');
    const calls = src.split('\n').filter((line) => line.includes('offerWindowStatements(') && !line.trim().startsWith('*'));
    assert.ok(calls.length > 0, `${file} writes windows`);
    for (const call of calls) assert.match(call, /offerWindowStatements\(c\.env\.DB, subjectOf\([a-z.]+\), offer\)/i, `${file}: ${call.trim()} names no occasion`);
  }
  const offer = { starts_at: null, ends_at: null, required_tiers: [], offer_price_mode: 'discount_percent', offer_price_iqd: null, discount_percent: 20, discount_iqd: null, plus_price_iqd: null, locked_preview: true, active: true, max_per_user: null, max_global: null };
  const statements = offerWindowStatements(w.db, subjectOf(PID), offer);
  await w.db.batch(statements);
  assert.equal(row<{ discount_percent: number }>(w.raw, 'SELECT discount_percent FROM offer_windows WHERE subject_id = ?', PID)!.discount_percent, 20, 'the save landed');
  assert.equal(stored(w.raw)!.badge, 'eid_al_adha', 'and the occasion stayed');
  // With an occasion named (the door, on 0224), both columns are written; '' clears them.
  await w.db.batch(offerWindowStatements(w.db, subjectOf(PID), offer, { badge: '', badge_text: '' }));
  assert.equal(stored(w.raw)!.badge, '');
});

/* ------------------------------------------------------------ deploy-ahead -- */

test('a database before 0224: an ordinary save works, naming an occasion is a 409 in three languages, and nothing is labelled', async () => {
  const w = await discountWorld({ through: '0223' });
  assert.equal(hasColumn(w.raw, 'offer_windows', 'badge'), false);
  // The card always sends the key ('' here): an ordinary save.
  const ordinary = await w.saveOffer(w.owner, percent(10, { badge: '', expected_updated_at: null }));
  assert.equal(ordinary.status, 200, JSON.stringify(ordinary.body));
  assert.equal(ordinary.body.offer.badge, '', 'the answer reads none');
  assert.equal((await w.saveOffer(w.owner, percent(12))).status, 200, 'and an older client’s save, which names none');
  const named = await w.saveOffer(w.owner, percent(10, { badge: 'black_friday' }));
  assert.equal(named.status, 409);
  assert.equal(codeOf(named), 'OFFER_OCCASION_NOT_INSTALLED');
  const said = named.body.details.errors[0];
  assert.ok(said.ar && said.en && said.ckb && said.ckb !== said.ar);
  // The preview says it beside the priced rows.
  const p = await w.previewOffer(w.owner, percent(10, { badge: 'black_friday' }));
  assert.deepEqual(p.body.issues.map((i: { code: string }) => i.code), ['OFFER_OCCASION_NOT_INSTALLED']);
  // The tab's list: a key lists nothing, 'none' lists every row.
  assert.deepEqual((await w.call(w.owner, 'GET', '/api/admin/offers?badge=black_friday')).body.offers, []);
  assert.equal((await w.call(w.owner, 'GET', '/api/admin/offers?badge=none')).body.offers.length, 1);
  // The storefront: the sale prices, and no occasion is named anywhere.
  const listing = await w.call(w.guest, 'GET', '/api/products?limit=50');
  const card = listing.body.products.find((x: { id: string }) => x.id === PID);
  assert.equal(card.offer.price_source, 'offer');
  assert.equal('badge' in card.offer, false);
  const offers = await w.call(w.guest, 'GET', '/api/products?type=offers');
  assert.deepEqual(offers.body.products.map((x: { id: string }) => x.id), [PID], '«العروض» still lists the sale');
  assert.deepEqual(offers.body.occasions, []);
});

/* ---------------------------------------------------------------- the list -- */

test('the tab’s list filters by occasion and pages past its 200, the newest first', async () => {
  const w = await discountWorld();
  await w.saveOffer(w.owner, percent(10, { badge: 'black_friday' }));
  const insert = w.raw.prepare(
    "INSERT INTO offer_windows (subject_type, subject_id, id, offer_price_mode, discount_percent, badge, updated_at) VALUES ('product', ?, ?, 'discount_percent', 5, ?, ?)"
  );
  for (let i = 0; i < 205; i++) {
    const id = `p_bulk_${String(i).padStart(3, '0')}`;
    insert.run(id, `ofw_${id}`, i % 2 ? 'black_friday' : i % 5 ? '' : 'ramadan', `2026-10-01T00:${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}.000Z`);
  }
  const page = (q: string) => w.call(w.owner, 'GET', `/api/admin/offers${q}`);
  const first = await page('');
  assert.equal(first.status, 200);
  assert.equal(first.body.offers.length, 200);
  assert.equal(first.body.has_more, true);
  assert.equal(first.body.next_offset, 200);
  assert.equal(first.body.offers[0].product.id, PID, 'the newest first');
  const second = await page('?offset=200');
  assert.equal(second.body.offers.length, 6);
  assert.equal(second.body.has_more, false);
  assert.equal(second.body.next_offset, null);
  const ids = new Set([...first.body.offers, ...second.body.offers].map((o: { subject_id: string }) => o.subject_id));
  assert.equal(ids.size, 206, 'two pages walk one order: nothing twice, nothing missed');
  const friday = (await page('?badge=black_friday&limit=200')).body.offers;
  assert.equal(friday.length, 1 + 102);
  assert.ok(friday.every((o: { badge: string }) => o.badge === 'black_friday'));
  assert.equal((await page('?badge=ramadan')).body.offers.length, 21);
  assert.equal((await page('?badge=any&limit=200')).body.offers.length, 124);
  assert.equal((await page('?badge=none')).body.offers.length, 82);
  const bogus = await page('?badge=nope');
  assert.equal(bogus.status, 400);
  assert.equal(codeOf(bogus), 'OFFER_OCCASION_UNKNOWN');
});
