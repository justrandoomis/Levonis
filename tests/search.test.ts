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
import { MEASURE_UNITS, normalizeSearchText, normalizeText, tokenize } from '../worker/lib/search/normalize';
import { collapseSpelledLetters, romanize } from '../worker/lib/search/translit';
import { bestMatches, boundedDistance, candidatePrefix, editBudget, isMeasureToken } from '../worker/lib/search/match';
import { buildIndexRows, expandQuery, FIELD_WEIGHT, resolveTokens, strongProducts } from '../worker/lib/search/index';
import { toSearchDoc } from '../worker/lib/search/document';
import {
  INDEX_ROWS_PER_STATEMENT,
  INDEX_STAMP,
  planSearchIndex,
  planSearchIndexRows,
  searchDocColumns,
  searchDocsForRows,
  searchProducts,
} from '../worker/lib/search/store';
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
  // "PLA1.75" must be findable by "pla" — and by its diameter, WHOLE (`#doc:6`):
  // «1.75» used to survive only as `75`, which «2.75» and «75 mm» shared.
  const spool = tokenize('PLA1.75');
  assert.ok(spool.includes('pla'), 'the part a shopper actually types');
  assert.ok(spool.includes('1.75'), 'the diameter, as one token');
  assert.ok(!spool.includes('75'), 'and not the fragment it used to leave behind');
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

test('THE PRE-FIX CRON’S OWN ROWS ARE REPAIRED — «كومبو» comes back without a re-save', async () => {
  /**
   * THE SYMPTOM THE OWNER REPORTED, AS PRODUCTION ACTUALLY HAS IT. Making the
   * backfill and the save share one document builder fixes the NEXT product
   * indexed. Production is not next: the pre-fix cron already ran, so every
   * active product carries thin rows built WITHOUT `variantNames`, and the
   * backfill's old predicate — "has no rows in search_tokens" — excluded
   * precisely that population. The suite was green because a fresh fixture
   * database has no tokens at all, which proves the fix for new products and
   * says nothing about the broken ones.
   *
   * So this test does what the earlier one could not: it writes the rows the
   * OLD builder wrote, then runs the real cron and demands the repair. The
   * stamp is what makes it possible — see INDEX_STAMP in
   * worker/lib/search/store.ts.
   */
  const raw = freshDb();
  const db = asD1(raw);
  seed(raw, 'p_x2d', 'Bambu Lab X2D 3D Printer', {
    hashtags: ['x2d'],
    options: [{ id: 'opt_combo', name_en: 'Combo', name_ar: 'كومبو', name_ckb: '' }],
    colors: [{ id: 'col_jade', name_en: 'Jade White', name_ar: '', name_ckb: '' }],
  });

  // EXACTLY the document the shipped-and-broken cron composed: the same
  // builder, minus the option and colour names.
  await db.batch(
    planSearchIndex(
      db,
      toSearchDoc({
        id: 'p_x2d',
        name: 'Bambu Lab X2D 3D Printer',
        description: '',
        hashtags: ['x2d'],
        brandName: null,
        categoryNames: [],
      })
    )
  );
  // ...and strip the stamp, because the builder that wrote those rows did not
  // have one. Without this the test would be seeding today's index, not the
  // one sitting in production.
  raw.prepare('DELETE FROM search_tokens WHERE token = ?').run(INDEX_STAMP);

  assert.deepEqual((await searchProducts(db, 'كومبو')).ids, [], 'pre-condition: the shipped bug');
  assert.deepEqual((await searchProducts(db, 'bambu')).ids, ['p_x2d'], 'and it IS indexed, thinly');

  const report = await cron(db);
  assert.deepEqual(report.errors, []);
  assert.equal(report.search_indexed, 1, 'the cron must NOT skip a product it indexed thinly');

  assert.deepEqual((await searchProducts(db, 'كومبو')).ids, ['p_x2d'], 'the option name, repaired');
  assert.deepEqual((await searchProducts(db, 'combo')).ids, ['p_x2d']);
  assert.deepEqual((await searchProducts(db, 'jade white')).ids, ['p_x2d']);

  // And it converges: a second run has nothing left to do, so a shop that is
  // caught up does not rewrite its whole catalogue every cron tick.
  const second = await cron(db);
  assert.deepEqual(second.errors, []);
  assert.equal(second.search_indexed, 0, 'a stamped catalogue is done');
});

test('the index STAMP is unreachable from the search side', async () => {
  /**
   * The stamp is a row in the same table the shopper's query scans, so the one
   * thing it must never do is turn up as a result. `normalizeText` drops
   * everything that is not a letter or a digit, so no typed query can produce
   * a token beginning with '#' and no prefix range built from those tokens
   * can reach one — '#' sorts below every digit and letter a range starts at.
   */
  const raw = await shop();
  const db = asD1(raw);
  const stamped = raw.prepare('SELECT COUNT(*) n FROM search_tokens WHERE token = ?').get(INDEX_STAMP) as {
    n: number;
  };
  assert.ok(stamped.n > 0, 'the fixture is stamped, so this test is asking a real question');
  // The stamp's only letters and digits survive normalisation; the '#' that
  // makes it unreachable does not, so no typed query can spell it.
  assert.equal(normalizeText(INDEX_STAMP), `doc ${INDEX_STAMP.slice('#doc:'.length)}`, 'a query can never carry the stamp’s own shape');
  assert.ok(INDEX_STAMP < '0', 'and it sorts below every range a query token can open');
  // A one-letter query opens the widest range there is, and still never
  // reaches it: the stamp is not a word anybody's letter can complete.
  assert.ok(!(await searchProducts(db, 'd')).understood.includes(INDEX_STAMP), 'a letter never completes to the stamp');
  for (const q of [INDEX_STAMP, '#', '#doc', 'doc:3', 'doc:4', '\u0000doc:2']) {
    const got = await searchProducts(db, q);
    assert.deepEqual(got.ids, [], `«${JSON.stringify(q)}» must match nothing through the stamp`);
  }
});

