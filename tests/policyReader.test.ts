import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  indexPolicyDocument,
  parseArticleRef,
  parsePolicyVersion,
  policyAnchor,
  policyArticleHref,
  policyDocumentUrl,
  policyHighlight,
  policyOutline,
  policyQueryTokens,
  policySummary,
  searchPolicyIndex,
} from '../src/lib/policyReader';
import { POLICY_DOCUMENTS } from '../worker/lib/policies';
import { POLICY_LANGS } from '../worker/lib/policies/types';

/**
 * THE READER, against the corpus it actually has to read.
 *
 * These assertions run over the real eighteen documents rather than a fixture,
 * because every property that matters here is a property of THAT text: that a
 * link to article 4.2 opens 4.2 in all three languages, that a document with
 * no numbered parts still produces a table of contents, and that the words a
 * customer types find the clause they are arguing about.
 */

test('historical versions are explicit and invalid input never selects the latest', () => {
  assert.deepEqual(parsePolicyVersion(null), { valid: true, version: null });
  assert.deepEqual(parsePolicyVersion('12'), { valid: true, version: 12 });
  for (const value of ['', '0', '-1', '1.5', 'NaN', '1e2', '1000001']) {
    assert.deepEqual(parsePolicyVersion(value), { valid: false, version: null });
  }
});

test('document requests pin both historical version and supported locale', () => {
  assert.equal(policyDocumentUrl('terms', 2, 'en'), '/api/policies/terms?lang=en&version=2');
  assert.equal(policyDocumentUrl('privacy', null, 'ckb'), '/api/policies/privacy?lang=ckb');
  assert.equal(policyDocumentUrl('terms?evil', 1, 'bad&x=y'), '/api/policies/terms%3Fevil?lang=ar&version=1');
});

test('an article link carries the anchor in the fragment and the version in the query', () => {
  assert.equal(policyArticleHref('returns', 'art-4-2'), '/policies/returns#art-4-2');
  assert.equal(policyArticleHref('returns', 'art-4-2', 3), '/policies/returns?version=3#art-4-2');
  assert.equal(policyAnchor(3, '4.2', 99), 'art-4-2');
  assert.equal(policyAnchor(2, '7', 99), 'part-7');
  // No number is the only case that falls back to a position.
  assert.equal(policyAnchor(2, null, 12), 'h-12');
});

test('EVERY article in the corpus is addressable, and by the SAME anchor in all three languages', () => {
  // A customer may accept the terms in one language and argue about them in
  // another, so a link sent in Arabic has to open the right clause in English.
  const unnumbered: string[] = [];
  for (const doc of POLICY_DOCUMENTS) {
    const anchors = POLICY_LANGS.map((lang) =>
      policyOutline(doc.body[lang]).map((h) => h.anchor).join('|')
    );
    assert.equal(anchors[0], anchors[1], `${doc.key}: ar and en outlines address different articles`);
    assert.equal(anchors[0], anchors[2], `${doc.key}: ar and ckb outlines address different articles`);

    const outline = policyOutline(doc.body.ar);
    assert.ok(outline.length >= 2, `${doc.key} has no table of contents`);
    for (const heading of outline) {
      if (heading.level === 3 && !heading.number) unnumbered.push(`${doc.key}: ${heading.title}`);
    }
    // Two articles sharing an anchor would make one of them unreachable.
    const articleAnchors = outline.filter((h) => h.level === 3).map((h) => h.anchor);
    assert.equal(new Set(articleAnchors).size, articleAnchors.length, `${doc.key} has duplicate article anchors`);
  }
  assert.deepEqual(unnumbered, [], 'these articles carry no number, so their link is a line position and not stable');
});

test('the outline handles both shapes the corpus uses', () => {
  // Numbered parts with articles under them…
  const parts = policyOutline('## 1. التمهيد\nنص\n### 1.1 الغرض\nنص\n### 1.2 الأطراف');
  assert.deepEqual(parts.map((h) => [h.level, h.number, h.anchor]), [
    [2, '1', 'part-1'],
    [3, '1.1', 'art-1-1'],
    [3, '1.2', 'art-1-2'],
  ]);
  // …and a single unnumbered title line followed by articles.
  const flat = policyOutline('## وثيقة الاسترجاع — المادة 4\nنص\n### 4.1 التعريفات');
  assert.deepEqual(flat.map((h) => [h.level, h.number]), [[2, null], [3, '4.1']]);
  assert.equal(flat[0].title, 'وثيقة الاسترجاع — المادة 4');
});

