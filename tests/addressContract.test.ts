/**
 * AN ADDRESS IS A PARCEL'S ONLY INSTRUCTIONS. IT HAS TO BE REAL.
 *
 * `worker/routes/admin.ts` copies `address.phone` and `address.governorate`
 * straight onto the courier's shipment request. Until now the route accepted
 * whatever passed `/^\+?[0-9\s-]{7,20}$/` — a shape check — while the client
 * blindly prepended `'+964-'` to whatever was typed. Between them:
 *
 *   - `+964-0770 123 4567` was stored verbatim, hyphen, spaces, bogus leading
 *     zero and all, and handed to Al-Waseet;
 *   - `+964-12345678` passed too, and is not a routable Iraqi number;
 *   - a stored `+13105551234` could never be edited, because the client
 *     stripped `+964` only on an exact match and then re-added it, producing
 *     `+964-+13105551234`, which the regex then refused — forever;
 *   - the governorate, the field DISPATCH ROUTES ON, was optional on edit, and
 *     a legacy value outside the closed list was silently wiped to '' by the
 *     act of opening the editor and saving.
 *
 * These pin the route's half of the contract. The client's half (one shared
 * form, no prefixing, a required governorate on both create and edit) lives in
 * `src/components/address/AddressForm.tsx`.
 *
 * Run: npm run test:unit
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { asD1, freshDb, get, json, post, stubApp, row } from './fixtures/app';
import { addressRoutes } from '../worker/routes/addresses';

function build() {
  const raw = freshDb();
  raw.exec(
    "INSERT INTO users (id,name,email,password_hash,role) VALUES ('u1','Buyer','b@x.co','h','customer');"
  );
  const app = stubApp(asD1(raw), { id: 'u1', role: 'customer', email: 'b@x.co' }, (a) => {
    a.route('/api/addresses', addressRoutes);
  });
  return { app, raw };
}

const BASE = {
  label: 'Home',
  name: 'Ahmed Ali',
  address: 'Karrada, street 14, house 7',
  governorate: 'baghdad',
  area: 'Karrada',
  landmark: '',
  notes: '',
};

test('a phone is stored as E.164, whatever shape the customer typed', async () => {
  const shapes = [
    ['07701234567', '+9647701234567'],
    ['+9647701234567', '+9647701234567'],
    ['009647701234567', '+9647701234567'],
    // The digits an Arabic keyboard produces.
    ['٠٧٧٠١٢٣٤٥٦٧', '+9647701234567'],
    // Spaces and hyphens are a human writing a number, not part of it.
    ['0770 123 4567', '+9647701234567'],
  ];
  for (const [typed, expected] of shapes) {
    const { app, raw } = build();
    const res = await post(app, '/api/addresses', { ...BASE, phone: typed });
    assert.equal(res.status, 200, `${typed} was refused`);
    const id = (await json(res)).id as string;
    const stored = row<{ phone: string }>(raw, 'SELECT phone FROM addresses WHERE id = ?', id);
    assert.equal(stored?.phone, expected, `${typed} stored wrong`);
  }
});

test('the malformed strings the old client produced are HEALED, not merely refused', async () => {
  // `'+964-' + '07701234567'` is what the old form wrote into the database and
  // what it therefore reads back on an edit. libphonenumber recognises the
  // country code, drops the national trunk prefix and yields the number that
  // was meant all along — so simply opening and saving such an address repairs
  // it, rather than locking the customer out of their own record. That is the
  // behaviour worth pinning: repair beats rejection when the intent is
  // unambiguous.
  for (const legacy of ['+964-07701234567', '+964-0770 123 4567', '+964-7701234567']) {
    const { app, raw } = build();
    const res = await post(app, '/api/addresses', { ...BASE, phone: legacy });
    assert.equal(res.status, 200, `${legacy} was refused`);
    const id = (await json(res)).id as string;
    assert.equal(
      row<{ phone: string }>(raw, 'SELECT phone FROM addresses WHERE id = ?', id)?.phone,
      '+9647701234567',
      `${legacy} was not repaired`
    );
  }
});

test('input with no honest reading is refused, with a code the client can translate', async () => {
  for (const bad of [
    // Two country codes: the exact string the old client produced when it
    // re-prefixed an address whose number was not Iraqi. There is nothing to
    // repair here — it is not a number.
    '+964-+13105551234',
    'not a phone',
    '07701',
  ]) {
    const { app } = build();
    const res = await post(app, '/api/addresses', { ...BASE, phone: bad });
    assert.equal(res.status, 400, `${JSON.stringify(bad)} was accepted`);
    assert.equal((await json(res)).code, 'INVALID_PHONE', `${JSON.stringify(bad)} refused for the wrong reason`);
  }
  // Below the length floor the generic field guard answers first — still a
  // 400 the form shows inline, just not this code.
  for (const tooShort of ['', '123']) {
    const { app } = build();
    assert.equal((await post(app, '/api/addresses', { ...BASE, phone: tooShort })).status, 400);
  }
});

test('an international number is kept on its own numbering plan, not mangled into +964', async () => {
  const { app, raw } = build();
  const res = await post(app, '/api/addresses', { ...BASE, phone: '+13105551234' });
  assert.equal(res.status, 200);
  const id = (await json(res)).id as string;
  assert.equal(row<{ phone: string }>(raw, 'SELECT phone FROM addresses WHERE id = ?', id)?.phone, '+13105551234');
});

test('a number that could not be edited before round-trips through an update', async () => {
  const { app, raw } = build();
  const created = await json(await post(app, '/api/addresses', { ...BASE, phone: '+13105551234' }));
  // The old client would have sent '+964-+13105551234' here and been refused
  // every single time. Sending what is stored must simply work.
  const res = await app.request(`/api/addresses/${created.id}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', 'CF-Connecting-IP': '1.2.3.4' },
    body: JSON.stringify({ ...BASE, phone: '+13105551234', address: 'Karrada, street 15, house 9' }),
  });
  assert.equal(res.status, 200);
  const after = row<{ phone: string; address: string }>(raw, 'SELECT phone, address FROM addresses WHERE id = ?', created.id);
  assert.equal(after?.phone, '+13105551234');
  assert.equal(after?.address, 'Karrada, street 15, house 9');
});

test('the governorate is required on create AND on edit — dispatch routes on it', async () => {
  const { app } = build();
  const missing = await post(app, '/api/addresses', { ...BASE, phone: '07701234567', governorate: '' });
  assert.equal(missing.status, 400);
  assert.equal((await json(missing)).code, 'GOVERNORATE_REQUIRED');

  const created = await json(await post(app, '/api/addresses', { ...BASE, phone: '07701234567' }));
  // The edit path skipped the check entirely, which is how a saved address
  // came to reach the courier with an empty governorate.
  const wiped = await app.request(`/api/addresses/${created.id}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', 'CF-Connecting-IP': '1.2.3.4' },
    body: JSON.stringify({ ...BASE, phone: '07701234567', governorate: '' }),
  });
  assert.equal(wiped.status, 400);
  assert.equal((await json(wiped)).code, 'GOVERNORATE_REQUIRED');
});

test('an unknown governorate is refused rather than normalised to nothing', async () => {
  const { app } = build();
  const res = await post(app, '/api/addresses', { ...BASE, phone: '07701234567', governorate: 'atlantis' });
  assert.equal(res.status, 400);
  assert.equal((await json(res)).code, 'GOVERNORATE_REQUIRED');
});

test('the read carries the PRO snapshot fields the address screen explains eligibility with', async () => {
  const { app } = build();
  await post(app, '/api/addresses', { ...BASE, phone: '07701234567' });
  const data = await json(await get(app, '/api/addresses'));
  const a = data.addresses[0];
  // Both are computed on every read specifically for this screen; every client
  // used to discard them.
  assert.ok('backs_approved_snapshot' in a);
  assert.ok('matches_approved_snapshot' in a);
  assert.equal(a.backs_approved_snapshot, false);
  assert.equal(a.matches_approved_snapshot, null);
});
