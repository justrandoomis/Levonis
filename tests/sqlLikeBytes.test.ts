/**
 * D1 REFUSES A LIKE PATTERN OVER 50 BYTES, AND EVERY CAP IN THIS REPO COUNTED
 * CHARACTERS.
 *
 * The product delete died on it outright — an R2 key is exactly 50 bytes and two
 * `%` made 52 — and the same limit sits under every search box in the shop. A
 * character cap is not a bound on a byte limit: Arabic is two bytes a letter, so
 * a query well inside `{ max: 60 }` is well over 50 bytes, and the customer
 * searching in the language this shop is WRITTEN in got a 500 while the one
 * searching in English did not.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './fixtures/d1';
import {
  D1_LIKE_PATTERN_MAX_BYTES,
  likePattern,
  patternBytes,
  sqlLikeClause,
} from '../worker/lib/sqlLike';

test('an Arabic query that fits every CHARACTER cap still fits D1`s BYTE limit', () => {
  // 33 characters, 61 bytes — inside `str(q, { max: 60 })` and over D1's 50.
  const arabic = 'بحث عن طابعة ثلاثية الأبعاد بامبو';
  assert.ok(arabic.length < 60, 'the fixture must pass a character cap');
  assert.ok(new TextEncoder().encode(arabic).length > D1_LIKE_PATTERN_MAX_BYTES, 'and exceed the byte limit');

  const pattern = likePattern(arabic);
  assert.ok(
    patternBytes(pattern) <= D1_LIKE_PATTERN_MAX_BYTES,
    `the built pattern is ${patternBytes(pattern)} bytes, which D1 would refuse`
  );
  assert.ok(pattern.startsWith('%') && pattern.endsWith('%'));
});

test('truncation never splits a character in half', () => {
  // Every prefix length, so the cut lands inside a multi-byte sequence at some
  // point. A lone surrogate or a half-formed UTF-8 sequence corrupts the query.
  const long = 'ا'.repeat(80) + '😀'.repeat(20);
  for (let i = 1; i <= long.length; i++) {
    const pattern = likePattern(long.slice(0, i));
    assert.ok(patternBytes(pattern) <= D1_LIKE_PATTERN_MAX_BYTES);
    assert.equal(pattern.includes('�'), false, 'no replacement character');
    // Re-encoding and decoding must round-trip, which a split sequence cannot.
    const round = new TextDecoder().decode(new TextEncoder().encode(pattern));
    assert.equal(round, pattern);
  }
});

test('a wildcard the customer typed is a LITERAL, not a wildcard', () => {
  assert.equal(likePattern('50% off'), '%50\\% off%');
  assert.equal(likePattern('a_b'), '%a\\_b%');
  assert.equal(likePattern('back\\slash'), '%back\\\\slash%');
  // Which only works if the SQL says so — hence the clause builder.
  assert.equal(sqlLikeClause(['name']), "name LIKE ? ESCAPE '\\'");
  assert.equal(sqlLikeClause(['a', 'b'], '?1'), "a LIKE ?1 ESCAPE '\\' OR b LIKE ?1 ESCAPE '\\'");
});

test('an escape pair is never cut between the backslash and its character', () => {
  // A term of pure percents: every accepted piece costs two bytes, so a naive
  // byte cut would land between `\` and `%` and leave a dangling escape.
  const pattern = likePattern('%'.repeat(60));
  assert.ok(patternBytes(pattern) <= D1_LIKE_PATTERN_MAX_BYTES);
  const body = pattern.slice(1, -1);
  assert.equal(body.length % 2, 0, 'the body is whole escape pairs');
  assert.equal(/\\$/.test(body), false, 'and never ends on a dangling backslash');
});

test('no term means no clause, not a pattern that matches everything', () => {
  assert.equal(likePattern(''), '');
  assert.equal(likePattern('   '), '');
  assert.equal(likePattern(null), '');
  assert.equal(likePattern(undefined), '');
});

test('prefix and suffix shapes keep the bound too', () => {
  const long = 'ط'.repeat(60);
  for (const shape of ['prefix', 'suffix'] as const) {
    const p = likePattern(long, shape);
    assert.ok(patternBytes(p) <= D1_LIKE_PATTERN_MAX_BYTES, `${shape} pattern is too long`);
  }
  assert.equal(likePattern('abc', 'prefix'), 'abc%');
  assert.equal(likePattern('abc', 'suffix'), '%abc');
});

/**
 * THE REGRESSION GUARD. A new search box that hand-rolls `'%' + q + '%'` is the
 * bug coming back, and it will not be noticed until somebody searches in
 * Arabic on the live site.
 */
test('no route builds a LIKE pattern by hand any more', () => {
  const offenders: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const p = join(dir, entry);
      if (statSync(p).isDirectory()) walk(p);
      // The helper itself names the shapes it replaces, in its own note.
      else if (entry.endsWith('.ts') && !p.endsWith('/lib/sqlLike.ts')) {
        const src = readFileSync(p, 'utf8');
        const code = src
          .split('\n')
          .filter((l) => !l.trimStart().startsWith('*') && !l.trimStart().startsWith('//') && !l.trimStart().startsWith('/*'))
          .join('\n');
        // `'%' + term + '%'` and `` `%${term}%` `` in TypeScript, and
        // `'%' || ? || '%'` built inside SQL.
        if (/`%\$\{/.test(code) || /'%'\s*\+/.test(code) || /LIKE\s*'%'\s*\|\|/.test(code)) {
          offenders.push(p.replace(`${ROOT}/`, ''));
        }
      }
    }
  };
  walk(join(ROOT, 'worker'));
  assert.deepEqual(
    offenders,
    [],
    'build the pattern with likePattern() — a hand-rolled one is unbounded in BYTES and D1 refuses it over 50'
  );
});
