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
 * is tried the same way: a stage is completed only by leaving it.
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
  const db = freshDb();
  db.exec('PRAGMA foreign_keys = OFF');
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
  const db = freshDb();
  db.exec('PRAGMA foreign_keys = OFF');
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
  const db = freshDb();
  db.exec('PRAGMA foreign_keys = OFF');
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
  const db = freshDb();
  db.exec('PRAGMA foreign_keys = OFF');
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

test('a stage is completed only by leaving it', () => {
  const db = freshDb();
  db.exec('PRAGMA foreign_keys = OFF');
  const setLcs = (from: From, lcs: Stage, state?: State) =>
    inSavepoint(db, () => {
      seed(db, 'running', from);
      try {
        db.prepare(`UPDATE catalog_import_items SET last_completed_stage = ?${state ? ', processing_state = ?' : ''} WHERE id = 'it'`).run(...((state ? [lcs, state] : [lcs]) as never[]));
        return null;
      } catch (e) {
        return String((e as Error).message);
      }
    });
  for (const from of situations()) {
    for (const lcs of STAGES) {
      if (lcs === from.lcs) continue;
      const why = setLcs(from, lcs);
      // Without a state change, the only way to complete a stage is the stage the item is in.
      const expected = lcs !== '' && lcs === from.state;
      assert.equal(why === null, expected, `${from.state}(lcs=${from.lcs || '∅'}) set lcs=${lcs || '∅'}: ${why}`);
      if (!expected) assert.equal(why, 'IMPORT_ILLEGAL_TRANSITION');
    }
  }
  assert.equal(setLcs({ state: 'BLOCKED', lcs: 'EXTRACTING' }, 'WRITING'), 'IMPORT_ILLEGAL_TRANSITION', 'a BLOCKED item cannot claim stages');
});