test('the brand/section name lookup stays under D1’s 100-parameter refusal', async () => {
  /**
   * D1 REFUSES A STATEMENT WITH MORE THAN 100 BOUND PARAMETERS — the rule
   * worker/lib/financeReport.ts §7 writes down and four other call sites chunk
   * at 90 for. `searchDocsForRows` bound its id list TWICE, once per side of a
   * UNION, and both of its callers hand it fifty products: the cron backfill
   * and, since the tag rewrite started reindexing, `rewriteHashtag`. Fifty
   * products with their own brand and two sections is 150 distinct ids and
   * therefore 300 bound parameters — three times the limit.
   *
   * THE SUITE CANNOT SEE THIS BY RUNNING IT: node:sqlite allows 32766 bound
   * parameters, so the green test and the production 500 are perfectly
   * compatible. The only way to pin it is to COUNT what gets bound, which is
   * what this does.
   */
  const raw = freshDb();
  const db = asD1(raw);
  const rows: Record<string, unknown>[] = [];
  for (let i = 0; i < 50; i++) {
    const n = String(i).padStart(3, '0');
    raw.prepare('INSERT INTO brands (id, slug, name_ar, name_en) VALUES (?,?,?,?)').run(`brd_${n}`, `b${n}`, 'ب', `Brand ${n}`);
    raw.prepare('INSERT INTO catalogs (id, slug, name_ar, name_en) VALUES (?,?,?,?)').run(`cat_a${n}`, `a${n}`, 'ق', `Cat ${n}`);
    raw.prepare('INSERT INTO catalogs (id, slug, name_ar, name_en) VALUES (?,?,?,?)').run(`cat_b${n}`, `s${n}`, 'ق', `Sub ${n}`);
    rows.push({
      id: `p_${n}`,
      name: `Printer ${n}`,
      name_ar: '',
      name_ku: '',
      description: '',
      hashtags: '[]',
      sku: '',
      brand_id: `brd_${n}`,
      category_id: `cat_a${n}`,
      sub_category_id: `cat_b${n}`,
      options: '[]',
      colors: '[]',
    });
  }

  // Every statement passes through; each `bind` is counted. A statement sent unbound (the search-alias
  // loader's presence probe, worker/lib/catalogKnowledge.ts) binds nothing and passes as it is.
  const bindCounts: number[] = [];
  const counting = {
    prepare(sql: string) {
      const st = db.prepare(sql);
      return new Proxy(st, {
        get(target, prop) {
          if (prop === 'bind') {
            return (...args: unknown[]) => {
              bindCounts.push(args.length);
              return target.bind(...args);
            };
          }
          const value = Reflect.get(target, prop, target) as unknown;
          return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
        },
      });
    },
  } as unknown as D1Database;

  const docs = await searchDocsForRows(counting, rows);
  assert.equal(docs.length, 50);
  assert.ok(bindCounts.length > 0, 'the lookup really ran');
  const worst = Math.max(...bindCounts);
  assert.ok(worst <= 90, `no statement may bind more than 90 parameters; the worst bound ${worst}`);
  // The alias read (worker/lib/search/aliases.ts) is a UNION too: its numbered parameters serve both
  // halves, so fifty products bind fifty values, once.
  assert.ok(bindCounts.includes(50), 'the alias read bound its fifty product ids once');
  // And the names still reach the documents, chunked or not.
  assert.ok(docs[49].fields.brand?.includes('Brand 049'), 'the last chunk is not dropped');
  assert.ok(docs[49].fields.category?.includes('Sub 049'));
});

