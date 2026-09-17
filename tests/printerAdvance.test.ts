import { test } from 'node:test';
import assert from 'node:assert/strict';

import { printerAdvanceApplies, printerHomeDeliveryAdvanceIqd } from '../worker/lib/printerAdvance';
import { SETTING_DEFAULTS, printerNoteIqdFrom } from '../worker/lib/settings';

const HOME = { hasPrinterLine: true, isPickup: false } as const;

test('a printer sent to a home address owes the configured advance', () => {
  assert.equal(printerHomeDeliveryAdvanceIqd({ ...HOME, noteIqd: 50000 }), 50000);
  assert.equal(printerAdvanceApplies({ ...HOME, noteIqd: 50000 }), true);
});

test('the amount charged is the same number the storefront displays', () => {
  // The note the customer reads on the product page, in the cart and at
  // checkout comes from printerNoteIqdFrom(printerHomeDeliveryNoteIqd). If the
  // charge were sourced anywhere else the screen could promise one figure and
  // the wallet lose another.
  const displayed = printerNoteIqdFrom(SETTING_DEFAULTS.printerHomeDeliveryNoteIqd);
  assert.equal(displayed, 50000);
  assert.equal(printerHomeDeliveryAdvanceIqd({ ...HOME, noteIqd: displayed }), displayed);
});

test('store pickup owes nothing — the rule is about delivering to a home', () => {
  assert.equal(printerHomeDeliveryAdvanceIqd({ hasPrinterLine: true, isPickup: true, noteIqd: 50000 }), 0);
  assert.equal(printerAdvanceApplies({ hasPrinterLine: true, isPickup: true, noteIqd: 50000 }), false);
});

test('a cart with no printer owes nothing, however it is delivered', () => {
  assert.equal(printerHomeDeliveryAdvanceIqd({ hasPrinterLine: false, isPickup: false, noteIqd: 50000 }), 0);
  assert.equal(printerHomeDeliveryAdvanceIqd({ hasPrinterLine: false, isPickup: true, noteIqd: 50000 }), 0);
});

test('clearing the setting switches the requirement OFF rather than inventing a figure', () => {
  // The owner can empty the note. The charge must disappear with it — the
  // alternative is a wallet debit for an amount no screen ever showed.
  for (const cleared of [null, 0, -1, 1.5]) {
    assert.equal(
      printerHomeDeliveryAdvanceIqd({ ...HOME, noteIqd: cleared as number | null }),
      0,
      `noteIqd=${cleared} should not charge`
    );
  }
});

test('a changed setting changes the charge, with no second source of truth', () => {
  assert.equal(printerHomeDeliveryAdvanceIqd({ ...HOME, noteIqd: 75000 }), 75000);
  assert.equal(printerHomeDeliveryAdvanceIqd({ ...HOME, noteIqd: 25000 }), 25000);
});

test('the advance is per order, not per printer unit', () => {
  // Documented intent: the owner's wording is singular, and a two-printer cart
  // must not silently ask for double. This test is the record of that reading
  // — if it is ever meant to be per unit, this is the line that changes.
  const oneCart = printerHomeDeliveryAdvanceIqd({ ...HOME, noteIqd: 50000 });
  assert.equal(oneCart, 50000);
});
