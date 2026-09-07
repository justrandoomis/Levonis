# LEVO Printer Farm — architecture and Phase 1

A server-authoritative 3D-printing business simulator inside Levonis. The
player starts with one Bambu Lab A1 mini, one PLA spool and a tiny room, takes
customer jobs, prints, delivers before deadlines, earns Farm Coins and
reputation, maintains machines, and grows into an automated print farm.

This document is the contract every part of the game is built against. It is
written so Phases 2–6 add to it without replacing Phase 1.

## 1. Principles

- **The server is the game.** Every state change that affects coins, points,
  tickets, inventory, printers, jobs, reputation or leaderboards happens in a
  route handler over D1, in an atomic batch, with the server clock. The client
  renders state and sends intents. Client timers, balances and timestamps are
  never trusted.
- **Deterministic simulation.** Progress is resolved from timestamps, never by
  ticking: a print that started at T with duration D is done at T+D whenever
  the state is next read. Random outcomes come from a seeded PRNG keyed on
  stable ids, so replaying a request cannot change an outcome.
- **Two currencies, one wall.** Farm Coins live only in the game. Levonis
  Points are the site's real reward currency and are minted only through the
  existing points functions, behind configurable, server-enforced limits.
  Phase 1 mints no Levonis Points at all.
- **Everything numeric is configuration.** Prices, rates, probabilities,
  rewards, deadlines, thresholds and limits live in one versioned setting the
  admin edits without a deploy; defaults ship in code and are normalised on
  read.
- **Progressive disclosure.** The server tells the client what is unlocked;
  the client shows only that.
- **Reuse.** Auth, sessions, rate limits, audit, admin settings, wallet-style
  ledgers, points and tickets are the existing Levonis systems. The game adds
  no duplicate of any of them.

## 2. Data model (migration 0053)

All tables are prefixed `farm_`. Money is integer Farm Coins. Times are ISO
strings from the server clock. Every row carries `user_id` and every read is
scoped by it.

