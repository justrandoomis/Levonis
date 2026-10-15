/**
 * Services V2, S-P0a — the trade-in figure a draft may ask for (G11), the
 * copy that promised published rules (G22), and Sorani on the trade-in,
 * points and services screens (row 183).
 *
 * G11. A trade-in estimate is a function of the answers, so a door that prices
 * any answers on demand gives back the owner's valuation rules one toggled
 * answer at a time (DECISIONS row 220). The door stays — a customer sees the
 * figure before sending — but every answer it gives is COUNTED: 20 for one
 * request, 60 for one account in any 24 hours, enforced in the database by a
 * single conditional INSERT. A draft's own view (create, read, save) carries
 * no figure for its customer, so the count cannot be stepped around by saving
 * answers and reading the draft back. The counted figures are log lines on the
 * request: the customer's timeline never shows them, the desk reads how many.
 *
 * LOCAL ONLY: in-memory SQLite with every migration, the real routes, stub sessions.
 * Run: node --import tsx --test tests/sv2_tradein_preview_limits.test.ts
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import type { DatabaseSync } from 'node:sqlite';
import { get, json, post, send } from './fixtures/app';
import { adminApp, customerApp, restoreFetch, seed, submitted } from './sv2_tradein_fixture';
import { TRADE_IN_PREVIEW_PER_DAY, TRADE_IN_PREVIEW_PER_REQUEST, publicQuestions } from '../worker/lib/tradeIn';
import { DEFAULT_RULE_SETS } from '../packages/pricing/src/tradeInDefaults';
import { FACTOR_LABELS, FAMILY_LABELS, OPTIONAL_PHOTO, REQUIRED_PHOTOS, STATUS_LABELS, TRADE_IN_FAMILIES, blankInputs } from '../packages/pricing/src/tradeIn';
import { REFUSAL_STRINGS } from '../src/lib/refusalStrings';

after(restoreFetch);

const GOOD = (family: 'fdm' | 'ams') => blankInputs(family);

async function draft(raw: DatabaseSync) {
  const a = customerApp(raw);
  const res = await post(a, '/api/trade-in/requests', { order_item_id: 'oi_a1', unit_index: 1, scope: 'whole' });
  assert.equal(res.status, 201, await res.clone().text());
  const request = (await json(res)).request;
  return { a, request, id: request.id as string, comps: request.components as Array<{ role: string; family: 'fdm' | 'ams' }> };
}

const answers = (comps: Array<{ role: string; family: 'fdm' | 'ams' }>, exterior: number) =>
  Object.fromEntries(comps.map((c) => [c.role, { ...GOOD(c.family), exterior }]));

const previewRows = (raw: DatabaseSync, id: string) =>
  Number((raw.prepare(`SELECT COUNT(*) AS n FROM trade_in_events WHERE request_id = ? AND action = 'preview'`).get(id) as { n: number }).n);

// ------------------------------------------------------------------ G11

test('G11: a draft answers 20 counted figures, then refuses with TRADE_IN_PREVIEW_LIMIT (429) and no figure', async () => {
  const raw = seed();
  const { a, request, id, comps } = await draft(raw);
  assert.equal(request.previews_left, TRADE_IN_PREVIEW_PER_REQUEST, 'a new draft has all of its figures left');
  assert.equal(TRADE_IN_PREVIEW_PER_REQUEST, 20);
  assert.equal(TRADE_IN_PREVIEW_PER_DAY, 60);

  for (let i = 1; i <= TRADE_IN_PREVIEW_PER_REQUEST; i++) {
    const res = await post(a, `/api/trade-in/requests/${id}/preview`, { components: answers(comps, 1 + (i % 5)) });
    assert.equal(res.status, 200, `figure ${i}: ${await res.clone().text()}`);
    const body = await json(res);
    assert.ok(body.estimate.total_iqd > 0);
    assert.equal(body.previews_left, TRADE_IN_PREVIEW_PER_REQUEST - i, `figure ${i} says how many are left`);
  }
  const refused = await post(a, `/api/trade-in/requests/${id}/preview`, { components: answers(comps, 4) });
  assert.equal(refused.status, 429);
  const body = await json(refused);
  assert.equal(body.code, 'TRADE_IN_PREVIEW_LIMIT');
  assert.equal(body.details?.scope, 'request');
  assert.equal(body.estimate, undefined, 'a refusal answers no figure');
  assert.equal(previewRows(raw, id), TRADE_IN_PREVIEW_PER_REQUEST, 'the refusal took no slot');

  // The draft's own view says none are left — and still carries no figure.
  const view = (await json(await get(a, `/api/trade-in/requests/${id}`))).request;
  assert.equal(view.previews_left, 0);
  assert.equal(view.estimate, null);
  raw.close();
});

test('G11: 60 figures per account in any 24 hours, across its requests; older ones no longer count', async () => {
  const raw = seed();
  const first = await draft(raw);
  // Sixty figures asked an hour ago on the first draft (written as the door writes them).
  const hourAgo = new Date(Date.now() - 3600_000).toISOString();
  const ins = raw.prepare(
    `INSERT INTO trade_in_events (id, request_id, actor_id, actor_role, action, detail_json, created_at) VALUES (?, ?, 'cust', 'customer', 'preview', '{}', ?)`
  );
  for (let i = 0; i < TRADE_IN_PREVIEW_PER_DAY; i++) ins.run(`tie_seed_${i}`, first.id, hourAgo);
  // A fresh request on the same device: its own count is zero, the account's is not.
  const cancelled = await post(first.a, `/api/trade-in/requests/${first.id}/cancel`, { reason: 'changed before sending' });
  assert.equal(cancelled.status, 200, await cancelled.clone().text());
  const second = await draft(raw);
  const refused = await post(second.a, `/api/trade-in/requests/${second.id}/preview`, { components: answers(second.comps, 5) });
  assert.equal(refused.status, 429, await refused.clone().text());
  const body = await json(refused);
  assert.equal(body.code, 'TRADE_IN_PREVIEW_LIMIT');
  assert.equal(body.details?.scope, 'day');
  assert.equal(previewRows(raw, second.id), 0);

  // A day later those sixty no longer count.
  raw.prepare(`UPDATE trade_in_events SET created_at = ? WHERE id LIKE 'tie_seed_%'`).run(new Date(Date.now() - 25 * 3600_000).toISOString());
  const ok = await post(second.a, `/api/trade-in/requests/${second.id}/preview`, { components: answers(second.comps, 5) });
  assert.equal(ok.status, 200, await ok.clone().text());
  assert.equal((await json(ok)).previews_left, TRADE_IN_PREVIEW_PER_REQUEST - 1);
  raw.close();
});

test('G11: presses at once cannot slip past the limit — 25 together, exactly 20 answered', async () => {
  const raw = seed();
  const { a, id, comps } = await draft(raw);
  const all = await Promise.all(
    Array.from({ length: 25 }, (_, i) => post(a, `/api/trade-in/requests/${id}/preview`, { components: answers(comps, 1 + (i % 5)) }))
  );
  const codes = all.map((r) => r.status);
  assert.equal(codes.filter((c) => c === 200).length, TRADE_IN_PREVIEW_PER_REQUEST, codes.join(','));
  assert.equal(codes.filter((c) => c === 429).length, 5, codes.join(','));
  assert.equal(previewRows(raw, id), TRADE_IN_PREVIEW_PER_REQUEST);
  raw.close();
});

test('G11: a draft\'s own views carry no figure for its customer — create, read and save — so the count is the only door', async () => {
  const raw = seed();
  const { a, request, id, comps } = await draft(raw);
  assert.equal(request.estimate, null);
  assert.equal(request.estimated_iqd, null);
  const read = (await json(await get(a, `/api/trade-in/requests/${id}`))).request;
  assert.equal(read.estimate, null);
  assert.equal(read.estimated_iqd, null);
  const saved = await send(a, 'PATCH', `/api/trade-in/requests/${id}`, {
    components: answers(comps, 2),
    target: { product_id: 'p_p1s', option_value_ids: [], color_id: null },
  });
  assert.equal(saved.status, 200, await saved.clone().text());
  const view = (await json(saved)).request;
  assert.equal(view.estimate, null, 'saving answers hands back no figure');
  assert.equal(view.estimated_iqd, null);
  for (const c of view.components) assert.ok(!('value_iqd' in c), `${c.role}: no part value on a draft`);
  assert.equal(previewRows(raw, id), 0, 'reading and saving count nothing');

  // The owner's desk reads the engine's figure on the saved answers; no reader prices the v2 offer
  // on a read (S-P2 §4.5: preview, submit, intake and an override only).
  const desk = (await json(await get(adminApp(raw), `/api/admin/trade-in/requests/${id}`))).request;
  assert.ok(desk.estimate?.total_iqd > 0, JSON.stringify(desk.estimate));
  raw.close();
});

test('G11: the counted figures stay out of the customer\'s timeline; the desk reads how many', async () => {
  const raw = seed();
  const { a, id, comps } = await draft(raw);
  for (let i = 0; i < 3; i++) {
    const r = await post(a, `/api/trade-in/requests/${id}/preview`, { components: answers(comps, 2 + i) });
    assert.equal(r.status, 200);
  }
  const mine = (await json(await get(a, `/api/trade-in/requests/${id}`))).request;
  assert.ok(!mine.events.some((e: { action: string }) => e.action === 'preview'), JSON.stringify(mine.events));
  assert.equal(mine.previews_left, TRADE_IN_PREVIEW_PER_REQUEST - 3);
  assert.equal(mine.previews, undefined, 'the customer is told what is left, not a log');
  const desk = (await json(await get(adminApp(raw), `/api/admin/trade-in/requests/${id}`))).request;
  assert.equal(desk.previews, 3);
  assert.ok(!desk.events.some((e: { action: string }) => e.action === 'preview'), 'the desk timeline is the request\'s steps');
  // Each log line keeps the one offer it answered, for the desk (S-P2).
  const lines = raw.prepare(`SELECT detail_json FROM trade_in_events WHERE request_id = ? AND action = 'preview'`).all(id) as Array<{ detail_json: string }>;
  assert.ok(lines.every((l) => Number(JSON.parse(l.detail_json).offer_iqd) > 0), JSON.stringify(lines));
  raw.close();
});

test('G11: a sent request keeps the estimate fixed at submit for its customer, and answers no more figures', async () => {
  const raw = seed();
  const id = await submitted(raw);
  const a = customerApp(raw);
  const view = (await json(await get(a, `/api/trade-in/requests/${id}`))).request;
  assert.ok(view.estimated_iqd > 0, 'the submitted offer is the customer\'s to read');
  assert.equal(view.offer?.offer_iqd, view.estimated_iqd, 'S-P2: the one offer, fixed at submit');
  assert.equal(view.estimate, null, 'no breakdown, no part value');
  assert.equal(view.previews_left, undefined);
  const res = await post(a, `/api/trade-in/requests/${id}/preview`, {});
  assert.equal(res.status, 409);
  assert.equal((await json(res)).code, 'TRADE_IN_NOT_EDITABLE');
  raw.close();
});

test('G11: the refusal reads in Arabic, English and Sorani (not the Arabic copied), and the wizard asks rather than streams', () => {
  const r = REFUSAL_STRINGS.TRADE_IN_PREVIEW_LIMIT;
  assert.ok(r?.ar && r.en && r.ckb);
  assert.notEqual(r.ckb, r.ar);
  const wizard = readFileSync('src/components/tradeIn/TradeInWizard.tsx', 'utf8');
  // One door to the figure, behind «حدّث التقدير» and the last step's single ask — no timer re-pricing every tap.
  assert.equal(wizard.match(/\/preview`/g)?.length ?? 0, 1, 'the wizard posts to the preview door in one place');
  assert.ok(/const askFigure = useCallback/.test(wizard));
  assert.ok(!/setTimeout\(/.test(wizard), 'no debounced ticker');
});

// ------------------------------------------------------------------ G22

test('G22: the trade-in screens promise a clear offer, never «published, transparent rules»', () => {
  const files = ['src/pages/TradeIn.tsx', 'src/components/tradeIn/TradeInWizard.tsx', 'src/components/tradeIn/TradeInRequest.tsx', 'src/components/tradeIn/controls.tsx'];
  for (const f of files) {
    const s = readFileSync(f, 'utf8');
    for (const banned of ['قواعد تقييم معلنة', 'معلنة وشفافة', 'published, transparent rules', 'transparent rules']) {
      assert.ok(!s.includes(banned), `${f} still says «${banned}»`);
    }
  }
  const page = readFileSync('src/pages/TradeIn.tsx', 'utf8');
  assert.ok(page.includes("L('بعرض واضح قبل الإرسال.', 'With a clear offer before you send.', 'بە پێشنیارێکی ڕوون پێش ناردن.')"));
});

// ------------------------------------------------------------------ Sorani

/** Every loc()/L() call in a file, read from the TypeScript syntax tree — not a regular expression. */
function locCalls(file: string) {
  const src = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const out: Array<{ line: number; args: ts.Expression[] }> = [];
  const visit = (n: ts.Node) => {
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && (n.expression.text === 'loc' || n.expression.text === 'L')) {
      out.push({ line: src.getLineAndCharacterOfPosition(n.getStart()).line + 1, args: [...n.arguments] });
    }
    ts.forEachChild(n, visit);
  };
  visit(src);
  return out;
}
const literal = (e: ts.Expression | undefined) =>
  e && (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) ? e.text : e && ts.isTemplateExpression(e) ? e.getText() : null;

