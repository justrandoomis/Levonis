/**
 * WHERE THE GIFTS MEET WALLET FREE DELIVERY (docs/GIFTS_QUICK_BUY.md D8).
 *
 * A gift line is priced 0 and pays nothing, so it can neither satisfy a
 * rule's section nor its minimum: an order of gifts alone, paid from the
 * wallet, still pays its standard delivery. A PAID line from a covered
 * section beside the gift earns the waiver exactly as it would alone.
 *
 * Run: node --import tsx --test tests/giftWalletFreeDelivery.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NOZZLE_04_RED, apps, giftInCart, giftWorld, json, post, quoteBody } from './fixtures/giftWorld';

test('a gift alone never earns wallet free delivery, even from a covered section; a paid line beside it does', async () => {
  const raw = giftWorld();
  // Both the gift's product and a paid one sit in FDM filament, which the default rule covers from 0 IQD.
  raw.exec(`UPDATE products SET category_id = 'cat_materials', sub_category_id = 'cat_materials_fdm' WHERE id IN ('p_nozzle', 'p_plain');
            INSERT INTO product_catalogs (product_id, catalog_id, position) VALUES ('p_nozzle', 'cat_materials_fdm', 9101), ('p_plain', 'cat_materials_fdm', 9102);`);
  const a = apps(raw);
  await giftInCart(a, NOZZLE_04_RED);

  const giftOnly = (await json(await post(a.buyer, '/api/orders/quote', quoteBody({ paymentMethodId: 'wallet' })))).quote;
  assert.ok(giftOnly, 'the gift-only cart is quoted');
  assert.equal(giftOnly.wallet_free_delivery.applied, false, JSON.stringify(giftOnly.wallet_free_delivery));
  assert.ok(giftOnly.shipping.total_iqd > 0 && giftOnly.shipping.wallet_waiver_iqd === 0, `the standard delivery is still charged (${giftOnly.shipping.total_iqd})`);

  assert.equal((await post(a.buyer, '/api/cart/items', { productId: 'p_plain', qty: 1 })).status, 200);
  const withPaid = (await json(await post(a.buyer, '/api/orders/quote', quoteBody({ paymentMethodId: 'wallet' })))).quote;
  assert.equal(withPaid.wallet_free_delivery.applied, true, JSON.stringify(withPaid.wallet_free_delivery));
  assert.equal(withPaid.shipping.total_iqd, 0, 'the paid filament earns it, the gift beside it changes nothing');
  assert.equal(withPaid.shipping.waiver_source, 'wallet');
});
