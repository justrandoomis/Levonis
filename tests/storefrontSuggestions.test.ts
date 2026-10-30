import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emailSuggestions } from '../src/components/auth/emailDomainSuggestions';
import { addressChoices } from '../src/components/address/addressChoices';
import type { ApiAddress } from '../src/lib/api';

test('email completion preserves the local part and suggests transposed domains without rejecting custom addresses', () => {
  assert.equal(emailSuggestions('Ali+shop@gmial.com').correction, 'Ali+shop@gmail.com');
  assert.equal(emailSuggestions('Ali@GMAIL.COM').correction, null);
  assert.equal(emailSuggestions('ali@levonis-iq.com').correction, null);
  assert.equal(emailSuggestions('username').correction, null);
  assert.equal(emailSuggestions('ali@x@y.com').correction, null);
  assert.deepEqual(emailSuggestions('ali@gm').domains, ['ali@gmail.com']);
  assert.equal(emailSuggestions('ali@').domains.length, 4);
});

test('address search matches only supplied saved streets and multilingual governorates', () => {
  const saved = { id: 'mine', label: 'العمل', address: 'شارع الصناعة بناية 12', area: 'الكرادة', landmark: 'قرب الجامعة', governorate: 'baghdad' } as ApiAddress;
  assert.equal(addressChoices([saved], 'الصناعة', 'ar')[0].saved, saved);
  assert.equal(addressChoices([saved], 'الجامعة', 'ar')[0].id, 'mine');
  assert.equal(addressChoices([], 'Baghdad', 'en')[0].governorate, 'baghdad');
  assert.equal(addressChoices([], 'اربيل', 'ar')[0].governorate, 'erbil');
  assert.deepEqual(addressChoices([], 'شارع غير معروف', 'ar'), []);
  assert.deepEqual(addressChoices([saved], 'ا', 'ar'), []);
});