test('RENAMING A HASHTAG across a wide catalogue does not exceed the parameter limit', async () => {
  /**
   * The same refusal, reached the way an admin reaches it: 120 products
   * carrying one tag, each with its own brand and sections, renamed through
   * `rewriteHashtag`. It chunks by PRODUCT at fifty, so before the fix the
   * name lookup inside the loop bound 300 parameters on the first chunk — and
   * it sits BEFORE `db.batch`, so the chunks already processed had committed
   * their UPDATE while the throwing one and every later one had not. A
   * half-applied rename, which is exactly what the same-batch design exists to
   * prevent.
   */
  const raw = freshDb();
  const db = asD1(raw);
  for (let i = 0; i < 120; i++) {
    const n = String(i).padStart(3, '0');
    raw.prepare('INSERT INTO brands (id, slug, name_ar, name_en) VALUES (?,?,?,?)').run(`brd_${n}`, `b${n}`, 'ب', `Brand ${n}`);
    raw.prepare('INSERT INTO catalogs (id, slug, name_ar, name_en) VALUES (?,?,?,?)').run(`cat_a${n}`, `a${n}`, 'ق', `Cat ${n}`);
    raw.prepare('INSERT INTO catalogs (id, slug, name_ar, name_en) VALUES (?,?,?,?)').run(`cat_b${n}`, `s${n}`, 'ق', `Sub ${n}`);
    raw
      .prepare(
        `INSERT INTO products (id, slug, name, description, price_iqd, status, hashtags,
           brand_id, category_id, sub_category_id, options, colors)
         VALUES (?,?,?,'',1000,'active',?,?,?,?,'[]','[]')`
      )
      .run(`p_${n}`, `p_${n}`, `Printer ${n}`, '["multi-material"]', `brd_${n}`, `cat_a${n}`, `cat_b${n}`);
  }

  const moved = await rewriteHashtag(db, 'multi-material', 'multi-mat');
  assert.equal(moved, 120, 'every product carrying the tag is rewritten');
  const left = raw.prepare(`SELECT COUNT(*) n FROM products WHERE hashtags LIKE '%multi-material%'`).get() as {
    n: number;
  };
  assert.equal(left.n, 0, 'no half-applied rename: not one product keeps the old tag');
  assert.equal(
    (await searchProducts(db, 'multi-mat', { limit: 200 })).ids.length,
    120,
    'and the index learned the new tag'
  );
});

test('an exact code reaches EVERY product that carries it; a code nobody carries is nobody’s — never a one-edit neighbour', async () => {
  // The live «10100» answer (2026-10-17) was the second line, not a short-circuit: no product's index held 10100
  // (the PLA Basic merge had stored none of its codes), so the typo tolerance offered PLA Basic Gradient's own
  // «10900». Once a product carries the code, the exact hit ends the search — every carrier, and no neighbour.
  const build = async (withCarriers: boolean) => {
    const raw = freshDb();
    const db = asD1(raw);
    const add = async (id: string, name: string, over: Partial<Parameters<typeof toSearchDoc>[0]>) => {
      raw.prepare(`INSERT INTO products (id, slug, name, description, price_iqd, status) VALUES (?, ?, ?, '', 1000, 'active')`).run(id, id, name);
      await db.batch(planSearchIndex(db, toSearchDoc({ id, name, ...over })));
    };
    await add('p_gradient', 'Bambu Lab PLA Basic Gradient Filament', { variantNames: ['Arctic Whisper (10900)', 'Solar Breeze (10901)'] });
    if (withCarriers) {
      await add('p_basic', 'Bambu Lab PLA Basic Filament 1kg', { aliases: ['10100', 'A00-W1-1.75-1000-SPLFREE'] });
      await add('p_trial', 'Bambu Lab PLA Basic Colour Trial Set', { aliases: ['10100'] });
    }
    return raw;
  };
  const shopWith = await build(true);
  assert.deepEqual((await ids(shopWith, '10100')).sort(), ['p_basic', 'p_trial'], 'both carriers, and not the Gradient');
  assert.deepEqual(await ids(shopWith, '10100 '), (await ids(shopWith, '10100')), 'a finished word answers the same');
  assert.deepEqual(await ids(shopWith, '10900'), ['p_gradient'], 'the Gradient keeps its own code');
  assert.equal((await ids(shopWith, 'A00-W1-1.75-1000-SPLFREE'))[0], 'p_basic');
  const shopWithout = await build(false);
  // This line used to read ['p_gradient']: the typo tolerance answered an unknown code with its neighbour 10900,
  // which is how the live «10102» came back as the 10100/10101 colours (docs/SEARCH.md §5). A code is right or absent.
  assert.deepEqual(await ids(shopWithout, '10100'), [], 'no carrier: no answer, not a neighbour’s colour');
  assert.deepEqual(await ids(shopWithout, '10100 '), [], 'finished or not');
  assert.deepEqual(await ids(shopWithout, '1090'), ['p_gradient'], 'a code still being typed is completed — while it is typed');
  assert.deepEqual(await ids(shopWithout, '1090 '), [], 'and a finished one is not');
});


// =========================================================================
// MEASURES, DIGITS AND A QUERY'S GRAMMAR (docs/SEARCH.md §4a–§5; the assistant’s acceptance rows 1–4 and 13)
// =========================================================================
//
// The live search could not tell 0.2 from 0.4 or 6×2 from 6×3: '.' and '×'
// were separators, a token needed two characters, so «0.4» tokenised to
// nothing and «nozzle 0.4» answered with every nozzle and wiper. And a code
// one edit from another (10102 / 10101) was "close enough". Each row below
// pins what MUST match and what must NOT.

