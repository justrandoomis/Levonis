/**
 * THE SEALED BOX OF WORKFLOW 60 (Bambu import spec §A.8; DECISIONS row 239).
 *
 * Artifacts of this public repository are public, so every file the import
 * job produces leaves it sealed to a one-time X25519 key whose private half
 * stays in the agent's sandbox. These tests pin what that promise rests on:
 *
 *   - a round trip: what seal.mjs seals, unseal.mjs opens, byte for byte, and
 *     two seals of the same bytes share nothing (fresh ephemeral key and nonce);
 *   - the public key is the dispatch input's shape, and a malformed, padded,
 *     non-canonical or low-order key is refused;
 *   - EVERY byte is authenticated: flipping any one of them is refused;
 *   - the wrong key is refused, and so is a forged key id;
 *   - the header version is read and checked before anything is decrypted;
 *   - the CLIs: a 0600 private key never written inside a git checkout, the
 *     plaintext deleted after sealing, no output on refusal, no overwrite.
 *
 * Run: node --import tsx --test tests/bambuSeal.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
// @ts-expect-error - plain ESM helper run by workflow 60 and in the sandbox, no types
import { HEADER_BYTES, MAGIC, PUBLIC_KEY_PATTERN, SealError, TAG_BYTES, VERSION, generateSealKeys, keyId, parsePublicKey, readSealedHeader, sealBuffer, unsealBuffer } from '../scripts/bambu-import/seal.mjs';
import { ROOT } from './fixtures/d1';

type SealErrorLike = { code: string; message: string };

const SEAL = join(ROOT, 'scripts/bambu-import/seal.mjs');
const UNSEAL = join(ROOT, 'scripts/bambu-import/unseal.mjs');

/** The SealError code a call throws, or a failure if it does not throw one. */
function refusal(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof SealError, `expected a SealError, got ${String(error)}`);
    return (error as SealErrorLike).code;
  }
  assert.fail('expected a refusal');
}

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), 'levonis-seal-test-'));
  return { dir, dispose: () => rmSync(dir, { recursive: true, force: true }) };
}

const node = (script: string, args: string[]) =>
  spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', timeout: 30_000 });

test('a round trip: every size comes back byte for byte, and two seals of the same bytes share nothing', () => {
  const keys = generateSealKeys();
  for (const plaintext of [Buffer.alloc(0), Buffer.from('{}'), randomBytes(1), randomBytes(4096), randomBytes(3 * 1024 * 1024 + 7)]) {
    const sealed = sealBuffer(keys.publicKey, plaintext);
    assert.equal(sealed.length, HEADER_BYTES + plaintext.length + TAG_BYTES, 'header + ciphertext + tag, nothing else');
    assert.deepEqual(unsealBuffer(keys.privateKeyPem, sealed), plaintext);
  }
  const text = Buffer.from('{"product":"a hidden product name"}');
  const first = sealBuffer(keys.publicKey, text);
  const second = sealBuffer(keys.publicKey, text);
  assert.notDeepEqual(first, second);
  const a = readSealedHeader(first);
  const b = readSealedHeader(second);
  assert.notDeepEqual(a.ephemeralRaw, b.ephemeralRaw, 'a fresh ephemeral key per file');
  assert.notDeepEqual(a.nonce, b.nonce, 'a fresh nonce per file');
  assert.ok(!first.includes(Buffer.from('hidden product')), 'the plaintext is not in the sealed bytes');
});

test('the header says what it is: magic, version 1, and the id of the key it is sealed to', () => {
  const keys = generateSealKeys();
  const sealed = sealBuffer(keys.publicKey, Buffer.from('x'));
  assert.deepEqual(sealed.subarray(0, MAGIC.length), Buffer.from('LVSEAL'));
  assert.equal(sealed[MAGIC.length], VERSION);
  assert.equal(VERSION, 1);
  const head = readSealedHeader(sealed);
  assert.equal(head.kid, keys.kid);
  assert.equal(head.kid, keyId(Buffer.from(keys.publicKey, 'base64url')).toString('hex'));
  assert.equal(HEADER_BYTES, 59);
});

test('the public key is the dispatch input: 43 base64url characters, one canonical X25519 key', () => {
  for (let i = 0; i < 20; i++) assert.match(generateSealKeys().publicKey, PUBLIC_KEY_PATTERN);
  assert.equal(PUBLIC_KEY_PATTERN.source, '^[A-Za-z0-9_-]{43}$');
  const good = generateSealKeys().publicKey;
  assert.equal(parsePublicKey(good).raw.length, 32);
  const lastIndex = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'.indexOf(good[42]);
  const nonCanonical = good.slice(0, 42) + 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'[lastIndex ^ 1];
  for (const bad of [
    good.slice(0, 42),
    `${good}A`,
    `${good}=`,
    `${good.slice(0, 42)}=`,
    good.replace(/[-_]/g, '+').replace(/^(.)/, '/'),
    nonCanonical,
    '',
    ' '.repeat(43),
  ]) {
    assert.equal(refusal(() => parsePublicKey(bad)), 'SEAL_KEY', JSON.stringify(bad));
    assert.equal(refusal(() => sealBuffer(bad, Buffer.from('x'))), 'SEAL_KEY', JSON.stringify(bad));
  }
  // A low-order point yields no shared secret; sealing to it would protect nothing.
  assert.equal(refusal(() => sealBuffer(Buffer.alloc(32).toString('base64url'), Buffer.from('x'))), 'SEAL_KEY');
});

