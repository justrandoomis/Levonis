import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  POLICY_DRAFTS,
  POLICY_KEYS,
  POLICY_LANGS,
  CHECKOUT_POLICY_KEYS,
  policyDocHash,
} from '../worker/lib/policyOps';

test('drafts cover every required policy key exactly once', () => {
  const keys = POLICY_DRAFTS.map((d) => d.key);
  assert.deepEqual([...keys].sort(), [...POLICY_KEYS].sort());
  assert.equal(new Set(keys).size, keys.length);
  // The checkout-gating keys must be part of the draft set.
  for (const k of CHECKOUT_POLICY_KEYS) assert.ok(keys.includes(k), `missing checkout key ${k}`);
});

test('every draft has all three languages with a visible draft banner', () => {
  for (const d of POLICY_DRAFTS) {
    for (const lang of POLICY_LANGS) {
      const title = d.title[lang];
      const body = d.body[lang];
      assert.ok(title && title.length >= 2, `${d.key}/${lang} title missing`);
      assert.ok(body && body.length >= 200, `${d.key}/${lang} body too short`);
      // Explicit not-yet-binding draft marker in every language.
      assert.ok(body.includes('⚠️'), `${d.key}/${lang} missing the draft banner`);
    }
  }
});

test('drafts are original LEVONIS text — no transplanted Bambu identity or compliance claims', () => {
  for (const d of POLICY_DRAFTS) {
    for (const lang of POLICY_LANGS) {
      const body = d.body[lang].toLowerCase();
      const title = d.title[lang].toLowerCase();
      for (const banned of ['bambu lab', 'bambulab.com', 'makerworld']) {
        assert.ok(!body.includes(banned) && !title.includes(banned), `${d.key}/${lang} references ${banned}`);
      }
      // No blanket legal-compliance assertion in the English drafts.
      if (lang === 'en') {
        assert.ok(!body.includes('fully compliant'), `${d.key}/en claims compliance`);
        assert.ok(!body.includes('gdpr-compliant'), `${d.key}/en claims compliance`);
      }
    }
  }
});

test('policyDocHash is deterministic and content-sensitive', async () => {
  const a = await policyDocHash('terms', 1, 'ar', 'T', 'body');
  const b = await policyDocHash('terms', 1, 'ar', 'T', 'body');
  const c = await policyDocHash('terms', 1, 'ar', 'T', 'body!');
  const d = await policyDocHash('terms', 2, 'ar', 'T', 'body');
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.notEqual(a, d);
  assert.match(a, /^[0-9a-f]{64}$/);
});


test('purchase terms cover all 25 sections in all three locales', () => {
  const terms = POLICY_DRAFTS.find((d) => d.key === 'terms')!;
  for (const lang of POLICY_LANGS) {
    const sections = [...terms.body[lang].matchAll(/^## (\d+)\./gm)].map((m) => Number(m[1]));
    assert.deepEqual(sections, Array.from({length:25}, (_, i) => i + 1), lang);
  }
});
