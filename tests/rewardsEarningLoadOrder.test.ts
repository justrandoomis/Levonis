/**
 * THE ORDER MODULES LOAD IN MUST NOT MATTER TO «WHO EARNS» (DECISIONS row 298).
 *
 * worker/lib/rewards/earning.ts sits on an import cycle through services/myDevices.
 * When its fragments were constants built at load, a process that entered at
 * myDevices or at routes/devices read `inShopSql` before its module had run and died
 * with a ReferenceError, while worker/index.ts happened to load in a kinder order. So
 * the shop's own entry worked, and one reordered import from a crash at start-up.
 *
 * The first import below IS the test: this file does not load if that returns.
 */
import { inShopSql } from '../worker/lib/services/myDevices';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { tradedInSql } from '../worker/lib/deviceCustody';
import { slotChainUnitIds, slotInShopSql, slotJoins, slotNotRefundedSql, slotOpenSql, slotStoppedSql, slotTradedInSql, slotWarrantyEndSql } from '../worker/lib/rewards/earning';

const source = readFileSync(new URL('../worker/lib/rewards/earning.ts', import.meta.url), 'utf8');

test('entered at myDevices, the fragments load, and they are the shared tests themselves', () => {
  assert.equal(slotInShopSql(), inShopSql('d'));
  assert.equal(slotTradedInSql(), tradedInSql('d'));
  for (const fragment of [slotChainUnitIds(), slotJoins(), slotNotRefundedSql(), slotOpenSql(), slotWarrantyEndSql()]) {
    assert.ok(fragment.length > 0);
  }
  const stopped = slotStoppedSql({ now: '?1', months: '?3' });
  assert.ok(stopped.includes(inShopSql('d')), 'the screens read the same test the sweep runs');
  assert.ok(stopped.includes(tradedInSql('d')));
});

test('earning.ts builds nothing at load: its only constants are plain text, the rest are functions', () => {
  const constants = [...source.matchAll(/^(?:export )?const (\w+)(?:: [^=\n]+)? = (?!\()/gm)].map((m) => m[1]).sort();
  assert.deepEqual(constants, ['SLOT_IS_PRINTER_SQL', 'SLOT_SOLD_HERE_SQL']);
  for (const name of constants) {
    const body = new RegExp(`const ${name} = \`([^\`]*)\``).exec(source)?.[1] ?? '';
    assert.ok(body.length > 0, name);
    assert.doesNotMatch(body, /\$\{/, `${name} is plain text`);
  }
});
