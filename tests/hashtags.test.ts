/**
 * The managed hashtag vocabulary (migration 0041): one normalization rule
 * shared by the product form, the import sheet and the taxonomy admin, and
 * case-insensitive equality everywhere — "PLA" and "pla" are one tag.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dedupeHashtags, hashtagKey, normalizeHashtag, parseHashtagsCell } from '../worker/lib/hashtags';
import { readFileSync } from 'node:fs';

test('normalizeHashtag strips the hash, trims, joins words and caps the length', () => {
  assert.equal(normalizeHashtag('#pla'), 'pla');
  assert.equal(normalizeHashtag('  ## Bambu Lab  '), 'Bambu-Lab');
  assert.equal(normalizeHashtag('-lead-and-trail-'), 'lead-and-trail');
  assert.equal(normalizeHashtag('x'.repeat(80)).length, 40);
  assert.equal(normalizeHashtag(''), '');
  assert.equal(normalizeHashtag(42), '');
  assert.equal(normalizeHashtag('عربي وسم'), 'عربي-وسم');
});

test('the separators of the import cell and of the form cannot live inside a tag', () => {
  // `a|b` would export as one cell and re-import as TWO tags; `,` is what the
  // form commits on. Both collapse to the join character instead.
  assert.equal(normalizeHashtag('a|b'), 'a-b');
  assert.equal(normalizeHashtag('a,b'), 'a-b');
  assert.equal(normalizeHashtag('a | b'), 'a-b');
  assert.equal(normalizeHashtag('trailing|'), 'trailing');
  // toCsv prefixes a formula-leading cell with a quote; a tag must not be
  // able to start with one, or an export would re-import as a different tag.
  assert.equal(normalizeHashtag('=HYPERLINK'), 'HYPERLINK');
  assert.equal(normalizeHashtag('+tag'), 'tag');
  assert.equal(normalizeHashtag('@tag'), 'tag');
  // A tag clipped at 40 characters never ends on the join character.
  assert.equal(normalizeHashtag(`${'x'.repeat(39)}-yz`).endsWith('-'), false);
});

test('hashtagKey folds case so two spellings are one tag', () => {
  assert.equal(hashtagKey('PLA'), hashtagKey('#pla '));
  assert.notEqual(hashtagKey('pla'), hashtagKey('plastic'));
});

test('dedupeHashtags keeps the first spelling and drops empties', () => {
  assert.deepEqual(dedupeHashtags(['PLA', 'pla', '', '#Pla', 'petg']), ['PLA', 'petg']);
});

test('parseHashtagsCell reads the stored JSON and never throws on garbage', () => {
  assert.deepEqual(parseHashtagsCell('["a","#b","a"]'), ['a', 'b']);
  assert.deepEqual(parseHashtagsCell(['x', ' y ']), ['x', 'y']);
  assert.deepEqual(parseHashtagsCell('not json'), []);
  assert.deepEqual(parseHashtagsCell(null), []);
  assert.deepEqual(parseHashtagsCell('{"a":1}'), []);
});

test('migration 0041 is additive and case-insensitively unique on the tag', () => {
  const sql = readFileSync('migrations/0041_hashtags.sql', 'utf8');
  assert.match(sql, /CREATE TABLE IF NOT EXISTS hashtags/);
  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS idx_hashtags_tag ON hashtags\(tag COLLATE NOCASE\)/);
  const statements = sql
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n');
  assert.doesNotMatch(statements, /DROP|DELETE|ALTER TABLE products/i);
});
