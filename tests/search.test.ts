/**
 * «مهما كتب يظهر الذي يريده» — whatever they type, they get what they wanted.
 *
 * THE SEARCH THAT COULD NOT FIND THIS SHOP'S OWN FLAGSHIP. It was
 * `name LIKE '%q%' OR name_ar LIKE '%q%' OR name_ku LIKE '%q%' OR
 * description LIKE '%q%'`. The owner's examples are the specification, and
 * every one of them failed against that: a customer looking for the
 * "Bambu Lab X2D Combo" types بامبو، بمبو، اكس تو دي، اكس، تو دي، طابعه،
 * نوزلين، طبعات — and not one of those is a substring of the product's name.
 *
 * The cases below ARE those examples. They are written first because they are
 * the acceptance criteria, and the rest of the file exists to keep them true:
 * the normalisation, the romanisation that lets «بامبو» and "bambu" meet, the
 * dictionary that knows «طابعة» means printer, and the bounded typo tolerance
 * that must forgive «بمبو» WITHOUT forgiving "abs" into "ams".
 *
 * Run: npm run test:unit
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { asD1, dbThrough, freshDb } from './fixtures/app';
import { runDurableJobs } from '../worker/lib/jobs';
import { rewriteHashtag } from '../worker/lib/hashtags';
import type { Env } from '../worker/lib/types';
import { normalizeText, tokenize } from '../worker/lib/search/normalize';
import { collapseSpelledLetters, romanize } from '../worker/lib/search/translit';
import { boundedDistance, editBudget } from '../worker/lib/search/match';
import { buildIndexRows, FIELD_WEIGHT } from '../worker/lib/search/index';
import { toSearchDoc } from '../worker/lib/search/document';
import { planSearchIndex, searchProducts } from '../worker/lib/search/store';
import { normalizedSynonymSeed, SYNONYM_SEED } from '../worker/lib/search/vocabulary';

type Raw = ReturnType<typeof freshDb>;

/** The shop's real catalogue, as the owner's screenshots show it. */
async function shop(): Promise<Raw> {
  const raw = freshDb();
  const db = asD1(raw);
  const add = async (
    id: string,
    name: string,
    over: Partial<Parameters<typeof toSearchDoc>[0]> = {}
  ) => {
    raw.prepare(
      `INSERT INTO products (id, slug, name, description, price_iqd, status) VALUES (?, ?, ?, '', 1000, 'active')`
    ).run(id, id, name);
    const stmts = planSearchIndex(db, toSearchDoc({ id, name, ...over }));
    await db.batch(stmts);
  };

  await add('p_x2d', 'Bambu Lab X2D / X2D Combo 3D Printer', {
    name_ar: 'طابعة بامبو لاب X2D كومبو',
    brandName: 'Bambu Lab',
    categoryNames: ['Printers', 'FDM Printers'],
    hashtags: ['3d-printer', 'x2d-combo', 'x2d', 'bambu-lab', 'multi-material', 'ams-2-pro', 'dual-nozzle', 'fdm'],
    variantNames: ['Combo', 'Dual nozzle'],
  });
  // The shop's current flagship, and the product behind the owner's «H»
  // report — migration 0091 seeds «اتش2دي» → `h2d` for exactly this one.
  await add('p_h2d', 'Bambu Lab H2D Combo 3D Printer', {
    name_ar: 'طابعة بامبو لاب H2D كومبو',
    brandName: 'Bambu Lab',
    categoryNames: ['Printers', 'FDM Printers'],
    hashtags: ['3d-printer', 'h2d', 'h2d-combo', 'bambu-lab', 'dual-nozzle', 'fdm'],
    variantNames: ['Combo'],
  });
  await add('p_a1', 'Bambu Lab A1 Combo 3D Printer', {
    name_ar: 'طابعة بامبو لاب A1 كومبو',
    brandName: 'Bambu Lab',
    categoryNames: ['Printers', 'FDM Printers'],
    hashtags: ['a1', 'a1-combo', 'bambu-lab', 'fdm'],
  });
  await add('p_u1', 'Snapmaker U1 3D Printer', {
    brandName: 'Snapmaker',
    categoryNames: ['Printers', 'FDM Printers'],
    hashtags: ['u1', 'snapmaker', 'fdm'],
  });
  await add('p_pla', 'PLA Basic Filament — Jade White', {
    name_ar: 'فلمنت بي ال اي أساسي',
    brandName: 'Bambu Lab',
    categoryNames: ['Printing Materials', 'FDM Materials'],
    hashtags: ['pla', 'pla-basic', 'filament'],
    variantNames: ['Jade White', '1 kg'],
    description: 'Compatible with Bambu Lab printers and every FDM machine.',
  });
  await add('p_nozzle', 'Hardened Steel Nozzle 0.4mm', {
    name_ar: 'نوزل فولاذ مقوى',
    brandName: 'Creality',
    categoryNames: ['Printer Accessories'],
    hashtags: ['nozzle', 'hardened-steel'],
  });
  return raw;
}