/** Nozzles in three sizes, a kit that sells all three, magnets in three sizes, ABS and an AMS, two diameters. */
async function measureShop(): Promise<Raw> {
  const raw = freshDb();
  const db = asD1(raw);
  const add = async (id: string, name: string, over: Partial<Parameters<typeof toSearchDoc>[0]> = {}) => {
    raw.prepare(`INSERT INTO products (id, slug, name, description, price_iqd, status) VALUES (?, ?, ?, '', 1000, 'active')`).run(id, id, name);
    await db.batch(planSearchIndex(db, toSearchDoc({ id, name, ...over })));
  };
  for (const size of ['0.2', '0.4', '0.6']) {
    await add(`p_noz${size.replace('.', '')}`, `Hardened Steel Nozzle ${size}mm`, {
      name_ar: `نوزل فولاذ مقوى ${size} ملم`,
      hashtags: ['nozzle'],
    });
  }
  await add('p_nozkit', 'Nozzle Kit', { name_ar: 'طقم نوزلات', variantNames: ['0.2mm', '0.4mm', '0.6mm'], hashtags: ['nozzle'] });
  await add('p_wiper', 'Nozzle Wiper', { name_ar: 'ماسحة نوزل', hashtags: ['nozzle'] });
  await add('p_mag62', 'Neodymium Magnet 6×2 mm', { name_ar: 'مغناطيس 6×2' });
  await add('p_mag63', 'Neodymium Magnet 6x3 mm', { name_ar: 'مغناطيس 6x3' });
  await add('p_mag620', 'Neodymium Magnet 6x20 mm', { name_ar: 'مغناطيس 6x20' });
  await add('p_abs', 'ABS Filament', { hashtags: ['abs'] });
  await add('p_ams', 'AMS 2 Pro', { hashtags: ['ams'] });
  await add('p_pla175', 'PLA Basic 1.75mm', { hashtags: ['pla'] });
  await add('p_pla285', 'PLA Basic 2.85mm', { hashtags: ['pla'] });
  await add('p_basic', 'Bambu Lab PLA Basic Filament 1kg', { aliases: ['10100', '10101'] });
  return raw;
}

test('row 1: «نوزل 0.4», «nozzle 0.4mm», «نوزل ٠.٤» — the 0.4 nozzle and the kit that sells one; never a 0.2 or 0.6', async () => {
  const raw = await measureShop();
  for (const q of ['نوزل 0.4', 'nozzle 0.4mm', 'نوزل ٠.٤', 'نوزل ۰٫۴ ملم', 'Nozzle 0.40 mm', 'nozzle .4']) {
    const got = await ids(raw, q);
    assert.deepEqual([...got].sort(), ['p_noz04', 'p_nozkit'], `${q}: ${got.join(' ')}`);
    assert.equal(got[0], 'p_noz04', `${q}: the nozzle NAMED 0.4 first`);
  }
});

test('row 2: bare «0.2» finds the 0.2 items and nothing else; a size nobody sells is an honest none', async () => {
  const raw = await measureShop();
  assert.deepEqual((await ids(raw, '0.2')).sort(), ['p_noz02', 'p_nozkit']);
  assert.deepEqual((await ids(raw, '0.2 ')).sort(), ['p_noz02', 'p_nozkit'], 'finished or still typed');
  assert.deepEqual(await ids(raw, '0.3'), [], 'no 0.3 is sold: nothing, not the nearest size');
  assert.deepEqual(await ids(raw, 'nozzle 0.3'), [], 'and not every nozzle because the word "nozzle" matched');
});

test('row 3: «مغناطيس 6×2», «6*2», «6 x 2», «٦x٢» — only the 6×2 magnet; never the 6×3, never the 6×20', async () => {
  const raw = await measureShop();
  for (const q of ['مغناطيس 6×2', '6*2', '6 x 2', '٦x٢', '6x2', 'magnet 6X2mm', '6.0×2']) {
    assert.deepEqual(await ids(raw, q), ['p_mag62'], q);
  }
  assert.deepEqual(await ids(raw, '6x3'), ['p_mag63']);
  assert.deepEqual(await ids(raw, '6x4'), [], 'one edit from 6x3 is a different magnet, not a typo');
});

test('row 4: «ABS» and «AMS» each find their own and never the other', async () => {
  const raw = await measureShop();
  assert.deepEqual(await ids(raw, 'ABS'), ['p_abs']);
  assert.deepEqual(await ids(raw, 'AMS'), ['p_ams']);
  assert.deepEqual(await ids(raw, 'abs '), ['p_abs']);
  assert.deepEqual(await ids(raw, 'ams '), ['p_ams']);
});

test('row 13: «1.75» and «2.85» each find that diameter only', async () => {
  const raw = await measureShop();
  assert.deepEqual(await ids(raw, '1.75'), ['p_pla175']);
  assert.deepEqual(await ids(raw, '2.85'), ['p_pla285']);
  assert.deepEqual(await ids(raw, 'pla 1.75mm'), ['p_pla175']);
  assert.deepEqual(await ids(raw, 'PLA ١٫٧٥'), ['p_pla175'], 'Arabic-Indic digits and the Arabic decimal separator');
});

test('an unknown colour code is nobody’s; a known one is its carrier’s — never a one-edit neighbour', async () => {
  const raw = await measureShop();
  assert.deepEqual(await ids(raw, '10101'), ['p_basic']);
  assert.deepEqual(await ids(raw, '10102'), [], '10102 is not 10101 or 10100');
  assert.deepEqual(await ids(raw, '10102 '), []);
  assert.deepEqual(await ids(raw, '١٠١٠١'), ['p_basic'], 'typed on an Arabic keyboard');
});

