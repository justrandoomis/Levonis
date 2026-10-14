/**
 * «تحديث البيانات» — ONE PRODUCT, ONE BATCH: ALL OF ITS CHANGES OR NONE
 * (docs/DECISIONS.md row 212; reproduced by the atomicity verifier of 317e878d).
 *
 * 317e878d applied a product too large for one batch in two: the product part,
 * a fresh comparison, then the pricing part. Between the two the product was
 * half-written, and it stayed so when the second part could not land — the
 * server even offered the split when it already knew the pricing part did not
 * fit (`parts.pricing.fits: false`), and the sheet's second step converted
 * typed dinars at a rate the owner had not read (it sent the FRESH preview
 * hash). The split is gone: past what D1's 1,000 leave, the apply is refused
 * with nothing written, the refusal carries counts only (no part, no token),
 * and the sheet makes one apply call per product.
 *
 *   (1) the verifier's edge world: a model renamed and both rules plus the
 *       shipping fields on 275 stored scopes — refused, nothing written, and no
 *       request (a `part` field included) writes half of it;
 *   (2) typed dinars apply only at the rate the owner read: after the rate
 *       moves, the owner's token is refused and nothing is written;
 *   (3) the sheet applies each product with ONE call, holding the card's own
 *       token and preview hash.
 *
 * Heavy (the edge world): run it on its own.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

test('(3) the sheet applies each product with ONE call: the card\'s own token and preview hash, no second step', () => {
  const src = readFileSync(join(process.cwd(), 'src/components/adminProducts/form/DataFileSheet.tsx'), 'utf8');
  const calls = [...src.matchAll(/'\/api\/admin\/template\/data-apply'/g)];
  assert.equal(calls.length, 1, 'one apply call site');
  assert.doesNotMatch(src, /\bpart:\s*'(document|pricing|all)'/, 'no part of a product is ever applied on its own');
  const at = src.indexOf("'/api/admin/template/data-apply'");
  const call = src.slice(at, src.indexOf('});', at));
  assert.match(call, /token: card\.token/);
  assert.match(call, /pricing_hash: card\.pricing\.preview_hash/);
});
