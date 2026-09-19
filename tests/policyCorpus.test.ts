import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  POLICY_DOCUMENTS,
  POLICY_KEYS,
  POLICY_SECTIONS,
  getPolicyDocument,
  isPolicyKey,
  policySectionOf,
} from '../worker/lib/policies';
import { POLICY_LANGS, policyDocHash } from '../worker/lib/policies/types';
import { CHECKOUT_POLICY_KEYS } from '../worker/lib/policyOps';

/**
 * THE CORPUS ITSELF — successor to tests/policyDrafts.test.ts.
 *
 * That file tested `POLICY_DRAFTS`: a table of unpublished drafts an admin
 * seeded through /api/policies/admin/seed-drafts and then published from a
 * form. The drafts, the endpoint and the form are all gone — policy text is
 * written in worker/lib/policies/ and deployed, and the owner's reason was
 * that anybody could edit it («يستطيع أي أحد التعديل عليها لا أريد ذلك»).
 *
 * What SURVIVES from it is every assertion that was really about the text
 * rather than about the drafting workflow: that each document exists in three
 * languages, that none of it is transplanted from a manufacturer, that it
 * claims no legal compliance, and that the content hash is deterministic. Those
 * are restated here against the registry. What is dropped is the draft banner
 * (a published document must not carry one) and the fixed 25-section shape of
 * the terms (the corpus now numbers its own parts and the reader builds the
 * table of contents from the headings).
 */

test('the registry is the whole corpus: every key resolves, and every document sits in exactly one section', () => {
  assert.equal(new Set(POLICY_KEYS).size, POLICY_KEYS.length);
  assert.equal(POLICY_DOCUMENTS.length, POLICY_KEYS.length);

  for (const key of POLICY_KEYS) {
    assert.ok(isPolicyKey(key));
    assert.ok(getPolicyDocument(key), `${key} does not resolve`);
    const sections = POLICY_SECTIONS.filter((s) => (s.keys as readonly string[]).includes(key));
    assert.equal(sections.length, 1, `${key} is in ${sections.length} sections`);
    assert.equal(policySectionOf(key), sections[0].id);
  }
  // A section listing a key the registry does not publish would render an
  // empty group on the library index.
  for (const section of POLICY_SECTIONS) {
    for (const key of section.keys) assert.ok(isPolicyKey(key), `section ${section.id} lists unknown key ${key}`);
  }
  // Consent is gated on documents that actually exist.
  for (const key of CHECKOUT_POLICY_KEYS) assert.ok(isPolicyKey(key), `checkout requires unknown key ${key}`);
});

