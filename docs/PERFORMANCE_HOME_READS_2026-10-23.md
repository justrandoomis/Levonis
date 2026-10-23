# Home read scheduling — 2026-10-23

Follow-up to the membership-read change (`e17f866`). The homepage still made its
product relations wait for unrelated settings/category work, and a signed-in
request waited for the viewer's tier before selecting discount candidates even
though that selection uses shared rules only. Extra shelves fetched product rows
before starting their relations, offers and pool reads.

The primary home now starts product enrichment as soon as its shelf rows arrive.
Discount candidate selection joins the existing shared configuration read;
actual prices still await the viewer's freshly read membership context. Graded
reference prices run alongside relations. A card shared by multiple shelves is
resolved once within that response, with separate sellable/catalog-only keys.
There is no new response cache or cross-request price, stock or entitlement cache.

Extra shelves start rows, relations, offers and pool reads together after the ids
are known. `loadRelationsViewsForIds` waits for the actual product rows before
assembling views, preserving BASE, OPTION, COLOR and VARIANT_COMBINATION inventory
modes and excluding rows that disappeared. Existing callers keep the original
`loadRelationsViews(db, rows)` interface.

## Measurements

Real home router, migrated SQLite, existing live-catalog/store fixtures and
`wavesD1`, before/after with identical data. Each simulated D1 wave costs 25 ms.
The catalog includes featured products; the graded variant also points an
open-box product at its new-product price reference.

| Request | Dependent D1 waves before → after | Statements before → after |
| --- | --- | --- |
| Home, cold shared configuration | 3 → 3 | 24 → 24 |
| Home, warm, guest | 3 → 2 | 19 → 19 |
| Home, warm, signed in | 3 → 2 | 22 → 22 |
| Home with graded reference, cold | 4 → 3 | 25 → 25 |
| Home with graded reference, warm, guest | 4 → 2 | 20 → 20 |
| Home with graded reference, warm, signed in | 4 → 2 | 23 → 23 |
| Extra home shelves, guest | 4 → 3 | 18 → 18 |
| Extra home shelves, signed in | 4 → 3 | 21 → 21 |

All twelve captured JSON responses (normal/graded × home/extra shelves ×
cold/warm/member) are structurally identical before and after. These figures
measure dependency depth, not a percentage improvement in a customer's full-page
load time. Cold configuration, network conditions, the session middleware and
image delivery remain outside that claim.

## Validation

- Tightened the normal home and extra-shelf ceilings in `tests/d1Waves.test.ts`.
- Added a graded home test with an active offer and overlapping shelves, checking
  the reference saving, unchanged cards, and the two-wave warm/member budget.
- Added a real-query test that loads rows and relations in one wave and compares
  the resulting views across all four inventory modes, including a missing id.
- Ran home shelves/categories, card projection, catalog-only cards, relational
  resilience, pricing V2 overlay and membership benefit integration suites.
- Worker/test TypeScript checks, changed-file lint and production build passed.

No migrations, deployment configuration, cache lifetimes or frontend visuals
changed. Deployment uses the repository's normal gated live workflow.
