# Handoff — inventory, privacy and connected financial systems (2026-10-11)

Read `CLAUDE.md` first. The default branch is `claude/new-session-2hq4ci`;
code pushes deploy through workflow 7 only. No feature branches, merges,
force-pushes, or alternate deployment path.

## Bambu Lab one-time catalogue import (DECISIONS 239–241, in progress)

> **Resumed 2026-10-15 ≈20:40 UTC.** The resume plan is `docs/bambu-import/HANDOFF-PLAN.md`; the spec and the
> P0 data are in `docs/bambu-import/`. Landed since: the package follow-ups (live) and step 5 (search aliases and the
> import stock gate). Steps 6, 7 and 8 are built in local worktrees and land one at a time through `ci/<lane>` and
> workflow 7. The data steps (re-crawl, sealed snapshot, curated files) wait on this environment's network policy:
> `us.store.bambulab.com`, `store.bblcdn.com`, `wiki.bambulab.com`, the GitHub artifact host
> `productionresultssa*.blob.core.windows.net` and `levonis-iq.com` are refused from the sandbox.

The owner's brief of 2026-10-15: import every product of us.store.bambulab.com (1,115 in its sitemap) as a
native, catalog-only Levonis product, one product at a time with a live check before the next, no price,
cost or stock from the source, no sync afterwards. Row 239 allows reading and writing the production D1/R2
for this import only. Catalog-only visibility and «طلب السعر» (row 240, 0193) are live.

- **Live:** migrations **0194** (the product knowledge model: source refs and stock decision, option/image
  source map, typed specs with provenance, documents, external ids, relations, swatches; four new group
  columns) and **0195** (the run ledger: one open run per source, one item in flight, the legal state graph,
  the lease fence, and generated guard triggers armed only by `ops_guards('catalog-import-batch')`), plus the
  package `packages/catalog/src/bambuImport` (extraction and mapping; 1,113 of the 1,115 crawled pages parse,
  2 on hold). Nothing reads or writes the new tables yet; the live site is unchanged.
- **Workflow 60** (`.github/workflows/bambu-import.yml`, dispatch-only, default branch only, deploys nothing):
  `snapshot` (a sealed read of the live catalogue: sections, brands, products of every status with identity
  fields only, memberships, printer fits, option values, colours, Bambu image provenance; row counts only in
  the public log) and `revoke` (the run-token kill switch). Every artifact is sealed to a one-time X25519 key
  (`scripts/bambu-import/seal.mjs --keygen <dir>` outside any checkout; open with `unseal.mjs`); only
  `*.sealed` files are uploaded. `scripts/bambu-import/cf.mjs` is the only code that holds Cloudflare
  credentials. The other modes refuse "not yet" until build step 8.
- **Stock setup of an imported product (step 5, live with it):** an imported product's V2 price cannot be published
  (409 `IMPORT_STOCK_NOT_CONFIGURED`) until an admin chooses, in the product form's section ٣ card, «تتبّع الكمية»
  (every row a sale can reach carries a number) or «بلا تتبّع (حسب الطلب)» — sold by pre-order without a limit, so it
  needs a pre-order on the product (`IMPORT_STOCK_UNTRACKED_NEEDS_PREORDER`): a direct sale with no recorded stock
  is closed anyway. «نشر» of a visible, unpriced product with no price typed is a content save (it stays visible).
- **Next (spec §K.2):** step 6 the token-protected ops endpoint
  and writer; step 7 the product page's knowledge tabs, swatches and gallery; step 8 the runner and the other
  workflow 60 modes; then the reviewed data files, dry runs, the canary `filament-buffer`, the eight audit
  classes and the bulk run. Every code step deploys through workflow 7 like any other push.
- **Holds and owner questions with safe defaults:** `cyberbrick-omnidirectional-forklift` (an option name
  read as an order type: "Omni**direct**ional"), `ams-2-pro` (an option value worded as a promotion, shown
  under a reviewed neutral label), «A1 Series» read per product, the Sorani names of the four seeded
  «مواد الصيانة» shelves (empty since 0148).

## Releases of 2026-10-14/15 (all live, workflow 7 green)

