# 2026-10-23 — remove writes and serial waits from unchanged membership reads

`getTierStatus` ran an expiry UPDATE, membership SELECT, restriction SELECT, and user-cache
UPDATE sequentially on every call, even for a free account with no memberships. This put
four D1 round trips on signed-in catalogue requests and merchant-store resolution. Both
UPDATE statements were sent even when neither changed a row.

Memberships, restrictions and the derived user-cache fields now load concurrently. Expiry
writes run only when an overdue, unfrozen row was found, followed by a re-read so a concurrent
renewal is respected. Derived user fields are written only when they differ. No cross-request
membership cache is added: restrictions, cancellation, pause/resume, reservation conversion
and prices still use fresh server authority. The pre-0145 schema remains supported.

Measured with the real route modules and migrated SQLite through `tests/fixtures/wavesD1.ts`:

| Route / account | Dependent D1 waves before | After |
| --- | ---: | ---: |
| Stable free or PLUS membership status | 4 | 1 |
| `/api/home`, signed in | 6 | 3 |
| `/api/products`, signed in | 4 | 2 |
| Product detail, signed in | 5 | 2 |
| `/api/home/sections`, signed in | 6 | 4 |
| Merchant storefront resolution | 5 | 3 |

These are database dependency counts, not claims of the same percentage improvement in
whole-page load time. Public HTTP probes include the test environment's network/proxy
latency and are not used as a before/after speed benchmark. The frontend bundle is unchanged.

Validation: 92 focused tests covering route budgets, stable reads, immediate expiry/renewal,
cancellation, membership entitlements, PRO pause/resume, benefit pricing, checkout and
concurrent subscriptions passed. Worker/test typechecks, changed-file lint and the production
build are checked before publication; the live deploy retains the repository's full CI gates.
