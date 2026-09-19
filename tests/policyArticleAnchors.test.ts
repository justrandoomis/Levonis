import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { LanguageProvider } from '../src/LanguageContext';
import PolicyProse from '../src/components/policies/PolicyProse';
import PolicyOutline from '../src/components/policies/PolicyOutline';
import { policyOutline } from '../src/lib/policyReader';
import { POLICY_DOCUMENTS } from '../worker/lib/policies';

/**
 * «انظر المادة ٤٫٢» HAS TO BE SENDABLE — end to end.
 *
 * The table of contents and the document are built from the same parse
 * (`parsePolicyLine`), and this is what proves it stays that way: an outline
 * entry linking to `#art-4-2` is worthless unless the rendered prose actually
 * carries an element with that id. A drift between the two produces a table of
 * contents where every entry is a dead link, and nothing else in the suite
 * would notice — the components would still render, the links would still be
 * links, and they would simply go nowhere.
 *
 * Written with `createElement` rather than JSX so the file stays a `.ts` and is
 * picked up by the runner's `tests/*.test.ts` glob.
 */

function renderDocument(body: string, key: string) {
  const headings = policyOutline(body);
  const html = renderToStaticMarkup(
    createElement(
      MemoryRouter,
      null,
      createElement(
        LanguageProvider,
        null,
        createElement(PolicyOutline, { headings, policyKey: key, version: null, activeAnchor: 'art-4-2' }),
        createElement(PolicyProse, { body, policyKey: key, version: null, activeAnchor: 'art-4-2' })
      )
    )
  );
  return { headings, html, ids: new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1])) };
}

test('every table-of-contents entry lands on an element the document actually rendered', () => {
  for (const doc of POLICY_DOCUMENTS) {
    const { headings, ids } = renderDocument(doc.body.ar, doc.key);
    const dead = headings.map((h) => h.anchor).filter((anchor) => !ids.has(anchor));
    assert.deepEqual(dead, [], `${doc.key}: the outline links to anchors the prose never rendered`);
  }
});

test('the same link opens the same article in all three languages', () => {
  // A customer may accept in one language and argue in another, so a link sent
  // by one reader has to resolve for the other.
  for (const key of ['returns', 'terms', 'privacy']) {
    const doc = POLICY_DOCUMENTS.find((d) => d.key === key)!;
    const ar = renderDocument(doc.body.ar, key);
    for (const lang of ['en', 'ckb'] as const) {
      const other = renderDocument(doc.body[lang], key);
      for (const heading of ar.headings) {
        assert.ok(other.ids.has(heading.anchor), `${key}/${lang}: ${heading.anchor} does not exist`);
      }
    }
  }
});

test('every article carries a copy-link control, and it is not a hover-only affordance', () => {
  const doc = POLICY_DOCUMENTS.find((d) => d.key === 'returns')!;
  const { headings, html } = renderDocument(doc.body.ar, 'returns');
  const articles = headings.filter((h) => h.level === 3).length;
  assert.equal((html.match(/data-policy-copy-link/g) ?? []).length, articles, 'an article has no way to be linked to');

  // Tailwind v4 gates `hover:` behind `@media (hover: hover)`, so a control
  // that only exists on hover does not exist on the phone the owner uses.
  // The button must be rendered outright, never `opacity-0` until hovered.
  const buttons = [...html.matchAll(/<button[^>]*data-policy-copy-link[^>]*>/g)].map((m) => m[0]);
  assert.ok(buttons.length > 0);
  for (const button of buttons) {
    assert.ok(!/\bopacity-0\b/.test(button), 'the copy button is hidden until hover');
    assert.ok(!/\bhidden\b/.test(button), 'the copy button is hidden until hover');
    assert.ok(/\bh-11\b/.test(button) && /\bw-11\b/.test(button), 'the copy button is under the 44px tap target');
  }
});

test('the article the reader arrived at is marked, and the document renders its own structure', () => {
  // site_terms is the one document that carries BOTH of the corpus's inline
  // constructs — bulleted clauses and a bold run — so it is what proves the
  // renderer handles the text the shop actually wrote.
  const doc = POLICY_DOCUMENTS.find((d) => d.key === 'site_terms')!;
  const { html } = renderDocument(doc.body.ar, 'site_terms');
  assert.ok(html.includes('<strong'), 'bold runs in the corpus are not rendered');
  assert.ok(html.includes('<ul'), 'bulleted clauses are not rendered as lists');
  // The prose column is measured rather than running the full width of a
  // desktop screen, which is what makes long legal prose readable at all.
  assert.match(html, /data-policy-prose[^>]*lg:max-w-\[68ch\]/);

  // The article a reader was sent to is distinguished from the ones around it.
  const returns = POLICY_DOCUMENTS.find((d) => d.key === 'returns')!;
  assert.ok(
    renderDocument(returns.body.ar, 'returns').html.includes('data-policy-active="true"'),
    'arriving on #art-4-2 does not distinguish article 4.2'
  );
});
