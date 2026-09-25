# Levo Merchant Platform — the plan, the rules, and why

> The owner, 2026-09-24: «أريد Levonis أن يصبح بالنسبة للتاجر ليس مجرد حساب يبيع منه
> داخل موقع، بل منصة أعمال كاملة … وفي الوقت نفسه الزبون يجب أن يشعر أن كل متجر داخل
> Levo هو متجر حقيقي مستقل بهوية صاحبه، وليس مجرد Profile فيه منتجات.»

This document is the source of truth for the re-development of **Levo Community +
Merchant Stores + Merchant Workspace**. It records what we decided, why, what is
fixed, and the order the work is done in. Read it before changing anything in
this area. The detailed baseline — every table, endpoint and verified defect with
`file:line` evidence — is in [`docs/merchant-platform/audit/`](merchant-platform/audit/).

---

## 1. What we are building

Levonis is a 3D-printing shop (printers, filament, resin, accessories, services).
Levo Community is the larger layer on top of it:

- a community for makers;
- a marketplace of independent merchant **stores**, each with its own identity,
  subdomain (`username.levonis-iq.com`) and installable app (PWA);
- a custom print-request board with offers, matching to real workshop capability,
  escrow-protected jobs, messages, reviews and reputation;
- a **Merchant Workspace** that is a complete business tool — as capable as
  Shopify/WooCommerce for this market, simpler for a beginner, deep for a pro, and
  with Levonis's own identity (not a visual copy of anyone).

## 2. Decisions that cannot be broken

These come from the owner. Engineering may choose *how*; it may not change *what*.

1. **One Cart = One Seller.** A cart holds one merchant's goods, or Levonis's —
   never two merchants, never a merchant with Levonis. Enforced **on the server**
   (and, from wave 2, by a database trigger). The client dialog is UX, not security.
   Offer: «العودة إلى السلة الحالية» / «إفراغ السلة والتحول للبائع الجديد».
2. **No mixing of Levonis official and a merchant cart** — separate checkout paths.
3. **The merchant sets the delivery of their store** — Levonis never prices it.
4. **Delivery price is computed on the server** from the customer's saved address
   → governorate → the merchant's delivery configuration, at quote **and again** at
   place-order. The client never sends a fee that is believed.
5. **A public print request is browsable inside the community** by eligible merchants.
6. **Merchant request preferences default to ALL** that the workshop can do.
7. **Preferences narrow; they never widen real capability** (printer technology,
   build volume, materials, stock).
8. **Pricing, stock, commission, payments and permissions are decided by the server.**
9. **A custom print request is not a cart product** — different domain model,
   different path. They may share a unified order-history *view* later.
10. **Verification is independent of PRO.** Never gate one on the other.
11. **Every merchant has an independent store** — identity, subdomain, PWA.
12. **The Store Builder never allows arbitrary code** — no HTML, JS, event handlers,
    iframes of arbitrary origin, or free CSS. Allow-listed schema only.
13. **No fake features.** Every button works end to end, or it is not shown (or it
    is shown as an explicit, intentional «قريبًا»).

### Owner answers recorded on 2026-09-24

| Question | Answer |
|---|---|
| When does a store order's money become available to the merchant? | When the **customer confirms receipt**, or **automatically 3 days after delivery** if no dispute was opened. A merchant's «تم التسليم» alone never releases money. |
| What does a customer see on an admin-suspended store? | **Only a «المتجر غير متاح حاليًا» page.** Products, banner and bio are not served. |
| Can a PREMIUM (`prime`) member open a store? | **Yes** — PREMIUM and PRO include the PLUS store entitlement (as the code already does). |
| Platform commission on merchant store sales? | **5%**, editable by the admin, and recorded as **its own ledger line** for every sale. |
| Custom domains for stores | Not in scope now (subdomains only); DECISIONS row 12 stands. |

Earlier decisions that still apply: Levo Community is behind the maintenance gate
(allow-listed testers only) and the `/requests` board closes with it; the referrer
keeps their manual reward; Sorani is **never machine-written** (§8).

## 3. Where we start (baseline, audited 2026-09-24)

Five read-only audits mapped the area and reproduced defects against the real
routes and migrations. Full reports:

