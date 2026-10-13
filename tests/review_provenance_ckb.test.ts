/**
 * REVIEW (provenance, 2c48bf1b): the new «Exact returned pieces» block of
 * StockOperationsPanel calls `loc(ar, en)` without a Sorani argument. `loc`
 * falls back to the Arabic for `ckb` (src/LanguageContext.tsx), which is what
 * DECISIONS row 183 forbids: a ckb slot never carries a copy of the Arabic.
 * FAILS on 10c6541a.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/** Every `loc(` call in a source file with its argument count. */
function locCalls(source: string) {
  const calls: Array<{ line: number; args: number; text: string }> = [];
  const re = /\bloc\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source))) {
    let i = m.index + 4, depth = 1, commas = 0, quote: string | null = null;
    for (; i < source.length && depth; i++) {
      const ch = source[i];
      if (quote) { if (ch === '\\') { i++; continue; } if (ch === quote) quote = null; continue; }
      if (ch === "'" || ch === '"' || ch === '`') { quote = ch; continue; }
      if ('([{'.includes(ch)) depth++;
      else if (')]}'.includes(ch)) depth--;
      else if (ch === ',' && depth === 1) commas++;
    }
    calls.push({ line: source.slice(0, m.index).split('\n').length, args: commas + 1, text: source.slice(m.index, i) });
  }
  return calls;
}

// Strings introduced by 2c48bf1b in the returned-pieces inspection block.
const NEW_STRINGS = [
  'القطع المرتجعة بالتحديد',
  'طابق الرقم الداخلي أو التسلسلي ومعلومات المورد',
  'محددة في مرتجع آخر',
  'الرقم الداخلي',
  'شراء قديم',
  'طلب المورد',
  'غير موثق',
  'التتبع',
];

test('the returned-pieces block carries a real Sorani string for every label', () => {
  const source = readFileSync('src/components/adminOperations/StockOperationsPanel.tsx', 'utf8');
  const missing = locCalls(source).filter((c) => c.args < 3 && NEW_STRINGS.some((s) => c.text.includes(`'${s}`)));
  assert.deepEqual(missing.map((c) => `${c.line}: ${c.text}`), []);
});

/* The skeptic's count was low: the same block also added «قطعة», «الدفعة» and
 * «المحدد / المطلوب» with two arguments. Every call inside the block now
 * carries Sorani (fix 2026-10-13, PROV-4). */
test('every label inside the returned-pieces block passes a Sorani string', () => {
  const source = readFileSync('src/components/adminOperations/StockOperationsPanel.tsx', 'utf8');
  const start = source.indexOf('{returnUnits.length > 0 ? <div className="inventory-line mt-4">');
  const end = source.indexOf('</div> : returnOrigins.length > 0', start);
  assert.ok(start > 0 && end > start, 'block found');
  const calls = locCalls(source.slice(start, end));
  assert.ok(calls.length >= 11);
  assert.deepEqual(calls.filter((c) => c.args < 3).map((c) => c.text), []);
});
