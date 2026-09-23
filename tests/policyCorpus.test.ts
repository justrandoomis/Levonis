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
import {
  POLICY_FACTS,
  PREMIUM_FREE_DELIVERY_MIN_IQD,
  PRO_FREE_DELIVERY_MIN_IQD,
  fillPolicyFacts,
} from '../worker/lib/policies/facts';
import { SETTING_DEFAULTS } from '../worker/lib/settings';
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
  // POLICY_SOURCE_DOCUMENTS, not POLICY_DOCUMENTS: the placeholders stay in
  // the modules, but a customer never sees one — worker/lib/policies/facts.ts
  // fills the ones the owner has answered and worker/lib/policies/render.ts
  // withholds the line that carries any other, and the tests below prove both.
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

// =========================================================================
// THE BLANKS ARE FILLED — «فراغات مثل "يسري ... government law" و
// {{BREACH_NOTIFICAYION_HOURS}} يجب ملؤها»
// =========================================================================

const published = (key: string) => POLICY_DOCUMENTS.find((d) => d.key === key)!;

/**
 * Withholding stopped the braces from showing, but it left the Terms with no
 * governing law and no court — the two lines the owner photographed. They are
 * now STATED, from worker/lib/policies/facts.ts, in all three languages.
 */
test('the governing law, the court and the breach deadline are stated, not withheld', () => {
  const article = (body: string, n: string) => {
    const lines = body.split('\n');
    const i = lines.findIndex((l) => l.startsWith(`### ${n} `));
    assert.ok(i >= 0, `article ${n} is not published`);
    let j = i + 1;
    while (j < lines.length && !lines[j].startsWith('#')) j++;
    return lines.slice(i + 1, j).join('\n');
  };
  const terms = published('terms');
  assert.match(article(terms.body.ar, '18.1'), /قوانين جمهورية العراق/);
  assert.match(article(terms.body.en, '18.1'), /the laws of the Republic of Iraq/);
  assert.match(article(terms.body.ckb, '18.1'), /یاساکانی کۆماری عێراق/);
  assert.match(article(terms.body.ar, '18.4'), /لمحاكم بغداد المختصة/);
  assert.match(article(terms.body.en, '18.4'), /the competent courts of Baghdad/);
  assert.match(article(terms.body.ckb, '18.4'), /دادگا تایبەتمەندەکانی بەغدا/);

  // «… خلال 72 ساعة من العلم به»: the token was once spelled
  // BREACH_NOTIFICAYION_HOURS and could never have resolved.
  const privacy = published('privacy');
  assert.match(privacy.body.ar, /خلال 72 ساعة من العلم/);
  assert.match(privacy.body.en, /within 72 hours of becoming aware/);
  assert.match(privacy.body.ckb, /لە ماوەی 72 کاتژمێر/);
  for (const doc of POLICY_SOURCE_DOCUMENTS) {
    for (const lang of POLICY_LANGS) assert.ok(!doc.body[lang].includes('NOTIFICAYION'), `${doc.key}/${lang}: misspelled token`);
  }

  // The age of purchase and the support page.
  assert.match(published('purchase').body.en, /A person under 18 years of age/);
  assert.match(published('terms').body.ar, /صفحة الدعم \(levonis-iq\.com\/support\)/);

  // No sentence reads the law or the court twice («لقوانين قوانين …»,
  // 'the laws of the laws of …', 'the courts of the competent courts …').
  for (const doc of POLICY_DOCUMENTS) {
    assert.ok(!/قانون قوانين|لقوانين قوانين|لمحاكم محاكم|قوانين قوانين/.test(doc.body.ar), `${doc.key}/ar doubles a fact`);
    assert.ok(!/(law|laws) of the laws|courts of the competent courts/.test(doc.body.en), `${doc.key}/en doubles a fact`);
    assert.ok(!/یاسای یاساکانی|یاساکانی یاساکانی|دادگاکانی دادگا/.test(doc.body.ckb), `${doc.key}/ckb doubles a fact`);
  }
});

