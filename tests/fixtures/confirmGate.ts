/**
 * THE SHEET'S LIVE GATE SAYS WHAT THE SERVER ANSWERS (docs/SMART_PRICING.md §4.9; ConfirmSheet's
 * `measureHold`). Before a confirmation is sent, `GET /estimates/products/:id` — the very read the sheet makes
 * when it opens — answers `confirm_gate`: the options the confirmation will refuse on default measures, whether
 * that refusal will say the refresh's apply is the cure, and the statement on offer. `confirmThroughGate` reads
 * it, sends the confirmation, and holds the two to each other, for the whole product and for chosen options.
 */
import assert from 'node:assert/strict';
import { get, json, post, type App } from './app';
import { measureHold } from '../../src/components/adminEstimates/ConfirmSheet';
import type { StoredEstimate } from '../../src/components/adminEstimates/api';

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/** POST `path` (…/products/:id/confirm) with `body`, after reading the product's gate; asserts they agree. */
export async function confirmThroughGate(app: App, path: string, body: Json): Promise<{ status: number; body: Json }> {
  const read = (await json(await get(app, path.replace(/\/confirm$/, '')))).product as (StoredEstimate & Json) | undefined;
  const res = await post(app, path, body);
  const answer = { status: res.status, body: (await json(res)) as Json };
  const gate = read?.confirm_gate;
  // A statement sent with it changes what step 1 reads (tests/priceEstimateAttest.test.ts holds that path).
  if (!read || read.state !== 'estimated' || body.real_measures !== undefined) return answer;
  if (answer.body.code === 'PRICING_CHANGED' || answer.body.code === 'PRICE_ESTIMATE_NOT_ELIGIBLE') return answer;
  assert.ok(gate, `an estimated product's read carries its gate: ${JSON.stringify(read).slice(0, 200)}`);
  const keys: string[] | null = Array.isArray(body.combo_keys) ? body.combo_keys : null;
  const held = gate.defaulted.filter((k: string) => !keys || keys.includes(k)).sort();
  const hold = measureHold(read, keys ? new Set(keys) : null);
  const label = `${path} ${JSON.stringify(keys)}`;
  if (answer.body.code === 'PRICE_ESTIMATE_DEFAULT_MEASURES') {
    assert.deepEqual(held, answer.body.details?.combo_keys, `${label}: the gate names the options refused`);
    const waiting = held.length > 0 && held.every((k: string) => (gate.waiting_keys ?? []).includes(k));
    assert.equal(waiting, answer.body.details?.waiting_on_apply === true, `${label}: the gate says when the apply is the cure`);
    assert.equal(hold.hard, true, `${label}: the sheet holds it`);
  } else if (answer.status === 200 || answer.body.code === 'PRICE_ESTIMATE_FLAGS_OPEN') {
    // Step 1 passed: nothing the confirmation targets is on a default measure, and the sheet holds nothing.
    assert.deepEqual(held, [], `${label}: the gate holds nothing the server accepts`);
    assert.equal(hold.hard, false, `${label}: the sheet does not hold it`);
  }
  return answer;
}