| Report | Area |
|---|---|
| [01-workspace-storefront](merchant-platform/audit/01-workspace-storefront.md) | `/merchant`, onboarding, storefront, subdomains, per-host manifest |
| [02-commerce-money](merchant-platform/audit/02-commerce-money.md) | cart isolation, store checkout, orders, coupons, delivery, commission, payouts |
| [03-requests-escrow-matching](merchant-platform/audit/03-requests-escrow-matching.md) | requests, offers, escrow, files, 3D viewer, matching, printers, costing |
| [04-social-admin](merchant-platform/audit/04-social-admin.md) | chats, reviews, reputation, verification, notifications, analytics, admin |
| [05-design-system-platform](merchant-platform/audit/05-design-system-platform.md) | design system, shell/routing, performance budget, i18n |

**Strong — keep, extend, do not rewrite:** server-side ownership on every
`/api/merchant/*` route (no IDOR found); host classification with 138 reserved
subdomains; seller-isolated cart doors; server pricing; the single atomic
order + wallet-debit batch; per-order commission snapshots; the escrow ledger;
chat participant checks; server-sniffed attachments; one-review-per-transaction
constraints; append-only reputation events; the per-host manifest's safe fallback;
the matching engine that records every decision; the print quote engine; the
community gate; the shared design-system tokens, `Overlay`, `Sheet` and motion system.

**Broken — fixed first (wave 1), highlights:**
- the store checkout is unreachable for a merchant-only cart (`GET /api/cart` scope);
- a merchant cancelling a **paid** store order does **not refund** the buyer;
- a merchant payout never lowers "available", so the same balance can be paid again;
- stock and coupon caps are no-ops under concurrency; a two-seller cart can settle
  to the first seller;
- the merchant self-certifies delivery and money becomes available at once;
- checkout ignores a lapsed/restricted merchant; quote and order are not bound;
- the delivery fee is charged to the customer and credited to nobody;
- request accept can wedge a request; offer price can change after the customer
  saw it; drafts are live before publish; costing marks dashboard printers too small;
- assistant-scope admins can move community money; sanctions overwrite each other;
  merchants can review themselves; store-order messages reach nobody.

**Missing — the gaps the waves close:** a real workspace (today 15 tabs in one
column, no URLs), a store builder (today one fixed layout with 7 accent presets),
per-governorate delivery, variants, an append-only merchant ledger with payout
requests, merchant notifications (only one event exists), real analytics (the
daily table is never written), a store inbox, merchant icon renditions for the
PWA, and an onboarding journey.

## 4. Architecture decisions

### 4.1 Tenancy
`community_merchants` 1—1 `merchant_stores` (both UNIQUE). **Money, identity and
reputation key on `merchant_id`; presentation and catalogue key on `store_id`.**
New tables carry both where a query needs both. Every `/api/merchant/*` handler
resolves the store from the session and scopes every statement in SQL — a route
never trusts an id from the client for ownership.

### 4.2 Delivery (merchant-owned, server-computed)
- `merchant_delivery_profiles` (one per store: default mode/fee, free-over
  threshold and its basis, pickup, preparation days, note, **version**) and
  `merchant_delivery_rules` (store × governorate id from the closed list:
  `fee | free | disabled`, fee, optional threshold/prep/note).
- One pure resolver in `packages/shipping` (precedence: disabled → pickup → free
  governorate → override → default, then the free-over threshold).
- Quote takes `addressId`; a legacy address without a governorate is refused with a
  stable code, never priced at the default. The quote returns a **fingerprint**;
  place-order recomputes from the saved address and refuses `QUOTE_CHANGED` with
  the fresh quote when anything moved. The applied rule is snapshotted on the order.
- The fee is credited to the merchant as its own ledger line.

### 4.3 Money: an append-only merchant ledger
- New `merchant_ledger_entries` (the old `merchant_payout_ledger` mutates `state`
  in place and cannot express payouts). **Append-only**: a bucket move is two new
  rows, never an UPDATE. Buckets: `pending → available → reserved → paid`.
- Every figure on the finance page is a SUM over it: gross, commission (5%, own
  line), delivery credit, refunds, receivable, pending, available, reserved, paid,
  plus escrow-held from `community_escrows`.
- Sale credits enter `pending`; they move to `available` on **customer
  confirmation or 3 days after delivery** with no open dispute (owner decision);
  a dispute freezes them.
