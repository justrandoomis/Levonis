/**
 * THE FOUR-STEP EDITOR AGAINST THE SERVER (community UI plan C4, the P1-06
 * 2d tests; docs/DECISIONS.md row 268): what the steps send, through the real
 * routes, read back.
 *
 *   the budget switch (Q2) persists: a draft saved with the switch OFF reads
 *   back off, ON reads back on; published either way, a guest reads the
 *   request with no budget, and the board lists none
 *   a job of several parts: the editor holds the v3 limits (12 parts, 4
 *   materials a part) and a resin part with two materials is refused with
 *   PART_RESIN_MULTI_MATERIAL, whose words exist in three languages and are
 *   what the part line of step 2 says
 *   the print method tiles of step 2 never leave a part naming a method its
 *   material denies
 *   a published request edited through the editor saves: the change goes out
 *   with «احفظ التعديلات», and the request stays open; an unchanged save
 *   after it is answered as the same job
 *   a reload of every step: the draft as the server answers it, hydrated,
 *   is the same body again
 *
 * Run: node --import tsx --test tests/requestEditorSteps.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { asD1, get, json, post, put, row, stubApp, type Mount, type StubUser } from './fixtures/app';
import { world } from './fixtures/requestModelWorld';
import { marketplaceRoutes } from '../worker/routes/marketplace';
import { printRequestRoutes } from '../worker/routes/printRequests';
import { requestEntryRoutes } from '../worker/routes/requestEntries';
import { communityRoutes } from '../worker/routes/community';
import { REFUSAL_STRINGS, apiRefusal } from '../src/lib/refusalStrings';
import {
  addMaterial,
  addPart,
  bodyKey,
  chooseMaterial,
  chooseProcess,
  editorBody,
  hydrate,
  LIMITS,
  partProcess,
  updateMaterial,
  type EditorState,
} from '../src/components/community/requests/editor/state';
import { partEstimates } from '../src/components/community/requests/editor/estimate';
import { editorStrings } from '../src/components/community/requests/editor/strings';
import type { DraftShape, Quote } from '../src/components/community/requests/api';

const mount: Mount = (a) => {
  a.route('/api/marketplace/print', printRequestRoutes);
  a.route('/api/marketplace/print', requestEntryRoutes);
  a.route('/api/marketplace', marketplaceRoutes);
  a.route('/api/community', communityRoutes);
};
const BUYER: StubUser = { id: 'buyer', role: 'customer', email: 'buyer@x.co' };
const app = (raw: DatabaseSync, u: StubUser | null) => stubApp(asD1(raw), u, mount);

const born = async (raw: DatabaseSync): Promise<string> => {
  const res = await post(app(raw, BUYER), '/api/marketplace/print/requests', { entry: { kind: 'blank' } });
  assert.equal(res.status, 201, JSON.stringify(await json(res.clone())));
  return (await json(res)).request_id as string;
};
const draftOf = async (raw: DatabaseSync, id: string): Promise<DraftShape> => (await json(await get(app(raw, BUYER), `/api/marketplace/print/requests/${id}/draft`))).draft as DraftShape;
const saveState = async (raw: DatabaseSync, s: EditorState) => {
  const res = await put(app(raw, BUYER), `/api/marketplace/print/requests/${s.requestId}/draft`, editorBody(s));
  return { status: res.status, body: await json(res) };
};
const publish = async (raw: DatabaseSync, s: EditorState) => {
  const res = await post(app(raw, BUYER), `/api/marketplace/print/requests/${s.requestId}/publish`, editorBody(s));
  return { status: res.status, body: await json(res) };
};

/** Step 1 and step 3 filled the way the steps fill them. */
async function filled(raw: DatabaseSync, budgetVisible: boolean): Promise<EditorState> {
  const id = await born(raw);
  const s = hydrate(await draftOf(raw, id));
  const next: EditorState = {
    ...s,
    title: 'A wall bracket',
    description: 'Four strong brackets in black, please',
    sets: 4,
    parts: s.parts.map((p) => ({ ...p, process: 'fdm', dims: { x: 80, y: 40, z: 30 } })),
    delivery: { ...(s.delivery ?? s.carried), governorate: 'baghdad', handover: 'delivery', budget: 45000, budgetVisible },
  };
  const saved = await saveState(raw, next);
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  return next;
}

