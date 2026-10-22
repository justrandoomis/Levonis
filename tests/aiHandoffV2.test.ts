/**
 * THE TICKET SAYS WHAT WAS READ FROM AN ATTACHMENT AND CONFIRMED, AND
 * NOTHING CHANGES WHEN NOTHING WAS (push B plan §16 #19, §6.10).
 *
 *   - with no `ai_read`, the summary is version 1, byte for byte as push A
 *     wrote it;
 *   - version 2 round-trips through `readHandoff` and `handoffForStaff`, and
 *     names only fields the summary carries;
 *   - a candidate chip with `via` sets `ai_read`; a later turn that sets the
 *     same field another way drops it;
 *   - the desk reads `read_by_ai`; the customer's own ticket read never
 *     returns the summary.
 *
 * Run: node --import tsx --test tests/aiHandoffV2.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTicketDraft, handoffForStaff, readHandoff } from '../worker/lib/assist/handoff';
import { readContext } from '../worker/lib/assist/context';
import { aiHarness, FULL } from './fixtures/aiRoutes';

type Rec = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

test('no ai_read: version 1, byte for byte as push A wrote it', () => {
  const input = { model: 'A1' as const, symptom: 'clog' as const, tried: true, code: '0300-0100-0001-0003', shown: ['h_a1'] };
  const plain = buildTicketDraft(input, 'ar');
  assert.ok(plain.handoff!.tried.length >= 2);
  // Push A's exact shape and key order: v, model, symptom, tried, code, shown, attachments.
  assert.equal(
    JSON.stringify(plain.handoff),
    JSON.stringify({ v: 1, model: 'A1', symptom: 'clog', tried: plain.handoff!.tried, code: '0300-0100-0001-0003', shown: ['h_a1'], attachments: 0 })
  );
  assert.equal(JSON.stringify(buildTicketDraft({ ...input, readByAi: [] }, 'ar')), JSON.stringify(plain), 'an empty list is no list');
  assert.ok(!('read_by_ai' in plain.handoff!));
  // A field the summary does not carry is not claimed: «printer» read, but the printer is another.
  const unclaimed = buildTicketDraft({ symptom: 'clog', readByAi: ['printer', 'part'] }, 'en');
  assert.equal(unclaimed.handoff!.v, 1);
  assert.ok(!('read_by_ai' in unclaimed.handoff!));
});

test('version 2 round-trips through readHandoff and handoffForStaff', () => {
  const draft = buildTicketDraft({ model: 'X1C', symptom: 'hms', code: '0300-0100-0001-0003', readByAi: ['printer', 'code', 'symptom'] }, 'en');
  const h = draft.handoff!;
  assert.equal(h.v, 2);
  assert.deepEqual(h.read_by_ai, ['code', 'symptom', 'printer'], 'in the fixed order');
  assert.deepEqual(Object.keys(h).slice(0, 1), ['v'], 'the version still leads');
  assert.deepEqual(readHandoff(h), h);
  assert.deepEqual(readHandoff(JSON.stringify(h)), h, 'as stored');
  const desk = handoffForStaff(JSON.stringify(h))!;
  assert.deepEqual(desk.read_by_ai, ['code', 'symptom', 'printer']);
  // Forged or stale entries are dropped by the same closed sets.
  assert.deepEqual(readHandoff({ ...h, read_by_ai: ['code', 'price', 'code', 'part'] })!.read_by_ai, ['code']);
  assert.equal(readHandoff({ ...h, read_by_ai: 'code' })!.v, 1);
  assert.equal(readHandoff({ v: 2, model: 'other', symptom: 'noise', read_by_ai: ['printer'] })!.v, 1, '«another printer» was never read');
  // A version 1 desk read carries no new field.
  const v1 = handoffForStaff({ v: 1, model: 'A1', symptom: 'clog' })!;
  assert.ok(!('read_by_ai' in v1));
});

test('the carried context keeps known field names only', () => {
  assert.deepEqual(readContext({ v: 1, ai_read: ['part', 'code', 'code', 'price', 7] }), { v: 1, ai_read: ['code', 'part'] });
  assert.deepEqual(readContext({ v: 1, ai_read: 'code' }), { v: 1 });
  assert.deepEqual(readContext({ v: 1, ai_read: [] }), { v: 1 });
});

test('a via chip sets ai_read; the ticket carries it; a typed change drops it', async () => {
  const h = aiHarness(FULL);
  // The printer, read from a photo and confirmed.
  const printer = (await h.assistant('owner', { intent: 'printer_problem', params: { step: 'printer', model: 'P1S', via: 'photo' }, context: { v: 1 } })).reply;
  assert.deepEqual(printer.context.ai_read, ['printer']);
  // The symptom, read from a clip and confirmed.
  const symptom = (await h.assistant('owner', { intent: 'printer_problem', params: { step: 'symptom', symptom: 'stringing', via: 'clip' }, context: printer.context })).reply;
  assert.deepEqual(symptom.context.ai_read, ['symptom', 'printer']);
  // «تحدث مع الفريق»: the draft's summary is version 2 and names both.
  const talk = (await h.assistant('owner', { intent: 'printer_problem', params: { step: 'talk' }, context: symptom.context })).reply;
  assert.equal(talk.ticket_draft.handoff.v, 2);
  assert.deepEqual(talk.ticket_draft.handoff.read_by_ai, ['symptom', 'printer']);
  // A forged via is no via.
  const forged = (await h.assistant('owner', { intent: 'printer_problem', params: { step: 'printer', model: 'A1', via: 'model' }, context: { v: 1 } })).reply;
  assert.equal(forged.context.ai_read, undefined);
  // The printer changed by a chip without via: no longer «read».
  const changed = (await h.assistant('owner', { intent: 'printer_problem', params: { step: 'change_printer' }, context: symptom.context })).reply;
  const other = (await h.assistant('owner', { intent: 'printer_problem', params: { step: 'printer', model: 'A1' }, context: changed.context })).reply;
  assert.ok(!(other.context.ai_read ?? []).includes('printer'));
  // Without any via anywhere, the summary stays version 1.
  const plain = (await h.assistant('owner', { intent: 'printer_problem', params: { step: 'symptom', symptom: 'clog' }, context: { v: 1, printer: { model: 'A1' }, triage: { stage: 'symptom' } } })).reply;
  const plainTalk = (await h.assistant('owner', { intent: 'printer_problem', params: { step: 'talk' }, context: plain.context })).reply;
  assert.equal(plainTalk.ticket_draft.handoff.v, 1);
  assert.ok(!('read_by_ai' in plainTalk.ticket_draft.handoff));
  assert.ok(!('ai_read' in plainTalk.context));
});

test('the part read from a photo needs no printer, and is the same answer as typing it', async () => {
  const h = aiHarness(FULL);
  const chip = (await h.assistant('owner', { intent: 'printer_problem', params: { step: 'part', part: 'nozzle_hotend', via: 'photo' }, context: { v: 1, printer: { model: 'A1' } } })).reply;
  const typed = (await h.assistant('owner', { text: 'اريد نوزل', context: { v: 1, printer: { model: 'A1' } } })).reply;
  const strip = (r: Rec) => JSON.stringify({ ...r, context: { ...r.context, ai_read: undefined } });
  assert.equal(strip(chip), strip(typed), 'the chip is the typed question, answered the same way');
  assert.deepEqual(chip.context.ai_read, ['part']);
  // A printer that is there and not the shop's is still refused: the triage's own start.
  const bad = (await h.assistant('owner', { intent: 'printer_problem', params: { step: 'part', part: 'nozzle_hotend', model: 'Z9' }, context: { v: 1 } })).reply;
  assert.equal(bad.context.part, undefined);
});

test('the desk reads read_by_ai; the customer’s own ticket read never returns the summary', async () => {
  const h = aiHarness(FULL);
  const draft = buildTicketDraft({ model: 'A1', symptom: 'hms', code: '0300-0100-0001-0003', readByAi: ['code'] }, 'ar');
  const sent = await h.postJson('owner', '/api/support/tickets', { confirm: true, subject: draft.subject, body: draft.body, handoff: draft.handoff });
  assert.equal(sent.status, 200, await sent.clone().text());
  const id = ((await sent.json()) as Rec).ticket.id as string;
  const stored = h.raw.prepare('SELECT handoff_summary FROM support_tickets WHERE id = ?').get(id) as { handoff_summary: string };
  assert.equal(JSON.parse(stored.handoff_summary).v, 2);
  const desk = (await (await h.as('admin', `/api/support/admin/tickets/${id}`)).json()) as Rec;
  assert.deepEqual(desk.handoff.read_by_ai, ['code']);
  const mine = await (await h.as('owner', `/api/support/tickets/${id}`)).text();
  assert.ok(!mine.includes('read_by_ai') && !mine.includes('handoff_summary'), 'the customer reads their ticket, not the summary');
});