test('the measure pass: canonical tokens, the unit kept as a word, no fragments, folded digits', () => {
  assert.deepEqual(tokenize('Nozzle 0.4mm'), ['0.4', 'nozzle', 'mm']);
  for (const typed of ['6×2', '6x2', '6*2', '6 x 2', '٦x٢', '۶×۲', '6.0 × 2.00']) assert.deepEqual(tokenize(typed), ['6x2'], typed);
  assert.deepEqual(tokenize('20×20×2mm'), ['20x20x2', '20x20', 'mm'], 'a three-part size carries its footprint');
  assert.deepEqual(tokenize('0.40'), ['0.4']);
  assert.deepEqual(tokenize('.4mm'), ['0.4', 'mm']);
  assert.deepEqual(tokenize('2.0mm'), ['2mm', 'mm'], '«2.0» is the number 2, an ordinary word again');
  assert.deepEqual(tokenize('m3x8'), ['m3x8'], 'a dimension glued to a word stays the word it was');
  assert.equal(normalizeSearchText('٠١٢٣٤٥٦٧٨٩ ۰۱۲۳۴۵۶۷۸۹'), '0123456789 0123456789');
  assert.deepEqual(tokenize('PLA ١٧٥ ۲۸۵'), ['pla', '175', '285'], 'the index and the query fold them alike');
  assert.ok(isMeasureToken('0.4') && isMeasureToken('6x2') && isMeasureToken('1.75') && isMeasureToken('20x20x2'));
  assert.ok(!isMeasureToken('x2d') && !isMeasureToken('10101') && !isMeasureToken('a1'));
  for (const unit of MEASURE_UNITS) assert.equal(normalizeText(unit), unit, `${unit}: units are written folded`);
});

test('a code or a size gets no typo budget; a size is completed only while typed and only when nobody carries it whole', () => {
  assert.equal(editBudget('10102'), 0);
  assert.equal(editBudget('x1c'), 0);
  assert.equal(editBudget('a00w1'), 0);
  assert.equal(editBudget('hardened'), 2, 'a word keeps its budget');
  const e = expandQuery('magnet 6x2', new Map());
  assert.deepEqual([...(e.measures ?? [])], ['6x2']);
  assert.ok(e.completing.has('6x2'), 'the size ending the query may still be being typed');
  assert.ok(!expandQuery('magnet 6x2 ', new Map()).completing.has('6x2'), 'a space finished it');
  assert.ok(!expandQuery('magnet 6x2mm', new Map()).completing.has('6x2'), 'a unit after it finished it');
  assert.ok(!expandQuery('6x2 magnet', new Map()).completing.has('6x2'), 'a word after it finished it');
  // Carried whole: the 6×2 alone, never the 6×20 it is a prefix of, typing or not.
  const sizes = ['6x2', '6x20', '6x3', '1.75', '1.7x2', 'pla'];
  assert.deepEqual(bestMatches('6x2', sizes, 5, { complete: true }).map((m) => m.token), ['6x2']);
  // Nobody's size yet, still typed: the SIZES it begins.
  assert.deepEqual(bestMatches('1.7', sizes, 5, { complete: true }).map((m) => m.token).sort(), ['1.75', '1.7x2']);
  // Finished: that size or nothing; never a neighbour one edit away.
  assert.deepEqual(bestMatches('1.7', sizes, 5, { complete: false }), []);
  assert.deepEqual(bestMatches('6x4', sizes, 5, { complete: true }), []);
});

// -------------------------------------------------------------------------
// Sizes written the other ways a catalogue writes them (review of 1.3/1.4)
// -------------------------------------------------------------------------

/** measureShop, plus the spellings the live catalogue uses: a mark or a word glued on, a decimal comma, a build volume. */
async function writtenSizesShop(): Promise<Raw> {
  const raw = await measureShop();
  const db = asD1(raw);
  const add = async (id: string, name: string, over: Partial<Parameters<typeof toSearchDoc>[0]> = {}) => {
    raw.prepare(`INSERT INTO products (id, slug, name, description, price_iqd, status) VALUES (?, ?, ?, '', 1000, 'active')`).run(id, id, name);
    await db.batch(planSearchIndex(db, toSearchDoc({ id, name, ...over })));
  };
  await add('p_o62', 'Neodymium Magnet Ø6×2mm');
  await add('p_o63', 'Neodymium Magnet Ø6×3mm');
  await add('p_ar62', 'مغناطيس6×2');
  // The live Bambu Lab magnet: no size in its name, both sizes in its OPTION names, written with a D.
  await add('p_round', 'Bambu Lab Round Magnet', { name_ar: 'مغناطيس دائري Bambu Lab', variantNames: ['D6×2 مم', 'D6x2 mm', 'D6×3 مم', 'D6x3 mm'] });
  await add('p_sunlu', 'Sunlu PLA 1,75mm 1kg');
  await add('p_noz04c', 'Brass Nozzle 0,4 mm', { hashtags: ['nozzle'] });
  await add('p_x1c', 'X1 Carbon', { description: 'Build volume 256×256×256 mm' });
  await add('p_plate', 'PEI Plate 256x256');
  await add('p_ext', 'Aluminium Extrusion 20x20x2');
  await add('p_screw', 'M3x8 Screw');
  return raw;
}

