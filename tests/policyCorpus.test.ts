import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  POLICY_DOCUMENTS,
  POLICY_SOURCE_DOCUMENTS,
  POLICY_KEYS,
  POLICY_SECTIONS,
  getPolicyDocument,
  isPolicyKey,
  policySectionOf,
} from '../worker/lib/policies';
import { POLICY_LANGS, policyDocHash } from '../worker/lib/policies/types';
import { publishedPolicyBody } from '../worker/lib/policies/render';
import { CHECKOUT_POLICY_KEYS } from '../worker/lib/policyOps';
import { asD1, freshDb } from './fixtures/app';
import { ROOT } from './fixtures/d1';
import { ensurePolicyCorpus, resetPolicyCorpusMemo } from '../worker/lib/policySync';

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
  // than a blank in a document shown to a bank, so the SOURCE corpus leaves a
  // `{{PLACEHOLDER}}`. This pins the FORM of them, so a half-substituted or
  // lowercase template token is caught rather than shipped as prose.
  //
  // POLICY_SOURCE_DOCUMENTS, not POLICY_DOCUMENTS: the placeholders are the
  // owner's to-do list and they stay in the modules, but a customer never sees
  // one — worker/lib/policies/render.ts withholds the line that carries it,
  // and the test below is what proves that.
  const seen = new Set<string>();
  for (const doc of POLICY_SOURCE_DOCUMENTS) {
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
  for (const doc of POLICY_SOURCE_DOCUMENTS) {
    const per = POLICY_LANGS.map((lang) => new Set([...doc.body[lang].matchAll(/\{\{([^}]*)\}\}/g)].map((m) => m[1])));
    for (const name of per[0]) {
      assert.ok(per[1].has(name) && per[2].has(name), `${doc.key}: {{${name}}} is missing from a translation`);
    }
  }
});

/**
 * THE STORE HAS ONE NAME AND IT IS LATIN. The corpus used to transliterate it
 * into each script — «ليفونيس» in Arabic, «لێڤۆنیس» in Sorani — while the
 * English text, the logo, the domain and article 11.2's own trademark clause
 * all said «Levonis». The owner photographed the mismatch on the policies
 * page. A mark that is spelled three ways is three marks, and the one clause
 * in the corpus that exists to protect it was naming a form nothing else used.
 *
 * The library's own subtitle sits outside the registry and is checked from
 * source, because it is rendered on the SAME page directly above these
 * documents and a fix that missed it would be visible in the same photograph.
 */
test('the store is «Levonis» in every language — the transliteration is not published', () => {
  // BOTH Sorani spellings, because the corpus really used both and a
  // find-and-replace that knew about one of them left the other shipping: the
  // second letter is ێ (U+06CE) in some bodies and ی (U+06CC) in others, and
  // they are different code points, so a guard naming one is green while the
  // other is published. selling/ckb carried 12 of the ی form, purchase/ckb 6
  // and payment/ckb 2 while the ar and en bodies of those SAME documents
  // already read «Levonis».
  for (const script of ['ليفونيس', 'لێڤۆنیس', 'لیڤۆنیس']) {
    for (const doc of POLICY_SOURCE_DOCUMENTS) {
      for (const lang of POLICY_LANGS) {
        assert.ok(!doc.body[lang].includes(script), `${doc.key}/${lang} still transliterates the store name`);
        assert.ok(!doc.title[lang].includes(script), `${doc.key}/${lang} titles the transliterated name`);
      }
    }
    const strings = readFileSync(join(ROOT, 'src/components/policies/policyStrings.tsx'), 'utf8');
    assert.ok(!strings.includes(script), 'the policy library subtitle still transliterates the store name');
  }
  // Article 11.2 protects three distinct forms and must keep naming all three.
  const terms = POLICY_DOCUMENTS.find((d) => d.key === 'terms')!;
  for (const lang of POLICY_LANGS) {
    for (const mark of ['Levonis', 'LEVONIS', 'LEVO']) {
      assert.ok(terms.body[lang].includes(mark), `terms/${lang}: the trademark clause dropped «${mark}»`);
    }
  }
});

/**
 * THE PUBLISHED TEXT CARRIES NO TEMPLATE TOKEN. This is the assertion the
 * corpus never had, and the gap was photographed by the owner: the Terms page
 * showed «يسري على هذه الشروط … قانون {{GOVERNING_LAW_JURISDICTION}}» and
 * «تختص {{COMPETENT_COURT}} بنظر النزاع» to the public.
 *
 * POLICY_DOCUMENTS is what worker/routes/policies.ts serves, what
 * worker/lib/policySync.ts archives and what ./types.ts hashes, so asserting
 * on it here covers every path a customer's eyes or a court's copy can reach.
 */
