/**
 * «ولم نفترض أي رقم غير مكتوب» — THE FINDER'S HONESTY, AS A PROPERTY
 * (catalog discovery S6a acceptance).
 *
 * Over thousands of answer combinations and randomly blanked spec sheets:
 *   - every reason quotes a field that is KNOWN and READABLE on that product,
 *     with exactly the compare engine's text for it;
 *   - a `weak` caveat quotes a known field; a `missing` caveat names a field
 *     that really is missing or unreadable;
 *   - a quiet-first answer over the live data produces the coverage note.
 *
 * Run: node --import tsx --test tests/printerFinderHonesty.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runFinder, valueText } from '../worker/lib/printerFinder';
import {
  FINDER_BUDGET_IDS,
  FINDER_LEVELS,
  FINDER_PRIORITIES,
  FINDER_SALES,
  FINDER_TECHS,
  FINDER_USES,
  type FinderAnswers,
} from '../packages/catalog/src/discovery';
import { liveCandidates } from './fixtures/finderCandidates';
import { readCompareValue } from '../worker/lib/compareSpecs';
import { allTemplateGroups } from '../worker/lib/templateFamilies';

/** A small deterministic PRNG, so a failure reproduces. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}
const FIELDS = new Map(allTemplateGroups().flatMap((g) => g.fields).map((f) => [f.id, f]));
const readable = (specs: Record<string, unknown>, id: string) => {
  const raw = String(specs[id] ?? '').trim();
  const f = FIELDS.get(id);
  if (!raw || !f) return false;
  const v = readCompareValue(f, raw);
  return !v.missing;
};

test('no reason ever cites a missing field — 3,000 random answers over randomly blanked sheets', () => {
  const rand = rng(20260925);
  const pick = <T,>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)];
  let checked = 0;
  for (let i = 0; i < 3000; i++) {
    const cands = liveCandidates((p) => {
      const spec: Record<string, string> = { ...p.spec_fields };
      for (const k of Object.keys(spec)) if (rand() < 0.3) delete spec[k];
      if (rand() < 0.1) spec.print_speed = 'very fast';
      return { spec_fields: spec, stock: rand() < 0.4 ? Math.floor(rand() * 6) : 0 };
    });
    const prio = FINDER_PRIORITIES.filter(() => rand() < 0.3).slice(0, 2);
    const a: FinderAnswers = {
      use: pick(FINDER_USES),
      tech: pick(FINDER_TECHS),
      budget: pick(FINDER_BUDGET_IDS),
      sale: pick(FINDER_SALES),
      prio,
      level: pick(FINDER_LEVELS),
    };
    const out = runFinder(cands, a);
    const byId = new Map(cands.map((c) => [c.id, c]));
    for (const r of out.results) {
      const specs = byId.get(r.card.id)!.specs;
      for (const reason of r.reasons) {
        checked++;
        if (reason.code === 'in_stock') {
          assert.ok(byId.get(r.card.id)!.available > 0);
          continue;
        }
        if (reason.code === 'in_budget') continue;
        assert.ok(readable(specs, reason.field_id), `${r.card.id} reason ${reason.code} cites ${reason.field_id} = «${specs[reason.field_id] ?? ''}»`);
        assert.equal(reason.value_text, valueText(specs, reason.field_id));
        assert.notEqual(reason.value_text, 'very fast', 'an unreadable value is never a reason');
      }
      for (const cav of r.caveats) {
        if (cav.code === 'weak') assert.ok(readable(specs, cav.field_id), `weak caveat on ${cav.field_id}`);
      }
      assert.ok(r.caveats.length <= 1, 'at most one caveat');
      assert.ok(r.reasons.length <= 3, 'at most three reasons');
    }
  }
  assert.ok(checked > 3000, `checked ${checked} reasons`);
});

test('a quiet-first answer produces the coverage caveat (noise is stated on 5 of 10)', () => {
  const out = runFinder(liveCandidates(), {
    use: 'hobby', tech: 'any', budget: 'any', sale: 'any', prio: ['quiet'], level: 'beginner',
  });
  assert.deepEqual(out.coverage, [{ criterion: 'quiet', field_id: 'noise_level', known: 5, total: 10 }]);
  // And a shortlist of machines with no stated noise says so, per machine.
  const loud = runFinder(liveCandidates(), {
    use: 'hobby', tech: 'any', budget: '2500000-', sale: 'any', prio: ['quiet'], level: 'intermediate',
  });
  assert.deepEqual(loud.results.map((r) => r.caveats), [
    [{ code: 'missing', criterion: 'quiet', field_id: 'noise_level' }],
    [{ code: 'missing', criterion: 'quiet', field_id: 'noise_level' }],
  ]);
  assert.ok(loud.results.every((r) => r.reasons.every((x) => x.code !== 'quiet')));
});