const ids = async (raw: Raw, q: string) => (await searchProducts(asD1(raw), q)).ids;
const first = async (raw: Raw, q: string) => (await ids(raw, q))[0];

// =========================================================================
// THE OWNER'S OWN EXAMPLES — these are the acceptance criteria
// =========================================================================

test('«بامبو» finds the Bambu Lab printers', async () => {
  const raw = await shop();
  const got = await ids(raw, 'بامبو');
  assert.ok(got.includes('p_x2d'), 'the flagship must be found by its brand in Arabic');
  assert.ok(got.includes('p_a1'));
  assert.ok(!got.includes('p_u1'), 'a Snapmaker is not a Bambu');
});

test('«بمبو» — a letter missing — still finds them', async () => {
  const raw = await shop();
  assert.ok((await ids(raw, 'بمبو')).includes('p_x2d'));
});

test('«اكس تو دي» — the model spelled out letter by letter — finds the X2D', async () => {
  // "ex two dee", each read aloud and written as an Arabic word. Romanisation
  // gives "aks tw dy", nowhere near "x2d"; only the spelled-letter table knows.
  const raw = await shop();
  assert.equal(await first(raw, 'اكس تو دي'), 'p_x2d');
});

test('«اكس» ON ITS OWN reaches the X2D — one spelled letter, used as a prefix', async () => {
  // The owner lists «اكس» beside «اكس تو دي». A run of three collapses to
  // `x2d`; a lone letter has no run to collapse, and romanising «اكس» gives
  // `aks`, nowhere near anything. It is expanded to the single character `x`
  // and used as a PREFIX, which is what somebody saying "X" at a printer shop
  // means.
  const raw = await shop();
  const got = await ids(raw, 'اكس');
  assert.ok(got.includes('p_x2d'), '«اكس» must reach the X2D');
  assert.ok(!got.includes('p_pla'), 'and must not drag the filament in with it');
});

test('«H» ON ITS OWN reaches the H2D — one letter is a query, not debris', async () => {
  /**
   * THE REPORT THAT BLOCKED SELLING. Typing a single «H» answered «لا توجد
   * منتجات» while the front page sold an H2D.
   *
   * `tokenize` drops a one-character word, and it is RIGHT to — a "h" row on
   * every product containing an H matches everything and ranks nothing, which
   * is what the single-character case below pins. But the same function ran on
   * the query side, so what a shopper TYPED was held to the index's floor:
   * «H» expanded to nothing, `searchProducts` exited before reading anything,
   * and the route painted its empty state.
   *
   * The engine has known what to do with a one-character term since «اكس»
   * above: it becomes a one-character index range and is matched as a PREFIX.
   */
  const raw = await shop();
  const got = await ids(raw, 'H');
  assert.ok(got.includes('p_h2d'), '«H» must reach the H2D');
  assert.ok(!got.includes('p_a1'), 'a letter names a shelf, not the whole catalogue');
  assert.equal((await searchProducts(asD1(raw), 'H')).indexReady, true, 'and it is a real answer');
});

test('one letter on an ARABIC keyboard crosses into a catalogue written in Latin', async () => {
  // «ب» is somebody one keystroke into "Bambu" with the wrong keyboard on.
  // The romanised skeleton — the same one that puts «بامبو» and "bambu" in
  // reach of each other — is what carries a single letter across the scripts.
  const raw = await shop();
  const got = await ids(raw, 'ب');
  assert.ok(got.includes('p_h2d') || got.includes('p_x2d'), '«ب» must reach the Bambu printers');
  assert.ok(!got.includes('p_nozzle'), 'and must not reach a product with no B in it');
});