| table | purpose |
| --- | --- |
| `farm_profiles` | one row per player: `farm_name`, level, xp, reputation (integer basis points 0–5000 → ★ 0.00–5.00), `location_key`, state (`active` / `recovery`), `last_seen_at`, `last_resolved_at`, `config_version`, `stats_json` (jobs delivered/late/cancelled, prints, failures, streak, lifetime coins), `tutorial_json` — NO coin column: the balance is always `SUM(farm_ledger.amount)` |
| `farm_ledger` | append-only Farm Coin ledger: `kind` (CHECK list), `amount` (signed, ≠ 0), `ref_type`/`ref_id`, `idempotency_key` (UNIQUE per user), `note`; a `BEFORE INSERT` trigger raises `FARM_INSUFFICIENT_COINS` when a debit would take the sum below zero, so an overdraft aborts the whole D1 batch |
| `farm_printers` | owned machines: `model_key` (catalog), `slot` (position in the room), `nickname`, `health` (0–100), `state` (`idle` / `printing` / `done` / `maintenance` / `broken`), `state_until` (server time when maintenance/repair finishes), `hours` (operating hours ×100), `prints`, `failures`, `upgrades_json` |
| `farm_spools` | filament inventory: `material`, `color`, `grams_left`, `grams_total`, `quality`, `cost_paid` |
| `farm_jobs` | customer jobs: `state` (`offered` / `accepted` / `printing` / `ready` / `delivered` / `late` / `cancelled` / `rejected` / `expired`), customer tier, product, qty, material, colours, grams, print seconds (reference machine, standard quality), quality, reward, reputation ±, penalties, `offered_at`, `offer_expires_at`, `deadline_at`, `accepted_at`, `delivered_at`, `seed` |
| `farm_assignments` | one per printer per job batch: `qty`, `spool_id`, `grams`, `seconds`, `position` in the printer's queue, `state` (`queued` / `printing` / `done` / `failed` / `collected`), `started_at`, `ends_at`, `failure_kind`, `outcome_seed` |
| `farm_events` | things that happened while away or on resolve: failures, deliveries, cancellations, maintenance done; `seen_at` drives the "While you were away" sheet |
| `farm_daily` | per player per Baghdad day (`baghdadDay()`, UTC+3 — the site's day boundary) counters for limits (coins earned, jobs delivered, later points converted) |
| `farm_achievements` | `key`, `unlocked_at`, `reward_json`, `claimed_at` (Phase 5 fills it; the table exists so Phase 1 stats are recorded) |

Indexes: `(user_id, state)` on jobs and printers, `(user_id, created_at)` on
ledger and events, `(printer_id, position)` on assignments, UNIQUE
`(user_id, idempotency_key)` on the ledger.

Balance rule: there is no stored balance. Every read computes
`SELECT COALESCE(SUM(amount),0) FROM farm_ledger WHERE user_id = ?`, every debit
is guarded by the trigger, and every coin movement is one row with an
idempotency key, so a replayed request is a no-op and two concurrent debits
cannot both pass. Loans (Phase 4) are a separate `farm_loans` table, never a
negative balance. Migration 0053 seeds no rows (defaults live in code) and
uses only idempotent statements.

## 3. Engine (`worker/lib/farm/`)

Pure, deterministic, unit-tested modules with no Hono or D1 inside:

- `config.ts` — `FarmConfig` type, `FARM_CONFIG_DEFAULTS`, `normalizeFarmConfig(raw)` (fills, clamps, versions), `publicFarmConfig(cfg)` (the subset the client may see; limits and anti-abuse stay private).
- `catalog.ts` — helpers over the config's printer models, materials, products, customer tiers and locations (compatibility, capacity, volume).
- `rng.ts` — seeded PRNG (mulberry32 over sha-256 of ids) → `roll(seed, salt)` in [0,1).
- `time.ts` — print duration for (product, qty, printer speed, quality), maintenance duration.
- `failure.ts` — failure probability from printer health, model reliability, material difficulty, spool quality, product complexity, print quality, upgrades; failure kind selection; costs (grams lost, time lost, health hit).
- `jobs.ts` — `generateOffers(profile, ownedCapacity, now, cfg, rng)` (tier gating by reputation/level, deadline ranges, reward formula = grams × material price × margin + time × rate, colour count from colour capability the player owns), `expireOffers`.
- `sim.ts` — `resolve(state, now, cfg)` → applies every assignment whose `ends_at ≤ now` (success/failure), advances printer states, marks ready/late/cancelled jobs, computes electricity, health wear, returns events and ledger deltas as data (the route writes them).
- `progression.ts` — xp/level thresholds, reputation deltas (delivery, late, cancel, failure), `unlocks(profile)` → flags for progressive disclosure, `starterKit(cfg)`.
- `ledger.ts` — builds the atomic statements for a coin movement with idempotency and the balance invariant.

## 4. API (`worker/routes/farm.ts`, mounted at `/api/farm`)

`farmRoutes.use('*', requireAuth)` except the leaderboard read. Every mutating
route takes `idempotencyKey` (8–80 chars) in the body and is rate-limited per
user (`farm-mutate` 120/h; buys 30/h). Errors are `HttpError`s with
SCREAMING_SNAKE codes the client maps to ar/en/ckb copy.

### Reads

`GET /state` → bootstrap and the single source of truth for the client:
```
{ success, now, config_version, unlocks: { market, inventory, maintenance, store, upgrades, employees, ... },
  profile: { farm_name, level, xp, xp_next, reputation_bp, stars, location: { key, max_printers, storage_grams }, state, coins, stats, tutorial },
  printers: [{ id, model_key, nickname, slot, health, state, state_until, hours, prints, failures,
               current: { assignment_id, job_id, title, qty, started_at, ends_at, progress } | null,
               queue: [{ assignment_id, job_id, title, qty, seconds }] }],
  spools: [{ id, material, color, grams_left, grams_total, quality }],
  jobs: { offered: [Job], active: [Job] },   // Job = { id, state, customer_tier, customer_name, title, product_key, qty, material, colors, grams, print_seconds, quality, reward_coins, reputation_gain, late_penalty_bp, cancel_penalty_coins, cancel_penalty_bp, offer_expires_at, deadline_at, accepted_at, delivered_at, assignments_summary }
  events_unseen: [{ id, kind, payload, created_at }],
  config: PublicFarmConfig }
```
Calling `/state` first creates the profile with the starter kit (ledger kind
`starter`, one A1 mini in slot 0, one PLA spool, first offers) and always runs
`resolve()` to `now` before answering.

`GET /ledger?before=<created_at|id>` → `{ entries: [{ id, kind, amount, balance_after, note, ref_type, ref_id, created_at }], next_before }` (balance_after computed in the query by running sum, newest first, 30 per page).
`GET /events?all=1` · `POST /events/seen { ids }`.
`GET /leaderboard?board=reputation|farm_value|jobs_delivered&limit=50` — public read (no auth), server-computed from `farm_profiles` + owned printers at catalog resale value; rows carry only `username`, `avatar_key`, `farm_name` and the score. Cached 60 s.
`GET /config` → `{ version, config: PublicFarmConfig }` with `ETag: "farm-v<version>"`.

### Job intents

`POST /jobs/:id/accept` · `POST /jobs/:id/reject` — offer → accepted / rejected; expired offers → 409 `OFFER_EXPIRED`; accepting counts against `limits.max_active_jobs`.
`POST /jobs/:id/assign { allocations: [{ printer_id, qty, spool_id }], quality: 'draft'|'standard'|'fine'|'ultra' }` — sum of qty must equal the job qty (partial allocation allowed only with `allow_partial: true`, the rest stays unassigned); for each allocation: printer owned and not `broken`/`maintenance`, model supports the material and the colour count (multi-colour needs an AMS-capable model), part fits the build volume, spool material/colour matches and has the grams (grams are reserved: `grams_left` decremented at assignment, refunded on job cancel before printing starts); creates `queued` assignments at the end of each printer's queue; an idle printer starts its first queued assignment immediately (`started_at = now`, `ends_at = now + seconds/time_scale`). 400 codes: `PRINTER_INCOMPATIBLE_MATERIAL`, `PRINTER_NO_MULTICOLOR`, `PART_TOO_LARGE`, `SPOOL_MISMATCH`, `SPOOL_INSUFFICIENT`, `PRINTER_UNAVAILABLE`, `QTY_MISMATCH`.
`POST /printers/:id/queue { order: [assignment_id] }` — reorder queued (not printing) assignments.
`POST /printers/:id/collect` — the finished batch (`done` or `failed`) is collected: printer → `idle`, next queued assignment starts; if every assignment of the job is collected and the delivered qty equals the job qty the job is delivered and paid in the same batch (ledger `job_payout`, reputation +gain, or late: reputation −late_penalty after `deadline_at`); a failed batch's qty stays undelivered until the player re-assigns it (`POST /jobs/:id/assign` again for the missing qty). The answer is the state body plus `{ printer_id, collected: { assignment_id, job_id, qty, outcome: 'done' | 'failed', failure_kind }, delivered: DeliverySummary | null, payout_deferred: { job_id, reward_coins, day, late, reason: 'daily_jobs_cap' | 'daily_coins_cap' } | null }` where `DeliverySummary = { job_id, reward_coins, late, reputation_delta_bp, reputation_bp, xp_gained, level, level_up }` (`deliveryPlan`, §9a); a replayed key answers the stored result with `replayed: true`. The client reads these fields to tell the player what the collect did (§6) — it never derives a payment from the balance moving.
`POST /jobs/:id/cancel` — player cancels an accepted job: reserved grams refunded for not-started batches, reputation −cancel_penalty_bp, coins −cancel_penalty_coins (Phase 1 default 0).

### Printer intents

`POST /printers/:id/maintain` — allowed when `idle`/`done` and the maintenance feature is unlocked (`409 FEATURE_LOCKED { min_level }` below it); debits `maintenance_cost`, sets `state='maintenance'`, `state_until = now + minutes/time_scale`; on resolve health → 100.
`POST /printers/:id/repair` — when `broken`; debits `repair_cost`; same mechanics; health restored to `repair_health`.
`POST /printers/:id/rename { nickname }`.

### Market intents

`POST /market/filament { material, color, grams }` — grams from the config's spool sizes; debits `price_per_gram × grams`; storage capacity checked against the location.
`POST /market/printers { model_key }` — debits the catalog price; requires a free slot (`location.max_printers`) and the model's `min_level`; the new printer lands in the lowest free slot.
`POST /market/printers/:id/sell` — credits `resale_factor × price` (idle printers with an empty queue only); the row is kept with `sold_at` and a parked slot, never deleted (§9a).

### Server resolution (`resolve()`), run on every read and mutation

For each printer with a `printing` assignment whose `ends_at ≤ now`: roll the outcome with `roll(assignment.outcome_seed)` against the failure probability computed at start (stored on the assignment so a config change cannot alter an in-flight print); success → `done`, `prints += qty`, hours += duration, health −= wear; failure → `failed` with a kind, grams of the batch lost, health −= wear + hit, `failures += 1`, event row; a hard failure kind can set the printer `broken`. Maintenance/repair whose `state_until ≤ now` completes. Offers past `offer_expires_at` expire; accepted jobs past `deadline_at + late_grace` with undelivered qty are cancelled by the customer (reputation −cancel_penalty_bp, event, reserved grams released), and new offers are generated up to `jobs.offers_visible` when the refresh interval has passed since `last_offer_at`. Electricity for completed batches is debited per printer-hour (`energy.coins_per_kwh × model.watts / 1000 × hours`). Everything resolved becomes `farm_events` rows for the "While you were away" sheet when more than `away_summary_after_minutes` passed since `last_seen_at`.

### Admin (`worker/routes/farmAdmin.ts`, mounted at `/api/admin/farm` so the main-host guard is inherited; `use('*', requireAdmin)`)

`GET /config` → `{ config, defaults, public, problems, version }`.
`PUT /config/:section { value, expected_version }` → 409 `CONFIG_VERSION_MISMATCH` on a stale version; normalises with `normalizeFarmConfig`, refuses with 400 `FARM_CONFIG_INVALID { problems }`, bumps `version`, `setSetting`, `audit('farm.config_update', section, { version, before, after })`.
`POST /config/:section/reset { confirm: 'RESET' }`.
`GET /players/:userId` (profile, ledger tail, printers, jobs) · `POST /players/:userId/grant { amount, reason, idempotencyKey }` (ledger `admin_grant`, audited).
The generic `PUT /api/admin/settings/:key` REFUSES `printerFarmConfig` so the normaliser is the only write path.

## 5. Configuration (`admin_settings.printerFarmConfig`)

One JSON document, `worker/lib/farm/config.ts` is the leaf module (imports only
`safeParse`): `FarmConfig`, `FARM_CONFIG_SCHEMA = 1`, `FARM_CONFIG_DEFAULTS`,
`normalizeFarmConfig(raw)` (fills every missing field from the defaults, clamps,
forces `schema`, preserves `version`), `publicFarmConfig(cfg)` (drops `limits`,
`rewards` budgets and anti-abuse values) and `farmConfigProblems(cfg)`
(blocking rules: every product's material exists, every printer supports ≥1
material, starter kit references exist, prices > 0, probabilities in [0,1]).
The key is registered in `SETTING_DEFAULTS` and kept out of `PUBLIC_SETTING_KEYS`.

Sections (every number below is a default the admin can change):

- `time`: `time_scale` = 20 game-seconds per real second (one game hour ≈ 3 real minutes), `offer_refresh_minutes` (real), `away_summary_after_minutes`.
- `economy`: `starter_coins` 1,500; `resale_factor` 0.55; `spool_sizes_g` [250, 500, 1000]; `maintenance` { cost, minutes, health_restore }; `repair` { cost, minutes, health }; `energy` { coins_per_kwh }.
- `printers`: catalog keyed by model — `name`, `family` (`A`/`P`/`X`/`H`), `price`, `speed` (mm/s reference → duration factor), `volume_mm` [x,y,z], `materials` [...], `ams` (bool → multi-colour), `reliability` 0–1, `watts`, `wear_per_hour` (health points), `min_level`, `sort`. Defaults: A1 mini 6,000 · A1 mini Combo 9,500 · A1 9,000 · A1 Combo 13,500 · A2L 12,000 · A2L Combo 17,000 · P1P 16,000 · P1S 19,000 · P2S 24,000 · X1C 32,000 · X2D 42,000 · H2S 48,000 · H2D 60,000 · H2C 75,000 (gated by `min_level`).
- `materials`: `PLA`, `PETG`, `TPU`, `ABS`, `ASA`, `PA`, `PC`, `PLA-CF`, `PETG-CF` — `price_per_gram`, `difficulty` 0–1, `min_level`, `colors` list.
- `products`: job templates — `key`, `name_ar/en/ckb`, `grams_per_part`, `seconds_per_part` (reference printer, standard quality), `complexity` 0–1, `max_colors`, `size_mm`, `materials` allowed, `min_tier`.
- `customers`: tiers `individual`, `small_business`, `merchant`, `company`, `industrial` — `min_reputation_bp`, `min_level`, `qty_range`, `deadline_factor` (deadline = print time × factor + buffer), `reward_margin`, `late_penalty_bp`, `cancel_penalty_bp`, `reputation_gain_bp`, `weight`.
- `jobs`: `offers_visible` 3, `offer_lifetime_minutes`, `late_grace_minutes`, `max_active_jobs` by level, `reward_formula` { `per_gram_factor`, `per_hour_coins`, `per_part_coins`, `quality_multipliers` }.
- `quality`: `draft`/`standard`/`fine`/`ultra` — `time_factor`, `failure_factor`, `reputation_factor`.
- `failure`: `base` 0.03; weights for health, reliability, material difficulty, spool quality, complexity, quality; `kinds` with `weight`, `grams_loss_factor`, `health_hit`, `breaks` (bool), `time_loss_factor`.
- `progression`: `xp_per_job`, `xp_per_part`, `level_thresholds` [...], `reputation_start_bp` 0, `reputation_cap_bp` 5000, unlock levels per feature (`market` 1, `inventory` 1, `maintenance` 2, `store` 3, `upgrades` 4, ...).
- `locations`: `tiny_room` (2 printers, 3,000 g, 0 employees) → `garage` (6) → `small_workshop` (14) → `print_farm` (40) → `industrial_farm` (120) with `price` and `min_level`.
- `starter`: `printer_model`, `spool` { material, color, grams }, `first_job` template.
- `limits` (private): `daily_jobs_cap`, `daily_coins_cap`, `mutations_per_hour`.
- `rewards` (private, Phase 5): `levonis_points` { `enabled: false`, `coins_per_point`, `daily_cap_points`, `weekly_cap_points`, `min_level`, `min_reputation_bp`, `budget_points_per_day` }.

Balancing targets for the defaults (asserted by a simulation test): with one
A1 mini and the starter spool the first job takes 2–4 real minutes; a second
spool is affordable after the first job; the second printer (A1 mini) after
roughly eight to ten delivered jobs; a single idle printer costs nothing.

## 6. Client (`src/pages/farm/`, lazy-loaded at `/games/printer-farm`)

Files: `PrinterFarm.tsx` (shell, state, polling/resync), `FarmSkeleton.tsx`
(eager, tiny), `FarmTabBar.tsx`, `room/Room.tsx` (inline-SVG isometric room:
floor tiles from the location, one `<symbol>` printer used per slot with state
colours and two compositor-only animations, filament shelf, work table, HTML
overlays for labels and countdowns, 44 px hit targets), `views/FarmView.tsx`,
`views/JobsView.tsx`, `views/MarketView.tsx`, `views/InventoryView.tsx`,
`sheets/JobSheet.tsx` (accept → allocate printers and spools), `sheets/
PrinterSheet.tsx` (queue, collect, maintain, repair, rename), `sheets/
AwaySheet.tsx` ("While you were away"), `sheets/LedgerSheet.tsx`, `strings.ts`
(ar/en/ckb), `format.ts` (game-time "4h 32m", coins). Types live in
`src/lib/farmApi.ts` and mirror §4 exactly.

Mobile-first: bottom pill tab bar **FARM · JOBS · MARKET · INVENTORY**; STORE
and UPGRADES render locked (not hidden) until `unlocks` says otherwise.
Countdowns tick locally from server `ends_at` and re-sync on every response;
the client never decides an outcome. Every mutation sends a fresh idempotency
key and re-renders from the returned state. A Collect additionally reads the
route's own fields (`collectResultOf` in `farmApi.ts`, `collectNotice` in
`collect.ts`) and shows one Note in an `aria-live="polite"` region under the
header (`data-farm-notice="collect"`, repeated inside the printer sheet for
that machine): paid → the server's `reward_coins` and signed reputation delta
(late deliveries say so; a `level_up` adds a line); a failed batch → the
failure kind and that the parts are free to re-assign; `payout_deferred` →
handed over, the coins arrive tomorrow because today's jobs or coins cap is
reached (the server's `reason` decides which); `replayed` → nothing extra was
paid; a partial job → parts collected, paid when every part is in. Active
jobs with `payout_deferred_day` wear a "payout pending" badge on the JOBS tab
and in the assign sheet. Coins and stars are Latin digits inside FSI…PDI
isolates; the close control is 44 px. Design language: dark, industrial,
warm gold accent, house springs and materials; no giant type, no neon, no
dashboard grid.

Games hub: `/games` (guest-visible) becomes the real hub — the Printer Farm
card with the player's own farm summary when signed in, links to
`/leaderboards` (now server-backed by `GET /api/farm/leaderboard`),
`/games/profile` (the farm profile and stats) and `/games/redeem` (the Farm
Coins → Levonis Points rules read from the server; while `rewards.levonis_
points.enabled` is false the page says conversion is not open yet — honest
server state, no fake button). The four fabricated games and the Profile
page's invented "free daily tickets" row are removed. `ticket_ledger` and
`game_sessions` stay untouched: tickets are blocked by DECISIONS row 25.

## 7. Security and anti-cheat

Server clock only; seeded outcomes; idempotent mutations; ledger invariant
with CHECK; per-user rate limits and daily caps; jobs and assignments are
state machines that refuse double accept / double collect; inventory cannot
go negative (reservation at assignment); printers cannot run incompatible or
overlapping work; Levonis Points are never touched in Phase 1 and later only
through the existing points functions with configured budgets; leaderboards
(Phase 5) are computed server-side from the ledger and stats.

Hardened after the adversarial review of Phase 1 (migration 0054, §9):

- **Randomness is the server's.** A print's `outcome_seed` is 32 random bytes
  written on the assignment row at insert (`randomSeedHex`); the assignment
  id stays deterministic per request so a retry collides instead of booking
  twice, but nothing derivable from the request decides the roll. Offers are
  seeded from `sha256(offer_salt : refresh index)` where `offer_salt` is a
  per-player secret created at bootstrap (backfilled on the first read for
  older profiles) and never returned by any route or projection — not
  `/state`, not a mutation body, not the admin player view (`raw_profile` and
  `assignments` are stripped of it). Failure kind and customer name come from
  those same server-held seeds.
- **The revision fence.** `farm_profiles.revision` is an integer every write
  batch — resolver and intent — expects and bumps: `SET revision = CASE WHEN
  revision = ?expected THEN revision + 1 ELSE -1 END` behind `CHECK (revision
  >= 0)`. A request that read stale rows commits nothing at all (the earlier
  token on `last_resolved_at` failed to fence a mutation after its own
  resolver batch, so two sandwiched requests both passed). The request
  re-reads, checks the replay memory, re-plans once, and answers `409
  STATE_CHANGED` if the farm moved again.
- **Ledger ids name the event, not the request.** `fl_payout_<jobId>`,
  `fl_energy_<assignmentId>`, `fl_sale_<printerId>`,
  `fl_maint_<printerId>_<revision>`, `fl_repair_<printerId>_<revision>`,
  `fl_cancelpen_<jobId>` (player and customer cancel alike). Purchases keep
  the request-derived id because the spool or printer they create is the
  event. An accidental double collides on the primary key and its batch rolls
  back.
- **Two key namespaces** in `farm_ledger.idempotency_key`: client keys are
  stored `req:<key>`, server rows `sys:<ledger id>`, admin grants
  `adm:<key>`. A client key containing `:` or starting with `fl_`/`sys` is
  refused (`400 IDEMPOTENCY_KEY_INVALID`), so a player cannot burn a resolver
  key and freeze their own clock; and `ensureFarmState` swallows only the
  fence abort and the bootstrap race — any other resolver failure is logged
  and surfaces instead of silently leaving prints unfinished.
- **Replay memory for every intent** (`farm_requests`): the same key on the
  same route replays the stored result with `replayed: true`; on a different
  route (or the same route for another job/printer — the route is `METHOD
  path`) it is `409 IDEMPOTENCY_KEY_REUSED`.
- **Sold printers are never deleted** (their assignments cascade): `sold_at`
  is set and the slot parked at `slot + 1,000,000 × n`; sold rows are excluded
  from state, slot counting, the leaderboard's farm value and every
  projection, while a half-delivered job keeps its collected parts.
- **Progressive disclosure is enforced**: `POST /printers/:id/maintain`
  answers `409 FEATURE_LOCKED { feature, min_level }` below the maintenance
  level (repair stays open at any level so a broken starter printer is always
  recoverable); the three market intents (`POST /market/filament`, `POST
  /market/printers`, `POST /market/printers/:id/sell`) answer the same below
  `progression.unlocks.market` — the tab the client hides is closed on the
  server too, whatever the admin sets the level to.
- **A farm always keeps a way to earn.** Selling the LAST live printer is
  refused with `409 LAST_PRINTER { coins_after_sale, cheapest_printer_coins }`
  when the proceeds plus the balance would not buy the cheapest model the
  player's level may own (defaults: 1,500 + 3,300 < 6,000); with enough coins
  the sale goes through. Bankruptcy never deletes a farm, and one tap on
  "Sell" must not strand it either.
- **`job_ready.late` is judged on the deadline**, not only on the stored
  state: a print that ends in the same resolution in which its deadline passes
  is announced late, as its payout will be.
- **Assistant admins** (`admin_scope = 'assistant'`) may read the console and
  edit balancing sections, but `PUT /config/limits`, `PUT /config/rewards`,
  their resets and `POST /players/:id/grant` answer `403
  FINANCIAL_SCOPE_REQUIRED` (`canViewFinancials`; the owner is always
  allowed).

## 8. Phases

1. Architecture + first playable loop (this document).
2. Own store products, market demand, printer/material depth.
3. Maintenance depth, spare parts, employees, electricity.
4. Locations, contracts, events, loans, recovery mode.
5. Leaderboards, achievements, challenges, limited Levonis Points.
6. Prestige, R&D, advanced automation.

## 9. Implementation notes — Phase 1

What was built on 2026-09-06 against §2–§5, and where the code decided
something this document left open. Every default in `worker/lib/farm/config.ts`
is a first balancing guess (DECISIONS.md row 96); the balancing targets of §5
are asserted by `tests/farmBalance.test.ts`.

**Migration `0053_printer_farm.sql`.** Nine `farm_` tables exactly as the §2
table lists them (profiles, ledger, printers, spools, jobs, assignments,
events, daily, achievements), all `IF NOT EXISTS`, no seed rows. Beyond §2:

- `farm_assignments.collected_at` — when the player cleared a finished batch
  off the printer. A `done` batch becomes `collected`; a `failed` batch keeps
  `failed` (its parts are free to re-assign) and only gets `collected_at`.
- `farm_assignments.quality` — the quality the player chose at assignment;
  `farm_jobs.quality` stays the customer's request. Reputation gain at delivery
  is scaled by the lowest `reputation_factor` among the job's batches.
- Assignment state `cancelled` (queued batches of a cancelled job).
- Four invariants the database holds, not the route: the overdraft trigger
  (`FARM_INSUFFICIENT_COINS`), `CHECK (grams_left >= 0)` on spools, a partial
  UNIQUE index (one `printing` batch per printer), UNIQUE `(user_id, slot)` on
  printers, and a BEFORE INSERT trigger `FARM_QTY_EXCEEDED` (live batches of a
  job never exceed its quantity).
- `farm_profiles.level` carries a NAMED check `ck_farm_profiles_level`; in
  Phase 1 every write batch opened with a compare-and-swap on
  `last_resolved_at` that set `level` to 0 when the row moved. The review
  showed that token does not fence a mutation after its own resolver batch;
  since 0054 the fence is the integer `revision` column (§9a) and the level
  check is just a check.
- `farm_profiles.last_offer_at` / `offer_refresh_index` — the refresh counter
  seeds the deterministic offer generator, since 0054 together with the
  per-player secret: `seedFrom(offer_salt, 'offers', index)` (§9a).
- `farm_daily.day` is the **Baghdad day** (UTC+3, `baghdadDayOf`), not UTC —
  §2 said UTC; the platform's day boundary won (DECISIONS row 94).
- `farm_printers.health` is REAL (wear per print is fractional).

**Config.** One extra section, `colors` (hex + ar/en/ckb names, referenced by
`materials[*].colors`), so a colour is editable like everything else.
`time.reference_speed_mms` (250, the A1 mini) turns a model's mm/s into a
duration factor. `jobs.deadline_buffer_minutes` is GAME minutes;
`jobs.offer_lifetime_minutes`, `jobs.late_grace_minutes`,
`time.offer_refresh_minutes` and `time.away_summary_after_minutes` are REAL
minutes; `economy.maintenance.minutes` / `repair.minutes` are GAME minutes
(divided by `time_scale`). `progression.failure_reputation_bp` is the
reputation cost of a failed print. `farmConfigProblems` refuses
`rewards.levonis_points.enabled = true`: no code path converts coins to
Points in this phase, so the switch cannot promise it. Names live in the
config in all three languages; the client renders them from `title`,
`customer_name` and the catalog. `publicFarmConfig` drops `limits` and
`rewards`; `failure` stays public (a risk figure on the assign sheet is a
server number).

**Engine.** `roll(seed, salt)` is synchronous (mulberry32 over a multiply-xor
fold of the sha-256 seed and an FNV-1a hash of the salt); `seedFrom` is the
async sha-256. `resolve(state, now, cfg, offerSeed)` is pure and returns
`{ updates, ledgerRows, events, newOffers, finishedAssignments, readyJobs,
lateJobs, cancelledJobs, expiredJobs, balance, reputationBp, stats, changed }`
— delivery is a collect intent, so there is no `deliveredJobs` from the
resolver. Updates carry `guardPrintingAssignment` / `guardQueuedAssignment`
so printer/spool/job changes repeat the winner's predicate; events and offers
carry deterministic ids (`INSERT OR IGNORE`); electricity and cancel-penalty
debits carry deterministic ids and are **clamped to the balance** (a resolve
must always land — a stuck farm is worse than a waived kilowatt-hour; the note
records it).

**Job states.** `offered → accepted → printing → ready → delivered`; `late` is
an overlay the resolver sets on any active job once `deadline_at` passes (the
job stays deliverable with the penalty); `cancelled` after `deadline_at +
late_grace` (queued batches release their grams; a printing batch finishes
and is wasted). The final state of a late delivery is `delivered` with
`delivered_at > deadline_at`; `stats.late` counts it. The deadline is fixed at
offer time: `offered_at + offer_lifetime + reference print time ×
deadline_factor + buffer` — accepting late leaves less time, as a customer's
deadline would.

**Routes.** All of §4, plus: `GET /state?config=0` omits the public config for
polling; the state carries `unlock_levels` (feature → level) and `limits:
{ max_active_jobs, storage_grams }` so the client can show "unlocks at level
N" without inventing it; `unlocks` reports a feature open only when the level
is reached AND the feature exists in this phase (`PHASE_FEATURES`); `POST
/profile { farm_name }` renames the farm (default farm name = the account's
username, or empty). Every mutation runs the resolver first (its own batch),
then the intent as one batch behind the fence (§9a); a replayed idempotency
key returns `replayed: true` with the stored result and the current state; the
same key reused for a different intent is `409 IDEMPOTENCY_KEY_REUSED`. Additional codes:
`JOB_NOT_OFFERED`, `JOB_NOT_ACTIVE`, `TOO_MANY_ACTIVE_JOBS`, `PRODUCT_UNKNOWN`,
`QUEUE_MISMATCH`, `NOTHING_TO_COLLECT`, `PRINT_NOT_FINISHED`, `PRINTER_BUSY`,
`PRINTER_BROKEN`, `PRINTER_NOT_BROKEN`, `MATERIAL_UNKNOWN`, `COLOR_UNKNOWN`,
`SPOOL_SIZE_UNKNOWN`, `MODEL_UNKNOWN`, `LEVEL_TOO_LOW`, `STORAGE_FULL`,
`NO_FREE_SLOT`, `INSUFFICIENT_COINS`, `STATE_CHANGED` (a fence that failed
twice; `CONFLICT_RETRY` and the 429 `DAILY_CAP_REACHED` are gone — the cap
defers the payout instead, §9a), `IDEMPOTENCY_KEY_INVALID`, `FEATURE_LOCKED`. Rate limits: `farm-mutate` = `limits.mutations_per_hour`
(120) per hour, `farm-buy` 30/h on the two purchases. `GET /leaderboard` is
registered before the module's `requireAuth`; `farm_value` = coin balance +
owned printers at resale; rows are `{ rank, username, avatar_key, farm_name,
score }`. Maintenance/repair set the target health when ordered (the machine
is blocked until `state_until`); the resolver emits `maintenance_done` for
both and auto-starts the first queued batch when the service ends.

**Admin.** `/api/admin/farm` (inherits the apex-only guard): `GET /config` →
`{ version, config, defaults, public, problems, sections }`; `PUT
/config/:section { value, expected_version }`; `POST /config/:section/reset {
confirm: 'RESET' }` (audited `farm.config_reset`); `GET /players/:userId`
(read-only — does not resolve the player's farm); `POST /players/:userId/grant
{ amount, reason, idempotencyKey }` creates the farm first if the player never
opened the game, writes `admin_grant` (positive) or `admin_adjust` (negative,
trigger-guarded), audited `farm.admin_grant`. The generic `PUT
/api/admin/settings/printerFarmConfig` answers `400 FARM_CONFIG_ROUTE`.

**Not in this phase.** Store, upgrades, locations, employees, contracts, loans
(flags exist, always `false`); achievements (table only); any Levonis Points
movement; a cron sweep (resolution is lazy, per request, as §4 says).

### 9a. Hardening after the adversarial review (2026-09-07, migration 0054)

**Migration `0054_printer_farm_hardening.sql`** (additive, re-runnable through
the harness): `farm_profiles.revision INTEGER NOT NULL DEFAULT 0` with the
named `ck_farm_profiles_revision` (the fence), `farm_profiles.offer_salt TEXT
NOT NULL DEFAULT ''` (the per-player secret; `''` = issue on first read),
`farm_printers.sold_at TEXT`, `farm_jobs.payout_deferred_day TEXT`, the table
`farm_requests (user_id, idempotency_key, route, result_json, created_at,
UNIQUE (user_id, idempotency_key))`, an index on it, and a partial index over
live printers. The `level` CASE of the old CAS is gone; the fence is the only
write guard on the profile row.

**Pipeline** (`runMutation`): rate limit → key validation → resolve (fenced
batch, re-read) → `farm_requests` lookup (replay / reuse) → plan on fresh rows
→ ONE batch `[fence, …intent, farm_requests row]`. On a fence abort the state
is re-read, the memory consulted again (a double-tap that lost the race
replays), the plan rebuilt once; a second abort is `409 STATE_CHANGED`. Any
other UNIQUE/PRIMARY KEY collision on fenced rows is also `409 STATE_CHANGED`
and logged — never a silent `replayed: true`. `mustChange` stays as a
defensive check (a plan disagreeing with its own predicate is logged and
409'd), but the fence is what prevents a half-applied intent.

**Selling** is `UPDATE farm_printers SET sold_at = now, slot = slot +
1000000 × (1 + sold rows already parked from that slot) WHERE … sold_at IS
NULL AND state = 'idle' AND no live assignment`; the original slot is `slot %
1000000`. `loadFarmState` reads `sold_at IS NULL` only; `lowestFreeSlot` and
`max_printers` count live rows; the leaderboard's farm value filters
`fp.sold_at IS NULL`. A sold machine's `prints`/`failures` and its
assignments remain for the job's summary and the player's history. The sell
result carries `slot_freed`.

**Deferred payout.** `collect` always clears the bed and frees the printer.
When the job's every part is collected and `dailyCapAllows` says no, the job
keeps `ready` (or `late`), records `payout_deferred_day = <Baghdad day>` and
`delivered_at = now` (the hand-over moment), and the response carries
`payout_deferred: { job_id, reward_coins, day, late, reason:
'daily_jobs_cap' | 'daily_coins_cap' }` with `delivered: null`. The resolver
(step 3) pays deferred jobs on the first read of a later Baghdad day, oldest
hand-over first, under that day's caps — same `deliveryPlan` as collect, same
`fl_payout_<jobId>` id; lateness is judged on `delivered_at`, not the payout
day. A deferred job is not counted against `max_active_jobs`, cannot be
cancelled by the player (`JOB_NOT_ACTIVE`), and is skipped by the deadline
step (the customer already has the parts). `deliveryPlan` (sim.ts) is the one
shape both paths use: job flip guarded on the active states, ledger row,
`level_up` event, `farm_daily` increment, and the running profile values.

**Late → ready.** When the last part of a job already `late` finishes, the
resolver emits `job_ready` (payload `late: true`) and lists it in `readyJobs`;
the state keeps the `late` overlay (it stays deliverable with the penalty).

**Names.** A printer is stored with `<model name en> <slot+1>` ("A1 mini 1")
at bootstrap and purchase; `printerPublic` falls back to the same for an empty
nickname (legacy rows, or a player who cleared it).

**State contract additions.** `printers[*].resale_coins` (the exact credit
`sell` would write now); `printers[*].nickname` never empty; `jobs.*[*].
payout_deferred_day` (string | null); `limits: { max_active_jobs,
storage_grams, daily_jobs_cap, daily_coins_cap, jobs_today, coins_today }`
on `/state` and every mutation body; collect result `payout_deferred`; sell
result `slot_freed`. New codes: `STATE_CHANGED` (replaces `CONFLICT_RETRY`),
`IDEMPOTENCY_KEY_INVALID`, `FEATURE_LOCKED` (maintain and the three market
intents), `FINANCIAL_SCOPE_REQUIRED`, `LAST_PRINTER` (§7).

Proof: `tests/farmHardening.test.ts` (27, with a gated D1 adapter that
interleaves two requests around the resolver batch), the 0054 cases in
`tests/farmEngine.test.ts`, and `node scripts/migrate-check.mjs --twice`.


### 9b. Evidence — one real session (2026-09-07)

Command line, from the repo root, against the BUILT dist and the migrated
local D1 (`npm run build` · `npx wrangler d1 migrations apply levonis-db
--local` · `npx wrangler dev --local --port 8787` in the background):

```
PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers node scripts/e2e-farm.mjs
```

Final run (the fourth of the day): **272 passed, 0 failed, exit 0**; its
complete output is `docs/evidence/farm/e2e-farm-2026-09-07.log`. The earlier
runs of the same day: run 1 passed sections 1–4 and was interrupted during
the 150 s wait of section 5; run 2 passed sections 1–8 and aborted in section
9 because Playwright's own actionability gate refuses to `tap` an
`aria-disabled="true"` tab (the locked-tab design §6 asks for) — the script
now forces that tap and keeps the assertion; run 3 passed 260 of 263, the
three failures being the script picking the desktop sidebar's hidden
`[data-tab="printer_farm"]` instead of the phone drawer's visible one at 360,
390 and 768 — the locator now takes the visible hook. No product assertion was
changed or removed between runs; nothing on the server was changed by this
run.

What the run proved (each line is an assertion in the log): a fresh account
receives exactly the configured starter kit and a second read creates nothing;
the first job (3,000 game s ≈ 150 real s at `time_scale` 20 — inside the §5
2–4 minute target) is accepted, assigned, printed on the server clock,
collected and paid by exactly `reward_coins` with one `job_payout` row;
a replayed collect pays nothing extra and the same key on another intent is
`409 IDEMPOTENCY_KEY_REUSED`; a spool costs `price_per_gram × grams`; the
dearest printer is refused and the farm is unchanged; the three public boards
list the player with public fields only; every game page renders at 360, 390,
768 and 1024 wide with no horizontal overflow and no console error; the
locked STORE tab is tappable and explains itself; the printer sheet is a named
`aria-modal` dialog that takes focus; Arabic duration tokens keep their
order; a second job is printed (the admin console raised `time_scale` for the
duration and the run restored it — two `PUT /config/time`)
and collected FROM THE BROWSER: the page's notice says what the server did
(`paid`, 573 coins in the final run) and the balance rose by that amount.

Screenshots (`docs/evidence/farm/*.png`, real captures of the running app,
Arabic UI, dark, each under 400 KB; `{w}` ∈ 360, 390, 768, 1024):

| file | shows |
| --- | --- |
| `games-guest-{w}.png` | `/games` as a guest: the hub card without a player's summary |
| `games-{w}.png` | `/games` signed in: the farm summary carrying the player's username |
| `farm-{w}.png` | `/games/printer-farm`, FARM tab: inline-SVG isometric room, the A1 mini card, the six-tab bar |
| `farm-jobs-{w}.png` | JOBS tab: offers and the accepted (unassigned) second job |
| `farm-market-{w}.png` | MARKET tab: filament and the printer catalog at the config prices |
| `farm-inventory-{w}.png` | INVENTORY tab: the starter spool and the bought one |
| `farm-job-sheet-{w}.png` | the assign sheet for the second job, the owned printer listed |
| `leaderboards-{w}.png` | `/leaderboards` with the player's row |
| `profile-{w}.png` | `/games/profile`: level, stars, the server's stats |
| `redeem-{w}.png` | `/games/redeem`: "conversion is not open" from the server flag |
| `admin-farm-{w}.png` | the admin Printer Farm balancing tab: version chip and every config section (drawer-opened below 1024) |
| `farm-collect-paid-390.png` | after clicking Collect in the browser: the paid notice in the live region (+573 coins, reputation delta, a level reached) |
| `farm-printer-sheet-after-collect-390.png` | the printer sheet after the hand-over: idle, bed clear, the notice repeated beside the machine |

Not proved by this run (server-decided outcomes the session did not
produce): a FAILED print and a payout DEFERRED by the daily cap were not
observed live, so their notices are covered by `tests/farmClient.test.ts`
(wording in ar/en/ckb from a server-shaped body) and the deferral itself by
`tests/farmHardening.test.ts`, not by a screenshot; the script's section 10
handles all three outcomes and would shoot `farm-collect-failed-390.png` /
`farm-collect-deferred-390.png` when the server produces them. Deviations
from the contract found by the run: none — every field the assertions read
(`collected`, `delivered`, `payout_deferred`, `replayed`, `limits`,
`unlock_levels`, the leaderboard rows) matched §4/§9a as written.