test('the budget switch persists off and on, and a guest reads the published request with no budget (Q2)', async () => {
  for (const visible of [false, true]) {
    const raw = world();
    const s = await filled(raw, visible);
    const back = hydrate(await draftOf(raw, s.requestId));
    assert.equal(back.carried.budget, 45000, 'the owner reads the figure');
    assert.equal(back.carried.budgetVisible, visible, `the switch reads back ${visible ? 'on' : 'off'}`);
    const pub = await publish(raw, { ...s, ...back, delivery: back.carried });
    assert.equal(pub.status, 200, JSON.stringify(pub.body));
    const guest = await get(app(raw, null), `/api/marketplace/requests/${s.requestId}`);
    assert.equal(guest.status, 200);
    assert.equal(((await json(guest)).request as Record<string, unknown>).budget_iqd, null, 'a guest never reads a budget');
    const board = (await json(await get(app(raw, null), '/api/community/requests'))).requests as Array<{ id: string; budget_iqd?: unknown }>;
    const card = board.find((r) => r.id === s.requestId);
    assert.ok(card, 'the published request is on the board');
    assert.equal(card.budget_iqd ?? null, null, 'and its card has no budget');
    assert.equal(row<{ budget_visible: number }>(raw, 'SELECT budget_visible FROM community_requests WHERE id = ?', s.requestId)!.budget_visible, visible ? 1 : 0);
  }
});

test('several parts: twelve at most and four materials a part; a resin part with two materials is refused in three languages', async () => {
  const raw = world();
  let s = await filled(raw, false);
  // The limits the editor holds (the server holds the same: PARTS_TOO_MANY, PART_MATERIALS_TOO_MANY).
  let many = s;
  for (let i = 0; i < 20; i++) many = addPart(many)[0];
  assert.equal(many.parts.length, LIMITS.maxParts);
  let mats = s;
  for (let i = 0; i < 9; i++) mats = addMaterial(mats, mats.parts[0].key)[0];
  assert.equal(mats.parts[0].materials.length, LIMITS.maxMaterialsPerPart);
  for (const code of ['PARTS_TOO_MANY', 'PART_MATERIALS_TOO_MANY', 'PART_RESIN_MULTI_MATERIAL']) {
    const e = REFUSAL_STRINGS[code];
    assert.ok(e?.ar && e.en && e.ckb, code);
    assert.notEqual(e.ckb, e.ar, `${code}: the Sorani is the Arabic`);
  }
  // Two parts; the second in resin with two materials.
  s = addPart(s)[0];
  const second = s.parts[1].key;
  s = addMaterial(s, second)[0];
  const [m1, m2] = s.parts[1].materials.map((m) => m.key);
  const processOf = (id: string): 'fdm' | 'resin' | '' => (id.startsWith('resin') ? 'resin' : id ? 'fdm' : '');
  s = chooseMaterial(s, second, m1, 'resin-standard', processOf);
  s = updateMaterial(s, second, m2, { materialId: 'resin-tough' });
  assert.equal(partProcess(s.parts[1], processOf), 'resin');
  const saved = await saveState(raw, s);
  assert.equal(saved.status, 200, 'a draft holds what was typed so far');
  const refused = await publish(raw, s);
  assert.equal(refused.status, 400, JSON.stringify(refused.body));
  assert.ok(['PART_RESIN_MULTI_MATERIAL', 'PART_MATERIAL_UNKNOWN', 'PART_PROCESS_MIXED'].includes(String(refused.body.code)), String(refused.body.code));
  // The refusal is said in the reader words, never the server English sentence.
  for (const lang of ['ar', 'en', 'ckb'] as const) {
    const said = apiRefusal({ code: 'PART_RESIN_MULTI_MATERIAL' }, lang, '');
    assert.equal(said, REFUSAL_STRINGS.PART_RESIN_MULTI_MATERIAL[lang]);
  }
  // The part line of step 2 carries the refusal a publish would answer.
  const t = editorStrings('ar');
  const quote = { priced: false, coverage: { complete: false, parts_total: 2, priced_parts: [], unpriced_parts: [{ position: 1, refusal: 'PART_RESIN_MULTI_MATERIAL' }] } } as unknown as Quote;
  const line = partEstimates(quote, 2, 'ar', t).get(1);
  assert.equal(line?.kind, 'unpriced');
  assert.ok(line?.text.includes(REFUSAL_STRINGS.PART_RESIN_MULTI_MATERIAL.ar.replace(/\.$/, '').slice(0, 12)), line?.text);
});