test('a lone character INSIDE a longer query is still debris', async () => {
  /**
   * Coverage is a MULTIPLIER in `scoreProducts`, and that is the line holding
   * "bambu x2d" above every other Bambu product. A bare `1` in "pla 1" would
   * match a tenth of the vocabulary and count as a second covered word while
   * doing it, so the one-character term is added only when it is the WHOLE
   * query — where there is no other word for it to dilute.
   */
  const { expandQuery } = await import('../worker/lib/search/index');
  const bare = new Map<string, string>();
  assert.ok(expandQuery('h', bare).lookup.includes('h'), 'alone, it is looked up');
  assert.ok(!expandQuery('pla 1', bare).lookup.includes('1'), 'beside a word, it is not');
  assert.ok(!expandQuery('bambu h', bare).lookup.includes('h'));

  const raw = await shop();
  assert.equal(await first(raw, 'pla 1'), 'p_pla', 'the filament, not everything with a 1 in it');
  assert.equal(await first(raw, 'bambu x2d'), 'p_x2d', 'the coverage multiplier is untouched');
});

test('a single letter reaches a SHELF, not the five tokens a word would', async () => {
  // `bestMatches` returns five by default, and for a word that is generous:
  // five completions of "pla" is already more guessing than a shopper wants.
  // A letter is not a word — it names a whole shelf, and five tokens is at
  // most five products, so «H» would answer with a scrap of the H shelf
  // chosen by nothing the shopper can see.
  const { expandQuery, resolveTokens } = await import('../worker/lib/search/index');
  const none = new Map<string, string>();
  const shelf = Array.from({ length: 30 }, (_, i) => `h${String(i).padStart(2, '0')}x`);
  assert.ok(resolveTokens(expandQuery('h', none), shelf).size > 5, 'a letter opens the shelf');
  const words = Array.from({ length: 30 }, (_, i) => `pla${i}`);
  assert.equal(resolveTokens(expandQuery('pla', none), words).size, 5, 'a word stays at five');
});

test('a one-character prefix is cut by WEIGHT, not alphabetically', async () => {
  /**
   * The candidate read is capped, and what the cap throws away matters once a
   * prefix is one character long — which is not exotic: `candidatePrefix`
   * returns one for every token of three characters or fewer, so «اكس تو دي»
   * has had three of them since the day it was written. `SELECT DISTINCT
   * token … LIMIT 2000` has no ORDER BY, so SQLite serves the range scan's own
   * order and the cap falls ALPHABETICALLY — on a real catalogue the second
   * half of the shelf is simply never considered.
   *
   * Two thousand junk tokens that sort before `h2d`, and the flagship has to
   * survive them.
   */
  const raw = await shop();
  raw.prepare(
    `INSERT INTO products (id, slug, name, description, price_iqd, status) VALUES ('p_noise', 'p_noise', 'Noise', '', 1000, 'active')`
  ).run();
  raw.exec(
    `INSERT INTO search_tokens (product_id, token, weight)
       SELECT 'p_noise', 'h0' || substr('00000000' || n, -8), 1
       FROM (WITH RECURSIVE c(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM c WHERE n < 2400) SELECT n FROM c)`
  );
  const got = await ids(raw, 'H');
  assert.ok(got.includes('p_h2d'), 'the flagship must not be buried by tokens that merely sort earlier');
});

test('a query with nothing to look up still says whether the index could answer', async () => {
  // «!!!» normalises to nothing, so there is no lookup to run — but the
  // caller still has to know whether that is "the index answered" or "the
  // index was never asked", because only the second falls back to the
  // substring scan while the backfill catches up. This return hard-coded
  // "ready", which told a shop mid-backfill to paint an empty grid.
  const raw = await shop();
  assert.equal((await searchProducts(asD1(raw), '!!!')).indexReady, true, 'a built index is ready');
  raw.exec('DELETE FROM search_tokens');
  assert.equal((await searchProducts(asD1(raw), '!!!')).indexReady, false, 'an empty one is not');
});

