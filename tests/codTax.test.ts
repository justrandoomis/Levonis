import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calculateCodTaxIqd, codDeliveryTaxIqd } from '../worker/lib/codTax';

test('COD tax charges 6,000 IQD for each complete 500,000 IQD block', () => {
  for (const [payable, expected] of [
    [0, 0],
    [499_999, 0],
    [500_000, 6_000],
    [750_000, 6_000],
    [999_999, 6_000],
    [1_000_000, 12_000],
    [1_250_000, 12_000],
    [1_500_000, 18_000],
    [3_000_000, 36_000],
  ] as const) {
    assert.equal(calculateCodTaxIqd(payable), expected, `${payable} IQD`);
  }
});

test('COD tax applies only to cash delivery by standard or personal service', () => {
  assert.equal(codDeliveryTaxIqd({ payableBeforeTaxIqd: 1_000_000, paymentMethodId: 'cash', deliveryMethodId: 'standard' }), 12_000);
  assert.equal(codDeliveryTaxIqd({ payableBeforeTaxIqd: 1_000_000, paymentMethodId: 'cash_on_delivery', deliveryMethodId: 'personal' }), 12_000);
  assert.equal(codDeliveryTaxIqd({ payableBeforeTaxIqd: 1_000_000, paymentMethodId: 'cod', deliveryMethodId: 'pickup' }), 0);
  assert.equal(codDeliveryTaxIqd({ payableBeforeTaxIqd: 1_000_000, paymentMethodId: 'wallet', deliveryMethodId: 'standard' }), 0);
  assert.equal(codDeliveryTaxIqd({ payableBeforeTaxIqd: 1_000_000, paymentMethodId: 'card', deliveryMethodId: 'personal' }), 0);
});

test('wallet value reduces the COD tax base and tax never taxes itself', () => {
  assert.equal(codDeliveryTaxIqd({ payableBeforeTaxIqd: 499_999, paymentMethodId: 'cash', deliveryMethodId: 'standard' }), 0);
  assert.equal(codDeliveryTaxIqd({ payableBeforeTaxIqd: 500_000, paymentMethodId: 'cash', deliveryMethodId: 'standard' }), 6_000);
  assert.equal(calculateCodTaxIqd(506_000), 6_000, 'a tax amount is not recursively added to its own base');
});
