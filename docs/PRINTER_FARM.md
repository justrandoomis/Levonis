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
`POST /printers/:id/collect` — the finished batch (`done` or `failed`) is collected: printer → `idle`, next queued assignment starts; if every assignment of the job is collected and the delivered qty equals the job qty the job is delivered and paid in the same batch (ledger `job_payout`, reputation +gain, or late: reputation −late_penalty after `deadline_at`); a failed batch's qty stays undelivered until the player re-assigns it (`POST /jobs/:id/assign` again for the missing qty).
`POST /jobs/:id/cancel` — player cancels an accepted job: reserved grams refunded for not-started batches, reputation −cancel_penalty_bp, coins −cancel_penalty_coins (Phase 1 default 0).

### Printer intents

`POST /printers/:id/maintain` — allowed when `idle`/`done`; debits `maintenance_cost`, sets `state='maintenance'`, `state_until = now + minutes/time_scale`; on resolve health → 100.
`POST /printers/:id/repair` — when `broken`; debits `repair_cost`; same mechanics; health restored to `repair_health`.
`POST /printers/:id/rename { nickname }`.

### Market intents

`POST /market/filament { material, color, grams }` — grams from the config's spool sizes; debits `price_per_gram × grams`; storage capacity checked against the location.
`POST /market/printers { model_key }` — debits the catalog price; requires a free slot (`location.max_printers`) and the model's `min_level`; the new printer lands in the lowest free slot.
`POST /market/printers/:id/sell` — credits `resale_factor × price` (idle printers only).

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
key and re-renders from the returned state. Design language: dark, industrial,
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

## 8. Phases

1. Architecture + first playable loop (this document).
2. Own store products, market demand, printer/material depth.
3. Maintenance depth, spare parts, employees, electricity.
4. Locations, contracts, events, loans, recovery mode.
5. Leaderboards, achievements, challenges, limited Levonis Points.
6. Prestige, R&D, advanced automation.
