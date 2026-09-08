/**
 * `scripts/lib/sign.mjs` is a second implementation of the platform kit's
 * Ed25519 token layout, and it exists for one reason: `scripts/e2e-dark.mjs`
 * runs under plain `node`, which cannot import the kit's TypeScript sources.
 *
 * A second implementation of a signature format is a liability unless it is
 * pinned to the first, so this suite pins it: the same payload signed with
 * both must be byte-identical, the `kid` derivation must agree, and what the
 * script mints must satisfy `verifyPrincipal` — the function Audit and
 * Analytics actually run on the header the end-to-end run sends them.
 *
 * If the canonical form, the header shape or the `kid` rule ever changes, this
 * goes red before the rig can quietly authenticate against a format the
 * services no longer speak.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  generateKeyPair as kitGenerate,
  importSigningKey as kitImport,
  signCompact as kitSign,
  kidOf as kitKid,
  KeyRing,
} from '@levonis/platform-kit/keys';
import { verifyPrincipal } from '@levonis/platform-kit/principal';
import { canonicalJson as kitCanonical, b64urlDecode as kitDecode } from '@levonis/contracts/canonical';
// @ts-expect-error - plain ESM helper shared with the deploy scripts, no types
import { generateKeyPair, importSigningKey, signCompact, canonicalJson, buildPrincipal, kidOf, b64urlDecode } from '../scripts/lib/sign.mjs';

const SAMPLE = { z: 1, a: { d: [3, 2, 1], b: 'x' }, m: null, n: false };

test('the script canonicalises exactly as the contracts package does', () => {
  assert.equal(canonicalJson(SAMPLE), kitCanonical(SAMPLE));
  assert.equal(canonicalJson([{ b: 1, a: 2 }]), kitCanonical([{ b: 1, a: 2 }]));
  assert.equal(canonicalJson({ keep: 1, drop: undefined }), kitCanonical({ keep: 1, drop: undefined }));
});

test('the script derives the same kid from the same public key', async () => {
  const pair = await kitGenerate();
  assert.equal(await kidOf(b64urlDecode(pair.publicKeyB64)), await kitKid(kitDecode(pair.publicKeyB64)));
  assert.equal(await kidOf(b64urlDecode(pair.publicKeyB64)), pair.kid);
});

test('the same payload signed by both implementations is byte-identical', async () => {
  // Ed25519 is deterministic (RFC 8032), so "identical" is a real assertion
  // here rather than a coincidence of one run.
  const material = await generateKeyPair();
  const mine = await importSigningKey(material.privateKeyB64, material.publicKeyB64);
  const theirs = await kitImport(material.privateKeyB64, material.publicKeyB64);
  assert.equal(mine.kid, theirs.kid);
  assert.equal(await signCompact(mine, SAMPLE), await kitSign(theirs, SAMPLE));
});

test('a principal the script mints is accepted by the verifier the services run', async () => {
  const material = await generateKeyPair();
  const key = await importSigningKey(material.privateKeyB64, material.publicKeyB64);
  const now = Math.floor(Date.now() / 1000);
  const header = await signCompact(
    key,
    buildPrincipal({ sub: 'usr_1', role: 'admin', scope: 'full', host_kind: 'main', cid: 'cid-1' }, now)
  );
  // The ring the consumers build from `ALLOWED_CALLER_KIDS` — `core` is the
  // issuer until Identity is its own Worker (`PRINCIPAL_ISSUERS`).
  const ring = await KeyRing.fromAllowlist(`core:${material.kid}:${material.publicKeyB64}`);
  const v = await verifyPrincipal(header, ring, { nowSeconds: now, issuers: ['identity', 'core'], expectHostKind: 'main' });
  assert.equal(v.ok, true);
  if (v.ok) {
    assert.equal(v.principal.sub, 'usr_1');
    assert.equal(v.principal.role, 'admin');
    assert.equal(v.principal.scope, 'full');
  }
});

test('a principal signed by a key the ring does not hold is refused', async () => {
  const mint = await generateKeyPair();
  const other = await generateKeyPair();
  const key = await importSigningKey(mint.privateKeyB64, mint.publicKeyB64);
  const now = Math.floor(Date.now() / 1000);
  const header = await signCompact(key, buildPrincipal({ sub: 'usr_1', role: 'admin', scope: 'full', cid: 'c' }, now));
  const ring = await KeyRing.fromAllowlist(`core:${other.kid}:${other.publicKeyB64}`);
  const v = await verifyPrincipal(header, ring, { nowSeconds: now, issuers: ['identity', 'core'] });
  assert.equal(v.ok, false);
  if (!v.ok) assert.equal(v.reason, 'UNKNOWN_KID');
});
