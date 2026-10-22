/**
 * THE RULES ANSWER FIRST; THE MODEL IS ASKED ONLY AT THE CLARIFY POINT (push B
 * plan §16 #6, §5.1, §0 "consulted after the strong lookup").
 *
 * With every task configured and a provider that would answer, a spy counts
 * the provider calls. It is called ZERO times for every turn push A's rules,
 * the legacy scorer, a pending question or the strong catalogue lookup
 * answers — the owner's screenshot cases among them — and ONCE for a sentence
 * nothing else could place, just before the clarify menu.
 *
 * Run: node --import tsx --test tests/aiRulesFirst.test.ts
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { aiHarness, FULL, provide, providerCalls, resetProvider, seedShop, textReading } from './fixtures/aiRoutes';
import { answer } from './fixtures/aiLayer';
import { freshDb } from './fixtures/app';

type Rec = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

afterEach(() => resetProvider());

async function shopHarness() {
  const raw = freshDb();
  await seedShop(raw);
  return aiHarness({ ...FULL, raw });
}

test('the owner’s screenshot cases and every rule-answered turn never reach the model', async () => {
  const h = await shopHarness();
  provide(() => answer(textReading({ action: 'triage', symptom: 'stringing' })));
  const asked: Array<[string, Rec]> = [
    ['owner', { text: 'نوزل مال اي ون اريده 0.2' }],
    ['owner', { text: 'بحث عن منتج صيانه خلل بالنوزل' }],
    ['owner', { text: 'كلوب' }],
    ['owner', { text: 'وين طلبي' }],
    ['owner', { text: 'مرحبا' }],
    ['owner', { text: 'شكرا' }],
    ['owner', { text: 'PLA Basic' }],
    ['owner', { text: 'الطابعة تطلع خيوط مثل الشعر بين القطع' }],
    ['owner', { text: "my first layer won't stick on the P1S", locale: 'en' }],
    ['', { text: 'وين طلبي' }],
    ['owner', { intent: 'printer_problem', params: {} }],
    ['owner', { intent: 'printer_problem', params: { step: 'symptom', symptom: 'clog' }, context: { v: 1, printer: { model: 'A1' }, triage: { stage: 'symptom' } } }],
    ['owner', { intent: 'choose_printer' }],
  ];
  for (const [who, body] of asked) {
    const reply = (await h.assistant(who, body)).reply;
    assert.equal(providerCalls(), 0, `asked the model for ${JSON.stringify(body)}`);
    assert.equal(reply.mode, undefined, JSON.stringify(body));
  }
  // «صارت عندي مشكله بالطابعه» → «تحدث مع الفريق»: the triage, then its prefilled ticket.
  const fault = (await h.assistant('owner', { text: 'صارت عندي مشكله بالطابعه' })).reply;
  assert.equal(fault.intent, 'printer_problem');
  const talk = (await h.assistant('owner', { text: 'تحدث مع الفريق', context: fault.context })).reply;
  assert.equal(talk.handoff, true);
  // A pending question answered by a bare product name («A1 combo» to «which product?»).
  await h.assistant('owner', { text: 'A1', expects: { intent: 'compare_products', slot: 'q', params: {} } });
  assert.equal(providerCalls(), 0);
});

test('a sentence nothing else could place: one call, just before the clarify menu', async () => {
  const h = await shopHarness();
  provide(() => answer(textReading({ action: 'triage', symptom: 'stringing' })));
  const reply = (await h.assistant('owner', { text: 'شي غريب يصير ما ادري شنو' })).reply;
  assert.equal(providerCalls(), 1);
  assert.equal(reply.mode, 'ai');
  assert.equal(reply.intent, 'printer_problem');
  // With the layer off, the same sentence is push A's clarify menu and no call.
  resetProvider();
  const off = aiHarness({ ...FULL, enabled: false, raw: h.raw });
  provide(() => answer(textReading({ action: 'triage', symptom: 'stringing' })));
  const basic = (await off.assistant('stranger', { text: 'شي غريب يصير ما ادري شنو' })).reply;
  assert.equal(providerCalls(), 0);
  assert.equal(basic.intent, 'clarify');
  assert.equal(basic.mode, undefined);
});

test('too short, Sorani without the owner’s toggle, a guest without it, and the limits: no call', async () => {
  const h = await shopHarness();
  provide(() => answer(textReading({ action: 'triage', symptom: 'stringing' })));
  await h.assistant('owner', { text: 'zqx' });
  await h.assistant('owner', { text: 'شتێکی سەیر ڕوودەدات', locale: 'ckb' });
  await h.assistant('owner', { text: 'شي غريب يصير ما ادري شنو', locale: 'ckb' });
  assert.equal(providerCalls(), 0);
  const noGuests = aiHarness({ ...FULL, guests: false, raw: h.raw });
  await noGuests.assistant('', { text: 'شي غريب يصير ما ادري شنو' });
  assert.equal(providerCalls(), 0, 'guests are off by default');
  // 20 in five minutes, per visitor.
  for (let i = 0; i < 25; i++) await h.assistant('stranger', { text: `شي غريب يصير ما ادري شنو ${'ا'.repeat(i)}` });
  assert.equal(providerCalls(), 20);
});

test('the «not what I meant» chip reaches the clarify menu', async () => {
  const h = await shopHarness();
  provide(() => answer(textReading({ action: 'intent', intent: 'greeting' })));
  const reply = (await h.assistant('owner', { text: 'شي غريب يصير ما ادري شنو' })).reply;
  assert.equal(reply.mode, 'ai');
  assert.equal(reply.intent, 'greeting');
  const chip = reply.choices.at(-1);
  assert.equal(chip.intent, 'menu');
  // The greeting's own topic chips stand before it: the mark never replaces a follow-up.
  assert.ok(reply.choices.length > 1);
  const menu = (await h.assistant('owner', { intent: chip.intent, params: chip.params })).reply;
  assert.equal(menu.intent, 'clarify');
  assert.equal(menu.mode, undefined);
});