test('A SPELLED LETTER THAT IS ALSO AN ARABIC WORD IS NOT READ AS A LETTER', async () => {
  // «في» means "in" and «ال» is the definite article. Reading them as V and L
  // would turn the two commonest words in the language into wildcards — which
  // is the whole reason `loneSpelledLetter` has a list instead of using the
  // spelled-letter table directly.
  const { loneSpelledLetter } = await import('../worker/lib/search/translit');
  for (const word of ['في', 'ال', 'او', 'ان', 'ام', 'تي', 'كي']) {
    assert.equal(loneSpelledLetter(word), null, `${word} is an Arabic word, not a letter`);
  }
  assert.equal(loneSpelledLetter('اكس'), 'x');
  assert.equal(loneSpelledLetter('دبليو'), 'w');
});

test('«طابعه» and «طبعات» find printers and not filament', async () => {
  const raw = await shop();
  // «طبعات» and «طبعه» are the same words with the alif dropped — how they are
  // typed in a hurry, and two of the owner's own examples. They are SEEDED
  // rather than forgiven, because the candidate vocabulary is fetched by the
  // first two characters and «طب» is not «طا»: a misspelling inside the prefix
  // is invisible to the fuzzy pass however generous its budget. See
  // migrations/0091.
  for (const q of ['طابعه', 'طابعات', 'طابعة', 'طبعات', 'طبعه']) {
    const got = await ids(raw, q);
    assert.ok(got.includes('p_x2d'), `${q} must reach the printers`);
    assert.ok(!got.includes('p_pla'), `${q} must not reach the filament`);
  }
});

test('«نوزلين» finds the nozzle', async () => {
  const raw = await shop();
  assert.equal(await first(raw, 'نوزلين'), 'p_nozzle');
});

test('«pla basic» and a fragment of it both find the filament', async () => {
  const raw = await shop();
  assert.equal(await first(raw, 'pla basic'), 'p_pla');
  assert.equal(await first(raw, 'pla bas'), 'p_pla', 'somebody still typing');
  assert.equal(await first(raw, 'pla basci'), 'p_pla', 'and somebody who mistyped');
});

test('«فلمنت» finds the filament through the dictionary', async () => {
  const raw = await shop();
  assert.equal(await first(raw, 'فلمنت'), 'p_pla');
});

test('«كومبو» reaches the combo, which is an OPTION name and not in the product name', async () => {
  const raw = await shop();
  const got = await ids(raw, 'كومبو');
  assert.ok(got.includes('p_x2d'));
});

test('two words beat one: "bambu x2d" puts the X2D above the A1', async () => {
  // Coverage is a multiplier, not a bonus. Without it every Bambu product
  // outranks the one the shopper actually named.
  const raw = await shop();
  const got = await ids(raw, 'bambu x2d');
  assert.equal(got[0], 'p_x2d');
});

test('a query that matches nothing returns nothing — no substring fallback', async () => {
  const raw = await shop();
  assert.deepEqual(await ids(raw, 'zzzqqq'), []);
});

// =========================================================================
// WHAT MUST NOT BE FORGIVEN
// =========================================================================

test('"abs" is not forgiven into "ams" — a wrong answer is worse than none', () => {
  // One edit apart, and they are a plastic and a filament changer. A shopper
  // shown an AMS when they searched for ABS has been misled by the shop.
  assert.equal(editBudget('abs'), 0, 'a three-letter token gets no typo budget');
  assert.equal(boundedDistance('abs', 'ams', 1), 1, 'they really are one edit apart');
});

test('the edit budget grows with the word, and the distance abandons early', () => {
  assert.equal(editBudget('pla'), 0);
  assert.equal(editBudget('bambu'), 1);
  assert.equal(editBudget('bigtreetech'), 2);
  assert.equal(boundedDistance('bambu', 'creality', 1), 2, 'beyond the budget, reported as such');
  assert.equal(boundedDistance('bambu', 'bambu', 2), 0);
});

// =========================================================================
// NORMALISATION AND ROMANISATION
// =========================================================================

test('Arabic orthography is folded: hamza, ta marbuta, alef maqsura, diacritics', () => {
  assert.equal(normalizeText('طَابِعَة'), normalizeText('طابعه'));
  assert.equal(normalizeText('أحمد'), normalizeText('احمد'));
  assert.equal(normalizeText('إسم'), normalizeText('اسم'));
  assert.equal(normalizeText('علــــى'), normalizeText('علي'), 'tatweel is decoration');
});

