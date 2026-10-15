/**
 * Services V2 survey — Sorani on the trade-in surfaces (DECISIONS row 183:
 * «a ckb slot never carries a copy of the Arabic»). FAILS on 10c6541a: the
 * engine's labels carry ar/en only, and the customer pages call loc(ar, en),
 * which renders the ARABIC to a Sorani reader. LOCAL ONLY.
 *
 * Run: node --import tsx --test tests/sv2_tradein_strings.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { FACTOR_LABELS, FAMILY_LABELS, REQUIRED_PHOTOS, STATUS_LABELS } from '../packages/pricing/src/tradeIn';

test('S1 every customer-visible trade-in label has a Sorani slot (status, family, factor, photo angle)', () => {
  const missing: string[] = [];
  for (const [k, v] of Object.entries(STATUS_LABELS)) if (!(v as Record<string, string>).ckb) missing.push(`status:${k}`);
  for (const [k, v] of Object.entries(FAMILY_LABELS)) if (!(v as Record<string, string>).ckb) missing.push(`family:${k}`);
  for (const [k, v] of Object.entries(FACTOR_LABELS)) if (!(v as Record<string, string>).ckb) missing.push(`factor:${k}`);
  for (const [f, list] of Object.entries(REQUIRED_PHOTOS)) for (const a of list) if (!(a as unknown as Record<string, string>).label_ckb) missing.push(`photo:${f}.${a.id}`);
  assert.deepEqual(missing, [], `${missing.length} labels without Sorani`);
});

test('S2 the customer trade-in screens never call loc(ar, en) without the Sorani argument', () => {
  // S-P2 (DECISIONS row 238): the 7-step wizard became the five phone screens; their words live in copy.ts.
  const files = [
    'src/pages/TradeIn.tsx',
    'src/components/tradeIn/TradeInFlow.tsx',
    'src/components/tradeIn/DeviceList.tsx',
    'src/components/tradeIn/ScopeSheet.tsx',
    'src/components/tradeIn/ConditionScreen.tsx',
    'src/components/tradeIn/TargetSearchSheet.tsx',
    'src/components/tradeIn/OfferScreen.tsx',
    'src/components/tradeIn/RequestTimeline.tsx',
    'src/components/tradeIn/controls.tsx',
  ];
  const twoArg = /\b(?:loc|L)\(\s*(['`])(?:\\.|(?!\1).)*\1\s*,\s*(['`])(?:\\.|(?!\2).)*\2\s*\)/gs;
  const counts = files.map((f) => [f, (readFileSync(f, 'utf8').match(twoArg) ?? []).length] as const);
  const total = counts.reduce((n, [, c]) => n + c, 0);
  assert.equal(total, 0, counts.map(([f, c]) => `${f}: ${c}`).join('; '));
});
