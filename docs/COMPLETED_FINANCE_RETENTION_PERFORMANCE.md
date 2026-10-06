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

## Follow-up: cancellation advances and product navigation

The shared stage-transition route returned stock on cancellation but did not call the wallet/points refund operation. Legacy status cancellation and customer cancellation used a different path. Stage cancellation now includes the common refund, stock return and points release in the same transaction. Historical recovery processes only cancelled, unfulfilled platform orders whose approved ledger proves the remaining debit, and runs before retention. Deterministic transaction identifiers prevent duplicate credits.

The common operation fences the current money snapshot against simultaneous price adjustments. Partial price refunds retain exact dinars as well as wallet cents; an already-refunded order cannot be reopened with stale prepaid fields through either admin route. A new order is required to collect a fresh advance.

Navigation diagnosis found a route-chunk → mount → detail-request waterfall, followed by a duplicate quote for the exact opening selection. Explicit product/catalogue taps now start data and route downloads together. The fresh detail quote is reused only while its exact selection matches; changed choices, focus refreshes and refusals still request current server prices. Catalogue Back navigation restores its cached viewport before paint. Optional printer-maintenance and taxonomy reads start alongside the main product-detail query wave.

Additional pre-deployment PageSpeed results:

| Page/device | Performance | Accessibility | Best practices | SEO |
|---|---:|---:|---:|---:|
| Home/desktop | 75 | 100 | 100 | 100 |
| Products/mobile | 83 | 98 | 100 | 100 |

Products mobile: FCP 2.6 s, LCP 4.1 s, TBT 10 ms, Speed Index 3.0 s. Report: https://pagespeed.web.dev/analysis/https-levonis-iq-com-products/t8g3dhu5lz?form_factor=mobile

Workspace curl latency is not used as a site-speed benchmark: both a cached HTML document and cached home API response showed large environment/network delays. The independent PageSpeed lab is the baseline.

## Update discovery

An ordinary frontend build previously copied the same `sw.js` bytes, so an already-open tab could not discover that its route-chunk hashes had been superseded. The generated service worker now includes a deterministic frontend build identity, independently of the stable asset-cache generation. Returning to a visible tab checks for updates at most once per minute; a waiting update remains user-controlled so a checkout is never reloaded automatically. Existing open tabs acquire the new focus checker after their next ordinary reload.

Service-worker/update/security regressions: 48 passed. The production build includes the generated identity and passes all live-marker checks.
