/**
 * THE IMPORT ITEM STATE GRAPH, EXHAUSTIVELY (Bambu import spec §B.3, §B.5).
 *
 * trg_cii_transition is the authority on how an item may move; this file is
 * its independent model. Every ordered pair of the 12 states is tried on
 * node:sqlite with every migration applied — from RETRYING and BLOCKED with
 * every value of last_completed_stage, because that is what decides where
 * they may resume — and the database must accept exactly the pairs the model
 * accepts, and refuse the rest with IMPORT_ILLEGAL_TRANSITION. With no open
 * run, every move is refused with IMPORT_RUN_NOT_OPEN. trg_cii_stage_monotonic
 * is tried the same way: a stage is completed only by leaving it FORWARD — not
 * in place, and not on the way to RETRYING or BLOCKED (review 4, finding 4).
 * trg_cii_insert keeps the graph from being bypassed by an INSERT: a row is
 * born DISCOVERED in an open run, and none is put back over an item that has
 * left DISCOVERED (review 4, finding 7).
 *
 * The graph tests seed items directly in every state, which is exactly what
 * trg_cii_insert forbids, so they drop that one trigger first (graphDb); the
 * insert trigger has its own test on an untouched schema.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { freshDb } from './fixtures/app';

const STATES = [
  'DISCOVERED', 'EXTRACTING', 'ENRICHING', 'VALIDATING', 'INGESTING_MEDIA', 'WRITING', 'PUBLISHING', 'VERIFYING_LIVE',
  'COMPLETE', 'RETRYING', 'BLOCKED', 'WITHDRAWN_AT_SOURCE',
] as const;
type State = (typeof STATES)[number];
const WORKING_STAGES = ['EXTRACTING', 'ENRICHING', 'VALIDATING', 'INGESTING_MEDIA', 'WRITING', 'PUBLISHING', 'VERIFYING_LIVE'] as const;
const WORKING: readonly State[] = WORKING_STAGES;
const STAGES = ['', ...WORKING_STAGES] as const;
type Stage = (typeof STAGES)[number];

/** The forward chain: DISCOVERED → EXTRACTING → … → VERIFYING_LIVE → COMPLETE. */
const NEXT: Partial<Record<State, State>> = {
  DISCOVERED: 'EXTRACTING', EXTRACTING: 'ENRICHING', ENRICHING: 'VALIDATING', VALIDATING: 'INGESTING_MEDIA',
  INGESTING_MEDIA: 'WRITING', WRITING: 'PUBLISHING', PUBLISHING: 'VERIFYING_LIVE', VERIFYING_LIVE: 'COMPLETE',
};
/** Where a RETRYING or BLOCKED item resumes: the stage after the last completed one. */
const RESUME: Record<Stage, State> = {
  '': 'EXTRACTING', EXTRACTING: 'ENRICHING', ENRICHING: 'VALIDATING', VALIDATING: 'INGESTING_MEDIA',
  INGESTING_MEDIA: 'WRITING', WRITING: 'PUBLISHING', PUBLISHING: 'VERIFYING_LIVE', VERIFYING_LIVE: 'COMPLETE',
};

interface From {
  state: State;
  lcs: Stage;
  blocker?: string;
}

/** The spec's graph, written independently of the trigger. */
function legal(from: From, to: State): boolean {
  if (from.state === to) return true; // not a transition: the trigger does not fire
  if (from.state === 'DISCOVERED') return to === 'EXTRACTING' && from.lcs === '';
  if (WORKING.includes(from.state)) return to === NEXT[from.state] || to === 'RETRYING' || to === 'BLOCKED';
  if (from.state === 'RETRYING') return to === 'BLOCKED' || (to === RESUME[from.lcs] && to !== 'COMPLETE');
  if (from.state === 'BLOCKED') {
    if (to === 'RETRYING') return true;
    if (to === 'WITHDRAWN_AT_SOURCE') return from.blocker === 'SOURCE_WITHDRAWN';
    return to === RESUME[from.lcs] && to !== 'COMPLETE';
  }
  if (from.state === 'COMPLETE') return to === 'DISCOVERED'; // the rollback, to the end of the queue
  return false; // WITHDRAWN_AT_SOURCE is terminal
}

