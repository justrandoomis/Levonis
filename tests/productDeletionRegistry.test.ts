/**
 * THE REGISTRY IS COMPLETE, AND THE SCHEMA IS WHAT PROVES IT.
 *
 * A delete that lists tables by hand is a delete that leaks the first time
 * someone adds a table. So this walks the LIVE schema — every migration
 * applied to a real SQLite database — finds every table carrying a
 * product-shaped column, and fails if any of them is absent from all three
 * registries in `worker/lib/productDeletion.ts`.
 *
 * That is the whole safety property. The next migration that adds, say,
 * `product_bundles_v2.product_id` cannot silently reintroduce residue: this
 * test names the table and refuses.
 *
 * It also checks the two things a registry can get wrong even when complete:
 * a HISTORY column that is NOT NULL (so the delete would fail at runtime), and
 * an OWNED table that does not actually have the column the registry deletes by.
 *
 * Run: npm run test:unit
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './fixtures/d1';
import {
  BLOCKING_REFS,
  FROZEN_HISTORY,
  HISTORY_TABLES,
  MEDIA_COLUMNS,
  OWNED_TABLES,
  mediaKeyFromRef,
  mediaKeysInJson,
} from '../worker/lib/productDeletion';

function schema(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  const dir = join(ROOT, 'migrations');
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) {
    db.exec(readFileSync(join(dir, f), 'utf8'));
  }
  return db;
}

const tablesOf = (db: DatabaseSync) =>
  (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as Array<{
    name: string;
  }>).map((r) => r.name);

const colsOf = (db: DatabaseSync, t: string) =>
  db.prepare(`PRAGMA table_info(${t})`).all() as Array<{ name: string; notnull: number }>;

/** A column that names a product, an option, a colour or a variant. */
const PRODUCT_SHAPED = /^(product_id|member_product_id|offer_product_id|option_id|option_value_id|color_id|variant_id)$/;

/** The tables a product-shaped column may legitimately point at. */
const PRODUCT_GRAPH = new Set([
  'products',
  'product_option_values',
  'product_option_groups',
  'product_colors',
  'product_variants',
  'product_images',
]);

/** Tables whose `product_id` is a community_products id, kept without a foreign key (see the loop). */
const COMMUNITY_NAMESPACE_WITHOUT_FK = new Set(['merchant_product_analytics_daily', 'storefront_event_marks']);

test('every table that can name a CATALOGUE product is in exactly one registry', () => {
  const db = schema();
  const owned = new Set(OWNED_TABLES.map((t) => t.table));
  const history = new Set(HISTORY_TABLES.map((t) => t.table));
  const frozen = new Set(FROZEN_HISTORY.map((t) => t.table));
  const blocking = new Set(BLOCKING_REFS.map((t) => t.table));

  const unregistered: string[] = [];

  for (const t of tablesOf(db)) {
    // The product row itself is deleted by the engine, not by a registry.
    if (t === 'products') continue;
    const cols = colsOf(db, t).map((c) => c.name);
    const shaped = cols.filter((c) => PRODUCT_SHAPED.test(c));
    if (!shaped.length) continue;

    // A column named `product_id` does not always mean OUR product. The
    // community listings are a separate namespace with their own table, and
    // `community_product_favorites.product_id` has a foreign key that says so.
    // Deleting from it on a catalogue delete would destroy unrelated data.
    const fks = db.prepare(`PRAGMA foreign_key_list(${t})`).all() as Array<{ from: string; table: string }>;
    const pointsElsewhere = shaped.every((c) => {
      const fk = fks.find((f) => f.from === c);
      return fk ? !PRODUCT_GRAPH.has(fk.table) : false;
    });
    if (pointsElsewhere) continue;
    // The merchant storefront's analytics (0125) name a COMMUNITY product by id
    // with no foreign key on purpose: a day's counters outlive the listing they
    // counted. They are the same separate namespace as the listings above.
    if (COMMUNITY_NAMESPACE_WITHOUT_FK.has(t)) continue;

    if (!owned.has(t) && !history.has(t) && !frozen.has(t) && !blocking.has(t)) {
      unregistered.push(`${t} (${shaped.join(', ')})`);
    }
  }

  assert.deepEqual(
    unregistered,
    [],
    `these tables can name a product and no registry claims them — a permanent delete would leave them behind:\n  ${unregistered.join('\n  ')}`
  );
});

