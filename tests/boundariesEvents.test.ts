/**
 * Every event emitted anywhere in this repository is an event
 * `packages/contracts` knows about, produced by a service the catalogue lists
 * as its producer (`01-TARGET.md` §5, `03-EVENTS.md` §1–§2, ADR-005, ADR-010).
 *
 * WHY A SEPARATE TEST. `tests/eventSchemas.test.ts` proves the CATALOGUE is
 * coherent — every schema has a fixture, every consumer has a schema, every
 * type has a producer. It cannot see the code. This one goes the other way:
 * it reads every emitter call site in `worker/` and `services/<name>/src` and holds
 * the argument the emitter was actually handed against that catalogue.
 *
 * The three ways an emitted event could be wrong, and how each is caught:
 *
 *  1. **An event nobody declared.** The schema argument must be a
 *     `<Type>V1` binding imported from `@levonis/contracts/events/v1/<Type>`,
 *     and `<Type>.v1` must exist in `EVENT_SCHEMAS`. An inline object, a bare
 *     string type, or a locally defined schema is a violation — those are how
 *     an event with no fixture, no PII annotation and no consumer entry gets
 *     onto the bus, where every consumer will refuse it as `invalid` and the
 *     producer will retry it eight times before marking it dead.
 *  2. **The wrong producer.** `PRODUCERS[key]` is verified BY SIGNATURE on
 *     every delivery, in rpc and queue mode alike. A service emitting a type it
 *     is not a declared producer of ships an event that every consumer refuses
 *     as `forged` — a failure that only appears in the consumers' delivery
 *     rows, in production, on a Worker nobody is watching.
 *  3. **A consumer that is not subscribed.** A service whose `OWNERSHIP.json`
 *     lists a `consumes` entry the subscriptions table does not route to it
 *     will simply never receive it, and no test anywhere would have failed.
 *
 * The scanner is exercised against inline samples first, so a green run is a
 * proof of the rules rather than of an empty loop — and the file counts the
 * call sites it found and fails if there are none.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EVENT_SCHEMAS } from '@levonis/contracts/events/index';
import { SUBSCRIPTIONS, PRODUCERS, ANY_PRODUCER } from '@levonis/contracts/subscriptions';
import { listServices, readManifest, tsFiles } from './lib/boundaries';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The emitters. Every one of them takes the schema as an argument, which is
 * the point of the design: an event is published by handing over the contract
 * object, so "publishing something the contracts do not describe" has to be
 * written deliberately rather than reached by accident.
 */
const EMITTERS = ['emitEvent', 'emitBestEffort', 'emitFromRequest', 'outboxStatement', 'publishStatement', 'publishEvent'];

export interface EmitCall {
  emitter: string;
  /** The argument in the schema position, verbatim. */
  schemaArg: string;
  line: number;
}

/**
 * Find emitter calls and the argument in the schema position.
 *
 * The schema is the argument that looks like a contract binding, so the parser
 * does not have to count commas through nested object literals: it takes the
 * text up to the first `{` or `(` after the call and picks the last bare
 * identifier in it. A call whose schema position holds anything else yields
 * that text verbatim, which is what makes the violation legible.
 */
export function emitCalls(src: string): EmitCall[] {
  const out: EmitCall[] = [];
  const lineOf = (index: number) => src.slice(0, index).split('\n').length;
  for (const emitter of EMITTERS) {
    const re = new RegExp(`(?<![A-Za-z0-9_.])${emitter}\\s*\\(`, 'g');
    for (const m of src.matchAll(re)) {
      const start = m.index! + m[0].length;
      // Up to the first object literal / call / closing paren: the plain
      // arguments, which is where the schema binding is.
      const head = src.slice(start, start + 400).split(/[{()]/)[0];
      const args = head.split(',').map((a) => a.trim()).filter(Boolean);
      const schema = args.find((a) => /^[A-Z][A-Za-z0-9]*V\d+$/.test(a)) ?? args[1] ?? args[0] ?? '';
      out.push({ emitter, schemaArg: schema, line: lineOf(m.index!) });
    }
  }
  return out.sort((a, b) => a.line - b.line);
}

/** `@levonis/contracts/events/v1/<Type>` imports in a file, by local name. */
export function contractEventImports(src: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of src.matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*['"]@levonis\/contracts\/events\/v1\/([A-Za-z0-9]+)['"]/g)) {
    for (const raw of m[1].split(',')) {
      const name = raw.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0].trim();
      if (name) out.set(name, m[2]);
    }
  }
  return out;
}