test('a size glued to a diameter mark, a D or an Arabic word is still the size; glued to a Latin word it is not', async () => {
  assert.deepEqual(tokenize('Neodymium Magnet Ø6×2mm'), ['6x2', 'neodymium', 'magnet', 'mm']);
  assert.deepEqual(tokenize('مغناطيس6×2'), ['6x2', 'مغناطيس']);
  for (const typed of ['D6x2', 'D6×2 مم', 'Φ6x2', '⌀6x2', 'ø6*2']) assert.ok(tokenize(typed).includes('6x2'), typed);
  assert.deepEqual(tokenize('M3x8 screw'), ['m3x8', 'screw'], 'an M3 screw stays the word it is');
  assert.ok(!tokenize('AD6x2').includes('6x2'), 'a D inside a Latin word is the word');

  const raw = await writtenSizesShop();
  for (const q of ['magnet 6x2', 'مغناطيس 6×2', 'مغناطيس6×2', 'D6x2', 'Ø6×2', '6x2 ']) {
    const got = await ids(raw, q);
    for (const must of ['p_o62', 'p_round']) assert.ok(got.includes(must), `${q} → ${must}: ${got.join(' ')}`);
    for (const never of ['p_o63', 'p_mag63', 'p_mag620']) assert.ok(!got.includes(never), `${q} must not list ${never}: ${got.join(' ')}`);
  }
  assert.ok((await ids(raw, 'مغناطيس 6×2')).includes('p_ar62'), 'the Arabic name written without a space');
  // The round magnet sells both sizes, so 6×3 finds it too — and not the 6×2-only magnets.
  const six3 = await ids(raw, 'مغناطيس 6x3');
  assert.ok(six3.includes('p_round') && six3.includes('p_o63'), six3.join(' '));
  assert.ok(!six3.includes('p_o62') && !six3.includes('p_ar62'), six3.join(' '));
  assert.deepEqual(await ids(raw, 'm3x8'), ['p_screw']);
});

test('a decimal comma is a decimal point: «0,4», «٠،٤», «1,75mm» (rows 1 and 13 in that spelling)', async () => {
  assert.deepEqual(tokenize('nozzle 0,4'), ['0.4', 'nozzle']);
  assert.deepEqual(tokenize('نوزل ٠،٤'), ['0.4', 'نوزل']);
  assert.ok(tokenize('Sunlu PLA 1,75mm 1kg').includes('1.75'));
  assert.deepEqual(tokenize('27,000'), ['27', '000'], 'three digits after a comma: a thousands separator');
  assert.deepEqual(tokenize('0.2,0.4'), ['0.2', '0.4'], 'a list stays a list');
  assert.deepEqual(tokenize('10100,10101'), ['10100', '10101']);

  const raw = await writtenSizesShop();
  for (const q of ['nozzle 0,4', 'نوزل 0,4', 'نوزل ٠،٤', 'nozzle 0.4']) {
    const got = await ids(raw, q);
    for (const must of ['p_noz04', 'p_noz04c', 'p_nozkit']) assert.ok(got.includes(must), `${q} → ${must}: ${got.join(' ')}`);
    for (const never of ['p_noz02', 'p_noz06', 'p_wiper']) assert.ok(!got.includes(never), `${q} must not list ${never}`);
  }
  for (const q of ['pla 1,75', 'PLA 1.75', '1.75']) {
    const got = await ids(raw, q);
    assert.deepEqual([...got].sort(), ['p_pla175', 'p_sunlu'], `${q}: ${got.join(' ')}`);
  }
});

test('a build volume answers its footprint: «256x256» finds the printer and the plate, «256x256x256» the printer alone', async () => {
  const raw = await writtenSizesShop();
  for (const q of ['256x256', '256×256', '256 x 256']) assert.deepEqual((await ids(raw, q)).sort(), ['p_plate', 'p_x1c'], q);
  assert.deepEqual(await ids(raw, '256x256x256'), ['p_x1c'], 'all three parts asked for');
  assert.deepEqual(await ids(raw, '20x20'), ['p_ext']);
  assert.deepEqual(await ids(raw, '20x20x2'), ['p_ext']);
  const e = expandQuery('256x256x256', new Map());
  assert.deepEqual(e.literal, ['256x256x256'], 'the footprint is not a second word of the query');
  assert.deepEqual([...(e.measures ?? [])], ['256x256x256']);
});

test('a size still being typed lists what it is on its way to; finished, it is that size or nothing', async () => {
  const raw = await measureShop();
  const typed = async (q: string) => (await searchProducts(asD1(raw), q, { completeLast: true })).ids;
  const done = async (q: string) => (await searchProducts(asD1(raw), q, { completeLast: false })).ids;
  assert.deepEqual(await typed('PLA 1.7'), ['p_pla175'], 'on the way to 1.75');
  assert.deepEqual(await done('PLA 1.7'), [], 'nobody sells 1.7');
  assert.deepEqual(await typed('PLA 2.8'), ['p_pla285']);
  // Carried whole, it is not completed: «6x2» is the 6×2 magnet, not the 6×20 as well.
  assert.deepEqual(await typed('6x2'), ['p_mag62']);
  assert.deepEqual(await typed('0.3'), [], 'nothing begins with 0.3 either');
});

