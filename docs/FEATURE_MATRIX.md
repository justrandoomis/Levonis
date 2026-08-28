# Feature matrix

Every route and interactive control, what it did in the original archive,
and what it does now. Status legend:

- ✅ **verified** — implemented and exercised by the automated API suite
  and/or the browser end-to-end run (docs/TEST_RESULTS.md)
- ⚙️ **implemented** — wired to the real API and type-checked; behavior
  covered by API tests where applicable, full browser pass pending Phase 3
  staging
- 🔶 **honest-disabled** — feature has no backend yet; the control is
  visible but clearly labeled "قريباً / Coming soon" (never fake success)
- ⛔ **removed** — fabricated content or a live hazard that was deleted

Data ownership below: "owner" = the signed-in account (server-enforced),
"admin" = admin role required server-side, "public" = anonymous read.

## Routes

| Route | Guard | Status |
| --- | --- | --- |
| `/` Home | public | ✅ |
| `/products`, `/bundles` | public | ✅ |
| `/product/:slug` | public | ✅ |
| `/cart`, `/checkout`, `/orders` | signed-in | ✅ |
| `/auth` (+ `?reset=TOKEN`) | public | ✅ |
| `/profile` | public (richer when signed in) | ⚙️ |
| `/edit-profile`, `/settings`, `/addresses` | signed-in | ✅ (addresses) / ⚙️ |
| `/wallet` | signed-in | ⚙️ (API flows ✅) |
| `/subscription` | signed-in | ⚙️ |
| `/points` (Rewards) | signed-in | ⚙️ (check-in API ✅) |
| `/community`, `/community/store/:id`, `/followed-stores` | public / signed-in | ⚙️ |
| `/chats`, `/chat/:id` | signed-in, participants only | ⚙️ |
| `/invest` | investor/admin only (was: any signed-in user) | ⚙️ |
| `/admin`, `/admin/invest` | admin role (was: any signed-in user) | ✅ overview / ⚙️ rest |
| `/warranty`, `/tools`, `/games`, `/leaderboards` | signed-in | ⚙️ / 🔶 |
| dead links (`/community/new-request`, `/merchant-giveaways`, `/feed`, `/store/:id`, `/login`) | — | ⛔ fixed: real flows, honest labels, or corrected targets |

## Storefront

| Page | Control | Original problem | Now (API) | Status |
| --- | --- | --- | --- | --- |
| Home | banner carousel | rendered nothing; next/prev were empty functions | admin-configured banners from settings; working autoplay/swipe/dots; hidden when unconfigured | ⚙️ |
| Home | ads marquee | localStorage, never rendered | `homeAds` admin setting | ⚙️ |
| Home | discounted rail / product grid / infinite scroll | raw SQL from browser | `GET /api/home`, `GET /api/products?offset=` | ✅ |
| Products/Bundles | search, category filter, cards | raw SQL, unbounded | `GET /api/products` (paginated, active-only) | ✅ |
| Product | data load | raw SQL + hardcoded mock branch | `GET /api/products/:slug` (catalog + community; hidden products 404) | ✅ |
| Product | add to cart | fake (local counter only, cart never saw it) | `POST /api/cart/items` (401 → sign-in) | ✅ |
| Product | options/colors/shipping selectors | decorative, hardcoded prices | real variants; price follows server pricing rules | ⚙️ |
| Product | favorite (heart) | dead button | `PUT/DELETE /api/profile/favorites/:id` | ⚙️ |
| Product | share | dead button | native share/clipboard | ⚙️ |
| Product | reviews block, sold counter, fake store card, free-shipping bar, trade-in banner | fabricated (37 reviews, "292 sold", "rhode 4.7★") | ⛔ removed → honest "No reviews yet"; real merchant/brand shown | ✅ (absence verified) |
| Cart | item list, qty ±, delete, select, variant modal, shipping modal | all local mock state, nothing persisted | server cart (`GET/POST/PATCH/DELETE /api/cart/items`), owner-scoped, stock-clamped | ✅ core / ⚙️ modals |
| Cart | promo code | decorative input | 🔶 honest-disabled (no coupon backend) | 🔶 |
| Cart | points toggle | client-side balance math | real point balance; applied server-side at checkout | ⚙️ |
| Checkout | address selection | hardcoded empty array | `GET /api/addresses` + link to create | ✅ |
| Checkout | delivery/payment methods | admin settings ignored on price | settings-driven with `price_iqd` | ✅ |
| Checkout | wallet toggle / advance payment | client-computed, trusted | server-validated; `INSUFFICIENT_BALANCE` errors surfaced | ✅ (API) |
| Checkout | Place Order | fake success, hardcoded `#ORD-2094X` | `POST /api/orders`: server totals, idempotency key, atomic stock+wallet, real order id | ✅ |
| Orders | list, status filter, details | hardcoded empty; renderer dead code | `GET /api/orders?status=` | ✅ |
| Orders | cancel | didn't exist | `POST /api/orders/:id/cancel` (pending only, refunds wallet/points, restores stock) | ✅ (API) |