- `c65cdf58` — **Bambu import foundation** (DECISIONS 241), deployed 2026-10-15 19:47 UTC, migrations
  0194 and 0195 (restore point `0000162d-0000006e-00005105-46aed4dbc52a01040b2de5a0d8bc24e1`; 21 probes, 0
  failed). Additive and inert: thirteen new tables and four defaulted group columns, the run ledger's
  one-item-at-a-time index and state-graph triggers, and guard triggers that refuse any write to money,
  stock, order, wallet and ledger tables (the price-request tables included) inside an import batch only.
  Two tests changed with it: a catalog-only fixture now finds the 0194 columns already present, and the
  deploy-ahead price-protection test drops 0195's guard triggers with `ops_guards`, since no real database
  has one without the other. Shard timings were re-measured for the new test files.
- `711d1b9e` — **Catalog-only + price requests** (DECISIONS 239/240), deployed 2026-10-15 18:25 UTC,
  migration 0193 (restore point `0000162c-000003c8-00005105-45cba74b6e57de3cd17f0626180fab0e`). Every
  active product without a V2 price — the old ones hidden since the clean start and every new one —
  is shown with «السعر غير متوفر حالياً», `price_status: 'unpriced'`, price `null` (never 0) and no
  stock word; every purchase door refuses it on the server. Signed-in customers can «طلب السعر» (one
  person counts once per product and selection); the needs-pricing queue sorts by requesters, the
  owner gets an hourly Telegram digest at thresholds, and consenting requesters are notified when the
  price is published. Import dependencies D-1…D-7 (Bambu spec §K.1) are in: probe rules `priceKeys` /
  `requirePriceKeys` / `expectValues`, `cleanstart.json` expects a VISIBLE unpriced product.
  Workflow 7 of this commit deployed correctly but its cost probes ran while some requests were
  still answered by the previous Worker (health said "expected 0192, ahead"), so they read the old
  404; a read-only check right after showed the product live as designed (200, unpriced, null price,
  public v1 200). Fixed in the next push: the freshness step now waits until /api/health reports this
  checkout's EXPECTED_MIGRATION and count three times in a row before any check runs.
- `abd1d411` — **Services S-P2, trade-in v2** (DECISIONS 238), deployed 2026-10-15 15:20 UTC, migration
  0192 (restore point `0000162c-0000005a-00005105-86d5325af4632a5f14b13b3fe9380172`; 21 probes, 0
  failed). Store-safe offer from today's V2 published price (owner parameters, owner-only valuation);
  device first: intake with serial and hours, the ceiling recomputed at intake, credit only after
  intake; tiered money authority (financial admin up to the ceiling, owner above with a reason);
  completion when the new order is delivered books the device into stock (lot at cost = credit used,
  a hidden «used» draft); a cancel or return never loses the credit (same coupon row, 30 days);
  expiry/reminder sweep in the quarter-hour tick; finance counts the credit as a payment; the desk's
  «الخدمات» group (queue v2, intake, value, owner panels) and five customer phone screens. Safe
  defaults the owner has not ruled on (S-P2 spec §16): an expired credit returns the device; one
  5,000 collection fee outside Baghdad, deducted from the credit; the used draft is hidden with 1
  month of warranty; no grace on an expired offer. The offer reads the approved USD/IQD rate through
  the no-price helper `worker/lib/pricingEngine/approvedRate.ts` (pinned in
  `tests/pricingCostToPriceUsd.test.ts`). Old-database behaviour: the customer routes degrade, only
  the owner's component references answer 503 `TRADE_IN_V2_NOT_INSTALLED`.
- `8a2c3345` — **Services S-P1** (DECISIONS 237), deployed 2026-10-15 03:34 UTC, migration 0191
  (restore point `00001627-00000700-00005105-2aa1ead2d562b0d83920e8e899724b12`). Triggers, not
  unique indexes, so old duplicate rows never break the migration: a cancel by any door gives the
  coupon use back and a reopen takes it back within the limits (or 409
  `ORDER_REOPEN_COUPON_SPENT`); one trade-in credit coupon for life, never re-minted (the same
  code returns with its end moved by the time an order held it); an inactive coupon is refused;
  one open warranty case per device (`CLAIM_ALREADY_OPEN`) and one requested protection claim
  per order line (`CLAIM_PENDING`); each new warranty claim records the cover it was filed under
  (four frozen `filed_cover_*` columns). Uses spent by orders cancelled before 0191 stay spent.
  Open for S-P2: cancelling the order of an already completed trade-in loses its credit.