test('Kurdish letters fold onto their Arabic twins where the sound is the same', () => {
  // A shopper switching keyboards types ک/ی/ە; the catalogue may hold ك/ي/ه.
  assert.equal(normalizeText('کتێب'), normalizeText('كتێب'));
  assert.equal(normalizeText('چاپکەر'), normalizeText('چاپكهر'));
  // …and NOT where it is different: پ چ ژ گ ڕ are distinct sounds.
  assert.notEqual(normalizeText('چاپ'), normalizeText('جاب'));
});

test('digits are never folded — a model number is mostly digits', () => {
  assert.notEqual(normalizeText('x2d'), normalizeText('x1c'));
  assert.ok(tokenize('X2D Combo').includes('x2d'));
});

test('a mixed letter/digit run keeps the whole token and the pieces worth keeping', () => {
  // "x2d" survives whole — that is how somebody who knows the model types it.
  // Its pieces are single characters and are DROPPED: a token of one character
  // matches most of the catalogue and ranks none of it.
  const t = tokenize('X2D');
  assert.ok(t.includes('x2d'));
  assert.deepEqual(t.filter((x) => x.length < 2), [], 'single characters are debris, not tokens');
  // Where a piece is a real word, it survives and is what makes the match:
  // "PLA1.75" must be findable by "pla".
  const spool = tokenize('PLA1.75');
  assert.ok(spool.includes('pla'), 'the part a shopper actually types');
  assert.ok(spool.includes('75'));
});

test('romanisation puts «بامبو» and "bambu" within reach of each other', () => {
  const ar = romanize(normalizeText('بامبو'));
  const en = romanize('bambu');
  assert.ok(boundedDistance(ar, en, 2) <= 2, `"${ar}" vs "${en}" should be close`);
});

test('spelled-out letters collapse only when there are enough of them', () => {
  assert.deepEqual(collapseSpelledLetters(['اكس', 'تو', 'دي']), ['x2d']);
  assert.deepEqual(collapseSpelledLetters(['في', 'دي']), [], 'two ordinary Arabic words are not a model number');
  assert.deepEqual(collapseSpelledLetters(['اي', '1']), [], 'a stray digit is not a spelled letter');
});

// =========================================================================
// THE INDEX ITSELF
// =========================================================================

test('a name outweighs a description — "compatible with Bambu Lab" must not win', async () => {
  // Half an accessory catalogue says that. At an equal weight, searching
  // «بامبو» buries the Bambu printer under everything that mentions one.
  const raw = await shop();
  const got = await ids(raw, 'bambu');
  // Both Bambu PRINTERS carry the word in their name and brand and rank
  // equally — there is no reason for one to beat the other, and asserting an
  // order between them would be pinning an accident. What must be true is
  // that the filament, which only mentions Bambu in its description, is last.
  const filament = got.indexOf('p_pla');
  assert.ok(filament > 0, 'the filament must be found…');
  assert.ok(got.indexOf('p_x2d') < filament, '…and behind the product actually named');
  assert.ok(got.indexOf('p_a1') < filament);
  assert.ok(FIELD_WEIGHT.name > FIELD_WEIGHT.description * 5);
});

test('a token found in two fields keeps the higher weight, not two rows', () => {
  const rows = buildIndexRows(
    toSearchDoc({ id: 'p', name: 'Bambu', description: 'Bambu Bambu Bambu' })
  );
  const bambu = rows.filter((r) => r.token === 'bambu');
  assert.equal(bambu.length, 1);
  assert.equal(bambu[0].weight, FIELD_WEIGHT.name);
});

test('hashtags are indexed, and weighted as the real signal they are', () => {
  const rows = buildIndexRows(toSearchDoc({ id: 'p', name: 'X', hashtags: ['dual-nozzle', 'ams-2-pro'] }));
  const tokens = rows.map((r) => r.token);
  assert.ok(tokens.includes('dual'));
  assert.ok(tokens.includes('nozzle'));
  assert.ok(FIELD_WEIGHT.hashtag > FIELD_WEIGHT.category);
});

test('every indexed token is stored with its romanised skeleton beside it', () => {
  const rows = buildIndexRows(toSearchDoc({ id: 'p', name_ar: 'بامبو' }));
  const tokens = rows.map((r) => r.token);
  assert.ok(tokens.some((t) => /^[a-z0-9]+$/.test(t)), 'an Arabic name must leave a Latin skeleton behind');
});

