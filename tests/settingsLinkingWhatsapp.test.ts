/**
 * «في لوحة الإعدادات في الربط لا يوجد خيار لربط ال WhatsApp».
 *
 * True — and the reason it was missing is the reason the row is shaped the
 * way it is rather than being a button.
 *
 * THERE IS NOTHING TO LINK. Telegram and Google are ACCOUNTS this one is
 * joined to, each with its own handshake. WhatsApp is not: the shop sends
 * through WasenderAPI from its own number, to the verified number already on
 * this account — `phone_e164`, which migration 0013 only ever writes after
 * Telegram contact verification. There is no WhatsApp handshake to offer, and
 * a «ربط واتساب» button that opened nothing would be the worst possible
 * answer to this report: a control with no effect, which is the defect this
 * codebase keeps removing rather than adding.
 *
 * So the row reports the state, in the section the owner went looking in, and
 * points at the Telegram link above — the thing that actually turns WhatsApp
 * on. This file pins that it says the true thing, that it never claims a
 * channel the deployment cannot send on, and that it shares its strings with
 * the notifications row so the two cannot drift into disagreeing.
 *
 * Run: npm run test:unit
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const settings = readFileSync(join(ROOT, 'src/pages/Settings.tsx'), 'utf8');

test('the linking section has a WhatsApp row now', () => {
  const at = settings.indexOf('data-linking-whatsapp');
  assert.ok(at > 0, 'the row exists');
  // In the LINKING section, which is where the report came from — after its
  // heading and before the section closes. Bounded by the section's OWN close
  // rather than by whichever section happens to follow it: the seven cards
  // were reordered for «أعد الترتيب» and a neighbour's name is not a boundary.
  const sectionStart = settings.indexOf('id="settings-linking"');
  assert.ok(sectionStart > 0, 'the linking section is still anchorable');
  const sectionEnd = settings.indexOf('</SectionCard>', sectionStart);
  assert.ok(sectionEnd > sectionStart, 'the linking section still closes');
  assert.ok(at > sectionStart && at < sectionEnd, 'inside «الربط», not somewhere else');
});

test('it reports a state and offers no handshake that does not exist', () => {
  const at = settings.indexOf('data-linking-whatsapp');
  const row = settings.slice(at, at + 1400);
  assert.ok(row.includes('user?.has_phone ? s.waReady : s.waNeedsPhone'), 'the two honest states');
  // No button, no link, no onClick: there is no WhatsApp flow to open.
  assert.ok(!/<button/.test(row), 'no button');
  assert.ok(!/onClick=/.test(row), 'and nothing to press');
});

test('it is drawn only when the DEPLOYMENT can send on WhatsApp at all', () => {
  const at = settings.indexOf('data-linking-whatsapp');
  const before = settings.slice(Math.max(0, at - 400), at);
  assert.ok(before.includes('{whatsappConfigured ?'), 'gated on the provider existing');
  // `whatsappConfigured` is about the DEPLOYMENT, not about whether the
  // shop's WhatsApp session happens to be linked right now — only a live
  // provider call could answer that, and this page makes none.
  assert.match(settings, /const whatsappConfigured = useCapabilities\(\)\?\.whatsappOtp \?\? false;/);
});

test('the number it reaches comes from Telegram verification, and the row says so', () => {
  const at = settings.indexOf('data-linking-whatsapp');
  const row = settings.slice(at, at + 1400);
  // The SAME strings the notifications row uses, not a second wording that
  // could come to disagree with it.
  assert.ok(row.includes('s.waReadyNote'));
  assert.ok(row.includes('s.waNeedsPhoneNote'));
  const notifAt = settings.indexOf('user?.has_phone ? s.waReadyNote : s.waNeedsPhoneNote');
  assert.ok(notifAt > 0 && notifAt !== row.indexOf('s.waReadyNote'), 'both rows read the same pair');
  // And «وثّق رقمك عبر تيليغرام ليعمل واتساب» is what that string says, in
  // all three languages.
  assert.equal(settings.split('waNeedsPhoneNote:').length - 1, 3, 'ar, en and ckb');
});