test('a size is required only of products indexed with sizes: older rows rank after, never vanish (the catch-up window)', async () => {
  const raw = await measureShop();
  const db = asD1(raw);
  // Three nozzles still on rows an older builder wrote: «0.4mm» was `4mm`, «0.2mm» `2mm`; no measure tokens.
  for (const [id, frag] of [['o_04', '4mm'], ['o_02', '2mm'], ['o_06', '6mm']] as const) {
    raw.prepare(`INSERT INTO products (id, slug, name, description, price_iqd, status) VALUES (?, ?, ?, '', 1000, 'active')`).run(id, id, `Old Nozzle ${frag}`);
    await db.batch(planSearchIndexRows(db, id, ['old', 'nozzle', frag, 'mm'].map((token) => ({ product_id: id, token, weight: 10 }))));
    raw.prepare("UPDATE search_tokens SET token = '#doc:5' WHERE product_id = ? AND token = ?").run(id, INDEX_STAMP);
  }
  const got = await ids(raw, 'nozzle 0.4 ');
  // Indexed with sizes: the 0.4 nozzle and the kit, first. Its 0.2 and 0.6 neighbours: ruled out.
  assert.deepEqual(got.slice(0, 2), ['p_noz04', 'p_nozkit'], got.join(' '));
  for (const never of ['p_noz02', 'p_noz06', 'p_wiper']) assert.ok(!got.includes(never), `${never}: ${got.join(' ')}`);
  // Not yet rewritten: kept on their other words, after.
  assert.deepEqual(got.slice(2).sort(), ['o_02', 'o_04', 'o_06']);
  // Once the catch-up has rewritten them, they answer like everybody else.
  for (const id of ['o_04', 'o_02', 'o_06']) {
    const size = { o_04: '0.4', o_02: '0.2', o_06: '0.6' }[id];
    await db.batch(planSearchIndex(db, toSearchDoc({ id, name: `Old Nozzle ${size}mm` })));
  }
  assert.deepEqual((await ids(raw, 'nozzle 0.4 ')).sort(), ['o_04', 'p_noz04', 'p_nozkit']);
});

test('a finished model fragment still reaches its model — no typo budget, but `x2d` is what `x2` begins', async () => {
  const raw = await shop();
  assert.equal(await first(raw, 'bambu x2 combo'), 'p_x2d');
  assert.equal(await first(raw, 'x2 '), 'p_x2d');
  assert.deepEqual(await ids(raw, 'x3d'), [], 'one edit from x2d is another model, not a typo');
});

test('a query’s grammar is not what it is about: stopwords and a measure’s unit are not looked up', () => {
  const syn = new Map<string, string>([['نوزل', 'nozzle'], ['قطع غيار', 'spare']]);
  assert.deepEqual(expandQuery('nozzle for the x1c', syn).literal, ['nozzle', 'x1c']);
  assert.deepEqual(expandQuery('نوزل في الطابعة', syn).literal, ['نوزل', 'الطابعه']);
  assert.deepEqual(expandQuery('نۆزڵ بۆ X1C', syn).literal, ['نۆزڵ', 'x1c'], 'Sorani «بۆ» is "for"');
  assert.deepEqual(expandQuery('nozzle 0.4 mm', syn).literal, ['0.4', 'nozzle'], 'the unit is said by the measure');
  assert.deepEqual(expandQuery('mm', syn).literal, ['mm'], 'a unit on its own is a word');
  assert.deepEqual(expandQuery('في', syn).literal, ['في'], 'a query of nothing but grammar stays itself');
  assert.ok(expandQuery('بي في سي', syn).lookup.includes('bvc'), 'a spelled run keeps its middle letter');
  assert.ok(expandQuery('قطع غيار', syn).lookup.includes('spare'), 'a phrase on its own words');
  assert.ok(!expandQuery('مقطع غيارات', syn).lookup.includes('spare'), 'and not inside longer words');
});

test('the Arabic article does not open the whole «ال» shelf', () => {
  assert.equal(candidatePrefix('الطابعه'), 'الط');
  assert.equal(candidatePrefix('والطابعه'), 'والط');
  assert.equal(candidatePrefix('طابعه'), 'طا');
  assert.equal(candidatePrefix('ال'), 'ا', 'a short word keeps the one-letter, weight-first range');
});

test('the document carries every language: Arabic and Sorani descriptions, brand and section names, variant SKUs', () => {
  const rows = buildIndexRows(
    toSearchDoc({
      id: 'p',
      name: 'Hotend',
      description: 'Fits the printer.',
      description_ar: 'مقاوم للحرارة',
      description_ku: 'بۆ چاپکردن',
      brandNames: ['Bambu Lab', 'بامبو لاب', 'بامبو لاب'],
      categoryNames: ['Spare Parts', 'قطع غيار', 'پارچە یەدەگ'],
      variantSkus: ['HE-X1-04'],
    })
  );
  const weightOf = (t: string) => rows.find((r) => r.token === normalizeText(t))?.weight;
  assert.equal(weightOf('مقاوم'), FIELD_WEIGHT.description, 'the Arabic description, at prose weight');
  assert.equal(weightOf('چاپکردن'), FIELD_WEIGHT.description, 'the Sorani description');
  assert.equal(weightOf('بامبو'), FIELD_WEIGHT.brand, 'the brand in Arabic');
  assert.equal(weightOf('پارچە'), FIELD_WEIGHT.category, 'the section in Sorani');
  assert.equal(weightOf('he'), FIELD_WEIGHT.model, 'a variant SKU, at the option names’ weight');
  assert.equal(weightOf('04'), FIELD_WEIGHT.model);
  // No skeleton for prose: an Arabic description word does not become a Latin key.
  assert.ok(!rows.some((r) => r.token === romanize(normalizeText('مقاوم'))), 'prose carries no skeleton');
  assert.ok(rows.some((r) => r.token === romanize(normalizeText('بامبو'))), 'a name still does');
});

