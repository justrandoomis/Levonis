# Handoff — 2026-10-21

The previous agent session stopped here at the owner's request, so that another
agent can continue. Read `CLAUDE.md` first (the push = live deploy rule), then
this file. Everything below is public-safe: no keys, no private data, no AI model
identifiers.

## 1. Live state

- **Live head:** `3f117db3` (support assistant v2, push A), landed 2026-10-22. Workflow 7 run 39772742711 is green.
- **Database:** live schema `0209_support_ticket_assist.sql`, 202 migrations.
- **Landed today, in order:**

| Commit | What | Workflow 7 |
|---|---|---|
| `529d49be` | Smart search 1.6/1.7 (`nl=1`, the precision rule, colour phrases such as «Multi-Color»), plus the trade-in money guard pinning its clock | run 39526606397 |
| `0c5ad613` | Assistant AI layer **B0**: Workers AI binding `AI` on `env.staging` only; workflow 7 reports `ANTHROPIC_API_KEY` by type | run 39537773129 |
| `53c0401d` | **P1-05** readers and offers v3 (per-part estimate with coverage, per-part eligibility, offer coverage and substitutions) | run 39644096376 |
| `3f117db3` | **Assistant v2, push A** (no AI): the reader for Iraqi Arabic, English and Sorani, the real search engine, the printer-problem triage with a ticket draft, attachments on the ticket; migration 0209. Final rounds 5.4–5.7 (see §3.1) | run 39772742711 (2026-10-22) |

- **B0 outcome:**
  - The deploy token accepted the AI binding.
  - The deploy log reads `ANTHROPIC_API_KEY: secret_text (correct)`, so the owner's key is in place on the Worker.
- **Live checks done:**
  - Smart search `nl=1` in ar, en and ckb (price + colour, «PLA Silk Multi-Color», AMS exclusion, a bare number applying nothing).
  - Public request routes answer `503 COMMUNITY_CLOSED`. The community gate is closed by the owner (Q1), so this is expected.

## 2. How work was landed (keep doing this)

1. Work in a git worktree, one branch per lane. Link `node_modules`:
   - symlink each entry of the main checkout's `node_modules`;
   - point `node_modules/@levonis/*` at the worktree's own `packages/*`;
   - point `studio/node_modules` at the main checkout's.
2. Run locally: `npm run check` plus the affected test files (`node --import tsx --test <files>`).
   - The full `npm run test:unit` takes more than 2 hours on this 4-core machine when other lanes run, so let CI run it.
3. Push the lane to `ci/<lane>`. `ci-push.yml` runs the full gate (19 jobs) on any branch except the default one.
4. When it is green and the default branch has not moved, fast-forward: `git push origin <sha>:claude/new-session-2hq4ci`.
5. Follow workflow 7 (`deploy-staging-code.yml`, 21 jobs) to green, then probe the live site.
   - Waiting was done by polling `GET /repos/justrandoomis/Levonis/actions/workflows/<file>/runs?head_sha=<sha>&branch=<branch>`.
   - Then poll `/actions/runs/<id>` and `/actions/runs/<id>/jobs` until every job has concluded.

## 3. Lanes in flight

### 3.1 Support assistant v2, push A — LANDED (`3f117db3`, 2026-10-22)

- The six final items are in (round 5.4, `aa9730f2`): the ownership guard, glued «ماعندي», still/«هێشتا», «بعد ما» as "after", the tried claim needs the steps as its object, and the tests.
- Rounds 5.5–5.7 (`f8c2ce82`, `02973253`, `3f117db3`) fixed the landing-gate findings of three verification rounds:
  - a turn worse than live;
  - a ticket draft stating something the customer did not give.

  Each round was checked by a live-vs-branch parity harness and a ticket-truth adversary.
- **Results:**
  - Last round: no regressions, and 0 false facts in 79 drafts on 120 realistic conversations.
  - 0 price mismatches against the storefront grid.
  - 0 data from another customer.
  - All 368 assistant and support tests pass, and CI was green on every tip.
- **Live check, guest, ar/en/ckb:**
  - case 1: the A1/A2 hotend first, then the Multi-Size kit;
  - case 2: nozzle maintenance products;
  - case 3: printer, then symptoms;
  - case 4: printer, then the clog steps and parts, then a draft that says "tried" only after "tried them".
- **Not checked live:**
  - the member path (own printer first);
  - case 5 (attachments).

  Both need a signed-in account; tests cover them.
- **Follow-ups, not blockers:**
  - Some real "tried all the steps" phrasings are drafted as "shown". This is the safe direction.
  - A price asked together with delivery loses its cards.
  - «خلصت الفلامنت مالتي» and «فیلامێنتم تەواو بوو» show loosely related products.
  - "I tried another filament, still clogged" shows the steps again.

### 3.2 Assistant AI layer B1 — in progress (branch `b1/server` in the local worktree `/home/user/levonis-b1s`, client lane `b1/client`); plan in `assist-ai-layer-B1-plan.md`

- Start after push A lands. It builds on push A's adapter seam `worker/lib/assist/ai/adapter.ts`.
- **Shape:**
  - It ships dark (`enabled=0`).
  - Migration `0210_assist_ai_layer.sql`, with schemaVersion `0210` / `203`.
  - Model ids live only in D1 rows the owner picks in admin from the provider's live model list. No model name may appear anywhere in the repository.
  - The model only classifies and chooses tools. Every reply is a template from real data, in ar/en/ckb.
  - Photos and clips are read by vision (clips through frames extracted in the browser).
  - Voice is transcribed on Workers AI, Arabic and English only; Sorani speech is never sent.
  - There is a ledger and a daily cap (default $1, UTC days).
  - Basic mode applies on any failure.
