/**
 * OWNER QUESTION Q7 (spec addendum A.14): bundles and mystery offers
 * (`composition` rows) carry a typed dinar price that V2 has no dollar method
 * for, so the clean start hides them with every other product
 * (`composition_pending`) until the owner answers how they are priced.
 *
 * A case that needs a LISTED composition is marked with this reason
 * (`{ todo: Q7 }`): it still runs and reports, but cannot fail the suite until
 * Q7 is answered and compositions are listed again. Cases that do not need a
 * listed composition stay ordinary tests.
 */
import { test as nodeTest, type TestContext } from 'node:test';

export const Q7 = 'Q7: compositions stay hidden until the owner answers how bundles and mystery offers are priced in dollars (addendum A.14)';

type Fn = (t: TestContext) => void | Promise<void>;

/** `test` with the Q7 mark: the same signature as node:test's `test(name, fn)`. */
export function q7Test(name: string, fn: Fn): void {
  void nodeTest(name, { todo: Q7 }, fn);
}
