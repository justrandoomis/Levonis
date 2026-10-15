/**
 * THE FLIGHT DECODER AND THE HASHES (Bambu import spec §C, §B.8).
 *
 * rsc.ts splits the React Server Components stream by BYTES (a text row's
 * length is its UTF-8 byte count), resolves `$<hex>`, `$<hex>:path`, `$L`,
 * `$@`, `$$` and `$undefined` lazily, and hash.ts gives the synchronous
 * SHA-256 / SHA-1 the deterministic ids are built from. Both are checked
 * against Node's own implementations and against the trimmed real page.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { H, sha1Hex, sha256Hex } from '../packages/catalog/src/bambuImport/hash';
import { deref, extractFlight, jsonLdBlocks, parseFlight, refOf, scalarOf, splitRows } from '../packages/catalog/src/bambuImport/rsc';
import { pageHtml } from './fixtures/bambu/load';

test('sha256Hex and sha1Hex equal node:crypto on ASCII, Unicode, empty and long inputs', () => {
  const inputs = ['', 'abc', 'bambu_us:product:6945416380552', 'p_x:Standard', 'Kurdî — کوردی — عربي 🚀', 'x'.repeat(1_000), 'y'.repeat(65_537)];
  for (const s of inputs) {
    assert.equal(sha256Hex(s), createHash('sha256').update(s, 'utf8').digest('hex'), `sha256 of ${s.length} chars`);
    assert.equal(sha1Hex(s), createHash('sha1').update(s, 'utf8').digest('hex'), `sha1 of ${s.length} chars`);
  }
});

test('H(x) is the first 24 hex characters of sha256 (§B.8)', () => {
  const x = 'bambu_us:value:581025672340709381';
  assert.equal(H(x), createHash('sha256').update(x).digest('hex').slice(0, 24));
  assert.match(H(x), /^[0-9a-f]{24}$/);
  assert.equal(`bv-${H(x)}`.length, 27);
});

test('text rows are cut by UTF-8 byte length, not by characters', () => {
  const text = 'Kurdî — کوردی ✓';
  const len = new TextEncoder().encode(text).length.toString(16);
  const flight = `1:T${len},${text}2:{"a":"$1","b":"$$5 literal","c":"$undefined"}\n3:["$","div",null,{"x":"$2:a"}]\n`;
  const { rows, badRows } = splitRows(flight);
  assert.equal(badRows, 0);
  assert.deepEqual(rows.get('1'), { kind: 'text', text });
  const two = rows.get('2');
  assert.equal(two?.kind, 'json');
  assert.equal(deref(rows, '$1'), text);
  assert.equal(deref(rows, '$2:a'), text, 'a path reference resolves step by step');
  assert.equal(scalarOf('$$5 literal'), '$5 literal');
  assert.equal(scalarOf('$undefined'), null);
  assert.equal(refOf('$$5'), null, '$$ is a literal, never a reference');
  assert.deepEqual(refOf('$L1f'), { lazy: true, id: '1f', path: [] });
  assert.deepEqual(refOf('$@2a:b:c'), { lazy: true, id: '2a', path: ['b', 'c'] });
});

test('a reference cycle resolves to null instead of looping', () => {
  const { rows } = splitRows('1:"$2"\n2:"$1"\n');
  assert.equal(deref(rows, '$1'), null);
});

test('the trimmed filament-buffer page decodes with no bad chunk or row, and its JSON-LD parses', () => {
  const html = pageHtml();
  assert.ok(Buffer.byteLength(html) <= 200 * 1024, 'the committed page stays under 200 KB');
  const { chunks, badChunks } = extractFlight(html);
  assert.ok(chunks > 10);
  assert.equal(badChunks, 0);
  const flight = parseFlight(html);
  assert.equal(flight.stats.badRows, 0);
  assert.ok(flight.rows.size > 20);
  const ld = jsonLdBlocks(html) as Array<Record<string, unknown>>;
  assert.ok(ld.some((b) => b['@type'] === 'ProductGroup'));
});