test('a product is a few statements, not one a token: its DELETE and one INSERT per 500 rows, the stamp in the last', async () => {
  const raw = freshDb();
  const db = asD1(raw);
  raw.prepare(`INSERT INTO products (id, slug, name, description, price_iqd, status) VALUES ('p_long', 'p_long', 'Long', '', 1000, 'active')`).run();
  const words = Array.from({ length: INDEX_ROWS_PER_STATEMENT + 20 }, (_, i) => `wo${i.toString(36).padStart(4, 'a')}`).join(' ');
  const doc = toSearchDoc({ id: 'p_long', name: 'Long', description: words });
  const stmts = planSearchIndex(db, doc);
  assert.equal(stmts.length, 1 + Math.ceil((buildIndexRows(doc).length + 1) / INDEX_ROWS_PER_STATEMENT));
  assert.equal(stmts.length, 3);
  await db.batch(stmts);
  const n = (raw.prepare("SELECT COUNT(*) AS n FROM search_tokens WHERE product_id = 'p_long'").get() as { n: number }).n;
  assert.equal(n, buildIndexRows(doc).length + 1, 'every row and the stamp');
  assert.deepEqual(await ids(raw, 'wo00a9'), ['p_long']);
});

test('the backfill reads every language of a name and the variant SKUs, with no statement of its own for them', async () => {
  const raw = freshDb();
  raw.prepare("INSERT INTO brands (id, slug, name_ar, name_en, name_ckb) VALUES ('brd_b','b','بامبو لاب','Bambu Lab','بامبۆ لاب')").run();
  raw.prepare("INSERT INTO catalogs (id, slug, name_ar, name_en, name_ckb) VALUES ('cat_n','n','نوزلات','Nozzles','نۆزڵەکان')").run();
  raw
    .prepare(
      `INSERT INTO products (id, slug, name, description, description_ar, description_ku, price_iqd, status, brand_id, category_id)
       VALUES ('p_n', 'p_n', 'Hardened Nozzle', 'Tough.', 'مقاوم للتآكل', 'بەرگەگرە', 1000, 'active', 'brd_b', 'cat_n')`
    )
    .run();
  raw.prepare("INSERT INTO product_variants (id, product_id, combo_key, sku, active) VALUES ('v1', 'p_n', 'k1', 'HN-04-QX', 1), ('v2', 'p_n', 'k2', 'HN-02-ZZ', 0)").run();
  await runDurableJobs({ DB: asD1(raw) } as unknown as Env);
  const rows = raw.prepare(`SELECT ${searchDocColumns()} FROM products WHERE id = 'p_n'`).all() as Record<string, unknown>[];
  assert.deepEqual(JSON.parse(String(rows[0].variant_skus)), ['HN-04-QX'], 'the active variant’s SKU, by the selection itself');
  for (const [q, why] of [
    ['بامبۆ', 'the brand in Sorani'],
    ['نۆزڵەکان', 'the section in Sorani'],
    ['nozzles', 'the section in English'],
    ['للتاكل', 'the Arabic description'],
    ['بەرگەگرە', 'the Sorani description'],
    ['qx', 'an active variant’s SKU'],
  ] as const) {
    assert.deepEqual(await ids(raw, q), ['p_n'], `${q}: ${why}`);
  }
  assert.deepEqual(await ids(raw, 'zz'), [], 'an inactive variant’s SKU is not a way in');
});

test('strongProducts: every typed word, reached without a forgiven typo', () => {
  const vocabulary = ['riser', 'base', 'antenna', 'wifi', 'oker'];
  const rows = [
    { product_id: 'riser', token: 'riser', weight: 10 },
    { product_id: 'riser', token: 'base', weight: 10 },
    { product_id: 'antenna', token: 'antenna', weight: 10 },
    { product_id: 'antenna', token: 'wifi', weight: 10 },
    { product_id: 'oker', token: 'oker', weight: 10 },
  ];
  const strong = (q: string) => {
    const expanded = expandQuery(`${q} `, new Map(), { completeLast: false });
    return [...strongProducts(expanded, resolveTokens(expanded, vocabulary), rows)].sort();
  };
  assert.deepEqual(strong('riser base'), ['riser'], 'both words, exact');
  assert.deepEqual(strong('ris bas'), ['riser'], 'completions count');
  assert.deepEqual(strong('riser lamp'), [], 'one word of two is not a strong match');
  assert.deepEqual(strong('okey'), [], 'a forgiven typo is not a strong match');
  assert.deepEqual(strong('wifi'), ['antenna']);
});

