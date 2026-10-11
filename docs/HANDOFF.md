# Handoff — inventory, privacy and connected financial systems (2026-10-11)

Read `CLAUDE.md` first. The default branch is `claude/new-session-2hq4ci`;
code pushes deploy through workflow 7 only. No feature branches, merges,
force-pushes, or alternate deployment path.

## Published release — 2026-10-11

Code `1e4084620e0e638b73a2fa9988d3e2baf1a4fcbe`, tree
`5185494f71a0fe94f0614d3d9c806cd14124ad1d`, is live through workflow 7 run
[`38106453316`](https://github.com/justrandoomis/Levonis/actions/runs/38106453316),
job `114372910022`. The run completed successfully; all steps 1–35 and cleanup
succeeded. The exact commit and the complete downloaded log were independently
checked after completion, rather than inferred from the partial running-log view.

- Complete check gate passed, including the 68/68 boundary tests.
- Root unit suite: 9,807 tests, 9,806 passed, zero failed, one declared skip.
  Workspace: 365/365 passed. Studio: 319 tests, 313 passed, zero failed,
  six declared skips. Combined unit result: 10,484 passed, seven declared skips.
- Frontend build retained all seven required live markers. Migration replay
  proved 179 files, 352 tables, zero foreign-key violations and zero orphan
  catalogues; its second full pass applied zero files.
- A Time Travel restore point preceded the live migration. Live history moved
  from 178 to 179 files, applying `0186_pricing_direct_purchase.sql` before code.
  Existing configuration preservation and deployment gates succeeded.
- The live `ServicesGrid-CvCxwc_y.js` was byte-identical to the built asset.
  Schema was current at 179/179, latest `0186_pricing_direct_purchase.sql`,
  with zero migrations behind. All 14 read-only cost/privacy probes passed;
  normal live endpoint, origin, admin/cart and configuration checks passed.
- A subsequent permitted direct `/api/health` assertion independently confirmed
  status `ok`, schema `current`, 179/179, zero behind and the exact 0186 filename.
  A separate post-deploy `scripts/live-cost-probes.mjs` run also passed all
  14 probes with zero failures, including public-product slug discovery.

Verification used synthetic financial fixtures and read-only production checks.
It did not perform a row-wide historical reconciliation or browser E2E. Missing
historical evidence still requires review under the implemented rules below.

## Earlier complete CI attempt

The preceding candidate was committed on the default branch as
`70b3b623c1bbc1882b51f0aeeb9761ca561d3fbf` (tree
`dffc4209ec9a84682df086601b40c6b86f62b077`). Workflow 7 run
[`38101412872`](https://github.com/justrandoomis/Levonis/actions/runs/38101412872)
completed its full check/unit gate with one failure: the conservative D1 SQL
source gate required the dynamically assembled placement UNION to have an
explicit structural bound. Root results were 9,807 tests: 9,805 passed, one
failed and one declared skip. Workspace tests passed 365/365; Studio passed
313 with six declared skips. All live phases (steps 8–35) were skipped; this
run did not migrate or deploy anything.

The capture query now declares exactly three placement branches, preserving
the same data and atomic operation. The existing D1 gate is unchanged; a runtime
assertion also checks the fully assembled SQL against the measured limit.
The final D1/deletion suites pass 9/9, including all placements, cycle-safe
ancestor depths, rollback, membership amounts and initial-schema compatibility.
The exact corrected source passes the complete `npm run check` and frontend
build with all seven required live markers.
The corrected release above subsequently passed the complete unchanged
workflow 7 and its live verification.

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

## Connected financial systems review

The owner expanded the task to every connected price/cost field. DECISIONS 217
and `FINANCIAL-INTEGRATION-AUDIT.md` map product inputs, FX/freight, procurement,
FIFO, orders/refunds, finance, staff/investors, invoices and trade-in. The review
also verifies the separate wallet, membership, print-quote and escrow boundaries.

Confirmed fixes include all-channel refusal, IQD conversion rate/version fencing,
FIFO concurrency, exact receipt remainders, receipt-versus-edit freezing, a
withdrawal-versus-wage fence, shared frozen membership interpretation, correct
refund/invoice/trade-in amounts, exact supplier totals and refreshed pricing lists.
The two old-looking product fields were not removed: both retain active uses.

Historical source rows, issued invoices and posted journals are not bulk rewritten.
Corrected membership readings flow through ordinary append-only wage/investor
reconciliation; unaffected persisted fingerprints stay unchanged. Refund decisions
and wallet credits commit together; downstream stock/finance recovery retains its
existing contract. Unknown prior refunds and positive refunds below one wallet
cent require explicit review rather than a claimed credit that did not happen.
Affected native sale journals also receive a single balanced correction when
their original account vector proves the former double-discount calculation.
The bounded recovery includes orders without employees or investors; unexplained
old journals require review. Posted lines and actual collections remain intact.

Workflow `38091210977` for `931ab683` was cancelled during check/unit tests while
this broader review was completed. All live phases (steps 8–35) were skipped.
No migration, deployment or other live write occurred in that cancelled run.

Local release verification for this review passed: the complete `npm run check`,
the frontend build (7/7 markers), 142 integration and affected finance/return
compatibility tests (including all 50 new cross-system regressions), and 294
privacy/bundle/theme/UI/refusal gates. The escaped-JSON native-journal regression
also passed after independent review. Separate runs passed 160 wallet/membership/
print/escrow boundary tests and 44 invoice-related tests. Migration replay passed
179 files, 352 tables, zero foreign-key violations and zero new files on the
second pass. These local results were followed by the successful complete
workflow and live verification recorded in the published-release entry above.

CI run `38094004065` for `3c051143` was cancelled during the unit suite after
an obsolete exact JSX assertion was repaired. Its downloadable log, unlike the
partial running-log view, revealed six failures through test 9651. The fixes are:
the `EngineSaveList` refresh-prop assertion; the invoice snapshot source check;
the direct-purchase readiness-code census; two serial/refund fixtures that used
an unpayable 1 IQD refund; and direct-purchase configuration in the product
deletion registry and atomic owner-guarded delete. All underlying assertions
remain, and the refund fixtures now verify the actual wallet credit as well.
The repricing suites pass 34/34; the invoice/census suites pass 15/15.
Run `38098880098` for the first assertion correction `ce987181` was also cancelled
when the remaining failures became available. Both runs skipped every live phase
(steps 8–35): no migration, deployment or live write occurred. Neither is a full
suite pass. The corrected release above subsequently passed the complete
unchanged workflow 7.

The remaining CI repairs pass 30 serial/refund/integration tests and 59 product
deletion/pricing compatibility tests. The previously unfinished root tail passes
173 tests; workspace tests pass 365/365, and Studio passes 313 with six declared
skips. The frontend rebuild retains all seven live markers. Independent deletion
review also found that clearing a catalogue link could lose the frozen membership
identity. Deletion now appends that exact identity to the benefit snapshot in the
same transaction before unlinking; original benefit fields and money stay intact.
The identity tests pass 11/11, the subsequent deletion compatibility run 29/29,
and the deletion writer/identity tests 6/6. The latest privacy, bundle, theme and
refusal gate passes 269/269 with `REQUIRE_DIST=1`. Existing financial compatibility
passes 53/53; bounded recovery remains 636 prepared statements and ten batches
containing 224 statements for its two-order fixture.

Deletion review also found product/catalogue-scoped wages could fall to zero
when a later reconciliation no longer found the product. The deletion batch now
appends exact scope facts to `audit_log` (which ordinary retention does not
prune), before removing catalogue placements. Effective rule revisions remain
authoritative, while existing financial snapshots and payments stay immutable.
Old deleted lines without this evidence use `WAGE_SCOPE_REVIEW_REQUIRED` before
an ambiguous scoped entitlement can be changed; no product identity or catalogue
history is inferred from names or a newly reused product ID.
Explicit universal, inactive or manually overridden rules retain their existing
policy. A safe proposed rule can use recorded prior earnings for its comparison
display only after the new targets pass the strict planner. Preview calculation
version 4 invalidates older stored jobs, including version 3, so a pre-deploy
preview cannot bypass the new evidence check when resumed or applied.

The final version-4 wage gate passes 52/52 with zero skips: five new deletion,
legacy-evidence and manual-override regressions; the complete wage timeline
(including superseded-version-3 preview rejection); earnings, bounded recovery
and the trilingual refusal census. SQL remains at 26,675 bytes / nesting 17,
and the two-order recovery fixture retains its 636-prepared-statement budget.
The exact stable version-4 source also passes the complete `npm run check`
(including all three embedded runners) and `npm run build` with all seven
required live markers. The unchanged full workflow 7 remains the release gate.

## Earlier implementation verification

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
locally. The combined tree subsequently passed workflow 7's mandatory full suite
and live rollout, as recorded above. A local build or queued workflow alone is
not evidence of publication.

Workflow run `38088439275` for `5e0593f2` was cancelled before any live phase
after a synthetic regression proved that completeness could wrongly hide a
directly adopted stock product. All migration/deploy/probe steps were skipped.
The follow-up fix includes storefront visibility, draft-edit and query-budget
regressions; the final release above completed all normal release gates.
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