const SORANI_SCREENS = [
  'src/pages/TradeIn.tsx',
  'src/components/tradeIn/TradeInWizard.tsx',
  'src/components/tradeIn/TradeInRequest.tsx',
  'src/components/tradeIn/controls.tsx',
  'src/components/tradeIn/model.ts',
  'src/pages/Rewards.tsx',
  'src/components/home/ServicesGrid.tsx',
];

test('Sorani: every string on the trade-in, /points and services screens has a third, Sorani argument that is not the Arabic', () => {
  const missing: string[] = [];
  const copied: string[] = [];
  let written = 0;
  for (const f of SORANI_SCREENS) {
    for (const c of locCalls(f)) {
      if (c.args.length < 3) missing.push(`${f}:${c.line}`);
      const ar = literal(c.args[0]);
      const ckb = literal(c.args[2]);
      if (ar !== null && ckb !== null) {
        written++;
        if (ckb === ar) copied.push(`${f}:${c.line}`);
      }
    }
  }
  assert.deepEqual(missing, [], `calls without Sorani: ${missing.join(', ')}`);
  assert.deepEqual(copied, [], `Sorani copied from the Arabic: ${copied.join(', ')}`);
  assert.ok(written >= 230, `the written Sorani strings (${written}) cover the trade-in screens, /points and the services grid`);
});