// =========================================================================
// THE DICTIONARY
// =========================================================================

test('the seed normalises without two spellings claiming different meanings', () => {
  // The function throws on a conflict; calling it IS the test.
  const rows = normalizedSynonymSeed();
  assert.ok(rows.length > 50, 'the shop’s vocabulary is seeded');
  assert.ok(rows.length < SYNONYM_SEED.length + 1);
  for (const r of rows) {
    assert.equal(r.term, normalizeText(r.term), 'terms are stored normalised');
    assert.notEqual(r.term, r.canonical, 'a term that means itself is not a synonym');
  }
});

test('the owner can extend the dictionary without a deploy', async () => {
  const raw = await shop();
  assert.deepEqual(await ids(raw, 'ماكنه'), [], 'an unknown word finds nothing');
  raw.prepare("INSERT INTO search_synonyms (term, canonical, owner_added) VALUES ('ماكنه','printer',1)").run();
  assert.ok((await ids(raw, 'ماكنه')).includes('p_x2d'), 'and a word they add finds what they meant');
});

test('a re-seed never overwrites a meaning the owner set', () => {
  const raw = freshDb();
  raw.prepare("UPDATE search_synonyms SET canonical = 'something-else', owner_added = 1 WHERE term = 'طابعه'").run();
  // The migration's INSERT OR IGNORE, run again.
  raw.prepare("INSERT OR IGNORE INTO search_synonyms (term, canonical, owner_added) VALUES ('طابعه','printer',0)").run();
  const row = raw.prepare("SELECT canonical, owner_added FROM search_synonyms WHERE term = 'طابعه'").get() as {
    canonical: string;
    owner_added: number;
  };
  assert.equal(row.canonical, 'something-else');
  assert.equal(row.owner_added, 1);
});

// =========================================================================
// THE INDEX STAYS IN STEP WITH THE CATALOGUE
// =========================================================================

test('re-indexing a product REPLACES its rows — a renamed product loses its old name', async () => {
  const raw = await shop();
  const db = asD1(raw);
  assert.ok((await ids(raw, 'snapmaker')).includes('p_u1'));
  await db.batch(planSearchIndex(db, toSearchDoc({ id: 'p_u1', name: 'Anycubic Kobra' })));
  assert.deepEqual(await ids(raw, 'snapmaker'), [], 'the old name is gone, not merely outranked');
  assert.ok((await ids(raw, 'kobra')).includes('p_u1'));
});

test('deleting a product takes its index rows with it', async () => {
  const raw = await shop();
  raw.exec('PRAGMA foreign_keys = ON');
  raw.prepare("DELETE FROM products WHERE id = 'p_nozzle'").run();
  const left = raw.prepare("SELECT COUNT(*) AS n FROM search_tokens WHERE product_id = 'p_nozzle'").get() as {
    n: number;
  };
  assert.equal(left.n, 0, 'ON DELETE CASCADE, like every other product-scoped table');
});

// =========================================================================
// TWO WRITERS, ONE INDEX
//
// A product save writes the index rows; the cron backfill writes them for
// everything that predates migration 0089; a hashtag rename rewrites the tag
// arrays under both. Every one of those is a writer of the SAME index, and
// the moment they disagree about what a document contains, whether a product
// can be found depends on which of them happened to touch it last. These
// cases are here because two of them did disagree, and real products were
// unfindable for it.
// =========================================================================

/** One product row as the catalogue actually stores it: the option and colour
 *  names live in the JSON mirror, never in a name column. */
function seed(
  raw: Raw,
  id: string,
  name: string,
  over: { hashtags?: string[]; options?: unknown[]; colors?: unknown[] } = {}
): void {
  raw
    .prepare(
      `INSERT INTO products (id, slug, name, description, price_iqd, status, hashtags, options, colors)
         VALUES (?, ?, ?, '', 1000, 'active', ?, ?, ?)`
    )
    .run(
      id,
      id,
      name,
      JSON.stringify(over.hashtags ?? []),
      JSON.stringify(over.options ?? []),
      JSON.stringify(over.colors ?? [])
    );
}

const cron = (db: D1Database) => runDurableJobs({ DB: db } as unknown as Env);

