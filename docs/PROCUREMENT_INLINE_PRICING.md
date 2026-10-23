# Inline inventory pricing (owner request, 2026-10-24)

The final-cost and minimum-profit cells in a purchase card are editable USD
fields, including when no price exists. They accept six decimal places and
Arabic/Persian digits. Existing pricing is prefilled; missing cost inputs can
be prepared from the current purchase before it is saved.

`POST /api/admin/pricing/procurement/line-pricing` is owner-only and read-only.
It prepares an ordinary V2 pricing payload and review. Editing final cost
adjusts its supplier component after central freight and additional charges,
so freight is counted once. An option, colour or variant edit targets that
selection. Existing fixed-price and shelf-pricing rules remain in effect.

The card saves through `PUT /api/admin/products-v2/:id/pricing`, retaining its
sequence/hash checks, change confirmation, audit and permissions. No new
writer or database migration is introduced. Purchase costs, receipts and
existing lots retain their accounting values. Unsaved edits remain in the
private purchase draft; Continue waits for those edits to be saved or discarded.

`tests/procurementInlinePricing.test.ts` covers an unpriced purchase, precise
cost/profit save and reload, colour isolation, refusal of invalid selections
and costs, owner access, and editable empty fields.