- **Owner questions before turning it on** (plan §20):
  1. May customer photos go to the vision provider during triage? DECISIONS row 262(d) kept Smart Diagnose free of paid AI.
  2. Is server-side voice transcription accepted, with consent, as an editable draft in the customer's own composer?
  3. The consent and privacy wording.
  4. Is the account on Workers Paid?

### 3.3 P1-06 request UI v3 and entry points — branch `wip/req-v3-ui`

- **Base:** live `53c0401d`. No migration. DECISIONS row **268** is reserved for it.
- **Commits:**
  - Part 1 (`9d45dcb3`): the editor at `/requests/new[/:id]` and `/requests/:id/edit`.
  - Tip `798907f4`: WIP for part 2.
    - 2a done: server readers of the private budget (Q2), direct draft guard.
    - 2b done: server entries (project copy by sha256, product page, store page, copy from project, direct send).
    - 2c partial: client delivery and budget fields, the «ما يراه الآخرون» audience panel, review, entries, aliases, retiring the old wizard, storefront doors.
    - 2d not started: tests, the Playwright e2e `scripts/e2e-request.mjs` at 360×740 / 740×360 / keyboard open, docs, bundle check.
  - Nothing in part 2 has been reviewed or checked.
- **Read first:**
  - `p1-06-design.md`
  - `p1-06-design-critiques.md` (apply every point)
  - `p1-06-build-part1-report.md`
- **Done when:** the Scenario D request is created, saved, resumed and published. Scenario D is an STL + images + a link + a description + two parts in different materials. Plan: `docs/LEVO_PLAN_PHASE1_2.md`, section P1-06.

## 4. Next in the plan (not started)

- **P1-07:** merchant saved views and filters.
- **P1-08:** merchant Simple/Advanced mode.
- **P1-11:** Studio → request «اطلب تصنيعه».
- **P1-12:** private files, honest previews and an audit log.
- **P1-13:** cross-tenant and regression suites.
- **Then:** Phase 2 (P2-01…P2-10). See `docs/LEVO_PLAN_PHASE1_2.md`.
- **Assistant push C, Smart Diagnose:** the HMS code reader and ingestion, the flow engine, the content.
- **Search follow-up:** for «طابعة» / "printer", rank the printers category above printer accessories (cable packs and maintenance kits rank first today).
- **P1-05 lows:**
  - an open-material row has no word in the parts line;
  - the request page shows a raw id for a material outside the seed list.

## 5. Owner decisions pending

1. Approve the existing merchants in the admin panel.
2. Downloads when a store is suspended (conflict with DECISIONS row 137).
3. The print-price ruling (DECISIONS row 220): the public price reveals private inputs. Tests for it are kept as TODO.
4. The AI layer questions in §3.2.
5. Catalogue links, which are data and not code:
   - «Bambu Hotend - X1C» → X1C and X1E;
   - «Bambu Hotend - P1 Series» → P1S and P1P.
6. Optional: render the imported `content_blocks` on the product page.

## 6. Gotchas learned the hard way

- **Test guards that bite new code:**
  - `schemaVersion`: `EXPECTED_MIGRATION` and `EXPECTED_MIGRATION_COUNT` change with every migration.
  - SQL splitter: write `END )` with a space.
  - `claySystem`: no apostrophes in English comments under `src/`.
  - `sqlLikeBytes`: no `` `%${ `` or `'%' +`.
  - `listingPredicateGuard`: predicate counts per file, plus `NOT_CUSTOMER_CALLERS`.
  - `bundleBudget`: storefront cap 242,688 bytes, and the fixed weight within 3 KB of `STOREFRONT_FIXED_KB`.
  - `bundlePrivateNames`.
  - `refusalStrings`: every code in three languages.
- **Clock:** the full suite passes with the clock 45 days ahead, apart from harness artefacts: the in-memory SQLite and child processes keep the real clock. The one real time bomb was the trade-in money guard, fixed in `529d49be`. A test whose figures depend on "now" must pin its clock with `t.mock.timers`.
- **Long findings lists:** pass review findings to a fixer as a file or in full. A truncated list once left ten findings unfixed.
- **Conversational code** (the assistant) does not converge under open-ended review. Gate each round on "worse than live" and "a false fact in a ticket", and keep fixes minimal.
- **Disk:** the session allowance is small. Delete stale `/tmp/fx-matrix-*` and `/tmp/levonis-role-matrix-*` folders left by killed test runs.
- **Leftover branches:**
  - `ci/timebomb` is a throwaway branch (clock shifted 45 days, never merged). Deleting it from the previous session did not go through; it is safe to delete.
  - The other `ci/*` branches are finished lanes.

## 7. للمالك — ملخص بالعربية

- **على الموقع الآن:** البحث الذكي 1.6/1.7، وتجهيز طبقة الذكاء الاصطناعي (B0، والمفتاح محفوظ كسرّ)، وP1-05 (العروض على الطلبات متعددة القطع).
- **قيد العمل، ومحفوظ على فروع:**
  - المساعد الآلي v2: الفرع `wip/assist-v2`. آخر نسخة مُتحقَّق منها هي `0ca63248`، وبقيت ستة إصلاحات محددة قبل النشر.
  - واجهة الطلب الجديدة P1-06: الفرع `wip/req-v3-ui`.
- **التالي:**
  - طبقة الذكاء الاصطناعي B1: تحليل الصور والفيديو والصوت. خطتها كاملة في هذا المجلد.
  - بقية المرحلة الأولى، ثم المرحلة الثانية.
- **قرارات تنتظرك:** القائمة في القسم 5 أعلاه.