test('every document is published in all three languages, with a title and a substantial body', () => {
  for (const doc of POLICY_DOCUMENTS) {
    assert.ok(doc.version >= 1, `${doc.key}: no version`);
    assert.match(doc.effective_at, /^\d{4}-\d{2}-\d{2}$/, `${doc.key}: effective_at is not a calendar date`);
    for (const lang of POLICY_LANGS) {
      const title = doc.title[lang];
      const body = doc.body[lang];
      assert.ok(title && title.trim().length >= 2, `${doc.key}/${lang}: no title`);
      assert.ok(body && body.trim().length >= 1000, `${doc.key}/${lang}: body too short to be the document`);
      assert.ok(/^## /m.test(body), `${doc.key}/${lang}: no headings`);
    }
  }
});

test('these are published documents, not drafts — no banner, no provisional language', () => {
  for (const doc of POLICY_DOCUMENTS) {
    for (const lang of POLICY_LANGS) {
      const body = doc.body[lang];
      // The old seeded drafts carried a ⚠️ "not yet binding" marker in every
      // language. A document the owner shows a bank must not.
      assert.ok(!body.includes('⚠'), `${doc.key}/${lang} still carries the draft banner`);
      assert.ok(!/\bdraft\b/i.test(body), `${doc.key}/${lang} calls itself a draft`);
    }
  }
});

test('the text is LEVONIS\'s own: no transplanted manufacturer identity, no compliance claims', () => {
  for (const doc of POLICY_DOCUMENTS) {
    for (const lang of POLICY_LANGS) {
      const body = doc.body[lang].toLowerCase();
      const title = doc.title[lang].toLowerCase();
      for (const banned of ['bambu lab', 'bambulab.com', 'makerworld']) {
        assert.ok(!body.includes(banned) && !title.includes(banned), `${doc.key}/${lang} references ${banned}`);
      }
    }
    // A shop cannot certify its own legal compliance in its own terms.
    for (const claim of ['fully compliant', 'gdpr-compliant', 'gdpr compliant']) {
      assert.ok(!doc.body.en.toLowerCase().includes(claim), `${doc.key}/en claims compliance: ${claim}`);
    }
  }
});

test('nothing about this shop is invented: every unknown fact is a named placeholder', () => {
  // A registration number or a support line the code does not hold is worse
  // than a blank in a document shown to a bank, so the corpus leaves a
  // `{{PLACEHOLDER}}`. This pins the FORM of them, so a half-substituted or
  // lowercase template token is caught rather than shipped as prose.
  const seen = new Set<string>();
  for (const doc of POLICY_DOCUMENTS) {
    for (const lang of POLICY_LANGS) {
      for (const match of doc.body[lang].matchAll(/\{\{([^}]*)\}\}/g)) {
        seen.add(match[1]);
        assert.match(match[1], /^[A-Z][A-Z0-9_]*$/, `${doc.key}/${lang}: malformed placeholder {{${match[1]}}}`);
      }
      // A lone brace pair is a substitution that went wrong.
      assert.ok(!/\{\{\s*\}\}/.test(doc.body[lang]), `${doc.key}/${lang}: empty placeholder`);
    }
  }
  assert.ok(seen.size > 0, 'the corpus states every operational fact — verify that is true before deleting this');
  // The placeholder set is a to-do list for the owner; it is asserted to be
  // trilingual so a fact filled in Arabic alone cannot leave the other two
  // languages silently promising something different.
  for (const doc of POLICY_DOCUMENTS) {
    const per = POLICY_LANGS.map((lang) => new Set([...doc.body[lang].matchAll(/\{\{([^}]*)\}\}/g)].map((m) => m[1])));
    for (const name of per[0]) {
      assert.ok(per[1].has(name) && per[2].has(name), `${doc.key}: {{${name}}} is missing from a translation`);
    }
  }
});

test('the two owner rules the whole corpus turns on', () => {
  const doc = (key: string) => POLICY_DOCUMENTS.find((d) => d.key === key)!;

  // ONE: the return window and the warranty both run from the recorded
  // DELIVERY date, never the order date — which is what returns.ts and
  // warranty.ts actually read (`orders.delivered_at`).
  for (const key of ['returns', 'warranty', 'extended_warranty']) {
    assert.ok(doc(key).body.ar.includes('تاريخ التسليم المسجل'), `${key}/ar does not anchor on the recorded delivery date`);
    assert.ok(doc(key).body.en.includes('recorded delivery date'), `${key}/en does not anchor on the recorded delivery date`);
  }

  // TWO: a community-store order is prepaid from the wallet — no cash on
  // delivery and no warehouse pickup on that path.
  const community = doc('community');
  assert.ok(community.body.ar.includes('الدفع المسبق من المحفظة'), 'community/ar does not state wallet prepayment');
  assert.ok(/no cash on delivery/i.test(community.body.en), 'community/en does not rule out cash on delivery');
});

test('policyDocHash is deterministic and content-sensitive', async () => {
  const a = await policyDocHash('terms', 1, 'ar', 'T', 'body');
  const b = await policyDocHash('terms', 1, 'ar', 'T', 'body');
  assert.equal(a, b);
  assert.match(a, /^[0-9a-f]{64}$/);
  for (const other of [
    await policyDocHash('terms', 1, 'ar', 'T', 'body!'),
    await policyDocHash('terms', 2, 'ar', 'T', 'body'),
    await policyDocHash('terms', 1, 'en', 'T', 'body'),
    await policyDocHash('privacy', 1, 'ar', 'T', 'body'),
    await policyDocHash('terms', 1, 'ar', 'T!', 'body'),
  ]) {
    assert.notEqual(a, other);
  }
});