## Account

| Page | Control | Original problem | Now | Status |
| --- | --- | --- | --- | --- |
| Auth | login / register | JWT in localStorage; client-side admin email | cookie sessions; validation; uniform errors | ✅ |
| Auth | Google button | sent email/name for the server to trust blindly; alert-disclosed generated passwords | GIS credential verified server-side (sig/iss/aud/exp/email_verified) | ⚙️ (needs GOOGLE_CLIENT_ID; honest 503 until then) |
| Auth | forgot password | fake "link sent" | honest 503 until email configured; real hashed single-use 30-min tokens after | ✅ (503 path) |
| Auth | reset form (`?reset=`) | didn't exist | `POST /api/auth/reset-password`, revokes all sessions | ⚙️ |
| Settings | account/addresses/subscription nav | ok | kept | ✅ |
| Settings | push notifications | permission shown as "Working" | honest status + "delivery not configured" note | ⚙️ |
| Settings | appearance/language | ok (UI prefs) | kept (localStorage by design); language now persists | ✅ |
| Settings | "Elements"/"Setup extension" | `alert('… (Simulation)')` | 🔶 honest-disabled | 🔶 |
| Settings | sign out | missing | real logout row | ⚙️ |
| Edit profile | profile fields, avatar | localStorage only, fake 600 ms "saved", hardcoded Alex Smith | `PATCH /api/profile` + avatar upload to R2; server-enforced 14-day username cooldown | ⚙️ |
| Edit profile | merchant mode | `\|\| true` forced merchant view for everyone | off by default; only for merchants/admins/store owners | ⚙️ |
| Addresses | CRUD + default | localStorage; fake map autofill | full server CRUD, validation errors inline | ✅ |
| Profile | wallet/points chips, order badges | hardcoded numbers (`3/1/19`) | real balances + `GET /api/orders/counts` | ⚙️ |
| Profile | collection tab | 4 fake items | real favorites | ⚙️ |
| Profile | reviews tab, "saved 200,000", fake stats | fabricated | ⛔ removed → honest states | ✅ (absence) |
| Wallet | balance, transactions | client-computed from raw SQL | server balances (USD cents) | ✅ (API) |
| Wallet | deposit | receipt was a local object URL; never uploaded | required R2 receipt upload → `pending` admin review | ✅ (API) |
| Wallet | withdrawal | client-inserted | server request, balance-checked at request AND approval | ✅ (API) |
| Wallet | QR scan | `setTimeout` fake | 🔶 honest-disabled | 🔶 |
| Subscription | subscribe | client charged its own wallet (could go negative), localStorage entitlements, card number stored in DB | `POST /api/subscription/subscribe` (server price table, proration, atomic wallet spend); card number display-only | ⚙️ |
| Rewards | daily check-in | localStorage streak (infinitely re-claimable) | server streak + per-day unique claim (409 on repeat) | ✅ (API) |
| Rewards | PRO toggle | self-service entitlement doubling rewards | ⛔ removed; badge reflects server plan | ✅ (absence) |
| Rewards | push/video/browse missions | all client-attested, self-approving inserts | server-recorded claims; browse mission server-timed via pings; video honestly capped 1/day (client-attested playback — documented limitation) | ⚙️ |
| Warranty | submit claim | dead button | `POST /api/profile/warranty-claims` + status list | ⚙️ |
| Games / Leaderboards | game cards, ranks | fake play counters ("2,305,654"), fake profile "Mobbie Des" | ⛔ fakes removed; honest "coming soon"; real user shown | ⚙️ |
| Tools | Tool 1–4 grid | fake cards, no handlers | honest "coming soon" state | 🔶 |

## Community, chats, invest

