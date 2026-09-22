/**
 * The delivery company's cash-handling charge.
 *
 * «الضريبه في شركة التوصيل اجعلها 3 الف لكل 500 الف وتكون قابله للتغير من قبل
 *  الادارة» — the rate halved, and it stopped being a compiled constant.
 *
 * These tests cover BOTH halves: the default a shop charges out of the box,
 * and the fact that a configured rate is honoured — including the values a
 * configured rate must refuse, because `Math.floor(x / 0)` is `Infinity` and
 * an Infinity reaching a total is a number nobody can pay.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateCodTaxIqd,
  codDeliveryTaxIqd,
  normalizeCodTaxRate,
  COD_TAX_BLOCK_IQD,
  COD_TAX_PER_BLOCK_IQD,
} from '../worker/lib/codTax';

test('the default charge is 3,000 IQD for each complete 500,000 IQD block', () => {
  assert.equal(COD_TAX_PER_BLOCK_IQD, 3_000, 'the owner halved it from 6,000');
  assert.equal(COD_TAX_BLOCK_IQD, 500_000);
  for (const [payable, expected] of [
    [0, 0],
    [499_999, 0],
    [500_000, 3_000],
    [750_000, 3_000],
    [999_999, 3_000],
    [1_000_000, 6_000],
    [1_250_000, 6_000],
    [1_500_000, 9_000],
    [3_000_000, 18_000],
  ] as const) {
    assert.equal(calculateCodTaxIqd(payable), expected, `${payable} IQD`);
  }
});

test('COD tax applies only to cash delivery by standard or personal service', () => {
  assert.equal(codDeliveryTaxIqd({ payableBeforeTaxIqd: 1_000_000, paymentMethodId: 'cash', deliveryMethodId: 'standard' }), 6_000);
  assert.equal(codDeliveryTaxIqd({ payableBeforeTaxIqd: 1_000_000, paymentMethodId: 'cash_on_delivery', deliveryMethodId: 'personal' }), 6_000);
  assert.equal(codDeliveryTaxIqd({ payableBeforeTaxIqd: 1_000_000, paymentMethodId: 'cod', deliveryMethodId: 'pickup' }), 0);
  assert.equal(codDeliveryTaxIqd({ payableBeforeTaxIqd: 1_000_000, paymentMethodId: 'wallet', deliveryMethodId: 'standard' }), 0);
  assert.equal(codDeliveryTaxIqd({ payableBeforeTaxIqd: 1_000_000, paymentMethodId: 'card', deliveryMethodId: 'personal' }), 0);
});

test('wallet value reduces the COD tax base and tax never taxes itself', () => {
  assert.equal(codDeliveryTaxIqd({ payableBeforeTaxIqd: 499_999, paymentMethodId: 'cash', deliveryMethodId: 'standard' }), 0);
  assert.equal(codDeliveryTaxIqd({ payableBeforeTaxIqd: 500_000, paymentMethodId: 'cash', deliveryMethodId: 'standard' }), 3_000);
  assert.equal(calculateCodTaxIqd(503_000), 3_000, 'a tax amount is not recursively added to its own base');
});

// ────────────────────────────────────────────── the administrator's rate

test('a configured rate is what gets charged', () => {
  const rate = { perBlockIqd: 10_000, blockIqd: 250_000 };
  assert.equal(calculateCodTaxIqd(249_999, rate), 0);
  assert.equal(calculateCodTaxIqd(250_000, rate), 10_000);
  assert.equal(calculateCodTaxIqd(1_000_000, rate), 40_000);
  assert.equal(
    codDeliveryTaxIqd({ payableBeforeTaxIqd: 500_000, paymentMethodId: 'cash', deliveryMethodId: 'standard' }, rate),
    20_000
  );
  // The exemptions are about the METHOD, so a configured rate cannot make a
  // pickup taxable.
  assert.equal(
    codDeliveryTaxIqd({ payableBeforeTaxIqd: 500_000, paymentMethodId: 'cash', deliveryMethodId: 'pickup' }, rate),
    0
  );
});

test('zero is a rate — switching the charge off must not need a code change', () => {
  const off = { perBlockIqd: 0, blockIqd: 500_000 };
  assert.equal(calculateCodTaxIqd(3_000_000, off), 0);
  assert.equal(normalizeCodTaxRate(off).perBlockIqd, 0, 'a per-block of 0 is legal and is kept');
});

test('a broken rate falls back rather than producing Infinity on an invoice', () => {
  // THE DANGEROUS ONE. A block of 0 makes Math.floor(x / 0) === Infinity, and
  // an Infinity in a total is a number nobody can pay and a page nobody can
  // read. Anything non-finite or non-positive on the block reverts to the
  // default; a NEGATIVE per-block would be a refund at the door, so it does
  // too.
  for (const broken of [
    { perBlockIqd: 3_000, blockIqd: 0 },
    { perBlockIqd: 3_000, blockIqd: -500_000 },
    { perBlockIqd: 3_000, blockIqd: Number.NaN },
    { perBlockIqd: 3_000, blockIqd: Number.POSITIVE_INFINITY },
    { perBlockIqd: -1, blockIqd: 500_000 },
    { perBlockIqd: Number.NaN, blockIqd: 500_000 },
  ]) {
    const normalized = normalizeCodTaxRate(broken);
    assert.ok(Number.isFinite(normalized.blockIqd) && normalized.blockIqd > 0, JSON.stringify(broken));
    assert.ok(Number.isFinite(normalized.perBlockIqd) && normalized.perBlockIqd >= 0, JSON.stringify(broken));
    const charged = calculateCodTaxIqd(1_000_000, broken);
    assert.ok(Number.isFinite(charged), `${JSON.stringify(broken)} produced ${charged}`);
  }
  // Absent entirely is the commonest case — a server older than the setting.
  assert.equal(calculateCodTaxIqd(1_000_000, null), 6_000);
  assert.equal(calculateCodTaxIqd(1_000_000, undefined), 6_000);
  assert.equal(calculateCodTaxIqd(1_000_000, {}), 6_000);
});

test('a fractional configured rate is truncated, never carried into a price', () => {
  // Dinars are whole. A rate typed as 3000.7 must not put a fraction of a
  // dinar on an invoice.
  const charged = calculateCodTaxIqd(1_000_000, { perBlockIqd: 3_000.7, blockIqd: 500_000.9 });
  assert.equal(charged, 6_000);
  assert.equal(Math.trunc(charged), charged);
});
