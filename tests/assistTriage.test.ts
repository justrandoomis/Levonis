/**
 * THE PRINTER-PROBLEM TRIAGE: its curated data, its dictionary and its pure
 * state machine (worker/lib/assist/triage, ./strings.ts, ./handoff.ts).
 *
 * The data is the part a person reviews, so the tests hold it to the rules
 * that make a review meaningful: every string in three languages with a real
 * Sorani (never a copy of the Arabic, DECISIONS row 183), one to four steps,
 * the owner's own Arabic chip labels, and no wiki address that is not already
 * in the reviewed corpus.
 *
 * Run: node --import tsx --test tests/assistTriage.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SYMPTOMS, symptomDef, wikiFor } from '../worker/lib/assist/triage/symptoms';
import { nextTriage } from '../worker/lib/assist/triage/flow';
import { readContext } from '../worker/lib/assist/context';
import { ASSIST_T } from '../worker/lib/assist/strings';
import { buildTicketDraft } from '../worker/lib/assist/handoff';
import { PART_LABELS } from '../worker/lib/assist/understand/lexicon';
import { SYMPTOM_KEYS } from '../worker/lib/assist/types';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CURATED = join(ROOT, 'data/bambu-import/curated');
const corpus = readdirSync(CURATED)
  .filter((f) => f.endsWith('.json'))
  .map((f) => readFileSync(join(CURATED, f), 'utf8'))
  .join('\n');

const three = (where: string, l: { ar: string; en: string; ckb: string }) => {
  for (const loc of ['ar', 'en', 'ckb'] as const) assert.ok(l[loc] && l[loc].trim().length > 0, `${where}: ${loc} is empty`);
  assert.notEqual(l.ckb, l.ar, `${where}: the Sorani is a copy of the Arabic`);
};

test('eight symptoms, in the owner’s order, with the owner’s Arabic labels', () => {
  assert.deepEqual(SYMPTOMS.map((s) => s.key), [...SYMPTOM_KEYS]);
  assert.deepEqual(
    SYMPTOMS.map((s) => s.label.ar),
    ['انسداد النوزل', 'عدم الالتصاق', 'إزاحة الطبقات', 'خيوط stringing', 'مشكلة AMS', 'رمز خطأ HMS', 'صوت غريب', 'أخرى']
  );
});

test('every symptom and step is written three times, and the steps are few', () => {
  for (const s of SYMPTOMS) {
    three(s.key, s.label);
    assert.ok(s.steps.length >= 1 && s.steps.length <= 4, `${s.key}: ${s.steps.length} steps`);
    assert.equal(new Set(s.steps.map((x) => x.key)).size, s.steps.length, `${s.key}: duplicate step key`);
    for (const step of s.steps) {
      three(`${s.key}.${step.key}`, step.text);
      if (step.tried) three(`${s.key}.${step.key}.tried`, step.tried);
    }
  }
  for (const [key, label] of Object.entries(PART_LABELS)) three(key, label);
});

test('every wiki address is already in the reviewed corpus', () => {
  for (const s of SYMPTOMS) {
    const urls = [s.wiki?.url, ...Object.values(s.wiki?.byModel ?? {})].filter((u): u is string => !!u);
    for (const url of urls) {
      assert.ok(url.startsWith('https://wiki.bambulab.com/'), url);
      // The whole address, not a longer one that starts with it.
      const whole = new RegExp(`${url.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}(?![A-Za-z0-9/_-])`);
      assert.ok(whole.test(corpus), `${s.key}: ${url} is not in data/bambu-import/curated`);
    }
  }
  assert.equal(wikiFor(symptomDef('ams'), 'A1'), 'https://wiki.bambulab.com/en/ams-lite');
  assert.equal(wikiFor(symptomDef('ams'), 'X1C'), null, 'no page is invented for a printer without one');
});

test('the dictionary: the same keys in ar, en and ckb, the same placeholders, and a real Sorani', () => {
  const keys = Object.keys(ASSIST_T.ar).sort();
  assert.deepEqual(Object.keys(ASSIST_T.en).sort(), keys);
  assert.deepEqual(Object.keys(ASSIST_T.ckb).sort(), keys);
  const holes = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
  for (const key of keys) {
    assert.notEqual(ASSIST_T.ckb[key], ASSIST_T.ar[key], `${key}: the Sorani is a copy of the Arabic`);
    assert.deepEqual(holes(ASSIST_T.en[key]), holes(ASSIST_T.ar[key]), key);
    assert.deepEqual(holes(ASSIST_T.ckb[key]), holes(ASSIST_T.ar[key]), key);
  }
});

test('the state machine: printer, symptom, steps, outcome', () => {
  const asked = nextTriage({ v: 1 }, { kind: 'start', symptom: 'clog' });
  assert.deepEqual(asked.step, { kind: 'ask_printer', symptom: 'clog' });
  assert.deepEqual(asked.context.triage, { stage: 'printer', symptom: 'clog' });

  const steps = nextTriage(asked.context, { kind: 'printer', model: 'A1' });
  assert.deepEqual(steps.step, { kind: 'steps', model: 'A1', symptom: 'clog' });
  assert.deepEqual(steps.context.printer, { model: 'A1' });

  const known = nextTriage({ v: 1, printer: { model: 'P1S' } }, { kind: 'start' });
  assert.deepEqual(known.step, { kind: 'ask_symptom', model: 'P1S' }, 'a printer already chosen is not asked for again');

  const changed = nextTriage(steps.context, { kind: 'change_printer' });
  assert.deepEqual(changed.step, { kind: 'ask_printer', symptom: 'clog' });
  assert.equal(changed.context.printer, undefined);

  assert.deepEqual(nextTriage(steps.context, { kind: 'outcome', outcome: 'resolved' }).step, { kind: 'resolved' });
  assert.deepEqual(nextTriage(steps.context, { kind: 'outcome', outcome: 'not_fixed' }).step, { kind: 'handoff', model: 'A1', symptom: 'clog', tried: true });
  // Review round 4: nothing given is nothing stated, never «another printer» and «other» by default.
  assert.deepEqual(nextTriage({ v: 1 }, { kind: 'talk' }).step, { kind: 'handoff', tried: false });

  // A unit chosen for one model does not ride along to another.
  const withUnit = nextTriage({ v: 1 }, { kind: 'printer', model: 'A1', unit_id: 'u1' });
  assert.equal(withUnit.context.printer?.unit_id, 'u1');
  assert.equal(nextTriage(withUnit.context, { kind: 'printer', model: 'X1C' }).context.printer?.unit_id, undefined);

  // A code typed with the printer («P1S وطلعلي رمز …») is the code of the steps and the ticket.
  const coded = nextTriage({ v: 1, triage: { stage: 'printer' } }, { kind: 'printer', model: 'P1S', symptom: 'hms', code: '0300-0100-0001-0003' });
  assert.deepEqual(coded.step, { kind: 'steps', model: 'P1S', symptom: 'hms', code: '0300-0100-0001-0003' });
  assert.deepEqual(coded.context.triage, { stage: 'steps', symptom: 'hms', code: '0300-0100-0001-0003' });
  // A family named: its printers are the question's only answers.
  assert.deepEqual(nextTriage({ v: 1 }, { kind: 'start', symptom: 'clog', among: ['X1C', 'X1E'] }).step, {
    kind: 'ask_printer',
    symptom: 'clog',
    among: ['X1C', 'X1E'],
  });
});

test('the ticket draft names the printer, the symptom, the code and every step tried, in the customer’s language', () => {
  for (const loc of ['ar', 'en', 'ckb'] as const) {
    const d = buildTicketDraft({ model: 'A1', symptom: 'clog', tried: true }, loc);
    assert.match(d.subject, /A1/);
    assert.ok(d.body.includes(symptomDef('clog').label[loc]), loc);
    for (const step of symptomDef('clog').steps) assert.ok(d.body.includes((step.tried ?? step.text)[loc]), `${loc}: ${step.key}`);
    // Review round 3: the ticket lists what was tried, never «the matching parts are below».
    assert.doesNotMatch(d.body, /أدناه|below|خوارەوە/, `${loc}: the ticket points at parts it does not carry`);
  }
  const hms = buildTicketDraft({ model: 'X1C', symptom: 'hms', code: '0300-0100-0001-0003', tried: true }, 'en');
  assert.match(hms.body, /0300-0100-0001-0003/);
  assert.ok(!hms.body.includes('Type the full code'), 'a code already typed is not listed as a step to do');
  assert.equal(buildTicketDraft({ model: 'other', symptom: 'noise' }, 'ar').subject, 'مشكلة في الطابعة: صوت غريب');
});

test('round 3: a printer a shopping answer only showed is not the printer the triage goes on with', () => {
  const browsed = readContext({ v: 1, printer: { model: 'A1', browsed: true } });
  assert.deepEqual(browsed.printer, { model: 'A1', browsed: true });
  assert.deepEqual(readContext({ v: 1, printer: { model: 'A1', browsed: 'yes' } }).printer, { model: 'A1' }, 'closed set: true or nothing');
  assert.deepEqual(nextTriage(browsed, { kind: 'start', symptom: 'clog' }).step, { kind: 'ask_printer', symptom: 'clog' });
  assert.deepEqual(nextTriage(browsed, { kind: 'start' }).step, { kind: 'ask_printer' });
  assert.equal(nextTriage(browsed, { kind: 'symptom', symptom: 'noise' }).step.kind, 'ask_printer');
  // Chosen in the triage, it is the printer from then on.
  const chosen = nextTriage(browsed, { kind: 'printer', model: 'A1' });
  assert.deepEqual(chosen.context.printer, { model: 'A1' });
  assert.equal(nextTriage(chosen.context, { kind: 'start', symptom: 'clog' }).step.kind, 'steps');
});

test('round 4: the handoff states only what the customer gave: the triage printer, the symptom named, the steps shown', () => {
  // A printer a shopping answer only showed is not the customer's printer, in the ticket either.
  const browsed = nextTriage({ v: 1, printer: { model: 'P1S', browsed: true } }, { kind: 'start', symptom: 'clog' });
  assert.equal(browsed.step.kind, 'ask_printer');
  const early = nextTriage({ ...browsed.context, printer: { model: 'P1S', browsed: true } }, { kind: 'talk' });
  assert.deepEqual(early.step, { kind: 'handoff', symptom: 'clog', tried: false }, 'no printer, and no step was shown');
  assert.deepEqual(early.context.triage, { stage: 'done', symptom: 'clog' });
  // A member's unit rides only with a printer the triage chose.
  const own = nextTriage({ v: 1, printer: { model: 'A1', unit_id: 'u1', browsed: true } }, { kind: 'talk' });
  assert.deepEqual(own.step, { kind: 'handoff', tried: false });
  // At «which symptom?», the printer is known and nothing else.
  const atSymptom = nextTriage(nextTriage({ v: 1 }, { kind: 'printer', model: 'A1' }).context, { kind: 'talk' });
  assert.deepEqual(atSymptom.step, { kind: 'handoff', model: 'A1', tried: false });
  // «طابعة أخرى» chosen by the customer is what they gave, and stays.
  const other = nextTriage(nextTriage({ v: 1, triage: { stage: 'printer', symptom: 'noise' } }, { kind: 'printer', model: 'other' }).context, { kind: 'talk' });
  assert.deepEqual(other.step, { kind: 'handoff', model: 'other', symptom: 'noise', tried: true });
  // After the steps, another printer chosen for the same fault: the steps were still shown.
  const steps = nextTriage({ v: 1, triage: { stage: 'printer', symptom: 'clog' } }, { kind: 'printer', model: 'A1' });
  const changed = nextTriage(steps.context, { kind: 'change_printer' });
  assert.deepEqual(changed.context.triage, { stage: 'printer', symptom: 'clog', steps: true });
  assert.deepEqual(nextTriage(changed.context, { kind: 'talk' }).step, { kind: 'handoff', symptom: 'clog', tried: true });
  // Talked once after the steps, the done state keeps that they were shown; once before, it does not.
  const done = nextTriage(steps.context, { kind: 'talk' });
  assert.deepEqual(done.context.triage, { stage: 'done', symptom: 'clog', steps: true });
  assert.deepEqual(nextTriage(readContext(JSON.parse(JSON.stringify(done.context))), { kind: 'talk' }).step, { kind: 'handoff', model: 'A1', symptom: 'clog', tried: true });
  assert.deepEqual(nextTriage(early.context, { kind: 'talk' }).step, { kind: 'handoff', symptom: 'clog', tried: false });
  // The flag is a closed set, and means nothing without a symptom.
  assert.equal(readContext({ v: 1, triage: { stage: 'done', symptom: 'clog', steps: 'yes' } }).triage?.steps, undefined);
  assert.equal(readContext({ v: 1, triage: { stage: 'done', steps: true } }).triage?.steps, undefined);
});

test('round 4: a draft before any step names no step tried, and leaves out a printer or a fault nobody gave', () => {
  for (const loc of ['ar', 'en', 'ckb'] as const) {
    const label = symptomDef('clog').label[loc];
    const noPrinter = buildTicketDraft({ symptom: 'clog' }, loc);
    assert.equal(noPrinter.subject, ASSIST_T[loc].ticket_subject_other.replace('{symptom}', label), loc);
    assert.equal(noPrinter.body, ASSIST_T[loc].ticket_problem.replace('{symptom}', label), `${loc}: one line, the fault`);
    assert.deepEqual(noPrinter.handoff, { v: 1, model: null, symptom: 'clog', tried: [], shown: [], attachments: 0 });
    for (const word of [ASSIST_T[loc].printer_other, ASSIST_T[loc].ticket_tried, ASSIST_T[loc].ticket_printer.split('{')[0]]) {
      assert.ok(!noPrinter.body.includes(word), `${loc}: «${word}» is not in a draft that has no printer and no step`);
    }
    const noFault = buildTicketDraft({ model: 'A1' }, loc);
    assert.equal(noFault.subject, ASSIST_T[loc].ticket_subject_printer.replace('{printer}', 'A1'), loc);
    assert.equal(noFault.body, ASSIST_T[loc].ticket_printer.replace('{printer}', 'A1'), loc);
    assert.deepEqual(noFault.handoff, { v: 1, model: 'A1', symptom: null, tried: [], shown: [], attachments: 0 });
    const nothing = buildTicketDraft({}, loc);
    assert.deepEqual({ subject: nothing.subject, body: nothing.body, handoff: nothing.handoff }, { subject: ASSIST_T[loc].ticket_subject_plain, body: '', handoff: undefined });
    // Not shown, not tried, even when printer and fault are both known.
    const unshown = buildTicketDraft({ model: 'A1', symptom: 'clog' }, loc);
    assert.deepEqual(unshown.handoff?.tried, []);
    assert.ok(!unshown.body.includes(ASSIST_T[loc].ticket_tried), loc);
  }
});

test('round 4: no Sorani or Arabic clitic is glued onto a placeholder (a Latin line or printer name)', () => {
  for (const loc of ['ar', 'ckb'] as const) {
    for (const [key, text] of Object.entries(ASSIST_T[loc])) {
      assert.doesNotMatch(text, /\}[\u0621-\u064A\u0671-\u06D3\u06D5]/, `${loc}.${key}: ${text}`);
    }
  }
});
