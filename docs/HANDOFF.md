# Handoff — where the work stands (updated 2026-10-10, 20:40 UTC)

This file lets any agent pick up the work if a session stops. Read `CLAUDE.md`
first (default branch `claude/new-session-2hq4ci`, every push deploys through
workflow 7, ar/en/ckb strings). This file is prose: pushing it alone does not
deploy (workflow 7 ignores `docs/**` and `*.md`).

## 1. What is on the default branch

| Commit | What | Live? |
|---|---|---|
| `4b5fc125` | Clay redesign foundation (tokens, canvas, glass removed, primitives, chrome) — DECISIONS 207–210 | live (run 38063157537) |
| `75cc99a9` | Clay Phase 3: every page family converted (ratchet 0 / 14 / 172 / 2) — DECISIONS 211 | live (run 38077126903) |
| `d0221f0a` | «تحديث البيانات»: a large data file applies as one atomic batch per product (no fixed 200 cap; budget from D1's 1,000), every field labelled in ar/en/ckb — DECISIONS 212 | deploying (run 38079820825) |
| this push | «التسعير بالدولار والشحن»: «نشر» saves what the owner typed (data first, price only on the owner's confirm, never silent) — DECISIONS 213, 214 (was `wip/usd-pricing-save`) | queued behind d0221f0a |

After a deploy: `curl https://levonis-iq.com/api/health` (schema current,
178 migrations, last `0185_security_deception.sql`) and
`node scripts/live-cost-probes.mjs` (must be 14/14). Never send other
requests to the live site with a tool: the deception layer blocks tools that
touch its decoys, and production data is off-limits.

## 2. Finished fixes waiting to land (pushed as `wip/*`, NOT on the default branch)

Pushing a `wip/*` branch does not deploy (workflow 7's job only runs for the
default branch). To land one: rebase it onto the default branch, renumber its
DECISIONS rows to the next free numbers (the last row on the default branch is
**214**), run the gates (§4), then fast-forward the default branch and push.

### `wip/usd-pricing-save` — LANDED on the default branch (DECISIONS 213, 214)
The branch is kept only as a record. Gates on the landed tree: `npm run check`, `npm run build`, 1,904/1,905 targeted tests (1 skipped), browser regression `scripts/e2e-usd-pricing-save.mjs` 123/123.

### `wip/inventory-investment` (head `ef29c44b`, base `4b5fc125` — needs a rebase)
Owner request 2026-10-10: (1) name a stock purchase; (2) a stock purchase is
reviewed for **direct sale only** (no «طلب مسبق — بري» rows); (3) when an
investment funds a purchase and purchase + costs come to less, the remainder is
credited once to the investor's «أرباحي» wallet at the shipment confirmation
(idempotent, never edits old rows); (4) «سجل الحركات» removed from «أرباحي».
Built in three commits; its DECISIONS row says **211** → renumber to the next
free row when landing. Its independent verification (money, pricing, privacy,
browser flow) was still running at handoff — re-run it before landing: try to
credit twice / the wrong investor / before confirmation / a negative remainder,
and check that a stock purchase never changes pre-order prices.

## 3. Local-only work (deliberately NOT pushed — the repository is public)

A local data-leak audit (owner request: «المستخدم واي شخص يحصل فقط على السعر
النهائي لا يتسرب تكلفه او عمليه حسابيه نهائيا») proved 33 cost-privacy leaks
with failing tests and fixed all of them on a local branch. Because the
repository is public, the branch (which describes leaks that are still live)
is pushed only together with its deploy. If this machine is lost, re-run the
audit: map every route × role × private field, hunt by channel (customer and
public APIs, staff APIs for non-owner roles, edge cache and Cache-Control,
exports/imports, logs/errors/audit readers, notifications/Telegram, search/SEO,
client bundles and localStorage), prove each candidate with a failing local
test using `tests/fixtures/costlyProduct.ts` and `tests/fixtures/roleMatrix.ts`,
fix at the source, extend the shared guards (route classification, role matrix,
`bundlePrivateNames`, live probes).

## 4. Gates before any push to the default branch

The owner postponed the hours-long full suite locally (`npm run test:unit`);
workflow 7 runs it in CI on every push (~1 h). Locally, before pushing:

1. `npm run check`
2. `npm run build`
3. `REQUIRE_DIST=1 node --import tsx --test <files>`: every test that reads a
   changed file (grep `tests/` for the basenames) plus `bundleBudget`,
   `claySystem`, `themeSystem`, `uiSystem`, `refusalStrings`, the `cost*` tests.
4. With a migration: `node scripts/migrate-check.mjs --twice`.

Pitfalls seen today:
- A new Tailwind palette shade (e.g. `text-sky-100`) makes
  `scripts/theme-tokens.mjs` emit a new token → `themeSystem` fails until
  `node scripts/theme-tokens.mjs --write` (or reuse an existing shade).
- `tests/claySystem.test.ts` ratchet ceilings only go down; use `lv-surface`,
  `lv-well`, `lv-input`, `lv-button*`, `StatusChip`, semantic text tokens — no
  zinc, no `backdrop-blur`, no `rounded-[Npx]`.
- Public CSS budget 60 KB gzip (≈ 6 KB headroom now); merchant workspace shell
  JS closure has only ≈ 25 B headroom — fund any growth there first.
- Pins that quote source text (e.g. `tests/cardProjection.test.ts` quotes the
  products list SQL) must be updated when that text changes.

## 5. Owner actions still open (on the live site)

- Approve the FX rates and the market adjustment in «التسعير والشحن»; make sure
  each shipping route used has a central rate. Until then the engine computes
  no USD price (the data is still saved).
- Set the AMS section serial policy to «مطلوب»; assign brands to serial products
  that have none.
- Optional: add the `SECURITY_CANARY_KEY` secret; disconnect the Workers Builds
  Git integration (it is refused by design).

## 6. Backlog after the above

Community phases 6–8; merchant workspace v2 (MP2-A/B/C/E); Programme C · C1;
about 4,450 UI strings without Sorani; Sorani screenshot pass for the clay
redesign (the screenshot tool has no language option yet).

## 7. Prompt for a new agent

> Read `CLAUDE.md` and `docs/HANDOFF.md`. Check workflow 7's latest runs and
> the live health. Land `wip/inventory-investment`
> (re-run its money/pricing/privacy verification first), each with the §4 gates
> and renumbered DECISIONS rows; push to the default branch one at a time and
> verify live after each. Then continue with §3 if the leak fixes are not on
> the default branch, and §6.