/**
 * True for the module that DEFINES the emitters rather than using them
 * (`worker/lib/eventBus.ts` today). Its own `outboxStatement(db, schema, …)`
 * forwards a schema its caller chose, so scanning it would report the generic
 * parameter as an undeclared event. The exclusion is narrow on purpose and the
 * suite asserts how many modules it hides — a second one appearing is a real
 * finding, not a convenience.
 */
export function declaresEmitter(src: string): boolean {
  return EMITTERS.some((name) => new RegExp(`^\\s*(?:export\\s+)?(?:async\\s+)?function\\s+${name}\\b`, 'm').test(src));
}

/** `<Type>V1` -> the catalogue key `<Type>.v1`. */
export const keyOf = (binding: string): string => `${binding.replace(/V(\d+)$/, '')}.v${/V(\d+)$/.exec(binding)?.[1] ?? '1'}`;

// ------------------------------------------------------------- the scanner
test('the scanner finds the schema argument through nested object literals, and reports anything that is not one', () => {
  const good = `
    import { OrderCreatedV1 } from '@levonis/contracts/events/v1/OrderCreated';
    import { AddToCartV1 } from '@levonis/contracts/events/v1/AddToCart';
    const s = await outboxStatement(db, OrderCreatedV1, { order_id: id, items: [{ sku: 'a', qty: 1 }] }, { aggregate: 'order' });
    await emitBestEffort(env.DB, AddToCartV1, { product_id: p }, { waitUntil });
  `;
  assert.deepEqual(emitCalls(good).map((c) => [c.emitter, c.schemaArg]), [
    ['outboxStatement', 'OrderCreatedV1'],
    ['emitBestEffort', 'AddToCartV1'],
  ]);
  const imports = contractEventImports(good);
  assert.equal(imports.get('OrderCreatedV1'), 'OrderCreated');
  assert.equal(imports.get('AddToCartV1'), 'AddToCart');
  assert.equal(keyOf('OrderCreatedV1'), 'OrderCreated.v1');

  const bad = `const localSchema = defineEvent({ type: 'Homegrown' });\nawait emitEvent(db, localSchema, {}, {});`;
  assert.deepEqual(emitCalls(bad).map((c) => c.schemaArg), ['localSchema']);
  // a method of the same name on an object is not the free function
  assert.deepEqual(emitCalls('bus.emitEvent(db, XV1, {}, {});'), []);
});

// ------------------------------------------------------- the tree, for real
interface Emission {
  producer: string;
  file: string;
  call: EmitCall;
  importedFrom: string | undefined;
}

const emitterModules: string[] = [];

function scanTree(): Emission[] {
  const out: Emission[] = [];
  emitterModules.length = 0;
  const collect = (producer: string, dir: string) => {
    for (const file of tsFiles(dir)) {
      const rel = relative(ROOT, file).split(sep).join('/');
      // The kit and the contracts DEFINE the emitters; they emit nothing.
      if (rel.startsWith('packages/')) continue;
      const src = readFileSync(file, 'utf8');
      if (declaresEmitter(src)) {
        emitterModules.push(rel);
        continue;
      }
      const calls = emitCalls(src);
      if (!calls.length) continue;
      const imports = contractEventImports(src);
      for (const call of calls) out.push({ producer, file: rel, call, importedFrom: imports.get(call.schemaArg) });
    }
  };
  collect('core', join(ROOT, 'worker'));
  for (const svc of listServices(ROOT)) {
    const manifest = readManifest(join(ROOT, 'services', svc));
    collect(manifest?.service ?? svc, join(ROOT, 'services', svc, 'src'));
  }
  return out;
}