test('every fact is trilingual, used by the corpus, and carries no token of its own', () => {
  const used = new Set<string>();
  for (const doc of POLICY_SOURCE_DOCUMENTS) {
    for (const m of doc.body.ar.matchAll(/\{\{([A-Z0-9_]+)\}\}/g)) used.add(m[1]);
  }
  for (const [name, value] of Object.entries(POLICY_FACTS)) {
    assert.ok(used.has(name), `facts.ts fills {{${name}}}, which no document uses — a misspelled key fills nothing`);
    for (const lang of POLICY_LANGS) {
      assert.ok(value[lang] && value[lang].trim(), `{{${name}}} has no ${lang} value`);
      assert.ok(!/[{}]/.test(value[lang]), `{{${name}}}/${lang} carries a brace`);
    }
  }
  // Business facts nobody has given are NOT in the table: inventing a
  // registration number or an address is worse than a silent clause.
  for (const name of ['LEVONIS_LEGAL_NAME', 'LEVONIS_REGISTRATION_NO', 'LEVONIS_ADDRESS', 'LEVONIS_SUPPORT_HOURS']) {
    assert.ok(!(name in POLICY_FACTS), `${name} was filled without the owner`);
  }
  // Substitution leaves an unknown token exactly as written, for render.ts.
  assert.equal(fillPolicyFacts('a {{LEVONIS_ADDRESS}} b', 'en'), 'a {{LEVONIS_ADDRESS}} b');
  assert.equal(fillPolicyFacts('{{MIN_PURCHASE_AGE_YEARS}} سنة', 'ar'), '18 سنة');
});

/**
 * The membership delivery thresholds are the figures the checkout applies:
 * `membership_benefit_rules` seeded by migration 0074 (and, for PRO, the
 * `shippingPolicy` fallback agrees). A new seed that left the documents on
 * the old figure is the cash-on-delivery-tax regression over again.
 */