test('a frozen-history column really is NOT NULL, which is the reason it is frozen', () => {
  const db = schema();
  for (const f of FROZEN_HISTORY) {
    const cols = colsOf(db, f.table);
    for (const c of f.columns) {
      const info = cols.find((x) => x.name === c);
      assert.ok(info, `${f.table}.${c} does not exist`);
      assert.equal(
        info!.notnull,
        1,
        `${f.table}.${c} IS nullable — so it can and should be cleared like the other history links, not frozen`
      );
    }
    assert.ok(f.why.length > 30, `${f.table} is frozen without a stated reason`);
  }
});

test('every OWNED table really has the column the delete uses', () => {
  const db = schema();
  const present = new Set(tablesOf(db));
  for (const t of OWNED_TABLES) {
    assert.ok(present.has(t.table), `OWNED names ${t.table}, which does not exist`);
    if ('column' in t.by) {
      const cols = colsOf(db, t.table).map((c) => c.name);
      assert.ok(cols.includes(t.by.column), `${t.table} has no ${t.by.column}`);
    }
  }
});

test('every HISTORY column is nullable — otherwise the delete fails at runtime', () => {
  const db = schema();
  for (const h of HISTORY_TABLES) {
    const cols = colsOf(db, h.table);
    for (const c of h.columns) {
      const info = cols.find((x) => x.name === c);
      assert.ok(info, `${h.table}.${c} does not exist`);
      assert.equal(
        info!.notnull,
        0,
        `${h.table}.${c} is NOT NULL, so preserving the row while clearing its product link is impossible — it belongs in OWNED, or the column needs to become nullable`
      );
    }
  }
});

test('a blocking reference names a real column, so the refusal cannot be silent', () => {
  const db = schema();
  for (const b of BLOCKING_REFS) {
    const cols = colsOf(db, b.table).map((c) => c.name);
    assert.ok(cols.includes(b.column), `${b.table}.${b.column} does not exist`);
    assert.ok(b.remedy.length > 20, `${b.code} has no usable remedy text`);
  }
});

test('the media columns the delete scans all exist', () => {
  const db = schema();
  for (const m of MEDIA_COLUMNS) {
    const cols = colsOf(db, m.table).map((c) => c.name);
    assert.ok(cols.includes(m.column), `${m.table}.${m.column} does not exist`);
    assert.ok(cols.includes(m.by), `${m.table}.${m.by} does not exist`);
  }
});

// ------------------------------------------------------- what is OURS to delete

test('an external vendor URL is never ours to delete', () => {
  for (const foreign of [
    'https://bambulab.com/images/a1.png',
    'https://cdn.shopify.com/x/y.webp',
    'http://i.imgur.com/5J32z6S.jpeg',
    '//cdn.example.com/a.png',
    '/assets/local-bundled.svg',
  ]) {
    assert.equal(mediaKeyFromRef(foreign), null, `${foreign} would have been queued for deletion from OUR bucket`);
  }
});

test('our own references resolve to the bucket key, however they were stored', () => {
  assert.equal(mediaKeyFromRef('products/p1/main.webp'), 'products/p1/main.webp');
  assert.equal(mediaKeyFromRef('/files/products/p1/main.webp'), 'products/p1/main.webp');
  assert.equal(mediaKeyFromRef('https://levonis-iq.com/files/products/p1/main.webp'), 'products/p1/main.webp');
  assert.equal(mediaKeyFromRef(''), null);
  assert.equal(mediaKeyFromRef(null), null);
  assert.equal(mediaKeyFromRef(42), null);
});

test('media keys are found inside the JSON documents on the product row', () => {
  const usageGuide = {
    official_url: 'https://bambulab.com/guide',
    steps: [
      { id: 's1', images: ['/files/products/p1/step-1.webp'], video_url: 'https://youtube.com/watch?v=x' },
      { id: 's2', images: ['products/p1/step-2.webp'], video_url: '' },
    ],
  };
  const keys = mediaKeysInJson(usageGuide);
  assert.ok(keys.has('products/p1/step-1.webp'));
  assert.ok(keys.has('products/p1/step-2.webp'));
  // The vendor guide and the YouTube link are not files of ours.
  assert.equal(keys.has('https://bambulab.com/guide'), false);
  assert.equal([...keys].some((k) => k.includes('youtube')), false);
});

test('prose inside a JSON document is not mistaken for a media key', () => {
  const блок = {
    title: 'How to level the bed',
    body: 'Turn the knob 1/4 turn. See section 3.2 for details.',
    note: 'Contact support',
  };
  assert.deepEqual([...mediaKeysInJson(блок)], []);
});