| Page | Control | Original problem | Now | Status |
| --- | --- | --- | --- | --- |
| Community | products/merchants/requests tabs | raw SQL | real listing endpoints | ⚙️ |
| Community | search | decorative | client-side filter, wired | ⚙️ |
| Community | new request | dead link to unrouted page | inline modal → `POST /api/community/requests` | ⚙️ |
| Community | "Make Offer", 3 promo banners | dead / unrouted | 🔶 honest-disabled (offer flow needs a customer-id in payload — future) | 🔶 |
| Merchant store | whole page | rendered a blank black screen; all content fabricated | real merchant, products, follower count, member-since | ⚙️ |
| Merchant store | follow/unfollow | localStorage | server `follows` table | ⚙️ |
| Merchant store | message | dead | 🔶 honest-disabled (store payload lacks the user id — future) | 🔶 |
| Followed stores | list | localStorage | `GET /api/community/followed` + unfollow | ⚙️ |
| Chats | conversation list | hardcoded empty | real chats with unread counts | ⚙️ |
| Chat | messages | 100% client-side, lost on unmount; fake merchant name | participants-only messages, text+image, 5 s polling | ⚙️ |
| Chat | voice/location/red envelope/etc. | six dead buttons + fake recorder | 🔶 honest-disabled; camera/album do real image upload | 🔶 |
| Invest | portfolio | real data DISCARDED and replaced by a hardcoded 5 M IQD mock | real investments (USD cents), investor-gated | ⚙️ |
| Invest | new investment | client INSERT with mock profit rates | ⛔ removed — admin-arranged; honest note + support chat | ✅ (absence) |
| Invest | move funds | faked instant deposits via negative charges | honest redirect to the real wallet | ⚙️ |
| Invest | support chat | raw SQL | `POST /api/invest/messages` | ⚙️ |
| Invest admin | user list | `SELECT * FROM users` shipped password hashes to the browser | safe column list; investor toggle; CRUD incl. previously-dropped duration edits | ⚙️ |

## Admin console

| Component | Control | Original problem | Now | Status |
| --- | --- | --- | --- | --- |
| Admin shell | access | NO role check at all (any signed-in user) | server-enforced role on every API + route gate | ✅ |
| Overview | stats | seeded fake numbers, fake charts, hardcoded ×1500 rate | real aggregates only | ✅ |
| Overview | quick actions | approved/rejected wallet tx with **hardcoded ids '1'/'2'** (live data corruption) | ⛔ removed; real pending list with approve/reject | ✅ |
| Orders tab | status management | didn't exist | legal transitions, cancel auto-refunds | ⚙️ |
| Products | editor (33 fields), delete | raw SQL upsert; USD/rate conversion silently repriced catalog on rate change | `POST/DELETE /api/admin/products`, canonical IQD, visibility + stock fields, R2 uploads | ✅ create+hide verified / ⚙️ full editor |
| Products | translate / URL extract | open endpoints | admin-only; honest 503 when Gemini unset; SSRF-guarded extract | ✅ (guards) |
| Users | role/plan/investor edits | raw SQL from browser (self-promotion possible) | audited PATCH; self-demotion blocked | ✅ (API) |
| Wallet requests | approve/reject | raw SQL; `window.prompt` | decide endpoint (withdrawals re-checked against live balance), receipt links, inline notes | ✅ (API) |
| Wallet settings | exchange rate / ad video / manual methods | one DB write per keystroke; stale-state clobbering | explicit saves, hydration fix | ⚙️ |
| Store settings | delivery/payment/shipping methods | editable ids orphaned product references; missing icon field | ids locked after save; icon select added | ⚙️ |
| Home settings + Ads | sections/banners/items | **localStorage only** — admin "saves" never reached any other user | server settings keys with real saves + uploads | ⚙️ |
| Dashboard layout | logout | navigated without logging out | real session logout | ⚙️ |
| Dashboard layout | notifications | fake badge "3", fake list | honest empty dropdown | ⚙️ |
| Merchant dashboard | store setup/products | 100% mock; uncontrolled inputs; fake "$240,117" | real my-store API; controlled forms; honest empty analytics | ⚙️ |

## Cross-cutting fixes

- i18n: language choice now persists; Kurdish included in translate targets.
- All client-generated primary keys replaced by server-minted ids.
- `src/types.ts` is stale-but-unused; `src/lib/api.ts` types are authoritative.

## Known follow-ups (not blocking Phase 2)

1. Reviews system (products & merchants) — UI shows honest empty states.
2. Merchant orders/analytics; community "Make Offer" and store "Message"
   (needs a safe way to expose the counterpart user id).
3. Coupon codes; games; push delivery backend; email verification.
4. JS bundle code-splitting (1.37 MB main chunk).
5. Strict document CSP (Phase 3, must be tested against Google Sign-In).
