/**
 * A LINK INSIDE A NOTE IS A LINK THE CUSTOMER CAN TAP — AND NOTHING ELSE IS (owner, 2026-11-20; DECISIONS row 365).
 *
 * The warehouse pickup note is the owner's own line, and on the live site it carries the map:
 * «مخزن Levonis — الموقع على الخريطة: https://maps.app.goo.gl/…». It was drawn as text, so the customer could
 * neither tap nor (inside a choice button) select it. `noteParts` splits a note into text and http(s) links;
 * the screens draw the text as text and each link as an anchor labelled «افتح الخريطة» (new tab,
 * rel="noopener noreferrer"). Only http and https are ever a link; nothing is ever HTML.
 *
 * Run: node --import tsx --test tests/noteLinks.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { OPEN_MAP_LABEL, noteLinks, noteParts, noteWithoutLinks } from '../src/lib/noteLinks';
import { ROOT } from './fixtures/d1';

const LIVE = 'مخزن Levonis — الموقع على الخريطة: https://maps.app.goo.gl/QRRhjfexuoBLESyX7';
const MAP = 'https://maps.app.goo.gl/QRRhjfexuoBLESyX7';

test('the live pickup note: its words stay words and the map is one link', () => {
  assert.deepEqual(noteParts(LIVE), [
    { kind: 'text', text: 'مخزن Levonis — الموقع على الخريطة: ' },
    { kind: 'link', href: MAP },
  ]);
  assert.deepEqual(noteLinks(LIVE), [MAP]);
  // Where an anchor cannot be drawn (inside a choice button) the sentence stands without its dangling colon.
  assert.equal(noteWithoutLinks(LIVE), 'مخزن Levonis — الموقع على الخريطة');
});

test('a note without a link is one text part, unchanged; an empty one is nothing', () => {
  assert.deepEqual(noteParts('تستلمها بنفسك — بلا أجور توصيل'), [{ kind: 'text', text: 'تستلمها بنفسك — بلا أجور توصيل' }]);
  assert.equal(noteWithoutLinks('تستلمها بنفسك — بلا أجور توصيل'), 'تستلمها بنفسك — بلا أجور توصيل');
  assert.deepEqual(noteLinks('Sat–Thu 10:00–18:00'), []);
  for (const v of ['', null, undefined]) {
    assert.deepEqual(noteParts(v), []);
    assert.equal(noteWithoutLinks(v), '');
  }
  // A note that is only a link leaves no sentence behind — the caller falls back to its own words.
  assert.equal(noteWithoutLinks(MAP), '');
});

test('the link ends where the address ends: sentence punctuation and following words are not swallowed', () => {
  assert.deepEqual(noteParts(`Map: ${MAP}. Open Sat–Thu.`), [
    { kind: 'text', text: 'Map: ' },
    { kind: 'link', href: MAP },
    { kind: 'text', text: '. Open Sat–Thu.' },
  ]);
  assert.deepEqual(noteLinks(`(${MAP})`), [MAP]);
  assert.deepEqual(noteLinks(`الخريطة ${MAP}، من السبت إلى الخميس`), [MAP]);
  // Arabic letters written straight after the address are not part of it.
  assert.deepEqual(noteLinks(`${MAP}المخزن`), [MAP]);
  // A query string and a fragment belong to the address.
  const q = 'https://www.google.com/maps/search/?api=1&query=33.3152,44.3661#pin';
  assert.deepEqual(noteLinks(`هنا ${q} شكراً`), [q]);
  // Two links are two links, in order.
  assert.deepEqual(noteLinks(`${MAP} أو http://example.com/a`), [MAP, 'http://example.com/a']);
  // Mid-sentence, the words on both sides stay (only a lead-in left dangling at the END is trimmed).
  assert.equal(noteWithoutLinks(`Collect it here ${MAP} from Saturday to Thursday`), 'Collect it here from Saturday to Thursday');
});

test('only http and https are ever a link — every other scheme stays inert text', () => {
  for (const hostile of [
    'javascript:alert(1)',
    'JaVaScRiPt:alert(document.cookie)',
    'data:text/html,<script>alert(1)</script>',
    'vbscript:msgbox(1)',
    'file:///etc/passwd',
    'intent://scan/#Intent;scheme=zxing;end',
    'tel:+9647700000000',
    'mailto:a@b.co',
    '//evil.example/path',
    'www.example.com',
    'maps.app.goo.gl/QRRhjfexuoBLESyX7',
    'http://',
    'https:///nohost',
    'https://user:secret@evil.example/login',
  ]) {
    assert.deepEqual(noteLinks(hostile), [], hostile);
    assert.deepEqual(noteParts(hostile), [{ kind: 'text', text: hostile }], hostile);
  }
});

test('markup in a note is text: no part ever carries HTML, and an address stops at a quote or an angle bracket', () => {
  const html = '<img src=x onerror=alert(1)> <a href="javascript:alert(1)">الخريطة</a>';
  assert.deepEqual(noteParts(html), [{ kind: 'text', text: html }]);
  const breakout = 'https://maps.example/a"onmouseover="alert(1)';
  assert.deepEqual(noteLinks(breakout), ['https://maps.example/a']);
  assert.deepEqual(noteLinks('<https://maps.example/a>'), ['https://maps.example/a']);
  for (const part of noteParts(`${html} ${breakout}`)) {
    if (part.kind === 'link') assert.match(part.href, /^https?:\/\/[^\s"'<>]+$/);
  }
  // Every text part put back together with the links is the note itself: nothing is dropped or invented.
  for (const note of [LIVE, html, `a ${MAP} b ${MAP}.`, breakout]) {
    assert.equal(noteParts(note).map((p) => (p.kind === 'text' ? p.text : p.href)).join(''), note, note);
  }
});

test('the label is said in three languages, and the Sorani is not the Arabic', () => {
  assert.equal(OPEN_MAP_LABEL.ar, 'افتح الخريطة');
  assert.equal(OPEN_MAP_LABEL.en, 'Open the map');
  assert.ok(OPEN_MAP_LABEL.ckb && OPEN_MAP_LABEL.ckb !== OPEN_MAP_LABEL.ar);
});

test('the screens draw it as text and an anchor — never as HTML — on a new tab with rel="noopener noreferrer"', () => {
  const src = (p: string) => readFileSync(join(ROOT, p), 'utf8');
  const view = src('src/components/ui/NoteLinks.tsx');
  assert.match(view, /target="_blank"/);
  assert.match(view, /rel="noopener noreferrer"/);
  assert.doesNotMatch(view, /dangerouslySetInnerHTML|innerHTML/);
  assert.match(view, /noteParts\(/);
  // Every place the customer (or the owner's preview) reads the pickup note goes through it.
  for (const p of [
    'src/components/product/PrinterPackages.tsx',
    'src/components/product/CustomizeSheet.tsx',
    'src/components/adminPrinterServices/CustomerPreview.tsx',
    'src/pages/Checkout.tsx',
  ]) {
    const text = src(p);
    assert.match(text, /NoteLinks|NoteLinkRow|NoteText/, p);
    assert.doesNotMatch(text, /dangerouslySetInnerHTML=\{\{\s*__html:\s*[^}]*note/i, p);
  }
});
