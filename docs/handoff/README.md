# Handoff — 2026-10-21

The previous agent session stopped here at the owner's request, so that another
agent can continue. Read `CLAUDE.md` first (the push = live deploy rule), then
this file. Everything below is public-safe: no keys, no private data, no AI model
identifiers.

## 1. Live state

- **Live head:** `53c0401d` (P1-05). Workflow 7 run 39644096376 is green (21/21).
- **Database:** live schema `0208_request_sources_parts.sql`, 201 migrations.
- **Landed today, in order:**

| Commit | What | Workflow 7 |
|---|---|---|
| `529d49be` | Smart search 1.6/1.7 (`nl=1`, the precision rule, colour phrases such as «Multi-Color»), plus the trade-in money guard pinning its clock | run 39526606397 |
| `0c5ad613` | Assistant AI layer **B0**: Workers AI binding `AI` on `env.staging` only; workflow 7 reports `ANTHROPIC_API_KEY` by type | run 39537773129 |
| `53c0401d` | **P1-05** readers and offers v3 (per-part estimate with coverage, per-part eligibility, offer coverage and substitutions) | run 39644096376 |

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

### 3.1 Support assistant v2, push A (no AI) — branch `wip/assist-v2`

- **What it is:** the owner complained that the support bot is dumb and that photos, video and voice notes cannot be attached. Push A changes the support assistant in `worker/lib/assist/**`, `worker/routes/support.ts`, `src/pages/Support.tsx` and `src/components/support/AssistAttach.tsx`:
  - it reads Iraqi Arabic, English and Sorani, including spoken printer names («اي ون», «بي ون اس», «ئەی وەن»);
  - it asks the real search engine (prices equal the storefront grid);
  - it runs a printer-problem triage (printer → symptom → steps → «تحدث مع الفريق» with a prefilled draft);
  - it attaches photos, clips and voice notes to the ticket.
- **Migration:** `0209_support_ticket_assist.sql`, with `worker/lib/schemaVersion.ts` at `0209` / `202`. This is correct on top of live 0208/201.
- **Commits:**
  - The branch is based on `529d49be`. Rebase it onto the live head first; conflicts are expected to be small.
  - **Last verified commit:** `0ca63248` (review round 5.3).
  - **Tip `6ce6a051`:** WIP, with test edits only for the final round. No code backs them yet, so some tests fail. Implement the items below to make them pass, or drop the commit.
- **Test file naming:**
  - `tests/assistReader.test.ts` is push A's reader test.
  - `tests/assistUnderstand.test.ts` belongs to the live smart-search lane.
- **The six final items** (all in `worker/lib/assist/understand/*` and `orchestrator.ts`; each needs a test in ar, en and ckb):
  1. **Ownership guard.**
     - In `printerOnly`, a sentence with a first-person have/own/bought word («عندي», «طابعتي», «اشتريت … من عندكم», "I have", "I own", "my printer", «…م هەیە», «پرینتەرەکەم») is not "a printer name only". It falls through to the legacy answer, exactly as live does (the clarify menu).
     - Keep printer-first for want/need («اريد», "I want", «دەمەوێ», «پێویستە»), for not-having, for «عندكم اي ون؟» / "do you have the A1", and for any price or stock ask.
     - A wrong hit must only ever produce the live answer.
     - Do not reintroduce an ownership triage: rounds 4.2–5.2 tried it, and it never converged.
  2. **Glued negation.** Split «ماعندي» / «معندي» into «ما عندي» before reading. Today «ماعندي طابعة» fuzzy-matches a Matte filament.
  3. **«still» / «هێشتا».** Read it as "not fixed" when a fault, problem or sameness word follows it. Do not, when a not-tried or waiting phrase is present.
  4. **«بعد ما» / «بعدما».** Before a verb it means "after", never a negation. Remove «بعدني ما» from `OUTCOME_NOT_TRIED`.
  5. **The tried claim.** A try/do verb counts only when its object means the steps (them, it, all, the steps, «ـها/ـهم», «الخطوات», «هەمووم») or the clause ends. Never with a gerund or another noun ("tried printing again"), and never with a third-person subject ("it did that again"). Otherwise the draft lists the steps as shown, not as tried.
  6. Tests for each item.
- **Landing gate** (what blocks landing):
  - a turn worse than live `0c5ad613`;
  - a ticket draft or staff summary stating something the customer did not give;
  - a broken owner case;
  - a price different from the storefront grid;
  - data from another customer.

  Everything else is follow-up.
- **The five owner cases to verify live after landing**, in ar, en and ckb, as guest and member:
  1. «نوزل مال اي ون اريده 0.2»: the exact A1/A2 0.2 hotend first. The Multi-Size kit after it is accepted (lead decision: the kit carries a 0.2 nozzle).
  2. «بحث عن منتج صيانه خلل بالنوزل»: maintenance products for a nozzle.
  3. «صارت عندي مشكله بالطابعه»: the triage, own printer first, symptoms, steps, then a handoff draft that states only what was given.
  4. «كلوب»: which printer, then the clog steps, the parts and the wiki link.
  5. The + button attaches a photo, video and voice note to the ticket. Staff see them only after the ticket includes them.

### 3.2 Assistant AI layer B1 — not started; plan in `assist-ai-layer-B1-plan.md`

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