test('the index line for a document is quoted from the document, not written for the card', () => {
  for (const doc of POLICY_DOCUMENTS) {
    const summary = policySummary(doc.body.ar);
    assert.ok(summary.length > 20, `${doc.key}: no scope line`);
    assert.ok(doc.body.ar.includes(summary), `${doc.key}: the summary is not text from the document`);
    assert.ok(!summary.startsWith('#') && !summary.startsWith('- '), `${doc.key}: the summary is a heading or a bullet`);
  }
  // A full stop inside an article reference does not end the sentence.
  assert.equal(policySummary('## t\n\nتُقرأ مع المادة 4.2 من الوثيقة. وما بعدها.'), 'تُقرأ مع المادة 4.2 من الوثيقة.');
});

test('«المادة ٤٫٢» is an address, in either set of digits', () => {
  assert.equal(parseArticleRef('٤٫٢'), '4.2');
  assert.equal(parseArticleRef('المادة ٤٫٢'), '4.2');
  assert.equal(parseArticleRef('4.2'), '4.2');
  assert.equal(parseArticleRef('article 12.3'), '12.3');
  // A bare number is a word in a query, not an article reference.
  assert.equal(parseArticleRef('4'), null);
  assert.equal(parseArticleRef('الكرتون'), null);
});

test('search reaches the article a customer is arguing about', () => {
  const articles = POLICY_DOCUMENTS.flatMap((doc) => indexPolicyDocument(doc.key, doc.title.ar, doc.body.ar));
  assert.ok(articles.length > 1000, 'the whole corpus is indexed');

  const find = (query: string) => searchPolicyIndex(articles, query, 10);

  // The owner's own examples. «الكارتون» is spelled in the corpus both with
  // and without the alef, and the reader has to land on the clause either way.
  const carton = find('الكارتون');
  assert.ok(carton.length > 0, 'الكارتون finds nothing');
  assert.ok(
    carton.slice(0, 5).some((h) => h.key === 'delivery' && h.number === '3.20'),
    'الكارتون does not reach the carton fee in article 3.20'
  );
  assert.ok(
    find('الكرتون').slice(0, 3).every((h) => h.key === 'delivery'),
    'الكرتون brings back articles that are not about the carton'
  );
  assert.ok(find('الحدود').length > 0, 'الحدود finds nothing');

  // An article reference is an exact address and answers with that article.
  const byNumber = find('المادة ٤٫٢');
  assert.ok(byNumber.length > 0);
  assert.ok(byNumber.every((h) => h.number === '4.2'), 'an article reference returned other articles');

  // Two words narrow; they do not widen.
  const both = find('ضمان الطابعة');
  assert.ok(both.length > 0);
  assert.ok(both.length < find('ضمان').length, 'adding a word did not narrow the result');

  // Every hit can be opened.
  for (const hit of both) assert.match(hit.anchor, /^(art|part|h)-/);
});

test('folding is the shop’s: a Kurdish keyboard and a missing hamza find the same clause', () => {
  const article = indexPolicyDocument('t', 'T', '### 1.1 التعريفات\nالطابعة المؤهلة تُباع بضمان أساسي.');
  for (const query of ['الطابعه', 'الطابعة', 'التعریفات', 'اساسي', 'أساسي']) {
    assert.equal(searchPolicyIndex(article, query).length, 1, `${query} did not fold onto the text`);
  }
  // A word that is genuinely absent stays absent.
  assert.equal(searchPolicyIndex(article, 'الكوبون').length, 0);
});

test('query tokens are folded, and the highlighter marks whole words on the original text', () => {
  assert.deepEqual(policyQueryTokens('الطابعة  الأولى'), ['الطابعه', 'الاولي']);
  // One-character noise never becomes a token that matches everything.
  assert.deepEqual(policyQueryTokens('a ب 1'), []);

  const parts = policyHighlight('رسم الكرتون يستحق', policyQueryTokens('الكرتون'));
  assert.deepEqual(parts.filter((p) => p.hit).map((p) => p.text), ['الكرتون']);
  assert.equal(parts.map((p) => p.text).join(''), 'رسم الكرتون يستحق', 'the highlighter rewrote the text');
  // Nothing to mark returns the text whole rather than in fragments.
  assert.deepEqual(policyHighlight('نص', []), [{ text: 'نص', hit: false }]);
});
