/**
 * «مرشد الطابعات» — THE SCORER'S TRUTH TABLE (catalog discovery S6a, §9).
 *
 * Over the ten live printers of 2026-09-25. Each case pins one rule of §9:
 * the hard filters, the one-step-at-a-time relaxation and its labels, the
 * weights, the experience adjustments, the direct-sale bonus, the 4th-result
 * rule, `use_cases` counting only once it exists, and the laser answer (Q3).
 *
 * Run: node --import tsx --test tests/printerFinderScoring.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runFinder, finderWeights, AVAILABLE_NOW_BONUS } from '../worker/lib/printerFinder';
import { parseFinderParams } from '../packages/catalog/src/discovery';
import { P } from './fixtures/liveCatalog';
import { liveCandidates } from './fixtures/finderCandidates';

const answers = (q: string) => {
  const p = new URLSearchParams(q);
  return parseFinderParams((k) => p.get(k));
};
const ids = (r: { results: Array<{ card: { id: string } }> }) => r.results.map((x) => x.card.id);

test('ACCEPTANCE: business · FDM · 1.25–2.5M · any sale · [speed, colors] · intermediate → X2D, H2S, P2S; U1 ranked lower', () => {
  const out = runFinder(liveCandidates(), answers('use=business&tech=fdm&budget=1250000-2500000&sale=any&prio=speed,colors&level=intermediate'));
  assert.deepEqual(ids(out), [P.X2D, P.H2S, P.P2S]);
  assert.deepEqual(out.excluded.ranked_lower, [P.U1]);
  assert.equal(out.excluded.budget.length, 6, '«6 خارج ميزانيتك»');
  assert.equal(out.total, 10);
  assert.equal(out.tech_matches, 10);
  assert.ok(out.results.every((r) => r.relaxed.length === 0));
  const [x2d, h2s] = out.results;
  assert.deepEqual(x2d.reasons.map((r) => r.code), ['in_stock', 'speed', 'colors']);
  assert.equal(x2d.reasons[0].units, 2);
  assert.deepEqual(x2d.reasons[1], { code: 'speed', field_id: 'print_speed', value_text: '1,000 mm/s', top: true });
  assert.deepEqual(x2d.reasons[2], { code: 'colors', field_id: 'max_colors', value_text: '25', top: true });
  assert.equal(h2s.reasons[2].top, false, 'H2S has 24 colours — not the most');
  assert.deepEqual(out.results[2].caveats, [{ code: 'weak', criterion: 'speed', field_id: 'print_speed', value_text: '600 mm/s' }]);
});

test('DIRECT-ONLY under 750k relaxes, one step at a time, and labels what it relaxed', () => {
  const out = runFinder(liveCandidates(), answers('use=unsure&tech=any&budget=0-750000&sale=direct&prio=none&level=beginner'));
  // Only the A1 is direct and in budget. +20% budget (900k) adds no direct
  // printer, so pre-order is allowed: the A1 mini joins, labelled.
  assert.deepEqual(ids(out), [P.A1, P.A1MINI]);
  assert.deepEqual(out.results[0].relaxed, []);
  assert.deepEqual(out.results[1].relaxed, ['allow_preorder']);
  assert.deepEqual(out.results[1].caveats, [{ code: 'relaxed', relaxation: 'allow_preorder' }]);
  assert.ok(out.results[1].score > out.results[0].score, 'the A1 mini scores higher…');
  assert.equal(out.results[0].card.id, P.A1, '…and still never outranks the non-relaxed A1');
});

test('the budget step comes first: +20% lets in a printer just above, labelled', () => {
  // 750k–1.25M holds P1S (999k) and A2L (1,024k); +20% (1.5M) adds the P2S.
  const out = runFinder(liveCandidates(), answers('use=hobby&tech=fdm&budget=750000-1250000&sale=any&prio=none&level=intermediate'));
  assert.equal(out.results.length, 3);
  const relaxed = out.results.filter((r) => r.relaxed.length);
  assert.deepEqual(relaxed.map((r) => [r.card.id, r.relaxed]), [[P.P2S, ['budget_plus_20']]]);
  assert.equal(out.results.at(-1)!.card.id, P.P2S, 'relaxed results come last');
});

test('RESIN with no resin printers: tech_matches 0, and every result is labelled a different technology', () => {
  const out = runFinder(liveCandidates(), answers('use=figures&tech=resin&budget=any&sale=any&prio=none&level=pro'));
  assert.equal(out.tech_matches, 0, 'the page leads with support');
  assert.ok(out.results.length >= 3);
  assert.ok(out.results.every((r) => r.relaxed.includes('any_tech')));
  assert.equal(out.results[0].card.id, P.X2D, 'figures weigh quality: the 0.04 mm layer');
});

test('LASER (owner Q3): printers with a laser module option, and nothing else', () => {
  const withLaser = new Set<string>([P.H2D, P.H2S, P.H2C]);
  const cands = liveCandidates((p) => (withLaser.has(p.id) ? { spec_fields: { ...p.spec_fields, has_laser_module: 'Yes' } } : undefined));
  const out = runFinder(cands, answers('use=business&tech=laser&budget=any&sale=any&prio=none&level=intermediate'));
  assert.equal(out.tech_matches, 3);
  assert.deepEqual(new Set(ids(out).slice(0, 3)), withLaser);
  assert.ok(out.results.slice(0, 3).every((r) => r.relaxed.length === 0));
  const none = runFinder(liveCandidates(), answers('use=business&tech=laser&budget=any&sale=any&prio=none&level=intermediate'));
  assert.equal(none.tech_matches, 0, 'with no module tagged, «Laser» matches nothing — it is never guessed from a name');
});

test('the weights: §9.4 base, +3/+2 for the priorities, and the experience rules', () => {
  const w = finderWeights({ use: 'business', prio: ['speed', 'colors'], level: 'intermediate' });
  assert.deepEqual(w, { speed: 5, colors: 3, quality: 1, quiet: 0, ease: 1, size: 1.5, durable: 1.5, reliability: 2, use_fit: 2 });
  const beg = finderWeights({ use: 'hobby', prio: [], level: 'beginner' });
  assert.equal(beg.ease, 4);
  const pro = finderWeights({ use: 'hobby', prio: ['ease'], level: 'pro' });
  assert.equal(pro.ease, 0, 'pro: ease × 0, even when asked for');
  assert.equal(pro.speed, 2);
  assert.equal(pro.size, 1.5);
});

test('a beginner is warned off a Professional machine, and its score is scaled by 0.85', () => {
  const beg = runFinder(liveCandidates(), answers('use=business&tech=fdm&budget=2500000-&sale=any&prio=none&level=beginner'));
  const inter = runFinder(liveCandidates(), answers('use=business&tech=fdm&budget=2500000-&sale=any&prio=none&level=intermediate'));
  const h2dB = beg.results.find((r) => r.card.id === P.H2D)!;
  const h2dI = inter.results.find((r) => r.card.id === P.H2D)!;
  assert.deepEqual(h2dB.caveats, [{ code: 'professional' }]);
  assert.ok(h2dB.score < h2dI.score);
});

test('the direct-sale bonus is +0.06, and it is always SAID (in_stock reason)', () => {
  const base = runFinder(liveCandidates(), answers('use=unsure&tech=any&budget=any&sale=any&prio=none&level=intermediate'));
  const noStock = runFinder(liveCandidates(() => ({ stock: 0 })), answers('use=unsure&tech=any&budget=any&sale=any&prio=none&level=intermediate'));
  for (const r of base.results) {
    const same = noStock.results.find((x) => x.card.id === r.card.id);
    const inStock = r.reasons.find((x) => x.code === 'in_stock');
    if (inStock) {
      assert.ok(inStock.units! > 0);
      if (same) assert.ok(Math.abs(r.score - same.score - AVAILABLE_NOW_BONUS) < 1e-3, 'exactly the bonus');
    }
  }
  assert.ok(base.results.some((r) => r.reasons.some((x) => x.code === 'in_stock')));
  assert.ok(noStock.results.every((r) => r.reasons.every((x) => x.code !== 'in_stock')));
});

test('`use_cases` counts only once it exists: absent everywhere → weight 0; filled → it moves the ranking', () => {
  const q = answers('use=business&tech=fdm&budget=1250000-2500000&sale=any&prio=speed,colors&level=intermediate');
  const before = runFinder(liveCandidates(), q);
  const tagged = runFinder(
    liveCandidates((p) => (p.id === P.P2S ? { spec_fields: { ...p.spec_fields, use_cases: 'Business, Products to sell' } } : undefined)),
    q
  );
  assert.deepEqual(ids(before), [P.X2D, P.H2S, P.P2S]);
  assert.ok(before.results.every((r) => r.reasons.every((x) => x.code !== 'use_fit')), 'no printer is scored on an empty field');
  const p2s = tagged.results.find((r) => r.card.id === P.P2S)!;
  assert.ok(p2s.reasons.some((r) => r.code === 'use_fit' && r.field_id === 'use_cases' && r.value_text === 'Business، Products to sell'));
  const others = tagged.results.filter((r) => r.card.id !== P.P2S);
  for (const r of others) {
    assert.ok(r.score < before.results.find((x) => x.card.id === r.card.id)!.score, 'an untagged printer scores 0 on it, never assumed to fit');
  }
});

test('a 4th result is shown only within 0.02 of the 3rd', () => {
  const out = runFinder(liveCandidates(), answers('use=figures&tech=resin&budget=any&sale=any&prio=none&level=pro'));
  if (out.results.length === 4) assert.ok(out.results[2].score - out.results[3].score <= 0.02 + 1e-9);
  const acc = runFinder(liveCandidates(), answers('use=business&tech=fdm&budget=1250000-2500000&sale=any&prio=speed,colors&level=intermediate'));
  assert.equal(acc.results.length, 3, 'the U1 is further than 0.02 behind the P2S');
});

test('coverage says how many candidates state each priority', () => {
  const out = runFinder(liveCandidates(), answers('use=hobby&tech=any&budget=any&sale=any&prio=quiet,ease&level=beginner'));
  assert.deepEqual(out.coverage, [
    { criterion: 'quiet', field_id: 'noise_level', known: 5, total: 10 },
    { criterion: 'ease', field_id: 'skill_level', known: 10, total: 10 },
  ]);
});