test('the CRON BACKFILL indexes option and colour names, exactly as a save does', async () => {
  /**
   * «كومبو» is an OPTION name on this shop's products — "X2D Combo" is a
   * selection under "Bambu Lab X2D", not a product of its own — and the
   * acceptance case above pins it. The save path passed those names to the
   * document; the backfill built its own document and passed none, so every
   * product the owner had not re-saved by hand since the index shipped was
   * indexed WITHOUT the one word half of them are sold under. Both now go
   * through the same builder, which is the only thing that keeps them equal.
   */
  const raw = freshDb();
  const db = asD1(raw);
  seed(raw, 'p_x2d', 'Bambu Lab X2D 3D Printer', {
    hashtags: ['x2d', 'bambu-lab'],
    options: [{ id: 'opt_combo', name_en: 'Combo', name_ar: '', name_ckb: '' }],
    colors: [{ id: 'col_jade', name_en: 'Jade White', name_ar: '', name_ckb: '' }],
  });

  const report = await cron(db);
  assert.deepEqual(report.errors, [], 'the backfill step ran clean');
  assert.equal(report.search_indexed, 1);

  assert.deepEqual((await searchProducts(db, 'كومبو')).ids, ['p_x2d'], 'the option name, romanised');
  assert.deepEqual((await searchProducts(db, 'combo')).ids, ['p_x2d']);
  assert.deepEqual((await searchProducts(db, 'jade white')).ids, ['p_x2d'], 'and the colour name');
  // The option name is a MODEL match, not a name match: it must not outweigh
  // the product's own name, which is what the field weights are for.
  assert.equal(
    (await searchProducts(db, 'bambu')).ids[0],
    'p_x2d',
    'and none of that displaced what was already indexed'
  );
});

test('RENAMING A HASHTAG reindexes the products it rewrote, in the same batch', async () => {
  /**
   * Hashtags are weight 5 — the index's own header calls this shop's tags
   * among the best signals it has. `UPDATE products SET hashtags` on its own
   * left `search_tokens` carrying the OLD tag for ever and never taught it
   * the new one: the shop stayed findable only under a word that no longer
   * exists anywhere a shopper can see it.
   */
  const raw = freshDb();
  const db = asD1(raw);
  seed(raw, 'p_x2d', 'Bambu Lab X2D 3D Printer', { hashtags: ['x2d', 'multi-material'] });
  seed(raw, 'p_pla', 'PLA Basic Filament', { hashtags: ['pla'] });
  await cron(db);
  assert.deepEqual((await searchProducts(db, 'material')).ids, ['p_x2d'], 'the tag is indexed to begin with');

  assert.equal(await rewriteHashtag(db, 'multi-material', 'mmu'), 1);

  assert.deepEqual(
    JSON.parse(String((raw.prepare("SELECT hashtags FROM products WHERE id = 'p_x2d'").get() as { hashtags: string }).hashtags)),
    ['x2d', 'mmu'],
    'the product array is rewritten, as it always was'
  );
  assert.deepEqual((await searchProducts(db, 'material')).ids, [], 'and the old tag is GONE from the index');
  assert.deepEqual((await searchProducts(db, 'mmu')).ids, ['p_x2d'], 'and the new one is in it');
  assert.deepEqual(
    (await searchProducts(db, 'bambu')).ids,
    ['p_x2d'],
    'the rest of the document survived the rewrite — this replaces rows, it does not thin them'
  );
  assert.deepEqual((await searchProducts(db, 'pla')).ids, ['p_pla'], 'and a product the rename never touched is untouched');
});

test('DELETING A HASHTAG takes the word out of the index too', async () => {
  const raw = freshDb();
  const db = asD1(raw);
  seed(raw, 'p_a1', 'Bambu Lab A1 3D Printer', { hashtags: ['a1', 'fdm'] });
  await cron(db);
  assert.deepEqual((await searchProducts(db, 'fdm')).ids, ['p_a1']);

  assert.equal(await rewriteHashtag(db, 'fdm', null), 1);
  assert.deepEqual((await searchProducts(db, 'fdm')).ids, [], 'a tag removed everywhere is a word the index must forget');
  assert.deepEqual((await searchProducts(db, 'bambu')).ids, ['p_a1'], 'the product itself is still findable');
});