- `e7637338` — the three money race tests (`communityEscrowReview` F1/F2, `storeOrderMoneyReview`
  F7) force their interleaving with `RaceD1` instead of timing it. Cause: on Node < 22.22.3 tsx
  uses the off-thread loader, so `stubApp`'s per-request `import('./autoPublish')` costs an event
  turn and the other side always won. Other `Promise.all` race tests share the exposure; a local
  Node >= 22.22.3 (CI runs 22.23.x) or a static import in `stubApp` removes it for all of them.
- `a6203c29` — **Pricing V2 clean start** (DECISIONS 233–236; design `docs/PRICING-V2.md`),
  deployed 22:37 UTC. Migrations 0189 (V2 core) and 0190 (archive of the old values, D1 purchase
  reviews, line estimate). At this deploy every store product was hidden; each returns on its own
  when its V2 dollar price is published from the owner's «يحتاج تسعيرًا» queue. The old prices
  survive only in the invisible audit archive. Restore point taken before 0190: bookmark
  `00001627-000000dc-00005104-1845ed9527ef215d927a64da448e38e0`. Live checks after the deploy:
  `/api/health` 0190 current (183/183), `/api/products` lists nothing, the hidden product
  answers 404, 21 cost probes run / 0 failed / 4 skipped until a product is listed. The empty
  store is expected: the listing probe relaxes only when the slug read proves an empty catalogue.
  Bundles and mystery offers stay hidden until the owner answers Q7 (how to price compositions);
  Q8/Q9 run on their defaults (spec A.14).
- `059ea69d` — **Release A**: Pricing V2-0 (offer in quote/pills/public API, «from» prices,
  final numbers only in customer JSON — DECISIONS 225; purchase rate from the approved central
  rate with a 6% guard and Sorani finance screens — 224), the image pipeline (right-sized R2
  copies + srcset everywhere, ~67% fewer image bytes on phones — 226), Sorani checkout, stock
  counts, dates. Two test fixes: the store preload regex accepts imageSrcSet; the leak scanner
  treats 64-hex audit digests as random ids.
- `90fe7979` — **Services S-P0a/S-P0b** (DECISIONS 227/228): one money-authority rule (assistant
  never moves money; financial admin up to the server's figure / 250,000; owner above with a
  recorded reason; no self-approval), one `paidNetPerUnit`, mutual fences (return / warranty /
  trade-in / protection on one unit), coupon line allocation with every reader cut over, price
  protection rung/channel/PRIME fixes + review queue, warranty desk sheets, trade-in credit
  integrity (7-day credit, approved figure only), public promo codes owner-only, Sorani.
- `a7895150` — **Clay polish** (DECISIONS 229–232): dark depth and the light wash, one focus ink,
  clay phone cart, calm order cards, real not-found page, honest points page, Sorani profile,
  admin/merchant/auth leftovers; clay ratchet lowered to 0/10/29/0/19/5.

Owner decisions recorded: rows 221 (Pricing V2 A1/B1/C1/D1), 222 (clean start: every product
hidden at the deploy of Pricing V2 until its new pricing is published; staff see USD; route
below cost sells at direct), 223 (Services V2 decisions 1–8; perks per printer, admin-set amount).

Open for the owner after Pricing V2: Q7 (bundles/mystery pricing); whether a price drop caused
only by a membership rule is compensated on new orders (decision 6 compares base USD, so today
it is not); PRIME has no member price in V2 (`BENEFIT_TIER_NOT_ENTITLED`).
Next: catalog-only (0193, branch feat/catalog-only) and the Bambu Lab import (DECISIONS 239; spec in the session scratchpad `bambu/import-spec.md`); then Services S-P3 … S-P10 (plan in the session scratchpad `services-v2/plan.md`).

Working method (owner asked why work took days, 2026-10-14): local test/check runs on the
4-CPU container took 60–90 min and dominated; agents now run only the tests near their change
and the full 964-file verification runs on GitHub's 16 runners (side branch `ci/*` or workflow 7).
Exploit-describing tests never go to a public side branch before their fix deploys.

## Release of 2026-10-13 — review fixes, sixteen CI shards, the cost-leak audit

`ae3d8b2e` on the default branch carries, in order:

