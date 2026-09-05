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
| `farm_profiles` | one row per player: level, xp, reputation (0–5000 basis points → ★ 0.00–5.00), location, state (`active` / `recovery`), `coins` (cached ledger balance, always written in the same batch as the ledger row), `last_seen_at`, `config_version`, `stats_json`, `tutorial_json` |
| `farm_ledger` | append-only coin ledger: `kind`, `amount` (signed), `balance_after`, `ref_type`/`ref_id`, `idempotency_key` (UNIQUE per user), `note` |
| `farm_printers` | owned machines: `model_key` (catalog), `slot` (position in the room), `nickname`, `health` (0–100), `state` (`idle` / `printing` / `done` / `maintenance` / `broken`), `state_until` (server time when maintenance/repair finishes), `hours` (operating hours ×100), `prints`, `failures`, `upgrades_json` |
| `farm_spools` | filament inventory: `material`, `color`, `grams_left`, `grams_total`, `quality`, `cost_paid` |
| `farm_jobs` | customer jobs: `state` (`offered` / `accepted` / `printing` / `ready` / `delivered` / `late` / `cancelled` / `rejected` / `expired`), customer tier, product, qty, material, colours, grams, print seconds (reference machine, standard quality), quality, reward, reputation ±, penalties, `offered_at`, `offer_expires_at`, `deadline_at`, `accepted_at`, `delivered_at`, `seed` |
| `farm_assignments` | one per printer per job batch: `qty`, `spool_id`, `grams`, `seconds`, `position` in the printer's queue, `state` (`queued` / `printing` / `done` / `failed` / `collected`), `started_at`, `ends_at`, `failure_kind`, `outcome_seed` |
| `farm_events` | things that happened while away or on resolve: failures, deliveries, cancellations, maintenance done; `seen_at` drives the "While you were away" sheet |
| `farm_daily` | per player per UTC day counters for limits (coins earned, jobs delivered, later points converted) |
| `farm_achievements` | `key`, `unlocked_at`, `reward_json`, `claimed_at` (Phase 5 fills it; the table exists so Phase 1 stats are recorded) |

Indexes: `(user_id, state)` on jobs and printers, `(user_id, created_at)` on
ledger and events, `(printer_id, position)` on assignments, UNIQUE
`(user_id, idempotency_key)` on the ledger.

Balance rule: `farm_profiles.coins` must equal the sum of the player's ledger
and is only ever written together with a ledger row. A CHECK keeps it ≥ 0
(loans in Phase 4 add a separate `debt` column rather than a negative balance).

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

## 4. API (`worker/routes/farm.ts`, mounted at `/api/farm`, `requireAuth`)

| route | effect |
| --- | --- |
| `GET /state` | bootstrap: create the profile with the starter kit on first call; `resolve()` to now; return profile, printers with queues, spools, offered + active jobs, unseen events, unlocks, public config (ETag-able) |
| `POST /jobs/:id/accept` · `/reject` | offer → accepted / rejected (offer must not be expired) |
| `POST /jobs/:id/assign` `{ allocations: [{ printerId, qty, spoolId }], quality? }` | validates compatibility (material, colours, volume), grams (reserved from the spool at assignment), capacity; creates queued assignments; starts the first one on an idle printer |
| `POST /printers/:id/queue` `{ order: [assignmentId] }` | reorder queued work |
| `POST /printers/:id/collect` | take finished parts off the plate (printer → idle, next queued batch starts); when every batch of a job is collected the job is delivered and paid (late penalty applied after the deadline; cancelled after deadline + grace) |
| `POST /printers/:id/maintain` · `/repair` | costs coins, takes time (`state_until`), restores health / clears `broken` |
| `POST /market/filament` `{ material, color, grams }` · `POST /market/printers` `{ modelKey }` | buy; capacity and money checked server-side |
| `GET /ledger?before=` · `GET /events` · `POST /events/seen` | history and the away summary |
| `GET /api/farm/admin/config` · `PUT /api/farm/admin/config` | admin (main host): read/replace the balancing config with validation and audit |
| `GET /api/farm/admin/players/:userId` · `POST /api/farm/admin/players/:userId/grant` | admin support tools (audited) |

Every mutating route accepts an `idempotencyKey`; the ledger's UNIQUE key and
job/assignment state machines make replays harmless. Mutations are rate-limited
per user. All money and inventory changes are one D1 batch.

## 5. Configuration (`admin_settings.printerFarmConfig`)

One JSON document with `version` and these sections, each with defaults:
`economy` (starter coins, filament price per gram per material, printer
prices, resale factor, electricity per printer-hour, maintenance cost and
minutes, repair cost and minutes), `printers` (catalog keyed by model),
`materials`, `products` (job templates: grams per part, seconds per part,
complexity, colours), `customers` (tiers: min reputation, qty range, deadline
range, reward margin), `jobs` (offers per refresh, refresh minutes, offer
lifetime, late grace minutes), `failure` (base rate, weights, kinds and their
costs), `progression` (xp per job, level thresholds, reputation deltas),
`locations` (max printers, storage grams, employees), `limits` (daily job
cap, daily coin cap, later points conversion caps). The admin panel edits it
section by section; the client receives `publicFarmConfig`.

## 6. Client (`src/pages/farm/`, lazy-loaded at `/games/printer-farm`)

Mobile-first shell with a bottom tab bar: **FARM · JOBS · MARKET · INVENTORY**
at level 1; STORE, UPGRADES and the rest appear as the server unlocks them.
The farm view is an inline-SVG isometric room: floor tiles by location,
printer sprites per slot (state light, animated bed while printing, wear tint
by health), filament shelf coloured by spools, a work table. Buying a printer
puts it in the next free slot. Everything is rendered from server state;
countdowns animate locally between fetches and re-sync on every response.
Design language: dark, industrial, warm gold accent, the house springs and
materials; no giant type, no neon, no dashboard grid.

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
