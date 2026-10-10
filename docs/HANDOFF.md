# Handoff — interrupted inventory and privacy work resumed (2026-10-10)

Read `CLAUDE.md` first. The default branch is `claude/new-session-2hq4ci`;
code pushes deploy through workflow 7 only. No feature branches, merges,
force-pushes, or alternate deployment path.

## Current implementation

The default-branch work now integrates the three commits formerly waiting on
`wip/inventory-investment`, followed by regression fixes. DECISIONS 215 records:

- Purchase names can be changed at any purchase status, with stale-name fences.
- Stock-purchase pricing previews and writes target direct sale. Private purchase
  inputs are kept separately from ordinary preorder inputs, persist through later
  rate repricing, and are superseded by explicit owner edits of the same fields.
  An explicit complete review in the ordinary pricing editor can subsequently
  activate all channels; that apply clears the direct-only adoption flag.
- Product completeness and data-file previews use that same direct-purchase
  basis only for selections offering direct sale. A fully priced stock product
  must not be held as missing cost/profit merely because its ordinary preorder
  inputs are empty; a separate preorder-only model must still satisfy its own
  requirements. Proposed owner edits supersede the purchase basis in previews.
- Stored/prepaid preorder prices and route fees stay unchanged. The established
  checkout rule that COD may use the direct-sale price remains in force.
- Unused investment funding returns to the investor earnings wallet once at
  shipment confirmation; concurrent confirmations, contract cancellation and
  incorrect investor/withdrawal claims are covered by local regressions.
- The earnings transaction-history surface is removed; recorded ledger rows remain.

Migration `0186_pricing_direct_purchase.sql` is additive and replayable. Expected
schema: 179 migrations, last 0186. The normal deployment applies it before code.
Old-schema reads tolerate its absence; a stock-price apply fails closed.

DECISIONS 216 records the reconstructed privacy work. The former local-only
33-case audit branch was unavailable; this pass independently proved and repaired
current public/staff/import/snapshot/accessory/cache/notification/browser-session
issues with synthetic data. It does not claim to have recovered the old numbered
list. Shared role fixtures now exercise non-null margins and acquisition costs;
private acquisition costs are no longer exempted as public accessory prices.
Both hardware-capable calculators use the platform margin even for merchants;
a near-zero merchant margin can no longer turn the hardware price difference
into the exact acquisition amount. Merchants retain margin control for their own
no-hardware calculations. Deterministic final prices can still support estimates
when the formula and other inputs are known; preventing that inference would
require a separate public selling-price policy.

The prior USD pricing-save and product-data-file changes remain integrated
(DECISIONS 212–214). `wip/*` branches are historical records, not work to land again.

## Verification and release

Implementation and independent adversarial review are complete. `npm run check`
and `npm run build` pass. The final core run passed 289 tests (all cost suites,
bundle budgets/private names, clay/theme/UI/refusal gates and financial/privacy
unions). After the last hardware-margin fix, worker/test typechecks, changed-file
ESLint and 21 focused calculator/UI tests also pass. Migration replay passed 179
files, 352 tables, no foreign-key violations, and no statements on the second pass.

The 53-file inventory compatibility batch finished 453 tests: 450 passed, one
intentional census-only skip, and two stale source pins. Both pins were repaired
and their suites rerun successfully (6+5 tests); 40 additional exact source readers
also passed. All 253 selected privacy compatibility files are covered (140 head
files and 113 independent tail files), with zero unresolved failures. The tail
finished 1,420 tests; its obsolete purchase expectation was corrected and the full
SKU suite passed 5/5. The head's obsolete import-message source pin was corrected
and its full suite passed 3/3. The corrections retain the underlying safety checks
and add direct-only, unchanged-preorder and idempotent-replay assertions.

These are targeted local gates, not a claim that the entire unit suite ran
locally. The combined tree is ready for workflow 7's mandatory full suite and
live rollout; deployment has not yet been confirmed. Do not claim the site is
updated from a local build or a queued workflow alone.

Workflow run `38088439275` for `5e0593f2` was cancelled before any live phase
after a synthetic regression proved that completeness could wrongly hide a
directly adopted stock product. All migration/deploy/probe steps were skipped.
The follow-up fix includes storefront visibility, draft-edit and query-budget
regressions; its replacement workflow must complete all normal release gates.
Its local verification passed 58 focused tests, 282 privacy/bundle/theme/UI
gates and 12 programme-refusal tests, plus the complete `npm run check`, build,
and a final test typecheck after the new regressions were stable.

Local checks required before a code push:

1. `npm run check` (this environment needs a larger Node heap).
2. `npm run build` and the unchanged bundle/theme/clay/UI/refusal gates.
3. Changed-file source readers and affected runtime tests, all `cost*` tests,
   role sweeps and adversarial inventory/pricing tests, with `REQUIRE_DIST=1`.
4. `node scripts/migrate-check.mjs --twice` for 0186.

The owner previously postponed the hours-long full local `npm run test:unit`;
workflow 7 runs the entire suite before any live migration or deployment. Do not
skip that CI gate. Targeted tests run with `scripts/test-no-network.mjs` so no
notification/payment provider is contacted.

The browser regression scripts were updated and pass syntax checks, but this
environment has no Chromium binary and the normal Playwright download failed.
Do not describe browser end-to-end QA as passed; runtime/UI behavior tests and
frontend builds are separate evidence.

After deployment verify workflow 7's schema, bundle identity and read-only cost
probes. The permitted direct live checks remain `/api/health` and
`scripts/live-cost-probes.mjs`; do not send other tool requests to production or
write live products, money, stock or settings during verification.

## Owner configuration still separate from this code task

- Approve FX rates and market adjustment in «التسعير والشحن», and configure
  each shipping route used. Missing rates still prevent computed USD prices.
- Set the AMS serial policy to «مطلوب» and assign missing product brands.
- Optional: add `SECURITY_CANARY_KEY` and disconnect Workers Builds integration.

## Unrelated backlog

Community phases 6–8; merchant workspace v2; Programme C·C1; remaining Sorani
strings and the Sorani clay screenshot pass. These are not the two interrupted
workflows in the supplied screenshots.