test('no published policy shows a customer a template token', () => {
  for (const doc of POLICY_DOCUMENTS) {
    for (const lang of POLICY_LANGS) {
      assert.ok(!/\{\{/.test(doc.body[lang]), `${doc.key}/${lang} publishes a placeholder`);
      assert.ok(!/\{\{/.test(doc.title[lang]), `${doc.key}/${lang} titles a placeholder`);
    }
  }
});

/**
 * WITHHOLDING NEVER LEAVES A HEADING WITH NOTHING UNDER IT, and never empties
 * a document. An `### 18.1 القانون الواجب التطبيق` whose only paragraph was
 * held back reads as a broken page, which is the same class of defect as the
 * token itself; and the three languages must lose the SAME articles, or a
 * customer who accepted the Arabic and argues in Kurdish is arguing from a
 * different contract.
 */
test('a withheld clause takes its heading with it, in all three languages alike', () => {
  const articles = (body: string) =>
    body.split('\n').filter((l) => l.startsWith('### ')).map((l) => l.slice(4).split(' ')[0]).join(',');
  for (const doc of POLICY_DOCUMENTS) {
    for (const lang of POLICY_LANGS) {
      const lines = doc.body[lang].split('\n');
      assert.ok(lines.some((l) => l.trim()), `${doc.key}/${lang} published empty`);
      lines.forEach((line, i) => {
        if (!line.startsWith('#')) return;
        const level = line.startsWith('### ') ? ['### ', '## '] : ['## '];
        let content = false;
        for (let j = i + 1; j < lines.length && !level.some((s) => lines[j].startsWith(s)); j++) {
          if (lines[j].trim()) content = true;
        }
        assert.ok(content, `${doc.key}/${lang}: heading «${line}» has nothing under it`);
      });
      assert.ok(!/\n{3,}/.test(doc.body[lang]), `${doc.key}/${lang}: withholding left a blank run`);
    }
    assert.equal(articles(doc.body.en), articles(doc.body.ar), `${doc.key}: en lost different articles from ar`);
    assert.equal(articles(doc.body.ckb), articles(doc.body.ar), `${doc.key}: ckb lost different articles from ar`);
  }
});

/**
 * A DOCUMENT WITH NO PLACEHOLDER MUST COME BACK BYTE FOR BYTE. The render pass
 * only ever deletes; if it ever rewrote, reflowed or trimmed a body it had no
 * business touching, every hash in `policy_documents` would move under a
 * version number that did not.
 */
test('the render pass is a no-op on text that states no unknown', () => {
  const sample = '## 1. عنوان\n\n### 1.1 مادة\nنص.\n\n- بند\n- بند آخر';
  assert.equal(publishedPolicyBody(sample), sample);
  for (const doc of POLICY_SOURCE_DOCUMENTS) {
    for (const lang of POLICY_LANGS) {
      if (/\{\{/.test(doc.body[lang])) continue;
      assert.equal(publishedPolicyBody(doc.body[lang]), doc.body[lang], `${doc.key}/${lang} was altered for nothing`);
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

/**
 * THE COD TAX IS A SETTING, SO NO DOCUMENT MAY QUOTE IT.
 *
 * `codTaxPerBlockIqd` / `codTaxBlockIqd` are `admin_settings` rows
 * (worker/lib/settings.ts, both in PUBLIC_SETTING_KEYS). The owner edits them
 * from the admin screen; packages/shipping/src/codTax.ts holds only the
 * unconfigured default and receives the rate as an argument.
 *
 * A `{{TOKEN}}` is not an escape hatch for a figure like this one.
 * worker/lib/policies/render.ts withholds every line that still carries a
 * placeholder, so a token can no longer reach the customer as literal braces
 * — but what the customer then gets is SILENCE, not the live rate, and the
 * clause would still have to be re-published by hand on every rate change.
 * That leaves exactly one way for these documents to stay true: state no
 * figure and defer to the checkout screen, the way article 3.3 already does
 * for the delivery fees.
 *
 * This is a regression test with a history. The charge was halved from six
 * thousand to three thousand per five hundred thousand and made configurable,
 * and delivery.ts, payment.ts and purchase.ts went on promising six thousand —
 * in all three languages, nine sentences, published and binding — because the
 * header note in delivery.ts said the figures were hardcoded constants. The
 * assertion below is what makes the next rate change harmless.
 */
test('no policy quotes a figure for the cash-on-delivery tax — it is an admin setting and the documents defer to checkout', () => {
  // Small numbers written out beside "dinars". The corpus spells its amounts
  // in words, so this catches a re-hardcoded rate in any of the three
  // languages. "five hundred thousand dinars" / «پێنج سەد هەزار دینار» /
  // «خمسمئة ألف دينار» do not match: the block word sits between.
  const QUOTED_DINARS: Record<string, RegExp> = {
    ar: /(ثلاثة|أربعة|خمسة|ستة|ستّة|سبعة|ثمانية|تسعة|عشرة)\s+آلاف\s+دينار/,
    en: /\b(three|four|five|six|seven|eight|nine|ten)\s+thousand\s+dinars\b/i,
    ckb: /(سێ|چوار|پێنج|شەش|حەوت|هەشت|نۆ|دە)\s+هەزار\s+دینار/,
  };
  // The sentence that imposes the charge, and the phrase that must replace the
  // figure in it: the screen the customer is actually looking at.
  const IMPOSES: Record<string, RegExp> = {
    ar: /ضريبة[^\n]*(الباب|التحصيل النقدي)|(الباب|عند الاستلام)[^\n]*ضريبة/,
    en: /tax[^\n]*(at the door|door)|(at the door)[^\n]*tax/i,
    ckb: /باج[^\n]*بەردەرگا|بەردەرگا[^\n]*باج/,
  };
  const DEFERS: Record<string, RegExp> = {
    ar: /شاشة الدفع/,
    en: /checkout/i,
    ckb: /شاشەی پارەدان/,
  };

  for (const key of ['delivery', 'payment', 'purchase']) {
    const doc = POLICY_DOCUMENTS.find((d) => d.key === key)!;
    for (const lang of POLICY_LANGS) {
      const body = doc.body[lang];
      const lines = body.split('\n').filter((line) => IMPOSES[lang].test(line));
      assert.ok(lines.length > 0, `${key}/${lang}: the cash-on-delivery charge is no longer described at all`);
      for (const line of lines) {
        assert.ok(
          !QUOTED_DINARS[lang].test(line),
          `${key}/${lang} states a fixed dinar figure for the door tax, which a settings change silently falsifies: ${line}`
        );
      }
      // Stating no figure is only half of it; the reader has to be told where
      // the real figure lives, or the clause is merely vague.
      assert.ok(
        lines.some((line) => DEFERS[lang].test(line)),
        `${key}/${lang}: the door-tax clause names no figure and does not point at the checkout screen either`
      );
    }
  }
});

// =========================================================================
// A DRAFT ROW MUST NOT LOOK LIKE A PUBLISHED ONE
// =========================================================================

test('a draft row does not count as present, and checkout is not blocked for ever', async () => {
  /**
   * THE REPORTED FAILURE: «وافقت على السياسة وضغطت تأكيد الطلب فإنه يفشل».
   *
   * `preparePolicyAcceptance` refuses unless it can read a row for the
   * required (key, version) with status='published'. `ensurePolicyCorpus`
   * runs immediately before it to make sure that row exists.
   *
   * But the sync's presence set was built from
   *     SELECT key, version, lang FROM policy_documents
   * with NO status filter — so a row sitting at status='draft' (which
   * worker/lib/policyPublication.ts writes before promoting) counted as
   * present. The sync then skipped the document, and `INSERT OR IGNORE`
   * could never create the published row because the draft already occupies
   * that (key, version, lang).
   *
   * The result is a checkout that refuses consent the customer really gave,
   * on every attempt, for ever — and a fresh database never reproduces it,
   * which is why every existing test passed while the live shop failed.
   */
  const raw = freshDb();
  const db = asD1(raw);
  resetPolicyCorpusMemo();

  // The shape the live database can be in: the row EXISTS, but as a draft.
  const doc = getPolicyDocument('terms')!;
  raw
    .prepare(
      `INSERT INTO policy_documents (id, key, version, lang, title, body, hash, status, published_at, effective_at)
       VALUES (?, 'terms', ?, 'ar', ?, ?, 'stale-hash', 'draft', NULL, NULL)`
    )
    .run('pol_draft_terms', doc.version, doc.title.ar, doc.body.ar);

  await ensurePolicyCorpus(db);

  const published = raw
    .prepare("SELECT COUNT(*) AS n FROM policy_documents WHERE key='terms' AND version=? AND lang='ar' AND status='published'")
    .get(doc.version) as { n: number };
  assert.equal(published.n, 1, 'the sync must leave a PUBLISHED terms row behind, not stop at the draft');
});
