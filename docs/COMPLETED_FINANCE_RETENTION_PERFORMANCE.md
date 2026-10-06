# Delivered finance, cancelled-order retention and mobile opening

## Behaviour

Finance lists, counts, search, pagination, product/category totals and CSV exports include only `status='delivered'`, using the Baghdad delivery date. Refund facts still reduce delivered-sale revenue and cost. Operational order screens remain available for fulfilment.

Cancelled, never-fulfilled orders become eligible for permanent cleanup seven full days after cancellation, regardless of who cancelled them. Cleanup runs in the existing durable-job sweep, five eligible orders per invocation. Reopening/re-cancellation restarts the clock. The transaction explicitly deletes owned records and removes order links from independent history, including with foreign keys disabled. Migration 0171 permits guarded removal of cancelled checkout department snapshots.

Deletion deliberately refuses linked accounting/wage/payment/fulfilment evidence, unreleased stock and unsettled refunds. These records are not claimed to be fully purged; deleting them requires a separate archival/accounting design. An old protected record does not block later eligible orders.

## Loading changes

- Public main-host identity is included in opening HTML; home/catalogue/product API requests receive early preload hints without embedding personal prices.
- Optional home sections and speculative downloads wait for visible images, fonts and paint. Near-viewport sections still load immediately; slow connections and Save-Data skip speculative loads.
- Language/theme panel and overlay dependencies load on intent/use rather than opening every page.
- The PSI command reports performance, accessibility, best practices and SEO separately, with an explicit all-above-95 result.

## Validation, 2026-10-06

- Existing full `npm run check` log passed; focused regression run: 62 tests passed, zero failures.
- Frontend regression run: 71 passed; production build and live-marker check passed.
- Live **pre-deployment** PageSpeed mobile homepage: Performance **82**, Accessibility **100**, Best Practices **100**, SEO **100**. FCP 2.7 s, LCP 3.9 s, TBT 0 ms, CLS 0.002, Speed Index 4.2 s.
- Report: https://pagespeed.web.dev/analysis/https-levonis-iq-com/uk68m278ly?form_factor=mobile
- Largest delay: discovery of the opening promo image (2,140 ms); blocking CSS 44.6 KiB / 1,310 ms. These are baseline measurements, not results of the changes above. A score above 95 has **not** yet been verified.