test('the membership free-delivery thresholds are the seeded rules, and terms 8.4 is back', () => {
  const seed = readFileSync(join(ROOT, 'migrations/0074_membership_benefit_rules.sql'), 'utf8');
  const threshold = (id: string) => {
    const m = seed.match(new RegExp(`'${id}',\\s*'\\w+',\\s*'free_shipping',\\s*'global',\\s*(\\d+)`));
    assert.ok(m, `seed ${id} not found`);
    return Number(m![1]);
  };
  assert.equal(PRO_FREE_DELIVERY_MIN_IQD, threshold('seed-pro-free-shipping'));
  assert.equal(PREMIUM_FREE_DELIVERY_MIN_IQD, threshold('seed-premium-free-shipping'));
  assert.equal(PRO_FREE_DELIVERY_MIN_IQD, SETTING_DEFAULTS.shippingPolicy.pro_threshold_iqd);

  // The exception 8.3 points at is published, with its figures, so the Terms
  // no longer say that every delivery cost falls on every customer.
  const terms = published('terms');
  assert.match(terms.body.ar, /### 8\.4 [^\n]*\n[^\n]*75,000 دينار[^\n]*100,000 دينار/);
  assert.match(terms.body.en, /### 8\.4 [^\n]*\n[^\n]*above 75,000 IQD[^\n]*above 100,000 IQD/);
  assert.match(published('delivery').body.ckb, /### 3\.17 /);
});

/**
 * A POINTER TO NOTHING GOES WITH ITS TARGET. Terms 8.3 used to promise «ما لم
 * ينطبق استثناء المادة 8.4 أدناه» while 8.4 was withheld; support 13.x sent the
 * customer to «المادة 14.4», also withheld.
 */
test('a line citing a withheld article of the same document is withheld too', () => {
  const body = [
    '## 1. عنوان',
    '',
    '### 1.1 الأصل',
    'الأصل كذا، ما لم ينطبق استثناء المادة 1.2 أدناه.',
    '',
    '### 1.2 الاستثناء',
    'يُستثنى ما فوق {{UNKNOWN_FIGURE}}.',
    '',
    '### 1.3 إحالة إلى وثيقة أخرى',
    'وفق المادة 1.2 من سياسة التوصيل.',
    '',
    '### 1.4 مرجع',
    'المرجع: وثيقة الشراء، المادة 1.2.',
  ].join('\n');
  const out = publishedPolicyBody(body);
  assert.ok(!out.includes('1.2 الاستثناء'), 'the withheld article is gone');
  assert.ok(!out.includes('### 1.1'), 'the article whose only line cited it went with it');
  assert.ok(out.includes('وفق المادة 1.2 من سياسة التوصيل'), 'a citation of ANOTHER document is not this one');
  assert.ok(out.includes('المرجع: وثيقة الشراء، المادة 1.2.'), 'a reference naming its document first is kept');

  // The English and Sorani forms, and a list of articles.
  assert.equal(
    publishedPolicyBody('### 2.1 A\nSee articles 2.3 and 2.2.\n\n### 2.2 B\n{{X}}\n\n### 2.3 C\nKept.'),
    '### 2.3 C\nKept.'
  );
  assert.equal(publishedPolicyBody('### 3.1 ئا\nبڕگەی 3.2 جێبەجێ دەبێت.\n\n### 3.2 ب\n{{X}}\n\n### 3.3 ج\nمایەوە.'), '### 3.3 ج\nمایەوە.');

  // The corpus as published: support's 14.4 is on the page it is cited from.
  const support = published('support');
  for (const lang of POLICY_LANGS) {
    if (support.body[lang].match(/(المادة|article|ماددەی) 14\.4/)) {
      assert.match(support.body[lang], /^### 14\.4 /m, `support/${lang} cites 14.4 without publishing it`);
    }
  }
  assert.match(published('terms').body.ar, /استثناء المادة 8\.4 أدناه/);
});

// =========================================================================
// THE TEXT CHANGES HANDED TO THIS DOCUMENT SET BY THE OWNER'S REPORT
// =========================================================================

test('a referral or a support code gives the referred account nothing — rewards 10.4, delivery 3.16', () => {
  // «الإحالة لا يحصل على أي شيء فقط كود دعم».
  const rewards = published('rewards');
  assert.match(rewards.body.ar, /### 10\.4 الحساب المُحال لا ينال شيئاً\n[^\n]*لا إعفاء من أجرة التوصيل، ولا خصم، ولا نقاط، ولا عضوية/);
  assert.match(rewards.body.en, /### 10\.4 The referred account receives nothing\n[^\n]*no delivery waiver, no discount, no points and no membership/);
  assert.match(rewards.body.ckb, /### 10\.4 [^\n]*\n[^\n]*نە بێبەشکردن لە تێچووی گەیاندن، نە داشکاندن، نە خاڵ، نە ئەندامێتی/);
  for (const lang of POLICY_LANGS) {
    assert.ok(!/^### 10\.13 /m.test(rewards.body[lang]), `rewards/${lang}: chapter 10 was not renumbered`);
  }
  assert.ok(!rewards.body.ar.includes('يُعفى الحساب المُحال من أجرة التوصيل'));
  assert.ok(!/what the friend receives/i.test(rewards.body.en));

  const delivery = published('delivery');
  const clause = (body: string, marker: RegExp) => body.split('\n').find((l) => marker.test(l)) ?? '';
  assert.ok(!clause(delivery.body.ar, /المادة 3\.17 حصراً/).includes('إحالة'), 'delivery/ar 3.16 still names a referral');
  assert.ok(!/referral/i.test(clause(delivery.body.en, /article 3\.17 exclusively/)), 'delivery/en 3.16 still names a referral');
  assert.ok(!clause(delivery.body.ckb, /بڕگەی 3\.17دا هاتووە/).includes('ڕەوانەکردن'), 'delivery/ckb 3.16 still names a referral');
});

test('memberships are active on purchase, and the PLUS printer gift is granted by hand — membership 8.2, 9.x, 12.1', () => {
  const membership = published('membership');
  for (const lang of POLICY_LANGS) {
    const body = membership.body[lang];
    assert.ok(!/ستُحجز حتى الإطلاق|reserved until the launch|تا دەستپێکردن حیجز دەکرێت/.test(body), `membership/${lang} 8.2 reserves until launch`);
    assert.ok(!/بعد إعلان الإطلاق تبدأ|After the launch has been announced|دوای ڕاگەیاندنی دەستپێکردن/.test(body), `membership/${lang} 9.1 waits for the launch`);
  }
  assert.match(membership.body.ar, /### 9\.2 التفعيل فور الشراء/);
  assert.match(membership.body.en, /### 9\.2 Activation on purchase/);
  assert.match(membership.body.ar, /والمنح يدوي بقرار من إدارة المتجر، لا يقع تلقائياً بالشراء/);
  assert.match(membership.body.en, /The grant is made by hand/);
  assert.match(membership.body.ckb, /بە شێوەی خۆکار ڕوونادات/);
});

/**
 * ONE FIGURE PER TIER. Returns 5.x once said «PRO والعضوية المميزة فوق ...
 * {{PRO_FREE_DELIVERY_MIN_IQD}}» — while the token was withheld nobody read
 * it, but filling it would have promised PREMIUM members the PRO threshold
 * (75,000) when checkout, delivery 3.17, terms 8.4 and membership all give
 * PREMIUM 100,000, standard delivery only. The PRO figure must always belong
 * to the PRO tier: the tier named nearest before it, on its own line, is PRO.
 */
test('the PRO threshold is never attached to PREMIUM — returns, purchase and every other document', () => {
  const pro = PRO_FREE_DELIVERY_MIN_IQD.toLocaleString('en-US');
  const premium = PREMIUM_FREE_DELIVERY_MIN_IQD.toLocaleString('en-US');
  const TIER = /\bPRO\b|PREMIUM|Premium|PRIME|المميزة|ئەندامێتی تایبەت/g;
  let checked = 0;
  for (const key of POLICY_KEYS) {
    for (const lang of POLICY_LANGS) {
      for (const line of published(key).body[lang].split('\n')) {
        let at = line.indexOf(pro);
        while (at >= 0) {
          const names = line.slice(0, at).match(TIER);
          if (names) {
            checked++;
            assert.equal(names[names.length - 1], 'PRO', `${key}/${lang}: ${pro} is given to ${names[names.length - 1]}: ${line}`);
          }
          at = line.indexOf(pro, at + 1);
        }
      }
    }
  }
  assert.ok(checked > 0, 'no threshold line was inspected at all');
  const returns = published('returns');
  assert.match(returns.body.ar, new RegExp(`لعضو PREMIUM في أجرة التوصيل الاعتيادية وحدها فوق قيمة الطلب البالغة ${premium} دينار`));
  assert.match(returns.body.en, new RegExp(`PREMIUM member, as to the standard delivery fee alone, above an order value of ${premium} IQD`));
  assert.match(returns.body.ckb, new RegExp(`ئەندامی PREMIUM[^\\n]*${premium} دینار`));
});

test('the middle tier is LEVO PREMIUM to the customer — PRIME appears only in the membership legacy-name article', () => {
  for (const key of POLICY_KEYS) {
    for (const lang of POLICY_LANGS) {
      const lines = published(key).body[lang].split('\n').filter((l) => /\bPRIME\b/.test(l));
      if (key === 'membership') {
        assert.ok(lines.length <= 1, `membership/${lang}: PRIME outside article 2.4`);
        for (const l of lines) assert.match(l, /LEVO PREMIUM/);
      } else {
        assert.deepEqual(lines, [], `${key}/${lang} names the tier PRIME`);
      }
    }
  }
  assert.match(published('purchase').body.en, /LEVO PREMIUM is waived the ordinary delivery fee alone where the value is strictly more than 100,000 dinars/);
});

test('membership no longer defines a state reserved pending the launch', () => {
  const membership = published('membership');
  for (const lang of POLICY_LANGS) {
    const body = membership.body[lang];
    assert.ok(!/بانتظار الإطلاق|pending the launch|چاوەڕێی دەستپێکردن/.test(body), `membership/${lang} still reserves pending the launch`);
    assert.ok(!/^- (الإطلاق|Launch|دەستپێکردن):/m.test(body), `membership/${lang} still defines the launch`);
  }
  assert.match(membership.body.en, /^- Reserved membership: [^\n]*article 9\.3\.$/m);
  assert.match(membership.body.ar, /^- العضوية المحجوزة: [^\n]*المادة 9\.3\.$/m);
});

test('purchase 10.3 — be present or authorise a recipient — is published while 9.7 is withheld', () => {
  const purchase = published('purchase');
  const src = POLICY_SOURCE_DOCUMENTS.find((d) => d.key === 'purchase')!;
  for (const lang of POLICY_LANGS) {
    assert.match(src.body[lang], /^### 9\.7 /m);
    assert.match(purchase.body[lang], /^### 10\.3 /m, `purchase/${lang} 10.3 was withheld`);
  }
  assert.match(purchase.body.en, /### 10\.3 [^\n]*\n[^\n]*The absence of both is a failed delivery\./);
});
