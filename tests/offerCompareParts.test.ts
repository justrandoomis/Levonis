/**
 * THE CUSTOMER'S SIDE OF A PARTIAL OR SUBSTITUTED OFFER (P1-05, docs/
 * DECISIONS.md row 267) — src/components/community/requests/offerParts.ts and
 * the composer half of the body, pure.
 *
 * Pinned: acceptance sends an acknowledgement only for what the offer needs
 * (a whole, unsubstituted offer sends the v1 body byte for byte); cheapest and
 * fastest are chosen among complete offers; by price a partial offer comes
 * after the complete ones; the partial label counts the parts; and the
 * composer sends coverage and substitutions only when they are not the
 * default — or writes the default out to clear an edited offer.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

(globalThis as { localStorage?: unknown }).localStorage = { getItem: () => null, setItem: () => undefined, removeItem: () => undefined };
const parts = await import('../src/components/community/requests/offerParts');
const { requestStrings } = await import('../src/components/community/requests/strings');
const { partsBody, defaultCoverage } = await import('../src/components/community/requests/OfferPartsField');
const { apiRefusal } = await import('../src/lib/refusalStrings');
import type { OfferV2 } from '../src/components/community/requests/api';

const offer = (o: Partial<OfferV2> = {}): OfferV2 =>
  ({
    id: 'o1', request_id: 'r1', merchant_id: 'm1', store_id: 's1', price_iqd: 20_000, delivery_fee_iqd: 0, total_iqd: 20_000,
    quantity: null, color: '', terms: '', completion_days: 3, delivery_method: 'merchant_delivery', message: '', materials: '',
    material_ids: [], included: '', warranty_terms: '', state: 'pending', draft: false, expires_at: null, valid_until: null,
    created_at: '', updated_at: '', revision: 1, request_revision: 1, revised: false, stale: false, expired: false, files: [],
    merchant: null, ...o,
  }) as OfferV2;

const SUB = { part_id: 'pb', material_row_id: 'mb', from: { material_id: 'tpu', colors: [] }, to: { material_id: 'petg', colors: [] }, note: '' };

test('acceptance acknowledges only what the offer needs; a whole offer sends the v1 body byte for byte', () => {
  assert.deepEqual(parts.acceptBody(offer(), 'a1'), { expected_total_iqd: 20_000, offer_revision: 1, address_id: 'a1' });
  assert.deepEqual(parts.acceptBody(offer({ coverage: { covers_all: true, parts: null }, substitutions: [] }), ''), { expected_total_iqd: 20_000, offer_revision: 1 });
  assert.deepEqual(parts.acceptBody(offer({ substitutions: [SUB] }), ''), { expected_total_iqd: 20_000, offer_revision: 1, accept_substitutions: true });
  assert.deepEqual(parts.acceptBody(offer({ coverage: { covers_all: false, parts: ['pa'] } }), ''), { expected_total_iqd: 20_000, offer_revision: 1, accept_partial: true });
  assert.deepEqual(parts.acceptBody(offer({ coverage: { covers_all: false, parts: ['pa'] }, substitutions: [SUB], delivery_method: 'pickup' }), 'a1'), {
    expected_total_iqd: 20_000, offer_revision: 1, accept_substitutions: true, accept_partial: true,
  });
});

test('the quick comparison picks the cheapest and the fastest among complete offers; by price a partial one comes after', () => {
  const whole = offer({ id: 'whole', total_iqd: 30_000, completion_days: 5 });
  const cheapPartial = offer({ id: 'part', total_iqd: 9_000, completion_days: 1, coverage: { covers_all: false, parts: ['pa'] } });
  const best = parts.bestOffers([whole, cheapPartial]);
  assert.equal(best.cheapest?.id, 'whole');
  assert.equal(best.fastest?.id, 'whole');
  // Only partial offers: they are the pool.
  assert.equal(parts.bestOffers([cheapPartial]).cheapest?.id, 'part');
  assert.deepEqual(parts.sortOffers([cheapPartial, whole], 'price').map((o) => o.id), ['whole', 'part']);
  assert.deepEqual(parts.sortOffers([cheapPartial, whole], 'time').map((o) => o.id), ['whole', 'part']);
});

test('the partial label counts the parts covered, in three languages; a whole offer has none', () => {
  const o = offer({ coverage: { covers_all: false, parts: ['pa'] } });
  assert.equal(parts.partialLabel(o, 2, requestStrings('ar')), 'جزئي — القطع المشمولة 1/2');
  assert.equal(parts.partialLabel(o, 2, requestStrings('en')), 'Partial — parts covered 1/2');
  assert.equal(parts.partialLabel(o, 2, requestStrings('ckb')), 'بەشەکی — پارچە گیراوەکان 1/2');
  assert.equal(parts.partialLabel(offer(), 2, requestStrings('ar')), '');
  const list = [{ id: 'pa', name: 'Body', position: 0 }, { id: 'pb', name: '', position: 1 }];
  const cov = parts.coverageOf(o, list);
  assert.deepEqual(cov.covered.map((p) => p.id), ['pa']);
  assert.deepEqual(cov.uncovered.map((p) => p.id), ['pb']);
  assert.equal(parts.partName(cov.uncovered[0], requestStrings('ckb')), 'پارچەی 2', 'a part without a name is named by its place');
});

test('the composer sends coverage and substitutions only when not the default — or the default written out to clear an edit', () => {
  assert.deepEqual(partsBody({ coverage: null, subs: [] }, { clear: false }), {});
  assert.deepEqual(partsBody({ coverage: null, subs: [] }, { clear: true }), { coverage: null, substitutions: [] });
  assert.deepEqual(partsBody({ coverage: ['pa'], subs: [] }, { clear: false }), { coverage: { parts: ['pa'] } });
  assert.deepEqual(
    partsBody({ coverage: null, subs: [{ part_id: 'pb', material_row_id: 'mb', material_id: 'petg', colors: [{ hex: '#1a1a1a', label: 'Black' }], note: '' }] }, { clear: false }),
    { substitutions: [{ part_id: 'pb', material_row_id: 'mb', to: { material_id: 'petg', colors: [{ hex: '#1a1a1a', label: 'Black' }] } }] }
  );
  // The default ticks are the parts the workshop can make.
  const ps = [{ id: 'pa' }, { id: 'pb' }];
  assert.equal(defaultCoverage(ps, null), null);
  assert.equal(defaultCoverage(ps, [{ part_id: 'pa', eligible: true, reasons: [] }, { part_id: 'pb', eligible: true, reasons: [] }]), null);
  assert.deepEqual(defaultCoverage(ps, [{ part_id: 'pa', eligible: true, reasons: [] }, { part_id: 'pb', eligible: false, reasons: ['MATERIAL'] }]), ['pa']);
});

test('a refusal about one part names the part first, in three languages; any other refusal reads as before', () => {
  const err = { code: 'PART_PROCESS_MIXED', message: 'x', details: { part_id: 'pt', position: 1 } };
  assert.ok(apiRefusal(err, 'ar').startsWith('القطعة 2: '));
  assert.ok(apiRefusal(err, 'en').startsWith('Part 2: One part cannot be printed'));
  assert.ok(apiRefusal(err, 'ckb').startsWith('پارچەی 2: '));
  assert.ok(apiRefusal({ code: 'OFFER_PART_NOT_ELIGIBLE', details: { part_id: 'pt', position: 0, reasons: [] } }, 'en').startsWith('Part 1: '));
  assert.equal(apiRefusal({ code: 'OFFER_STALE', details: { position: 3 } }, 'en'), apiRefusal({ code: 'OFFER_STALE' }, 'en'));
});