test('tampering: flipping any single byte of a sealed file is refused', () => {
  const keys = generateSealKeys();
  const sealed = sealBuffer(keys.publicKey, Buffer.from('{"rows":[{"slug":"a-draft-product"}]}'));
  const kidAt = MAGIC.length + 1;
  const ephemeralAt = kidAt + 8;
  const nonceAt = ephemeralAt + 32;
  const expected = (at: number) =>
    at < MAGIC.length ? 'SEAL_FORMAT'
      : at < kidAt ? 'SEAL_VERSION'
        : at < ephemeralAt ? 'SEAL_WRONG_KEY'
          : 'SEAL_TAMPERED'; // the ephemeral key, the nonce, the ciphertext and the tag
  for (let at = 0; at < sealed.length; at++) {
    const bent = Buffer.from(sealed);
    bent[at] ^= 0x01;
    assert.equal(refusal(() => unsealBuffer(keys.privateKeyPem, bent)), expected(at), `byte ${at} (nonce at ${nonceAt})`);
  }
  // Cut short, lengthened, or emptied.
  assert.equal(refusal(() => unsealBuffer(keys.privateKeyPem, sealed.subarray(0, sealed.length - 1))), 'SEAL_TAMPERED');
  assert.equal(refusal(() => unsealBuffer(keys.privateKeyPem, Buffer.concat([sealed, Buffer.from([0])]))), 'SEAL_TAMPERED');
  assert.equal(refusal(() => unsealBuffer(keys.privateKeyPem, sealed.subarray(0, HEADER_BYTES + TAG_BYTES - 1))), 'SEAL_FORMAT');
  assert.equal(refusal(() => unsealBuffer(keys.privateKeyPem, Buffer.alloc(0))), 'SEAL_FORMAT');
  assert.equal(refusal(() => unsealBuffer(keys.privateKeyPem, Buffer.from('{"not":"sealed"}'))), 'SEAL_FORMAT');
});

test('the wrong key is refused, and so is a key id forged to point at it', () => {
  const alice = generateSealKeys();
  const mallory = generateSealKeys();
  const sealed = sealBuffer(alice.publicKey, Buffer.from('the live snapshot'));
  assert.equal(refusal(() => unsealBuffer(mallory.privateKeyPem, sealed)), 'SEAL_WRONG_KEY');
  // Rewriting the key id to the other key does not make it open: the id is
  // authenticated, and the key agreement differs.
  const forged = Buffer.from(sealed);
  Buffer.from(mallory.kid, 'hex').copy(forged, MAGIC.length + 1);
  assert.equal(refusal(() => unsealBuffer(mallory.privateKeyPem, forged)), 'SEAL_TAMPERED');
  // Not an X25519 private key at all.
  const ed = generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' });
  assert.equal(refusal(() => unsealBuffer(ed, sealed)), 'SEAL_KEY');
});

test('the header version is checked before any key is used', () => {
  const keys = generateSealKeys();
  const sealed = sealBuffer(keys.publicKey, Buffer.from('x'));
  for (const version of [0, 2, 255]) {
    const other = Buffer.from(sealed);
    other[MAGIC.length] = version;
    assert.equal(refusal(() => readSealedHeader(other)), 'SEAL_VERSION');
    // Even with the wrong key: the version is read before the key id is compared.
    assert.throws(() => unsealBuffer(generateSealKeys().privateKeyPem, other), (error: unknown) =>
      error instanceof SealError && (error as SealErrorLike).code === 'SEAL_VERSION' && new RegExp(`version ${version}\\b`).test((error as SealErrorLike).message));
  }
});

