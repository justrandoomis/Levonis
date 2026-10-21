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
  assert.deepEqual(nextTriage(steps.context, { kind: 'outcome', outcome: 'not_fixed' }).step, { kind: 'handoff', model: 'A1', symptom: 'clog' });
  assert.deepEqual(nextTriage({ v: 1 }, { kind: 'talk' }).step, { kind: 'handoff', model: 'other', symptom: 'other' });

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
    const d = buildTicketDraft({ model: 'A1', symptom: 'clog' }, loc);
    assert.match(d.subject, /A1/);
    assert.ok(d.body.includes(symptomDef('clog').label[loc]), loc);
    for (const step of symptomDef('clog').steps) assert.ok(d.body.includes((step.tried ?? step.text)[loc]), `${loc}: ${step.key}`);
    // Review round 3: the ticket lists what was tried, never «the matching parts are below».
    assert.doesNotMatch(d.body, /أدناه|below|خوارەوە/, `${loc}: the ticket points at parts it does not carry`);
  }
  const hms = buildTicketDraft({ model: 'X1C', symptom: 'hms', code: '0300-0100-0001-0003' }, 'en');
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
