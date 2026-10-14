/**
 * The small copy the claim conversation shows in each language. A new claim
 * has no messages: every language must say so instead of «0 نامە», and a
 * Sorani reader must be told, right after submitting, where the conversation
 * lives — in Sorani, never the Arabic pasted across (DECISIONS row 183).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { WARRANTY_STRINGS } from '../src/components/warranty/strings';

test('no language shows «0 messages» for a claim nobody has written in yet', () => {
  assert.equal(WARRANTY_STRINGS.ar.messagesCount(0, '0'), 'لا توجد رسائل بعد');
  assert.equal(WARRANTY_STRINGS.en.messagesCount(0, '0'), 'No messages yet');
  assert.equal(WARRANTY_STRINGS.ckb.messagesCount(0, '0'), 'هێشتا هیچ نامەیەک نییە');
  assert.equal(WARRANTY_STRINGS.ckb.messagesCount(3, '3'), '3 نامە');
});

test('the Sorani «claim submitted» notice says where the conversation is, under its Sorani heading', () => {
  assert.ok(WARRANTY_STRINGS.ckb.claimSubmitted.includes(`«${WARRANTY_STRINGS.ckb.claims}»`));
});

test('the claim conversation copy is Sorani of its own, never the Arabic or the English (DECISIONS row 183)', () => {
  const { ar, en, ckb } = WARRANTY_STRINGS;
  for (const k of ['claimSubmitted', 'claimReplayNotice', 'claimsHint', 'threadIntro', 'threadClosed', 'attachments', 'evidenceHint', 'evidenceLimits'] as const) {
    assert.ok(ckb[k].trim().length > 0, `ckb.${k} is empty`);
    assert.notEqual(ckb[k], ar[k], `ckb.${k} is the Arabic`);
    assert.notEqual(ckb[k], en[k], `ckb.${k} is the English`);
  }
  assert.notEqual(ckb.messagesCount(0, '0'), ar.messagesCount(0, '0'));
});

test('the English admin queue pluralises its message count', () => {
  const src = readFileSync(new URL('../src/components/AdminSerials.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /message\(s\)/);
  assert.match(src, /messagesN: \(n: number\) => \(n === 1 \? '1 message' : `\$\{n\} messages`\)/);
});