test('every emitted event is a contract event, imported from the contracts, and this producer is a declared producer of it', () => {
  const emissions = scanTree();
  assert.ok(
    emissions.length > 0,
    'no emitter call site was found anywhere — either the emitters were renamed (update EMITTERS) or this suite is proving nothing'
  );
  const violations: string[] = [];
  for (const { producer, file, call, importedFrom } of emissions) {
    const where = `${file}:${call.line} (${call.emitter})`;
    if (!/^[A-Z][A-Za-z0-9]*V\d+$/.test(call.schemaArg)) {
      violations.push(`${where}: publishes "${call.schemaArg}", which is not a contract event binding — an event with no schema, no fixture and no PII annotation is refused by every consumer`);
      continue;
    }
    const key = keyOf(call.schemaArg);
    if (!importedFrom) {
      violations.push(`${where}: ${call.schemaArg} is not imported from @levonis/contracts/events/v1/… in this file`);
      continue;
    }
    if (`${importedFrom}V1` !== call.schemaArg && importedFrom !== call.schemaArg.replace(/V\d+$/, '')) {
      violations.push(`${where}: ${call.schemaArg} is imported from events/v1/${importedFrom} — the binding and the module disagree`);
    }
    if (!EVENT_SCHEMAS[key]) {
      violations.push(`${where}: "${key}" is not in EVENT_SCHEMAS — add the schema, its fixture and its subscriptions row first`);
      continue;
    }
    const producers = PRODUCERS[key] ?? [];
    if (!producers.includes(producer) && !producers.includes(ANY_PRODUCER)) {
      violations.push(
        `${where}: "${producer}" emits ${key}, but PRODUCERS lists ${producers.join(', ') || 'nobody'} — ` +
          'every consumer verifies the producer by signature, so this event would be refused as forged'
      );
    }
  }
  assert.deepEqual(violations, [], violations.join('\n'));
  // The exclusion above hides exactly one module. A second one means somebody
  // wrote a second dispatcher, which is a design change, not a lint detail.
  assert.deepEqual(emitterModules, ['worker/lib/eventBus.ts'], `the emitter definition modules changed: ${emitterModules.join(', ')}`);
});

test('the core really is emitting the events slice 1.6 says it emits, so this suite cannot pass by scanning nothing', () => {
  // A list, not a count: a count drifts and a rename would silently shrink it.
  const fromCore = new Set(
    scanTree().filter((e) => e.producer === 'core' && /^[A-Z]/.test(e.call.schemaArg)).map((e) => keyOf(e.call.schemaArg))
  );
  for (const key of [
    'UserCreated.v1', 'ReferralUsed.v1', 'AddToCart.v1', 'ProductViewed.v1', 'ProductAdded.v1', 'InventoryChanged.v1',
    'CheckoutStarted.v1', 'OrderCreated.v1', 'PaymentAuthorized.v1', 'PaymentCompleted.v1', 'PaymentFailed.v1',
    'RefundCompleted.v1', 'OrderStatusChanged.v1', 'OrderDelivered.v1', 'SubscriptionChanged.v1',
  ]) {
    assert.ok(fromCore.has(key), `the core no longer emits ${key} — plan 1.6 lists it, and removing an emitter is a contract change`);
  }
});

test('every event a service says it consumes is routed to it, and has a schema', () => {
  const violations: string[] = [];
  for (const svc of listServices(ROOT)) {
    const dir = join(ROOT, 'services', svc);
    if (!existsSync(join(dir, 'wrangler.jsonc'))) continue;
    const manifest = readManifest(dir);
    if (!manifest) continue;
    const name = manifest.service ?? svc;
    for (const key of manifest.consumes ?? []) {
      if (!EVENT_SCHEMAS[key]) {
        violations.push(`services/${svc}: consumes "${key}", which has no schema in packages/contracts`);
        continue;
      }
      if (!(SUBSCRIPTIONS[key] ?? []).includes(name as never)) {
        violations.push(`services/${svc}: consumes "${key}", but SUBSCRIPTIONS does not route it to "${name}" — it would never arrive`);
      }
    }
    for (const key of manifest.publishes ?? []) {
      if (!EVENT_SCHEMAS[key]) {
        violations.push(`services/${svc}: publishes "${key}", which has no schema in packages/contracts`);
        continue;
      }
      const producers = PRODUCERS[key] ?? [];
      if (!producers.includes(name) && !producers.includes(ANY_PRODUCER)) {
        violations.push(`services/${svc}: publishes "${key}", but PRODUCERS does not list "${name}"`);
      }
    }
  }
  assert.deepEqual(violations, [], violations.join('\n'));
});
