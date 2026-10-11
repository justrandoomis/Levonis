import test from 'node:test';
import assert from 'node:assert/strict';
import { changedSources, emptySource, rowKey, saveSourceChunks, sourceFields, type SourceDrafts, type SourceProgress, type SourceView } from '../src/components/adminOrders/preorderOriginDrafts';

function fixture(qty: number) {
  const view: SourceView = { installed: true, editable: true, historical: false, rows: Array.from({ length: qty }, (_, index) => ({
    ...emptySource(), id: null, order_item_id: 'item-a1', unit_index: index + 1, product_name: 'A1 Combo', selection: 'Combo', version: 0,
  })) };
  const drafts: SourceDrafts = Object.fromEntries(view.rows.map((row) => [rowKey(row), { ...sourceFields(row), supplier_order_no: ` SUP-${row.unit_index} ` }]));
  return { view, drafts };
}

test('preorder supplier saves above 500 units use bounded requests and retain each completed version', async () => {
  const { view, drafts } = fixture(1201);
  const server = structuredClone(view);
  const sizes: number[] = [], progress: SourceProgress[] = [];
  await saveSourceChunks(view, drafts, async ({ units }) => {
    sizes.push(units.length);
    for (const update of units) {
      const row = server.rows[update.unit_index - 1];
      assert.equal(update.version, row.version);
      Object.assign(row, update, { version: row.version + 1, id: `source-${row.unit_index}` });
    }
    return structuredClone(server);
  }, (saved) => { progress.push(saved); });
  assert.deepEqual(sizes, [500, 500, 201]);
  assert.deepEqual(progress.map((saved) => changedSources(saved.view, saved.drafts).length), [701, 201, 0]);
  const done = progress.at(-1)!;
  assert.equal(done.completed, 1201);
  assert.equal(done.total, 1201);
  assert.ok(done.view.rows.every((row) => row.version === 1));
  assert.equal(done.drafts['item-a1:1201'].supplier_order_no, 'SUP-1201');
});

test('a failed later chunk preserves unsaved drafts and their stale versions for safe retry', async () => {
  const { view, drafts } = fixture(501);
  let calls = 0;
  const progress: SourceProgress[] = [];
  await assert.rejects(saveSourceChunks(view, drafts, async ({ units }) => {
    calls++;
    if (calls === 2) {
      assert.equal(units[0].version, 0, 'a fresh version from an unrelated chunk must not authorize overwriting another admin');
      throw new Error('Version conflict');
    }
    const latest = structuredClone(view);
    for (const update of units) Object.assign(latest.rows[update.unit_index - 1], update, { version: 1 });
    Object.assign(latest.rows[500], { supplier_order_no: 'OTHER-ADMIN-SUPPLIER', version: 8 });
    return latest;
  }, (saved) => { progress.push(saved); }), /Version conflict/);
  assert.equal(progress.length, 1);
  const partial = progress[0];
  assert.equal(partial.completed, 500);
  assert.equal(partial.view.rows[0].version, 1);
  assert.equal(partial.view.rows[500].version, 0);
  assert.equal(partial.drafts['item-a1:501'].supplier_order_no, ' SUP-501 ');
  assert.deepEqual(changedSources(partial.view, partial.drafts).map((row) => row.unit_index), [501]);
  await assert.rejects(saveSourceChunks(partial.view, partial.drafts, async ({ units }) => {
    assert.equal(units.length, 1, 'a retry must not resend the 500 committed units');
    assert.equal(units[0].version, 0, 'the remaining conflict must still be surfaced');
    throw new Error('Version conflict');
  }, () => assert.fail('Failed retries must not discard the draft')), /Version conflict/);
});