test('keygen: a 0600 private key outside any git checkout, and only the public key on stdout', { skip: process.platform === 'win32' && 'asserts the key file\'s POSIX 0600 mode and a private directory; Windows reports 0o666 whatever the ACL' }, () => {
  const s = scratch();
  try {
    const keys = join(s.dir, 'keys');
    const made = node(SEAL, ['--keygen', keys]);
    assert.equal(made.status, 0, made.stderr);
    const lines = made.stdout.trim().split('\n');
    assert.equal(lines.length, 1, 'stdout carries the public key and nothing else');
    assert.match(lines[0], PUBLIC_KEY_PATTERN);
    const files = readdirSync(keys);
    assert.equal(files.length, 1);
    assert.match(files[0], /^bambu-seal-[0-9a-f]{16}\.pem$/);
    assert.equal(statSync(join(keys, files[0])).mode & 0o777, 0o600);
    assert.equal(statSync(keys).mode & 0o077, 0, 'the key directory is private');
    assert.match(readFileSync(join(keys, files[0]), 'utf8'), /^-----BEGIN PRIVATE KEY-----/);
    assert.ok(!made.stdout.includes('PRIVATE KEY') && !made.stderr.includes('PRIVATE KEY'));
    // The id in the file name is the id the header carries.
    const sealed = sealBuffer(lines[0], Buffer.from('x'));
    assert.equal(`bambu-seal-${readSealedHeader(sealed).kid}.pem`, files[0]);

    // Inside a git checkout (this repository): refused, nothing written.
    const inside = join(ROOT, 'scripts/bambu-import/.keygen-must-not-exist');
    const refused = node(SEAL, ['--keygen', inside]);
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /inside the git checkout/);
    assert.equal(refused.stdout, '');
    assert.ok(!existsSync(inside));
  } finally {
    s.dispose();
  }
});

test('the CLIs: seal deletes the plaintext; unseal refuses the wrong key and a tampered file and never overwrites', { skip: process.platform === 'win32' && 'asserts the opened file\'s POSIX 0600 mode; Windows reports 0o666 whatever the ACL' }, () => {
  const s = scratch();
  try {
    const pub = node(SEAL, ['--keygen', join(s.dir, 'keys')]).stdout.trim();
    const keyFile = join(s.dir, 'keys', readdirSync(join(s.dir, 'keys'))[0]);
    const other = node(SEAL, ['--keygen', join(s.dir, 'other')]).stdout.trim();
    assert.match(other, PUBLIC_KEY_PATTERN);
    const otherKey = join(s.dir, 'other', readdirSync(join(s.dir, 'other'))[0]);

    const clear = join(s.dir, 'snapshot.json');
    const body = JSON.stringify({ products: [{ slug: 'hidden-one', status: 'hidden' }] });
    writeFileSync(clear, body);
    // A name that does not end in .sealed would slip past the upload filter: refused.
    assert.equal(node(SEAL, ['--pub', pub, clear, join(s.dir, 'snapshot.bin')]).status, 1);
    assert.ok(existsSync(clear), 'a refused seal leaves the input alone');

    const sealedPath = join(s.dir, 'snapshot.sealed');
    const sealed = node(SEAL, ['--pub', pub, clear, sealedPath]);
    assert.equal(sealed.status, 0, sealed.stderr);
    assert.ok(!existsSync(clear), 'the plaintext is deleted after sealing');
    assert.ok(!existsSync(`${sealedPath}.partial`));
    assert.ok(!readFileSync(sealedPath).includes(Buffer.from('hidden-one')));
    assert.ok(!sealed.stdout.includes('hidden-one') && !sealed.stderr.includes('hidden-one'));
    // Never over an existing sealed file.
    writeFileSync(clear, body);
    assert.equal(node(SEAL, ['--pub', pub, clear, sealedPath]).status, 1);
    // --keep keeps the input.
    assert.equal(node(SEAL, ['--pub', pub, clear, join(s.dir, 'kept.sealed'), '--keep']).status, 0);
    assert.ok(existsSync(clear));

    const out = join(s.dir, 'opened.json');
    const wrong = node(UNSEAL, ['--key', otherKey, sealedPath, out]);
    assert.equal(wrong.status, 1);
    assert.match(wrong.stderr, /refused — this file is sealed to key [0-9a-f]{16}/);
    assert.ok(!existsSync(out), 'a refusal writes nothing');

    const bent = readFileSync(sealedPath);
    bent[bent.length - 20] ^= 0x80;
    writeFileSync(join(s.dir, 'bent.sealed'), bent);
    const tampered = node(UNSEAL, ['--key', keyFile, join(s.dir, 'bent.sealed'), out]);
    assert.equal(tampered.status, 1);
    assert.match(tampered.stderr, /altered or damaged/);
    assert.ok(!existsSync(out));

    const opened = node(UNSEAL, ['--key', keyFile, sealedPath, out]);
    assert.equal(opened.status, 0, opened.stderr);
    assert.equal(readFileSync(out, 'utf8'), body);
    assert.equal(statSync(out).mode & 0o777, 0o600);
    assert.ok(!opened.stdout.includes('hidden-one') && !opened.stderr.includes('hidden-one'), 'nothing of the plaintext is printed');
    assert.equal(node(UNSEAL, ['--key', keyFile, sealedPath, out]).status, 1, 'never over an existing file');

    assert.equal(node(UNSEAL, [sealedPath, out]).status, 2);
    assert.equal(node(SEAL, ['--pub', pub, clear]).status, 2);
  } finally {
    s.dispose();
  }
});