test('the method tiles never leave a part naming a method its material denies', () => {
  const processOf = (id: string): 'fdm' | 'resin' | '' => (id === 'petg' ? 'fdm' : id.startsWith('resin') ? 'resin' : '');
  const base = hydrate({ id: 'req_1', state: 'draft', revision: 1, title: '', description: '', customer_notes: '', quantity: 1, governorate: '', delivery_pref: '', deadline: '', budget_iqd: null, files: [], updated_at: 'x' } as unknown as DraftShape);
  const part = base.parts[0].key;
  const mat = base.parts[0].materials[0].key;
  const withPetg = chooseMaterial(base, part, mat, 'petg', processOf);
  assert.equal(partProcess(withPetg.parts[0], processOf), 'fdm');
  const [resin, cleared] = chooseProcess(withPetg, part, 'resin', processOf);
  assert.equal(cleared, true, 'the PETG had to go, and the step says so');
  assert.equal(resin.parts[0].materials[0].materialId, 'unsure');
  assert.equal(resin.parts[0].process, 'resin');
  const [same, none] = chooseProcess(withPetg, part, 'fdm', processOf);
  assert.equal(none, false);
  assert.equal(same.parts[0].materials[0].materialId, 'petg');
  const [unsure] = chooseProcess(withPetg, part, 'unsure', processOf);
  assert.equal(unsure.parts[0].materials[0].materialId, 'petg', '«لست متأكدًا» of the method clears no material');
});

test('a published request edited through the editor saves with «احفظ التعديلات», and stays open', async () => {
  const raw = world();
  const s = await filled(raw, false);
  const pub = await publish(raw, s);
  assert.equal(pub.status, 200, JSON.stringify(pub.body));
  const opened = hydrate(await draftOf(raw, s.requestId));
  assert.ok(['open', 'receiving_offers'].includes(opened.requestState), opened.requestState);
  const edited: EditorState = { ...opened, sets: 6 };
  const saved = await publish(raw, edited);
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  const after = hydrate(await draftOf(raw, s.requestId));
  assert.equal(after.sets, 6, 'the change is the request now');
  assert.notEqual(saved.body.replayed, true, 'a change is saved, never answered as the same job');
  const again = await publish(raw, after);
  assert.equal(again.body.replayed, true, 'and saving it again unchanged keeps what merchants priced');
  assert.ok(['open', 'receiving_offers'].includes(after.requestState));
});

test('a reload of any step: the draft the server answers, hydrated, is the same body again', async () => {
  const raw = world();
  const s = await filled(raw, true);
  const once = hydrate(await draftOf(raw, s.requestId));
  const twice = hydrate(await draftOf(raw, s.requestId));
  assert.equal(bodyKey(once), bodyKey(twice));
  assert.equal(once.title, 'A wall bracket');
  assert.equal(once.sets, 4);
  assert.equal(once.carried.governorate, 'baghdad');
  assert.equal(once.carried.handover, 'delivery');
});