test('Sorani: the engine labels, photo hints and the seeded checklists carry their own Sorani', () => {
  const same: string[] = [];
  for (const [k, v] of Object.entries({ ...STATUS_LABELS, ...FAMILY_LABELS, ...FACTOR_LABELS })) if (!v.ckb || v.ckb === v.ar) same.push(k);
  for (const a of [...Object.values(REQUIRED_PHOTOS).flat(), OPTIONAL_PHOTO]) {
    if (!a.label_ckb || a.label_ckb === a.label_ar) same.push(`label:${a.id}`);
    if (!a.hint_ckb || a.hint_ckb === a.hint_ar) same.push(`hint:${a.id}`);
  }
  assert.deepEqual(same, []);
  // The questions the Worker sends: every seeded fault and replaced part has its Sorani.
  for (const f of TRADE_IN_FAMILIES) {
    const q = publicQuestions(DEFAULT_RULE_SETS[f]);
    for (const item of [...q.faults, ...q.replaced_parts]) {
      assert.ok(item.label_ckb && item.label_ckb !== item.label_ar, `${f}:${item.id} has no Sorani`);
    }
  }
  // An item the owner wrote carries the owner's two languages, and nothing invented.
  const custom = structuredClone(DEFAULT_RULE_SETS.fdm);
  for (const r of custom.factors) if (r.config.kind === 'checklist' && r.factor === 'faults') r.config.items = [{ id: 'owner_item', label_ar: 'عطل كتبه المالك', label_en: 'Owner fault', effect_bp: -100 }];
  const owned = publicQuestions(custom).faults.find((i) => i.id === 'owner_item');
  assert.deepEqual(owned, { id: 'owner_item', label_ar: 'عطل كتبه المالك', label_en: 'Owner fault' });
});