test('a hashtag rename still works on a database that has not run 0089', async () => {
  /**
   * The same window `searchIndexInstalled` exists for on the save path: one of
   * this shop's two deploy paths ships a Worker without applying migrations.
   * An admin who cannot rename a tag because of a search index they never
   * asked about is the failure being prevented; the backfill cron indexes the
   * product as soon as the table lands.
   */
  const raw = dbThrough('0088');
  const db = asD1(raw);
  seed(raw, 'p_x2d', 'Bambu Lab X2D 3D Printer', { hashtags: ['x2d', 'multi-material'] });

  assert.equal(await rewriteHashtag(db, 'multi-material', 'mmu'), 1);
  assert.deepEqual(
    JSON.parse(String((raw.prepare("SELECT hashtags FROM products WHERE id = 'p_x2d'").get() as { hashtags: string }).hashtags)),
    ['x2d', 'mmu']
  );
});

// =========================================================================
// A DEPLOY THAT LANDS BEFORE ITS MIGRATION
// =========================================================================

test('without the index table, search falls back to the old substring scan', async () => {
  /**
   * THE ONE PLACE A FALLBACK IS RIGHT. Everywhere else in this file an
   * unmatched query returns nothing, deliberately. But a Worker carrying this
   * code can reach production before migration 0089 has been applied — that
   * has happened on this shop before, and it took the whole first screen down
   * — and answering "no results" for EVERY search on a live shop is worse
   * than the substring scan it replaces.
   *
   * A missing TABLE is the sanctioned degrade in worker/lib/membershipBenefits.ts,
   * and it is honest here for the same reason: a table that does not exist
   * holds no postings, so there is genuinely nothing to read.
   */
  const { productRoutes } = await import('../worker/routes/products');
  const { APEX, ctx, json, stubApp } = await import('./fixtures/app');
  const raw = await shop();
  raw.exec('DROP TABLE search_tokens');

  const db = asD1(raw);
  const a = stubApp(db as never, null, (x) => x.route('/api/products', productRoutes), {
    host: APEX,
    env: { DB: db, INITIAL_ADMIN_EMAIL: 'b@x.co', EXTRA_ALLOWED_ORIGINS: '' },
  });
  const res = await a.request('/api/products?search=Bambu', { headers: { 'CF-Connecting-IP': '1.2.3.4' } }, undefined, ctx);
  assert.equal(res.status, 200, 'a missing index must not 500 the listing');
  const body = await json(res);
  const got = (body.products as { id: string }[]).map((p) => p.id);
  assert.ok(got.includes('p_x2d'), 'the old LIKE scan still finds what it always found');
});

test('an index that exists but is EMPTY also falls back — the backfill window', async () => {
  /**
   * Migration 0089 creates the tables; the rows arrive through the cron
   * backfill, fifty products at a time. Between the deploy and the backfill
   * catching up the index is empty, and answering "no results" for every
   * search on a live shop would be worse than the substring scan this replaces.
   * The probe that tells those two apart only runs when a query found no
   * candidates, so it costs nothing once the index exists.
   */
  const { productRoutes } = await import('../worker/routes/products');
  const { APEX, ctx, json, stubApp } = await import('./fixtures/app');
  const raw = await shop();
  raw.exec('DELETE FROM search_tokens');

  const empty = await searchProducts(asD1(raw), 'bambu');
  assert.equal(empty.indexReady, false, 'an empty index is "cannot answer", not "no match"');

  const db = asD1(raw);
  const a = stubApp(db as never, null, (x) => x.route('/api/products', productRoutes), {
    host: APEX,
    env: { DB: db, INITIAL_ADMIN_EMAIL: 'b@x.co', EXTRA_ALLOWED_ORIGINS: '' },
  });
  const body = await json(
    await a.request('/api/products?search=Bambu', { headers: { 'CF-Connecting-IP': '1.2.3.4' } }, undefined, ctx)
  );
  assert.ok((body.products as { id: string }[]).some((p) => p.id === 'p_x2d'), 'the shop is still searchable meanwhile');
});

test('a BUILT index reporting no match is a real answer, not a fallback', async () => {
  const raw = await shop();
  const got = await searchProducts(asD1(raw), 'zzzqqq');
  assert.equal(got.indexReady, true);
  assert.deepEqual(got.ids, []);
});