- `72c55c37` — 18 confirmed findings from the review of the 25 commits of
  Oct 10–11 (DECISIONS 219): workflow 7 freshness (`fresh` job), the
  least-privilege @claude action, tracked-piece provenance, refund evidence in
  the decision batch, protection waits on an open return (PF-1), migration
  0188 (direct-sale-only engine products free their pre-order, option, colour
  and route prices).
- `fc8a219f`, `279d0f8a` — root tests in sixteen shards balanced by measured
  time (`scripts/test-timings.json`, refresh with
  `scripts/update-test-timings.mjs`); the @claude action verifies with the
  same parts. A full gate takes about 7 minutes.
- `35ae630c`, `8f872e97`, `f7f44ca2`, `ae3d8b2e` — the local cost-leak audit
  (DECISIONS 220): 33 proven leaks closed, the verifier's findings closed,
  `store_contribution_iqd` (batch cost less the investor's share) owner-only.
  `tests/leakAudit_*.test.ts` and `tests/leakVerify_*.test.ts` hold them.
  Eleven `# TODO OWNER RULING NEEDED` tests stay open by design: route price
  spreads, the investor's own principal, the exact dollar reading, and print
  prices as a public function of private inputs. Each needs a price decision
  from the owner, not code.

Behaviour that changed for staff and customers: the public dollar figure is
IQWealth's market rate (no adjustment, no typed rate); `printServicePricing`
is owner-only; merchants get the platform quote on public calculators; a
non-owner cannot raise a lot count (`LOT_COUNT_UP_OWNER_ONLY`); receiving
awaits the owner where a cost is needed (`RECEIVE_AWAITS_OWNER`).

Work in flight on 2026-10-13 (local worktrees, not pushed):

- Clay polish (`feat/clay-polish`): critique → plan → three build batches.
- Images (`feat/image-pipeline`): right-sized, compressed variants with
  `srcset`; card images measured at 1254×1254 and 100–170 KB.
- Pricing V2 and Services V2 (trade-in, offers/gifts/roulette, warranty,
  price protection): survey and design first; building starts only after
  the owner answers the money decisions.

## Published follow-up — pricing visibility and financial edge cases (2026-10-11)

The owner reported that the product editor says “preview only” and that dollar/
shipping edits leave the store price unchanged. The screenshots show an explicit
missing Direct Sale Extra on a manual product. The existing all-channel gate is
correct: one computed preorder row does not make the whole product ready. Zero
is a valid **explicit owner choice**, not a missing-field default. The product's
option/colour/SKU rules retain precedence over base values.

This follow-up makes the product's actual manual/automatic state, missing model/
channel inputs, save and reviewed price adoption visible in the final preview.
It corrects the global pricing workspace's obsolete “later update” wording and
refreshes sibling lists after bulk price adoption. Live customer quotes refresh
on saved product revisions without losing their selection. A connected synthetic
regression reproduces missing-extra → data-only/manual → explicit zero → reviewed
adoption → later approved FX/freight repricing; freight is charged once.

Independent financial review reproduced and repaired these additional paths:

- Large stale catalogues could spend the whole repricing read budget before any
  write, on every tick. An oversized backlog now advances a persistent circular
  window within the existing budget; each product's price/cost write stays atomic.
  Deficit priority remains global when the catalogue fits and within the window
  otherwise. A 951-product regression checks conflicts and subsequent progress.
- Partial location transfers of procurement-funded lots lost exact principal
  evidence on the new lot. The transfer transaction now copies the immutable
  per-unit amount, preserving remainder allocation through nested transfers,
  sales and later cost corrections. Old funded lots missing principal evidence
  now display an unknown balance with a review notice, not an understated total.
  No historic receipt or paid ledger is rewritten.
- Price-protection decisions could claim a sub-cent credit without a wallet entry,
  or become stranded after a failed wallet write. Decision and actual wallet credit
  now commit together with the cumulative-credit fence. Unpayable values and old
  ambiguous approved claims require review. Reciprocal transaction fences prevent
  a return and price protection paying twice for the same line, following the
  existing published policy; ambiguous partial-unit overlap requires review.
  Protection also caps claims to the frozen amount actually paid: membership,
  coupon/points and accepted price adjustments are counted once, using the
  existing return discount allocation and accepted invoice ceiling. Warranty/
  transport fees are excluded. Pending legacy claims are rechecked; historical
  paid rows are immutable. The final protection gate passed 51/51, including
  24 new atomicity/race and actual-checkout regressions, with independent review.

No migration or change to owner rates, profit rules, recorded payments, coupon
accounting policy, or live product data is part of this follow-up.

Local verification of the final source passed the full `npm run check` (including
68 boundary cases), the frontend build with all seven live markers, and migration
replay twice: 179 files, 352 tables, no foreign-key violations or orphan catalogues,
zero files applied on the second pass. The 86-file affected run had 918 cases:
917 passed and one obsolete source-shape assertion failed after the atomic wallet
refactor. That assertion now checks the same dinar/rate invariant inside the
guarded settlement transaction; its entire 16-case file passed on rerun. The
separate final protection gate passed 51/51 and the pricing UI gate passed 40/40.
The new backlog and exact-capital regressions also passed independent review.
No unresolved local failure remains.

Code `00d46047d737f272e520d1f8ce457ba060de912d`, tree
`04b77f3666015ccc4bab48a54501d71810361873`, is live through workflow 7
[run 38125838113](https://github.com/justrandoomis/Levonis/actions/runs/38125838113),
job `114429901074`. The run completed successfully at `2026-10-11T10:19:48Z`
(13:19:48 Baghdad); all 38 reported steps succeeded. The exact head, job result
and complete downloaded log were independently checked after completion.

- The complete check passed, including 68 boundary cases. Units passed **10,516
  tests, zero failures, seven declared skips**: root 9,838 passed/one skipped,
  workspaces 365 passed, Studio 313 passed/six skipped. The earlier owner waiver
  of the hours-long duplicate local unit suite did not change this full CI gate.
- The frontend build retained all seven required live markers. Migration replay
  proved 179 files, 352 tables, zero foreign-key violations and zero orphan
  catalogues. Its second full pass applied zero files; repeating 0186 left the
  affected tables unchanged.
- Time Travel bookmark `000015c6-00000176-00005101-d7a9bd1f712405be962018765b13e015`
  preceded the live migration check. Live history was already current at 179
  files, so no new migration applied. Worker version is
  `f94df5a3-756d-4105-84f9-53c5b8d44d6d`; existing vars were preserved.
- Live `ServicesGrid-BCuhQb06.js` matched the build byte for byte (3,188 bytes).
  Schema was current at 179/179, latest `0186_pricing_direct_purchase.sql`,
  zero behind. All 14 read-only cost/privacy probes and the normal live
  endpoint, cache, origin, admin/cart, sign-in and configuration gates passed.
- Subsequent permitted direct `/api/health` verification independently confirmed
  HTTP 200, status `ok`, schema `current`, `expected_count`/`applied_count` 179,
  zero behind, and both migration filenames equal to 0186. A separate
  `scripts/live-cost-probes.mjs` run passed all 14 probes with zero failures,
  including public-product slug discovery.

Verification used synthetic financial fixtures and read-only production checks.
It did not perform a row-wide historical reconciliation or browser E2E. Old
records without sufficient evidence still require review under the rules above.

The first full attempt used code `de54666a3150e022e1125fd56958b07adfb8b8f0`,
tree `2894567eca304f9a030d536de344578ce46b0b5f`, in workflow 7
[run 38119889237](https://github.com/justrandoomis/Levonis/actions/runs/38119889237),
job `114412259631`. Its complete check passed. Units had 10,515 passes, one
failure and seven declared skips (root: 9,837 passed, one failed, one skipped;
workspaces: 365 passed; Studio: 313 passed, six skipped). The single failure was
the old exact JSX expectation at `tests/engineSaveStrings.test.ts:123`: it
expected only `ratesSeq` before the sibling-list refresh change. The assertion
now explicitly requires both revision sources and the workspace callback; no
production source or financial formula changed. All live steps 8–35 were skipped,
so this attempt did not migrate or deploy. The successful retry is recorded above.
The corrected assertion and adjacent pricing suites passed 30/30 locally; the
complete `npm run check` also passed again on the exact retry source.

Local HTTPS Git push lacked credentials in this session. The connected GitHub
API uploaded the exact tested blobs, verified the identical root tree, and made
one non-forced fast-forward on the existing default branch. Workflow 7 remains
the only deployment path; no branch or pull request was created.

## Previous published release — 2026-10-11

Code `1e4084620e0e638b73a2fa9988d3e2baf1a4fcbe`, tree
`5185494f71a0fe94f0614d3d9c806cd14124ad1d`, was published through workflow 7 run
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