- Payouts are **requests** (`merchant_payouts`: requested → approved → paid |
  failed | cancelled) that reserve funds with a conditional insert — never more
  than available. Admin decisions require the financial admin scope.

### 4.4 Store presentation: themes + blocks + revisions
- A **theme** is a preset *name* from a code registry (Minimal, Modern, Premium Dark,
  Workshop, Portfolio, Product Focused …) mapped to CSS variables under
  `[data-store-theme]`. Merchant choices are enums/presets only — no merchant string
  ever reaches CSS or HTML.
- A **layout** is versioned JSON: `{schema_version, theme, tokens, header, footer,
  blocks: [{id, type, variant, settings, visibility, sort}]}`. Block types and every
  setting are allow-listed and validated by one shared module used by both the
  worker (authoritative, on write **and** read) and the builder. Text is
  `LocalizedText`; media are the merchant's own platform keys; links pass `safeLink`.
- **Draft / preview / publish / history:** revisions are rows; the store points at
  its published revision; publish is an atomic pointer swap; restore republishes an
  old revision. The public storefront reads **only** the published revision.
- **One renderer, two consumers:** storefront blocks are imported by the storefront
  and by the builder preview; blocks never import builder code. The preview renders
  in-page with container queries (the CSP forbids iframes: `frame-ancestors 'none'`).
- The first published layout of every existing store is generated from its current
  settings, so the switch-over is visually lossless.
- **The builder** (wave 4, W4-A; DECISIONS row 129) edits that layout block by block
  at `/merchant/store/design`: forms generated from the block registry, every change
  run through the same `normalizeLayout` (issues shown next to the field), an
  autosaved version-fenced draft, publish with a changes summary, and seven starter
  pages. It saves only the gate's output and nothing while a fatal issue stands.

### 4.5 Store identity: subdomain + PWA
- Keep `hosts.ts` classification, reserved lists, normalisation and slug parking;
  add redirects from parked slugs, and reserve API words (`resolve`, `by-id`, `p`).
- On logo upload the worker produces **192/512 PNG, 512 maskable and 180 Apple
  touch** renditions through the existing image binding; the per-host manifest uses
  them. Levonis icons appear on a merchant host only as a true fallback. We do not
  claim offline support we do not have.
- Share: copy link, native share, QR, preview.

### 4.6 Merchant Workspace
- URL-driven routes, one nav config feeding sidebar, drawer, bottom tabs, "More"
  and the command palette: `/merchant` (Command Center), `/orders`, `/products`,
  `/customers`, `/inbox`, `/marketing/coupons`, `/collections`, `/services`,
  `/showcase`, `/printers`, `/costing`, `/requests`, `/money`, `/analytics`,
  `/reviews`, `/notifications`, `/store/design`, `/store/settings`, `/store/delivery`.
  The same tree is served under `/admin/*` on the merchant's subdomain.
- Out of the customer shell (full-screen tree), each section `React.lazy` with its
  own skeleton; nothing of it reaches the customer's first load.
- Desktop: collapsible sidebar + top bar (store status, global search/⌘K, quick
  create, view store, design store, notifications). Tablet: icon rail. Phone:
  compact top bar, bottom tabs (Overview · Orders · Products · Store · More), cards
  instead of tables, sheets for filters/actions/settings, ≥44px targets, no
  horizontal overflow.
- The Command Center answers «what needs my attention now» from real counts
  (orders needing action, unread messages, matching requests, low stock, new
  reviews, money that became available, coupons ending).

### 4.7 Requests, matching, offers
- Draft → published split with revisions; nothing is visible or biddable before
  publish; editing a published job revises it and marks existing offers stale.
- Eligibility to **bid** and to **be notified** = request requirements ∩ printer
  capability (technology, build volume, materials, colours, features) ∩ material
  stock ∩ preferences (default ALL, narrowing only) ∩ location/delivery. Manual
  browsing of the public board stays open to any eligible merchant.
- Offers carry price, completion time, delivery method, materials, inclusions,
  message and warranty terms; the customer accepts exactly the version they saw;
  only one acceptance can ever win (server guard).
- After acceptance, the engaged merchant gets the contact, delivery details and a
  request chat; model files follow the access policy (tokenized, expiring viewer
  links; revoked when the request closes).

