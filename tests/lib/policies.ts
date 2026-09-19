import { getPolicyDocument } from '../../worker/lib/policies';
import { CHECKOUT_POLICY_KEYS } from '../../worker/lib/policyOps';

/**
 * CONSENT AS THE CODE REGISTRY CURRENTLY STATES IT, never a hand-copied
 * version number.
 *
 * Policy text moved into worker/lib/policies/, so `getRequiredCheckoutPolicies`
 * answers from the registry rather than from whatever happened to be published
 * in the database. That is the fix — a deployment whose database was reset now
 * still gates checkout on terms and privacy — and it is also why every test
 * that posts to /api/orders has to carry consent, including the ones whose
 * fixtures never published a policy because nothing required them to.
 *
 * Deriving it here means a version bump in one document does not fail the
 * seven test files that post an order body.
 */
export const acceptedPolicies = (): Array<{ key: string; version: number }> =>
  CHECKOUT_POLICY_KEYS.flatMap((key) => {
    const doc = getPolicyDocument(key);
    return doc ? [{ key: doc.key, version: doc.version }] : [];
  });
