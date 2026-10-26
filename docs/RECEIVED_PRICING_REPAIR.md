The owner reported received inventory still held from sale and saved procurement
prices missing from the products list on 2026-10-26.

V2 now leaves a direct-only selection with **zero physical stock** and missing
pricing inputs explicitly unpriced/off, allowing priced selections to publish.
Unknown stock, positive stock (including reserved stock), pre-orders and invalid
pricing configuration still require their own complete pricing. A procurement
preview models only the same zero initialization its guarded stock batch writes;
only receipt adds quantity.

Commercial completeness uses the received lot's known landed cost and confirmed
pricing measures. Received V2-priced goods sold only direct do not need a
supplier freight estimate. Empty tracked direct-only selections do not hold
available V2 selections. Images, category, name and genuine pricing gaps remain
required. Completeness version 2 refreshes existing verdicts, and price, shelf,
stock and colour-measure changes invalidate them.

Migration 0214 snapshots existing cost-mode, active, received products whose
latest data-only pricing save came from the price editor and which have no
published V2 result. This is a one-time correction of those saved prices, not a
general draft-publishing policy. Recovery refuses changed input/write sequences,
incomplete calculations, pending rates, unconfigured import stock and any priced
channel without a known received shelf cost. It uses the ordinary atomic V2
writer and records its audit and recovery completion together. It never edits
purchase costs, lots or quantities. Future drafts are not enqueued.

The owner products page drains this bounded snapshot through an owner-only POST;
the scheduled sweep also drains it within the existing invocation ceiling. All
ordinary preview hashes, fresh-session gates and unreviewed repricing guards
remain in place. A changed or genuinely incomplete snapshot is skipped.

Regression coverage: `tests/receivedPricingCompleteness.test.ts` exercises real
receipts, pricing writes, catalog flags, cart rejection, migration recovery,
idempotency, statement budgets, later edits, and unknown/positive/pre-order stock.