const RUN = 'cir_0123456789abcdef01234567';

/** Columns a row in `state` must carry to satisfy the item CHECKs. */
function companions(state: State, blocker = 'NETWORK'): Record<string, string> {
  switch (state) {
    case 'COMPLETE':
      return { levonis_product_id: 'p_1', live_url: 'https://levonis-iq.com/product/x', verified_at: 't', d1_checks: '{"ok":true}', edge_evidence: '{"ok":true}' };
    case 'BLOCKED':
      return { blocker_code: blocker, resume_instruction: 'dispatch workflow 60 mode=run resume=true' };
    case 'WITHDRAWN_AT_SOURCE':
      return { blocker_code: 'SOURCE_WITHDRAWN', withdrawn_evidence: '{"fetches":2}', withdrawn_by: 'row 241' };
    default:
      return {};
  }
}

function seed(db: DatabaseSync, runState: string, from: From): void {
  db.prepare('INSERT INTO catalog_import_runs (id, source, state) VALUES (?, ?, ?)').run(RUN, 'bambu_us', runState);
  // Two earlier items already COMPLETE, so a rollback has a queue end to go past.
  for (const [id, pos] of [['done1', 1], ['done2', 2]] as const) {
    const c = companions('COMPLETE');
    db.prepare(
      `INSERT INTO catalog_import_items (id, run_id, source, source_product_id, handle, canonical_url, queue_position, discovered_at,
         processing_state, last_completed_stage, levonis_product_id, live_url, verified_at, d1_checks, edge_evidence)
       VALUES (?, ?, 'bambu_us', ?, ?, 'u', ?, 't', 'COMPLETE', 'VERIFYING_LIVE', ?, ?, ?, ?, ?)`
    ).run(id, RUN, id, id, pos, c.levonis_product_id, c.live_url, c.verified_at, c.d1_checks, c.edge_evidence);
  }
  // A not-yet-processed item further down the queue: the end of the queue is past it too.
  db.prepare(
    `INSERT INTO catalog_import_items (id, run_id, source, source_product_id, handle, canonical_url, queue_position, discovered_at)
     VALUES ('later', ?, 'bambu_us', 'later', 'later', 'u', 4, 't')`
  ).run(RUN);
  const c = companions(from.state, from.blocker);
  const cols = ['id', 'run_id', 'source', 'source_product_id', 'handle', 'canonical_url', 'queue_position', 'discovered_at', 'processing_state', 'last_completed_stage', ...Object.keys(c)];
  const vals = ['it', RUN, 'bambu_us', 'it', 'it', 'u', 3, 't', from.state, from.lcs, ...Object.values(c)];
  db.prepare(`INSERT INTO catalog_import_items (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(...(vals as never[]));
}

/** The UPDATE a correct executor would issue for this move. */
function move(db: DatabaseSync, from: From, to: State): string | null {
  const set: Record<string, unknown> = { processing_state: to, ...companions(to) };
  if (WORKING.includes(from.state) && to === NEXT[from.state]) set.last_completed_stage = from.state; // leaving a stage completes it
  if (from.state === 'COMPLETE' && to === 'DISCOVERED') {
    Object.assign(set, { last_completed_stage: '', levonis_product_id: '', live_url: '', verified_at: '', d1_checks: '{}', edge_evidence: '{}', queue_position: 99 });
  }
  const names = Object.keys(set);
  try {
    db.prepare(`UPDATE catalog_import_items SET ${names.map((n) => `${n} = ?`).join(', ')} WHERE id = 'it'`).run(...(names.map((n) => set[n]) as never[]));
    return null;
  } catch (e) {
    return String((e as Error).message);
  }
}

/** Every from-situation: working states with the lcs a real item would have, RETRYING/BLOCKED with every lcs. */
function situations(): From[] {
  const out: From[] = [];
  out.push({ state: 'DISCOVERED', lcs: '' });
  WORKING.forEach((s, i) => out.push({ state: s, lcs: STAGES[i] }));
  out.push({ state: 'COMPLETE', lcs: 'VERIFYING_LIVE' });
  for (const lcs of STAGES) {
    out.push({ state: 'RETRYING', lcs });
    out.push({ state: 'BLOCKED', lcs });
  }
  out.push({ state: 'BLOCKED', lcs: 'ENRICHING', blocker: 'SOURCE_WITHDRAWN' });
  out.push({ state: 'WITHDRAWN_AT_SOURCE', lcs: 'EXTRACTING', blocker: 'SOURCE_WITHDRAWN' });
  return out;
}

/** A schema whose INSERT guard is lifted so items can be seeded in any state; every UPDATE trigger stays. */
function graphDb(): DatabaseSync {
  const db = freshDb();
  db.exec('PRAGMA foreign_keys = OFF');
  db.exec('DROP TRIGGER IF EXISTS trg_cii_insert');
  return db;
}

function inSavepoint<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('SAVEPOINT pair');
  try {
    return fn();
  } finally {
    db.exec('ROLLBACK TO pair');
    db.exec('RELEASE pair');
  }
}

test('every pair of the 12 states, with an open run: exactly the legal graph passes', () => {
  const db = graphDb();
  const covered = new Set<string>();
  const mismatches: string[] = [];
  let pairs = 0;
  for (const from of situations()) {
    for (const to of STATES) {
      if (from.state === to) continue;
      pairs++;
      covered.add(`${from.state}>${to}`);
      const why = inSavepoint(db, () => {
        seed(db, 'running', from);
        return move(db, from, to);
      });
      const expected = legal(from, to);
      const accepted = why === null;
      if (accepted !== expected) mismatches.push(`${from.state}(lcs=${from.lcs || '∅'}${from.blocker ? `,${from.blocker}` : ''}) → ${to}: db ${accepted ? 'accepted' : `refused (${why})`}, model ${expected ? 'legal' : 'illegal'}`);
      if (!accepted && !expected) assert.equal(why, 'IMPORT_ILLEGAL_TRANSITION', `${from.state} → ${to} refused for the wrong reason`);
    }
  }
  assert.deepEqual(mismatches, []);
  assert.equal(covered.size, 12 * 11, 'all 132 ordered pairs of distinct states were tried');
  assert.ok(pairs > 132);
});

test('the legal moves really happen, and a few named ones are refused', () => {
  const db = graphDb();
  const tryMove = (from: From, to: State) => inSavepoint(db, () => (seed(db, 'running', from), move(db, from, to)));
  assert.equal(tryMove({ state: 'DISCOVERED', lcs: '' }, 'EXTRACTING'), null);
  assert.equal(tryMove({ state: 'EXTRACTING', lcs: '' }, 'VALIDATING'), 'IMPORT_ILLEGAL_TRANSITION', 'a skipped stage');
  assert.equal(tryMove({ state: 'BLOCKED', lcs: 'EXTRACTING' }, 'DISCOVERED'), 'IMPORT_ILLEGAL_TRANSITION', 'BLOCKED never returns to DISCOVERED');
  assert.equal(tryMove({ state: 'BLOCKED', lcs: 'PUBLISHING' }, 'COMPLETE'), 'IMPORT_ILLEGAL_TRANSITION', 'BLOCKED never jumps to COMPLETE');
  assert.equal(tryMove({ state: 'BLOCKED', lcs: 'EXTRACTING' }, 'VERIFYING_LIVE'), 'IMPORT_ILLEGAL_TRANSITION', 'BLOCKED never skips ahead');
  assert.equal(tryMove({ state: 'BLOCKED', lcs: 'EXTRACTING' }, 'ENRICHING'), null, 'BLOCKED resumes at the stage after the last completed');
  assert.equal(tryMove({ state: 'BLOCKED', lcs: 'ENRICHING' }, 'WITHDRAWN_AT_SOURCE'), 'IMPORT_ILLEGAL_TRANSITION', 'only a SOURCE_WITHDRAWN block can be withdrawn');
  assert.equal(tryMove({ state: 'WITHDRAWN_AT_SOURCE', lcs: 'EXTRACTING', blocker: 'SOURCE_WITHDRAWN' }, 'COMPLETE'), 'IMPORT_ILLEGAL_TRANSITION', 'withdrawn is terminal');
});

test('a rollback goes to the END of the queue only', () => {
  const db = graphDb();
  const rollback = (position: number) =>
    inSavepoint(db, () => {
      seed(db, 'running', { state: 'COMPLETE', lcs: 'VERIFYING_LIVE' });
      try {
        db.prepare(
          `UPDATE catalog_import_items SET processing_state = 'DISCOVERED', last_completed_stage = '', levonis_product_id = '',
             live_url = '', verified_at = '', d1_checks = '{}', edge_evidence = '{}', queue_position = ? WHERE id = 'it'`
        ).run(position);
        return null;
      } catch (e) {
        return String((e as Error).message);
      }
    });
  assert.equal(rollback(3), 'IMPORT_ILLEGAL_TRANSITION', 'its own old place is not the end of the queue');
  assert.equal(rollback(1), 'IMPORT_ILLEGAL_TRANSITION', 'nor is a place before another processed item');
  assert.equal(rollback(4), 'IMPORT_ILLEGAL_TRANSITION', 'nor the place of an item still waiting');
  assert.equal(rollback(5), null, 'max + 1 is');
  const keepsProduct = inSavepoint(db, () => {
    seed(db, 'running', { state: 'COMPLETE', lcs: 'VERIFYING_LIVE' });
    try {
      db.exec(`UPDATE catalog_import_items SET processing_state = 'DISCOVERED', last_completed_stage = '', queue_position = 9 WHERE id = 'it'`);
      return null;
    } catch (e) {
      return String((e as Error).message);
    }
  });
  assert.equal(keepsProduct, 'IMPORT_ILLEGAL_TRANSITION', 'a rollback must clear the product it removed');
});

test('with no open run, every move is refused with IMPORT_RUN_NOT_OPEN', () => {
  const db = graphDb();
  const refusedForOtherReasons: string[] = [];
  for (const runState of ['closed', 'partial']) {
    for (const from of situations()) {
      for (const to of STATES) {
        if (from.state === to) continue;
        const why = inSavepoint(db, () => (seed(db, runState, from), move(db, from, to)));
        if (why !== 'IMPORT_RUN_NOT_OPEN') refusedForOtherReasons.push(`${runState}: ${from.state} → ${to}: ${why}`);
      }
    }
  }
  assert.deepEqual(refusedForOtherReasons, []);
});

test('a stage is completed only by leaving it forward: never in place, never on the way to RETRYING or BLOCKED', () => {
  const db = graphDb();
  const update = (from: From, lcs: Stage, to: State | null) =>
    inSavepoint(db, () => {
      seed(db, 'running', from);
      const set: Record<string, unknown> = { last_completed_stage: lcs };
      if (to !== null) Object.assign(set, { processing_state: to }, companions(to));
      if (from.state === 'COMPLETE' && to === 'DISCOVERED') {
        Object.assign(set, { levonis_product_id: '', live_url: '', verified_at: '', d1_checks: '{}', edge_evidence: '{}', queue_position: 99 });
      }
      const names = Object.keys(set);
      try {
        db.prepare(`UPDATE catalog_import_items SET ${names.map((n) => `${n} = ?`).join(', ')} WHERE id = 'it'`).run(...(names.map((n) => set[n]) as never[]));
        return null;
      } catch (e) {
        return String((e as Error).message);
      }
    });
  const mismatches: string[] = [];
  let tried = 0;
  for (const from of situations()) {
    for (const lcs of STAGES) {
      if (lcs === from.lcs) continue;
      for (const to of [null, ...STATES] as Array<State | null>) {
        tried++;
        const moves = to !== null && to !== from.state;
        // The model: last_completed_stage changes only together with the forward edge out of that very stage,
        // or back to '' with the rollback of a COMPLETE item.
        const expected =
          moves &&
          legal(from, to) &&
          ((lcs !== '' && lcs === from.state && to === NEXT[from.state]) || (from.state === 'COMPLETE' && to === 'DISCOVERED' && lcs === ''));
        const why = update(from, lcs, to);
        if ((why === null) !== expected) {
          mismatches.push(`${from.state}(lcs=${from.lcs || '∅'}) → ${to ?? '(same)'} with lcs=${lcs || '∅'}: db ${why === null ? 'accepted' : `refused (${why})`}`);
        } else if (why !== null) {
          assert.equal(why, 'IMPORT_ILLEGAL_TRANSITION', `${from.state} → ${to} lcs=${lcs}`);
        }
      }
    }
  }
  assert.deepEqual(mismatches, []);
  assert.ok(tried > 2000);
  // The two moves review 4 named.
  assert.equal(update({ state: 'WRITING', lcs: 'INGESTING_MEDIA' }, 'WRITING', 'RETRYING'), 'IMPORT_ILLEGAL_TRANSITION', 'a failing write is not a completed one');
  assert.equal(update({ state: 'WRITING', lcs: 'INGESTING_MEDIA' }, 'WRITING', null), 'IMPORT_ILLEGAL_TRANSITION', 'nor is a write marked complete in place');
  assert.equal(update({ state: 'VERIFYING_LIVE', lcs: 'PUBLISHING' }, 'VERIFYING_LIVE', 'RETRYING'), 'IMPORT_ILLEGAL_TRANSITION', 'a stage nothing can resume after');
  assert.equal(update({ state: 'BLOCKED', lcs: 'EXTRACTING' }, 'WRITING', null), 'IMPORT_ILLEGAL_TRANSITION', 'a BLOCKED item cannot claim stages');
  assert.equal(update({ state: 'WRITING', lcs: 'INGESTING_MEDIA' }, 'WRITING', 'PUBLISHING'), null, 'the write completes by moving on to PUBLISHING (§A.5 n-1)');
});

test('an item is born DISCOVERED in an open run, and no INSERT puts one back over an item that has left DISCOVERED', () => {
  const db = freshDb();
  db.exec('PRAGMA foreign_keys = OFF');
  db.prepare('INSERT INTO catalog_import_runs (id, source, state) VALUES (?, ?, ?)').run(RUN, 'bambu_us', 'running');
  const CLOSED = 'cir_76543210fedcba9876543210';
  db.prepare('INSERT INTO catalog_import_runs (id, source, state) VALUES (?, ?, ?)').run(CLOSED, 'bambu_us', 'closed');
  const insert = (verb: string, cols: Record<string, unknown>, tail = '') => {
    const row = { run_id: RUN, source: 'bambu_us', canonical_url: 'u', discovered_at: 't', ...cols };
    const names = Object.keys(row);
    try {
      db.prepare(`${verb} INTO catalog_import_items (${names.join(', ')}) VALUES (${names.map(() => '?').join(', ')})${tail}`)
        .run(...(Object.values(row) as never[]));
      return null;
    } catch (e) {
      return String((e as Error).message);
    }
  };
  const item = (id: string, pos: number, extra: Record<string, unknown> = {}) => ({ id, source_product_id: id, handle: id, queue_position: pos, ...extra });
  const state = (id: string) => (db.prepare('SELECT processing_state AS s, last_completed_stage AS l FROM catalog_import_items WHERE id = ?').get(id) as { s: string; l: string } | undefined);

  assert.equal(insert('INSERT', item('a', 1)), null, 'a new item, DISCOVERED, in an open run');
  assert.equal(insert('INSERT', item('b', 2, { processing_state: 'WRITING' })), 'IMPORT_ILLEGAL_TRANSITION', 'born in the middle of the graph');
  assert.equal(insert('INSERT', item('c', 3, { processing_state: 'COMPLETE', last_completed_stage: 'VERIFYING_LIVE', levonis_product_id: 'p', live_url: 'l', verified_at: 'v', d1_checks: '{"a":1}', edge_evidence: '{"a":1}' })), 'IMPORT_ILLEGAL_TRANSITION', 'born COMPLETE');
  assert.equal(insert('INSERT', item('d', 4, { last_completed_stage: 'WRITING' })), 'IMPORT_ILLEGAL_TRANSITION', 'born with a completed stage');
  assert.equal(insert('INSERT', item('e', 5, { run_id: CLOSED })), 'IMPORT_RUN_NOT_OPEN', 'into a closed run');
  assert.equal(insert('INSERT', item('f', 6, { run_id: CLOSED, processing_state: 'WRITING' })), 'IMPORT_RUN_NOT_OPEN', 'into a closed run, mid-graph');

  // /manifest's upsert (§A.3): a re-sent row of an item still DISCOVERED updates its discovery fields.
  const manifest = (id: string, pos: number, breadcrumbs: string) =>
    insert('INSERT', item(id, pos, { breadcrumbs }), ' ON CONFLICT (run_id, source, source_product_id) DO UPDATE SET breadcrumbs = excluded.breadcrumbs WHERE catalog_import_items.processing_state = \'DISCOVERED\'');
  assert.equal(manifest('a', 1, 'Printers'), null);
  assert.equal(insert('INSERT OR REPLACE', item('a', 1)), null, 'a REPLACE of an item that never left DISCOVERED changes nothing the graph knows');

  db.exec("UPDATE catalog_import_items SET processing_state = 'EXTRACTING' WHERE id = 'a'");
  db.exec("UPDATE catalog_import_items SET processing_state = 'ENRICHING', last_completed_stage = 'EXTRACTING' WHERE id = 'a'");
  assert.equal(insert('INSERT OR REPLACE', item('a', 1)), 'IMPORT_ILLEGAL_TRANSITION', 'a REPLACE back to DISCOVERED');
  assert.equal(
    insert('INSERT OR REPLACE', item('a', 1, { processing_state: 'COMPLETE', last_completed_stage: 'VERIFYING_LIVE', levonis_product_id: 'p', live_url: 'l', verified_at: 'v', d1_checks: '{"a":1}', edge_evidence: '{"a":1}' })),
    'IMPORT_ILLEGAL_TRANSITION',
    'a REPLACE straight to COMPLETE'
  );
  assert.equal(insert('INSERT OR REPLACE', item('a2', 9, { source_product_id: 'a' })), 'IMPORT_ILLEGAL_TRANSITION', 'a REPLACE through the source key, under another id');
  assert.equal(insert('INSERT OR REPLACE', item('a3', 1, { source_product_id: 'a3' })), 'IMPORT_ILLEGAL_TRANSITION', 'a REPLACE through the queue position');
  assert.equal(manifest('a', 1, 'Other'), 'IMPORT_ILLEGAL_TRANSITION', 'a manifest row is re-sent only while its item is new or DISCOVERED');
  assert.deepEqual({ ...state('a') }, { s: 'ENRICHING', l: 'EXTRACTING' }, 'and the item is where the graph left it');
  // The freed in-flight slot the review found: a second item still cannot start.
  assert.equal(insert('INSERT', item('g', 7)), null);
  assert.match(String((() => { try { db.exec("UPDATE catalog_import_items SET processing_state = 'EXTRACTING' WHERE id = 'g'"); return null; } catch (e) { return (e as Error).message; } })()), /UNIQUE/);
});