### 4.8 Conversations, notifications, analytics
- Conversations get a store-owned context and participant roles; the inbox pages
  by cursor and searches server-side; a merchant can only read threads they
  participate in.
- Merchant notifications have kinds, preferences that are actually read, and a
  **deep link to a real workspace route** for every notification.
- Analytics come from first-party events (store/product views deduped per visitor
  per day, add-to-cart, checkout started, orders) rolled into the daily table. Any
  figure without a real source is not shown.

### 4.9 Security invariants (tested)
Authentication; merchant, customer and order ownership in SQL; store scoping;
server-side prices, delivery, coupons, commission and wallet operations; rate
limits; idempotency; atomic order and money batches; conditional stock and coupon
fences that **abort** the batch; one-acceptance guards; private files with
authorised, tokenized, expiring access; MIME sniffing and size limits; safe file
names; audit log; XSS-safe rendering; builder schema allow-listing; admin money
actions behind the financial scope.

### 4.10 Performance
The storefront must stay very fast. Builder, workspace and analytics code must
never enter the customer's first load (lazy-only list and chunk budgets enforced
by `tests/bundleBudget.test.ts`). Workspace CSS lives in lazily imported files.
Server lists paginate by cursor; no N+1; batched reads.

## 5. Execution waves

Each wave ends with the full gate (`npm run check`, the whole test suite, build),
a push to the working branch, and — when the owner wants — a deploy.

| Wave | Scope | Status |
|---|---|---|
| 0 | Audit and this plan | done 2026-09-24 |
| 1 | **Correctness and money fixes** in the existing system (all verified defects in the five reports: store orders, payouts, guards, isolation, eligibility, completion rule, requests/escrow, sanctions, admin money scope, self-dealing, chats) — each with a regression test | in progress |
| 2 | **Foundations:** delivery profiles/rules + resolver + quote/place contract; append-only ledger + payout requests + finance API; layout/theme/revision schema + validator + published-only renderer + publish/restore API; icon renditions + manifest; notifications model + deep links; analytics events; conversation context | pending |
| 3 | **Design-system primitives + Merchant Workspace:** Overlay/Sheet v2, ConfirmDialog, Toast, form kit, DataList, Money, Menu, CommandPalette; AppShell + MerchantShell + routes; Command Center; products (lifecycle, variants, bulk, import/export, insights); orders workspace with timeline; inbox; customers; coupons; collections; delivery settings; printers; costing; money; analytics; reviews; notifications | pending |
| 4 | **Store Builder + themes + onboarding + share + storefront speed** | pending |
| 5 | **Community requests v2:** wizard, capability-bound matching and bidding, offers v2, post-acceptance contact and chat, reviews & reputation, verification workflow, admin moderation | pending |
| 6 | **Hardening:** security review, route-level contract tests (see §6), responsive and RTL checks at 320–1440px in ar/en/ckb, budgets, deploy | pending |

## 6. Contracts pinned by tests
Seller isolation (merchant×merchant and Levonis×merchant); merchant, customer and
order ownership; delivery by governorate, disabled governorate, free threshold;
coupon isolation; stock concurrency; idempotent checkout; ledger settlement and
payout reservation; escrow; offer race; request access and file privacy;
preferences default=ALL and narrowing; capability matching; builder schema
validation and malicious payloads; draft/published separation; publish/restore;
per-host manifest and merchant PWA identity; RTL/LTR; admin permissions.

## 7. Documentation drift fixed by this plan
`docs/MERCHANT_STORES.md` §2 (PREMIUM **may** open a store), §7 (the old ledger is
**not** append-only — the new one is), §9 (endpoint list), and `COMMUNITY_V2.md`
§11 (a suspended store shows only «المتجر غير متاح حاليًا») are superseded by §2
and §4 above until those documents are rewritten in their waves.

## 8. Language
Arabic (RTL, default), English (LTR) and Sorani Kurdish (RTL). Use `t()`/`loc()`
and logical properties (`ps/pe/ms/me/start/end`). **Sorani is never
machine-written** (`docs/DECISIONS.md` row 11): reuse existing hand-written Sorani
verbatim; otherwise the Arabic stands in, marked `// OWNER: Sorani to be written by
hand.` Long English labels must not clip; numbers and prices stay LTR islands.
