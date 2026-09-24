# 05 — Design system, app shell, performance budget, i18n and UI test conventions

**Audit area:** the Merchant Workspace re-development (premium app shell, block-based Store Builder with live preview, very fast public storefront, ar/en/ckb).
**Repo:** `/home/user/Levonis` at `234f5e3`. **Read-only:** no repo file was changed. `git status` was clean before and after.

**Method**
- Every file named in the brief was read. Primitives, shells, tests and docs were cross-checked with grep counts.
- Bundle numbers come from the existing `dist/`, which is fresh (`find src public index.html vite.config.ts -newer dist/index.html` returns nothing). They were measured with a script that copies the logic of `tests/bundleBudget.test.ts`.
- Module-level attribution comes from a second `npx vite build --sourcemap --outDir <scratchpad>/dist-audit`. That build wrote only to the scratchpad. `npm run build` was **not** run, because it also runs deploy-config scripts.
- These tests ran green, 168 in total:
  - Group of 14 files (121 tests): `uiSystem`, `adminSurfaceDesign`, `inputZoom`, `darkOnlyTheme`, `firstPaintAndFonts`, `bottomNavVisibility`, `bloubNavigation`, `asyncStates`, `storefrontIsolation`, `busyOverlay`, `printQuoteUi`, `profilePrintersMoved`, `refusalStrings`, `brandName`.
  - Group of 3 files (47 tests): `communityGate`, `languagePersist`, `cartPreorderQuotaWording`.
- `bundleBudget.test.ts` was deliberately **not** run. It rebuilds into `dist/` whenever it thinks `dist/` is stale.

---

## TL;DR

1. **There is a real shared system, and the merchant surfaces do not use it.**
   - What exists: `src/index.css` tokens plus `lv-*` component classes, and `src/components/ui/*` (Overlay/Sheet/Anchored, TabStrip/TabPanels, Segmented, AsyncStates, Skeleton, Spinner, SafeImage, Note, AppBusy), a motion system (`src/lib/motion.ts`) and a busy store.
   - What the merchant side uses instead: its own local kit (`src/components/merchant/dashboard/ui.tsx`). `MerchantDashboardPage`, the six dashboard tabs, `DashboardLayout`, `Storefront`, `StorefrontProduct` and `MerchantStart` contain **zero** semantic-token utilities or `lv-*` classes.
   - Instead they hold 209 `zinc-*` utilities, 150 `white/…` alpha utilities and hard-coded hexes (`#D4AF37`, `#708238`, `#18181b`), plus about 20 native `window.confirm/alert` calls, 15 hand-rolled `animate-spin` and 30 `text-red-*` error strings. Tap targets are 28–36px: IconBtn is 28px, Btn and Chip are 32/36px.
2. **There are at least 10 parallel, feature-local UI kits.** One of them is a whole second token system: `.ap` in `adminProducts/theme.css`, with a *purple* accent. The best dialog in the repo (focus trap, focus return, nested-Escape stack, keyboard-aware height, dirty-guard) lives in `adminProducts/ui.tsx`, not in `ui/`.
3. **Missing shared primitives:**
   - AppShell, side Drawer, BottomTabBar
   - Button/Field/Select/Switch components
   - Card, Badge/Chip
   - Toast, ConfirmDialog
   - Responsive DataList (table on wide screens, cards on narrow)
   - Combobox / command palette
   - Money
   - Dashboard skeletons
   - A focus trap in `Overlay`
   - A Sheet that drags from a handle only
4. **The current `/merchant` shell** renders *inside the customer shell*:
   - The customer BottomNav and the mascot anchor stay on screen.
   - The 15 tabs live in `useState`, so there are no URLs and no deep links.
   - All tabs are one eager 47.8 KB-gz chunk. With its 37 tiny shared chunks that is 62.6 KB beyond the initial payload.
   - On a merchant subdomain, only exact `/admin` is routed.
5. **`DashboardLayout` (the admin shell) is a good skeleton but not reusable as-is:**
   - Its palette is hard-coded.
   - It fetches `/api/community/my-store` on every mount.
   - Its notifications panel is a stub, although `NotificationBell` exists.
   - Its dropdowns are hand-rolled, the drawer sits at `z-[900]` outside `UI_LAYERS`, and it nests a `<main>` inside App's `<main>`.
   - Navigation is state-driven, and phones get no bottom navigation.
   - **Recommendation:** extract a presentational `AppShell` from it, keep `DashboardLayout` as the admin adapter (tests and e2e scripts pin its hooks), and build `MerchantShell` as the second adapter.
6. **Entry and budgets today:**
   - Entry: **70.3 KB gz** (budget 120).
   - Initial payload: **198.6 KB gz** in 4 files (budget 240).
   - CSS: **44.3 KB gz** total (budget 60). The render-blocking `index-*.css` alone is 36.2 KB gz.
   - A merchant-storefront visitor's first load is about **219 KB gz of JS plus 36 KB gz of CSS**. About **95 KB raw (~44%) of the entry** is apex-only chrome (Home, home/*, Header, BottomNav, LiveSearch, NotificationBell, EmailVerifyBanner…) that a storefront visitor downloads and parses but never renders.
   - The client also waits on `/api/storefront/resolve` before painting anything.
   - Idle prefetch then pulls apex pages on merchant hosts: **47.7 KB gz** of it a storefront visitor never uses.
7. **Tailwind v4 emits every utility used anywhere into the one render-blocking stylesheet.** A builder or dashboard built from new arbitrary utilities grows the customer's first paint unless its bespoke CSS lives in a lazily imported CSS file. Precedent: `adminProducts/theme.css` becomes `theme-*.css` at 1.0 KB.
8. **The Sorani policy is explicit and pinned by tests.** Sorani is **never machine-written**:
   - Reuse existing hand-written Kurdish verbatim.
   - Otherwise let Arabic stand in: `loc(ar, en)` with no third argument, plus `// OWNER: Sorani to be written by hand.`
   - Merchant-authored content is `LocalizedText{ar,en,ckb}` with `pickText`, which falls back to the first language the author actually filled.
9. **The builder preview cannot be an iframe.** Security headers are `frame-ancestors 'none'` and `X-Frame-Options: DENY`. It must be an in-page render of the *same* block components. Blocks must therefore respond to **container queries**, not viewport breakpoints; no container queries exist in `src/` today.
10. **No DnD library exists.** `motion@12.43` (already in the initial payload) provides `Reorder`, `drag` and `useDragControls`. `gsap` is a dependency, but its only importer is dead code.

---

## 1. Inventory of UI primitives and design tokens

### 1.1 Tokens: `src/index.css` `@theme` (lines 131–183)

| Token | Value | Notes |
|---|---|---|
| `--color-black` / `--color-white` | `#0b0c0f` / `#f2f3f5` | **Re-maps Tailwind's `black`/`white`** (`index.css:141-142`), so `bg-white` is not #fff. This matters for light storefront themes and QR codes. |
| `--color-canvas`, `--color-surface`, `--color-surface-raised`, `--color-surface-selected` | `#0b0c0f`, `#131519`, `#191c21`, `#20242a` | The semantic surfaces (`:143-146`). Pinned by `tests/uiSystem.test.ts:18` and `tests/darkOnlyTheme.test.ts:169`. |
| `--color-border-subtle` | `#2a2e35` | |
| `--color-text-primary/secondary/muted` | `#f2f3f5 / #b7bbc3 / #858b95` | |
| `--color-success/warning/danger/info` | `#42b77a / #d79b45 / #dc6363 / #6f9bd1` | |
| `--color-focus` | `#d2c392` | Used by `.lv-button:focus-visible` (`:297-300`) and by the `ring-focus` utility (43 files). |
| `--color-olive`, `-dark`, `-light` | `#1B2010 / #0F1208 / #2B3318` | Brand "olive". Mirrored in Studio (`:156-168` comment). |
| `--color-gold` / `--color-gold-light` | `#BAA369` / `#ffe55c` | `gold-light` is a saturated yellow that is off-palette. |
| `--radius-sm/md/lg/xl` | .5/.75/1/1.25rem | The only shape scale. |
| `--font-sans`, `--default-font-family` | Cairo | Cairo is loaded from `index.html:269-286`. A self-hosted 4.8 KB Kurdish patch face covers the 5 letters Cairo lacks (`index.css:1-50`, pinned by `firstPaintAndFonts.test.ts:94-111`). |
| `--animate-day-pop` | keyframes | `:744-761` |

**Runtime and JS-side tokens (not in `@theme`)**
- `--app-header-height` (`index.css:126`). Written live by Header (`Header.tsx:80-96`).
- `--nav-stack` for bottom-nav clearance (`index.css:863-874`).
- `--lv-home-*` / `--lv-header-*` mascot geometry (`:1005-1028`).
- `--admin-main-pb` (`DashboardLayout.tsx:506-518`). It is a live-verification marker, see §4.3.
- `UI_LAYERS = {header:100, bottomNav:120, popover:160, overlay:200}` (`Overlay.tsx:58-63`); AppBusy sits at `overlay+100`.
- `SPRING` presets `ui/move/sheet/momentum/rotate/quick` plus `CROSS_FADE` and `PRESS_MS` (`src/lib/motion.ts:62-98`).

**What the token layer lacks**
- **Type scale.** There are 3,440 arbitrary `text-[Npx]` utilities over 29 distinct values: `text-[12px]` ×783, `[11px]` ×721, `[13px]` ×619, `[12.5px]` ×276…
- **Spacing and density.**
- **Elevation and shadow.** The only one is inside `.lv-surface-raised`.
- **z-index in CSS.** The contract exists only in TS and is widely bypassed: `z-[1000]` in the adminProducts Modal, `z-[900]` in the DashboardLayout drawer, `z-[135]` and `z-[140]` in menus.
- **Motion durations in CSS.**
- **Merchant-theme tokens.** Storefront accents are Tailwind class strings in a page-level table (`Storefront.tsx:56-64`).

**Palette drift**
- DashboardLayout uses `#708238` "olive" and `#D4AF37` "gold", not the tokens (`DashboardLayout.tsx:287,333,361,422…`).
- The `.ap` system has its own 40 variables with a purple accent: `#6558e0` in `adminProducts/theme.css:4-47`, and a *different* purple, `#6B46FF`, in `adminProducts/ui.tsx:15`.

**Dark-only by decision**
- No `dark:` variant may appear in `src/` (`tests/darkOnlyTheme.test.ts:148-164`).
- There is no Tailwind config and no `@custom-variant dark` (`:166-177`).
- `color-scheme: dark` is declared on `<html>` (`index.css:122-123`, `index.html:39`).

### 1.2 Component classes in `src/index.css`, with adoption (files in `src/` using each)

| Class | Lines | Contract | Adoption |
|---|---|---|---|
| `.lv-surface`, `.lv-surface-raised`, `.lv-section` | 194-214 | Tonal surface with a 1px subtle border and `radius-lg`; raised adds a shadow; section is a block divider | 27 / 3 / 8 |
| `.lv-choice` + `.lv-choice-mark` | 216-267 | 44px min option. Selected state via `aria-pressed/aria-checked/data-selected`: surface-selected plus an **inset 2px gold start edge**, mirrored for RTL at `:241-245`. A check-mark fades in. Pinned by `uiSystem.test.ts:16-27`. | 16 / 7 |
| `.lv-button` (+`-primary/-secondary/-ghost/-danger/-accent/-sm`) | 269-375 | 44px min block size (the `-sm` variant keeps 44px and reduces only padding and type), focus-visible ring, disabled state. **Class-only; there is no `<Button>` component.** | 30 (primary 20, secondary 25, ghost 10, danger 3, accent 1, sm 14) |
| `.lv-input`, `.lv-field-error` | 377-408 | 46px min, focus ring, `aria-invalid` styling | 14 / 3 |
| `.lv-alert` (+`-success/-warning/-danger/-info`) | 410-420 | Start-edge 3px tone plus a 10% tint | 20 |
| Base press feedback | 502-526 | `:active` opacity .72 at 100ms, `touch-action: manipulation` | global |
| `press-scale`, `no-press` utilities | 530-546 | opt-in scale / opt-out | 20 / 2 |
| 16px coarse-pointer input floor | 483-500 | Prevents iOS focus zoom. `!important` is intentional. Pinned by `inputZoom.test.ts`. | global |
| `.material`, `-thin`, `-thick`, `.scroll-edge` | 568-600 | Glass chrome, with prefers-reduced-transparency and more-contrast fallbacks (`:635-656`) | 62 (incl. "material" word) / 2 |
| Reduced motion | 610-633 | Kills animation durations but keeps the press dim | global |
| Arabic/Kurdish tracking neutraliser; `leading-none/tight` floors | 687-699 | `html:lang(ar|ckb) [class*='tracking-']` gets normal letter-spacing | global |
| `pb-safe`, `hide-scrollbar`, `bleed-x`, `custom-scrollbar`, `nav-clearance` | 701-742, 95-114, 845-848 | Utilities | — |
| `html[data-overlay-open] [data-bottom-nav]` | 877-881 | A modal hides the customer bottom nav | — |
| `html[data-lang-swap] main` | 1198-1218 | 8px settle animation on language change | — |

**Doc drift:** `docs/MOTION.md:185-189` gives the material blur and opacity as 12px/64%, 20px/72% and 32px/82%. The shipped values are 12px/94%, 18px/90% and 24px/97% (`index.css:568-581`).

### 1.3 React primitives in `src/components/ui/`

| Primitive | File:lines | API | Quality | Gaps relevant to the merchant work |
|---|---|---|---|---|
| **Overlay** | `Overlay.tsx:214-322` | `open, onClose, label/labelledBy, mode:'modal'|'parallel', anchor, placement:'center'|'bottom'|'top', dismissOnEscape, dismissOnScrim, z, testId, panelMotion, solid` | Portalled to body. Springs with symmetric enter and exit. Scales from its anchor. Shared modal-lock counter (`acquireModalLock` :95-118, also used to hide the bottom nav). Copies `dir` onto the portal (:296). Reduced-motion cross-fade. Its bottom placement is a sheet on phones and a dialog at `sm` and up (:198-202). | **No focus trap and no focus restore** (:274-276 only focuses the panel). **No overlay stack**: every Overlay adds its own `document` keydown listener and calls `stopPropagation` (:255-265), which does not stop sibling listeners, so by code reading nested overlays all close on one Escape. The **default scrim label is hard-coded Arabic** `'إغلاق'` (:292). **Children are evaluated while closed** (JSX argument); `AdminKyc.tsx:228-245` records a black-screen crash from exactly this. The modal lock only knows `#main-scroll-container` (:97), so on the storefront and full-screen shells the real scroller is not locked. |
| **Sheet** | `Overlay.tsx:340-397` | `Overlay` props (minus placement/anchor) plus `height` | 1:1 drag with rubber band, projected-momentum dismissal (`project()`), grabber | **The whole panel is draggable.** That fights scrollable content, so `Addresses.tsx:516-531` deliberately uses `Overlay placement="bottom"` instead. There are **no detents or snap points** and no keyboard (visualViewport) awareness. |
| **Anchored** | `Overlay.tsx:427-552` | `open, onClose, anchor, align:'start'|'end', label, z, testId` | Portalled and positioned from the trigger in logical terms, clamped to the viewport, follows visualViewport scroll and resize | Declares `role="menu"` (:530) but has **no roving focus or arrow keys**. Escape does not stop propagation (:504-505). No typeahead. |
| **TabStrip / TabPanels** | `Tabs.tsx:67-119`, `:136-165` | `items{id,label,badge,show}, value, onChange, group, indicator/active/idle classes, fill, label` / `value, order` | A single travelling indicator (`layoutId`, :108). Panels slide in the writing direction (`m.dir`). | **No keyboard model**: no arrow keys, no roving tabindex, no `aria-controls`, no `role="tabpanel"`. Tab only, not links, so it cannot drive URL navigation. The default indicator is `bg-olive`, which is nearly invisible on canvas. |
| **Segmented** | `Segmented.tsx:69-164` | `items{id,label,icon,badge,accent,disabled}, value, onChange, label, group, dataAttr, size:'md'|'sm'` | A real `radiogroup` with roving tabindex. Arrow keys follow the writing direction (:90-107). 44px at `md`. | Hard-coded `bg-zinc-900/60 border-white/10` (:116). `sm` is 36px. |
| **AsyncStates** | `AsyncStates.tsx` (`classifyError` :30-42, `serverCause` :67-72, `ErrorState` :205-262, `EmptyState` :264-292, `NotFoundState` :294-330, `UnauthorizedState` :337-371) | `error, onRetry, next, compact, className` | 401, 404, network, 5xx, 403 and generic 4xx are kept distinct. ar/en/ckb copy (Sorani policy note at :123-127). Tests: `asyncStates.test.ts:11-49`. | `StateShell` uses hard-coded zinc (:171). RetryButton is not an `lv-button`. There is no inline or banner variant for a failed save. |
| **Spinner** | `Spinner.tsx:51-86` | `size:'xs'|'sm'|'md', delayMs (150), label, decorative` | Avoids flicker with a 150ms appear delay. Screen-reader status. Reduced motion becomes a pulse. | Injects a `<style>` at runtime (:17-37). The gold arc is the only style. |
| **Skeleton family** | `Skeleton.tsx:22-248` | `Skeleton`, `SkeletonGroup(label)`, plus Product, Cart and Bundle skeletons | Mirrors real dimensions; `aria-busy` plus one polite label | Commerce shapes only. **No list/table/stat/card/form skeletons for dashboards.** Hard-coded `bg-zinc-800/60`. |
| **SafeImage** | `SafeImage.tsx:19-141` | `src, alt, aspect, fit, eager, className…, onStatus` | Reserves its box (no CLS), lazy loading, retry, fallback icon, localised | Its Arabic `failed` string (:14) **is a live marker checked by `npm run build`** (§4.3). |
| **Note** | `Note.tsx:71-101` | `tone:'gold'|'amber'|'zinc', icon, compact, animate, testId` | `role=note`, a start-edge hairline (logical) | No danger or info tone; `.lv-alert` covers those. |
| **OfferBadge** | `OfferBadge.tsx:22-51` | `tone:'sale'|'saving'|'member'` | Applies `tracking-wide` only to Latin text (:20,34,45) | Commerce-specific |
| **SummaryInfo** | `SummaryInfo.tsx:34-118` | `label, value, question, note, testId, tone` | Disclosure rather than tooltip; accessible | Hard-coded `#BAA369` rather than the token |
| **Countdown** | `Countdown.tsx:90+` | `target, kind, onZero, className` | One shared 1Hz ticker; `<bdi dir=ltr>` digits | — |
| **StatCard / Spark / TINTS** | `statCards.tsx:8-50` | `tint, icon, label, value, sub, series` | Honest flat baseline when there are fewer than 2 points | **Five competing tints** (purple, blue, green, amber, red), against apple-design §2 and §7. 10.5px and 10px labels. |
| **AppBusy + busy store** | `AppBusy.tsx:156-293`; `src/lib/busy.ts` (`BusyReason` :53, `RANK` :62, `COMMITS` :70, `beginBusy` :136, `useBusy` :165, `createIntentMark` :186) | `useBusy(active, reason)` | Ref-counted and delayed (140ms, or 250ms for routes). The ceiling is derived from the API deadline. Leave-prompt only for money commits. `role=status` (not a dialog). Static import (`busyOverlay.test.ts:428-436`). | **The reasons are a closed set**: `order|payment|subscribe|quote|route`. A merchant "publish" or "save" hold needs a *new reason with hand-written copy in all three languages* (`busy.ts:41-45`). It is coupled to the mascot (`characterLayout`, AppBusy.tsx:76,170). |

### 1.4 Feature-local kits (the parallel design systems)

| Kit | File | What it adds | Notes |
|---|---|---|---|
| Merchant dashboard kit | `src/components/merchant/dashboard/ui.tsx` | `Spinner, Empty, Notice, Card, Stat, Input, TextArea, Toggle, Btn, Chip, ChipListEditor, useMainSiteHref` | Btn is `h-9`/`h-8` (:219) and Chip `h-8` (:243). **Labels are not associated with their inputs** (:117/:146). The Toggle has **no `role="switch"`/`aria-checked`** (:172-185). The remove button is 20px with an English `aria-label="remove"` (:278-285). Card titles are gold (:65). The apex is hard-coded as `https://levonis-iq.com` (:23). |
| adminProducts (`.ap`) | `adminProducts/theme.css`, `theme.ts`, `ui.tsx`, `form/formUi.tsx` | 40 CSS variables; `Modal` (:424-604) with **modal stack** (:338), **visualViewport height** (:354), **focus trap + opener restore** (:475-526), **dirty-close guard** with hand-written ckb (:379-400), sticky safe-area footer; `Field/Select/Toggle` | Purple accent. `z-[1000]` (:535). Its own body lock. No motion. |
| adminTaxonomy | `adminTaxonomy/shared.tsx` | `Table` (sticky action column, :187), `Badge` (:219), `Dialog` (save/cancel/busy/error, :343), `Toolbar`, `SearchBox` | Built on the `.ap` tokens |
| adminInventory, adminUsers, adminFarm (`inputs.tsx` Switch), warranty (`ui.ts`), farm (`pages/farm/ui.ts`, `bits.tsx`) | — | Local chips, switches and tables | — |

**Other reusable pieces outside `ui/`**
- `NotificationBell`, which uses Anchored on desktop and a Sheet on phones (`NotificationBell.tsx:37-44, 58, 455-470`).
- `LiveSearch`, a combobox (`LiveSearch.tsx:47-48, 368-381`).
- `CountryPicker`, a combobox.
- `FarmTabBar`, an in-flow bottom pill bar with a travelling indicator and locked tabs that explain why (`pages/farm/FarmTabBar.tsx:1-12`).
- `useIsWide`, which switches between a table and cards with only one mounted (`compare/useIsWide.ts:3-21`).
- `ImagePicker` (`media/ImagePicker.tsx:37`).
- `StoreCta.reasonText`, which explains a restriction in all three languages (`merchant/StoreCta.tsx:144`).

**Duplication**
- The `(max-width: 639px)` phone hook is copied in NotificationBell, PurchaseConfirm, `farm/hooks/usePhone` and DashboardLayout (1024px).
- There are three combobox implementations.
- There are three money formatters: `iqd()` gives "12,000 IQD" (`lib/merchant.ts:547-550`); `formatIqd()` gives "12,000 د.ع" with a locale-dependent `toLocaleString()` (`lib/api.ts:1773-1775`); `DinarPrice` gives "ع. 12,000" (`Storefront.tsx:577-584`).

### 1.5 Missing primitives (for the shell and builder)

**Shell and page**
- `AppShell`
- `SideDrawer` (DashboardLayout's `MobileDrawer` is private, `:533-672`)
- `BottomTabBar`
- `TopBar` / `PageHeader`
- `CommandPalette` / scoped `SearchField`
- `StoreStatusPill`
- `QuickActions` menu

**Controls**
- `Button` component (only classes exist)
- `IconButton` with a 44px hit area
- `Field` (label, hint, error, `aria-describedby`), `Input`, `Textarea`, `Select`
- `Switch`, `Checkbox`, `Radio`
- `Chip` / `FilterChip`, `Badge`
- `Stepper` (quantity)
- `Pagination`

**Feedback**
- `Toast` / `useToast` with a live region. Only the PWA `UpdateReadyToast` exists, and it is positioned by the customer `--nav-stack`.
- `ConfirmDialog`, to replace native `confirm()`.
- Inline save status.

**Data**
- `Card`
- `DataList` (table ↔ cards)
- `Stat` / `KpiTile` in one accent
- `Money`
- Dashboard skeletons
- `Disclosure` / `Accordion`
- `Menu` with keyboard
- `Tooltip` / `Popover`, for pointer-fine info only

**Behaviour**
- Focus trap, restore and stack in `Overlay`
- Sheet detents and handle-only drag
- A generic `useMediaQuery`

---

## 2. App shell and routing

### 2.1 Provider tree and the three shells

- **Providers** (`App.tsx:835-870`): `Auth → Language → Wallet → Currency → NavigationRouter → StoreProvider`. Inside that sit `AppBootstrapLayer` (the lazy mascot, :420-449), `UpdateReadyToast`, `AppBusy` and `AppContent`.
  - `NavigationRouter` (`components/NavigationRouter.tsx:43-63`) is BrowserRouter with `useTransition`, so a pending navigation holds a `route` busy wait.
- **Host gate** (`App.tsx:527-528`): nothing renders until `StoreContext` answers.
  - A store, or an unknown store host, goes to **`StorefrontApp`** (:373-411).
  - The apex continues.
- **Shell A — `StorefrontApp`** (merchant subdomain):
  - Root `div.h-[100dvh] … overflow-y-auto` (:376), with no `<main>` and no `#main-scroll-container`.
  - Routes: `/`, `/products`, `/about`, `/reviews`, `/p/:productSlug`, the policies, the platform's `/cart`, `/checkout`, `/store-checkout` and `/orders` (the account is shared), `/auth`, **`/admin` → `MerchantDashboardPage` (exact path only, :404)**, and `*` → Storefront.
- **Shell B — full-screen** (`isFullScreenRoute`, :534):
  - Prefixes: `/admin, /invest, /admin/invest, /auth, /points, /settings, /addresses, /checkout, /store-checkout, /games, /leaderboards, /support, /chat, /model-viewer`.
  - Wrapper `h-[100dvh] min-h-0 … overflow-hidden` (:538, pinned by `uiSystem.test.ts:78`), then `MotionCharacterFallbackHeader`, then `<main class="flex-1 flex overflow-hidden">` (:540).
  - **No `ChunkBoundary` in this tree** (:536-664). By code reading, a failed chunk on `/admin` or `/checkout` has no boundary below the root.
- **Shell C — main customer shell** (:680-832):
  - `Header` (renders only on `/`, `Header.tsx:98-100`), then `<main id="main-scroll-container">` (:688, the single scroll owner that Overlay, Header, Profile and Policies rely on), then routes, `nav-clearance`, `BottomNav` and `BrowseMissionTimer`.
  - **`/merchant`, `/merchant/*` and `/merchant/start` live here** (:754-756). The customer BottomNav therefore floats over the merchant dashboard, because `isBottomNavHidden` does not list `/merchant` (`BottomNav.tsx:19-30`). The mascot is hidden only on `/admin` (`MotionCharacterAnchor.tsx:89-92`).

### 2.2 Host-based routing on the client

- `StoreProvider` calls `storefrontApi.resolve()`, i.e. `GET /api/storefront/resolve`, once at boot (`StoreContext.tsx:53-73`; `lib/merchant.ts:338`). A 404 means an unknown store; any other failure falls back to the main site.
- The browser is forbidden from parsing `location.hostname`. This is pinned by `storefrontIsolation.test.ts:89-100` and explained in `docs/SUBDOMAIN_ARCHITECTURE.md:156-176`.
- The server work behind the call: on a merchant host, `/resolve` runs `storeBySlug`, `publicStore` and four stat queries (`worker/routes/storefront.ts:157-176`). On the apex it answers `store:null` at once.
- The SPA document for `/` is served by the **asset layer**, not the Worker. `run_worker_first` covers only `/api/*, /files/*, /product/*, /bundles/*, /p/*, /community/store/*, /manifest.webmanifest, /robots.txt, /sitemap.xml` (`wrangler.jsonc:76-90`). The client therefore cannot receive host data inside the HTML today.
- `docs/architecture/01-TARGET.md:497` already plans `GET /api/v1/boot`, which would combine resolve, capabilities and boot settings in one call.

### 2.3 Lazy-loading mechanics

- **`React.lazy` for every off-path page** (`App.tsx:33-35, 54, 70-98, 244-255, 265-269, 283-314`).
  - `Storefront`, `MerchantStart` and `StorefrontProduct` must be lazy (`firstPaintAndFonts.test.ts:27-40`).
  - `MerchantDashboardPage` has its own chunk (`bundleBudget.test.ts:229`).
- **`prefetchable()` plus `useIdlePrefetch()`** (`App.tsx:149-203, 233-237`): Products, Product, Cart and Addresses are fetched at idle. **This runs on every host**, because it is called at :521, before the host branch.
- **Eager by design:**
  - `Home` (:211)
  - `AppBusy`, which must not wait for a chunk (:37-45, `busyOverlay.test.ts:428-436`)
  - `FarmGate` and `CommunityGate` wrappers (:270-281)
  - `ChunkBoundary`, three of them (:384, :443, :693), exactly pinned (`firstPaintAndFonts.test.ts:75-79`); it reloads on failure (`ChunkBoundary.tsx`)
- **`AppIntro` (the mascot) is lazy** with `Suspense fallback={null}` (:338, :444-446; `firstPaintAndFonts.test.ts:46-50`).
- **`RouteFallback`** (:106-133) holds `useBusy(true,'route')`.
- **The Admin page lazy-loads each of its 29 panels** behind a panel-scoped Suspense with a `PanelFallback` (`pages/Admin.tsx:9-99, 101-113, 249`). This is the pattern the merchant page does *not* follow.
- **`vite.config.ts` manualChunks** (:47-61):
  - `vendor-react`: react, react-dom, router, scheduler
  - `vendor-motion`: motion and gsap
  - `vendor-webgl`: ogl, which must stay out of the eager closure
  - `vendor-charts`: recharts and d3
  - `vendor-phone`
  - `vendor-qr`
  - `vendor-i18n`: `translations.ts`
  - The reasoning is written up at :6-46.

### 2.4 The current merchant surface (as a consumer of the design system)

**`src/pages/MerchantDashboardPage.tsx`, 619 lines:**
- **State-driven tabs** (:44-47, :65), 15 of them (:112-134), shown as a horizontally scrolling pill row with group dividers (:197-214).
  - There are no URLs: `/merchant/*` renders the same page, and Back does not step between tabs.
  - Onboarding lands on the Printers tab through `location.state.created` (:53-65).
- **Every tab is statically imported** (:34-42): ProductsManager, CatalogTabs, SalesTabs, StoreSettingsTab, PrintersTab, CostingTab.
  - Measured chunk composition (raw): ProductsManager 36.6 KB, PrintersTab 31.5, StoreSettingsTab 18.4, the page 15.6, SalesTabs 14.8, CostingTab 13.1, CatalogTabs 12.8, ImagePicker 5.1, local kit 5.0 — about 156 KB raw, **47.8 KB gz**. Opening Overview downloads all of it.
- **Visual language:**
  - A fixed `bg-olive/15 blur-[120px]` glow blob positioned with physical `left-1/2` (:138).
  - `bg-[#0a0a0a]` page ground, not `bg-canvas` (:79, :137).
  - The active tab is `bg-olive` (a near-black olive), so the selected state is weak.
  - `pb-28` (:137) doubles the App's own `nav-clearance`.
  - A `Loader2 animate-spin` loader (:80).
  - A `motion.div` tab transition with hard-coded `{duration:0.25}` and `y:8` (:216), which bypasses `useMotion` and therefore reduced motion and the spring presets.
- **Error handling:**
  - Errors render as `Notice` with raw `e.message` (:258).
  - The review reply `await merchantApi.replyReview` has no try/catch (:415-423).
  - About 20 native `confirm()`/`alert()` calls live in the tabs, e.g. `CatalogTabs.tsx:119,264,277,540`, `ProductsManager.tsx:213-281`, `SalesTabs.tsx:148-566`, `StoreSettingsTab.tsx:652`, `PrintersTab.tsx:452`.
- **Other interaction issues:**
  - ProductsManager's table view is `min-w-[680px]` inside `overflow-x-auto` (:625-626). A grid view and a compact view exist, but the choice is manual, not responsive.
  - The ⌘K quick find matches `e.key === 'k'` (:135). That fails on an Arabic or Kurdish keyboard layout; AdminProducts fixed the same thing with `e.code === 'KeyK'` (`AdminProducts.tsx:274-275`, DECISIONS row 82).
  - The section rows show a decorative, non-functional `GripVertical` (`CatalogTabs.tsx:92`).
- **Kept from the old design, and pinned** (see §4): capabilities come from `/api/merchant/me` (`MerchantMe.can` and `selling`, `lib/merchant.ts:194-211`); restrictions are always explained (`StoreCta.reasonText`); a "View store" link and an Open/Paused chip (:150-181).
- **A second, legacy merchant dashboard exists:** `src/components/MerchantDashboard.tsx` (606 lines). It is embedded in `/edit-profile` behind an English-only toggle, "Merchant Mode: ON/OFF" (`EditProfile.tsx:165-172, 215-216`), and it is built on `DashboardLayout`.

### 2.5 Can `DashboardLayout` (the admin shell) be reused?

`src/components/DashboardLayout.tsx`, 672 lines.

**Good**
- A real grid: the sidebar sits beside a `min-w-0` content column, and the content column opens no stacking context (:6-13, :388-391).
- A collapsible icon rail at `lg` and up, persisted in `localStorage 'levo_dash_sidebar_collapsed'` (:130-138, :276-373).
- A spring drawer below `lg` that travels in the RTL-correct direction via `m.inline`. It focuses its first item, handles Escape and returns focus (:533-672).
- Sections and badges (:36-59, :339-348).
- `aria-current`.
- A topbar portal slot `#dash-topbar-slot` (:67-73, :405-406).
- The `--admin-main-pb` sticky-footer contract (:503-519).
- Hand-written trilingual `STRINGS` (:76-128).
- **Zero physical-direction classes.**

**Not reusable as-is**
- A hard-coded palette: `#18181b`, `#09090b`, `#708238`, `#D4AF37`.
- `tracking-widest uppercase` labels (:291, :308).
- A hard-coded "L" logo.
- **Admin and community coupling:**
  - `GET /api/community/my-store` on every mount (:220-230)
  - `goToMyStore` → `/community/store/:id` (:242-250)
  - a Levo Community link
  - a "View My Levo Page" card (:356-372)
- A **stub notifications panel**: "no notification backend exists" (:455-470), although `NotificationBell` and `/api/notifications` exist.
- Hand-rolled language and user dropdowns: absolute-positioned, no `Anchored`, no menu keyboard, no motion (:429-499).
- The drawer is **`z-[900]`** with its own `body.style.overflow` lock (:564-568, :598). It is outside `UI_LAYERS` and `acquireModalLock`, so it sets no `data-overlay-open`.
- It renders a **nested `<main>`** (:512) inside the full-screen shell's `<main>` (`App.tsx:540`).
- It is state-driven (`activeTab`/`onTabChange`, :61-66), so there are no URLs.
- There is **no phone bottom navigation**; every switch on a phone costs a drawer round trip.
- The drawer breakpoint is `lg`, i.e. 1024px, so an iPad in portrait gets a drawer.
- There is no search, no quick actions and no status.

**Pinned hooks to preserve if it is refactored**
- `data-action="open-sidebar"` and `data-tab` are used by 8 Playwright scripts (`scripts/e2e-product-form.mjs:253` and others).
- `badge?: number` and `item.badge` (at least three occurrences) are pinned by `supportConsoleClient.test.ts:172-181`.
- `useCommunityAccess` and `may_enter === false` are pinned by `communityGate.test.ts:616-630`.
- `admin-main-pb` is grepped by the live workflow (`verify-live-product-template.yml:109`).

**Verdict:** extract the layout mechanics into a presentational `AppShell`. `DashboardLayout` becomes a thin admin adapter that keeps its hooks, and `MerchantShell` becomes a second adapter.

### 2.6 What is in the entry bundle today (measured on the fresh `dist/`, gzip level 9, as the test measures)

| Measure | Now | Budget (test line) | Headroom |
|---|---|---|---|
| Entry `index-DodSXBlO.js` | **70.3 KB gz** (221.5 KB raw) | 120 KB (`bundleBudget.test.ts:52`) | 49.7 KB |
| Initial payload (entry plus its static closure) | **198.6 KB gz**: entry 70.3, `vendor-react` 72.7, `vendor-motion` 44.0, `vendor-i18n` 11.6. The last three are `modulepreload` links in `index.html`. | 240 KB (:61) | 41.4 KB |
| Largest single chunk | `vendor-charts` 116.8 KB gz (lazy only) | 250 KB (:54) | — |
| CSS, all files | **44.3 KB gz**: `index-*.css` 36.2 (263,777 B raw, render-blocking), `Auth-*.css` 7.2, `theme-*.css` 1.0 | 60 KB (:63) | 15.7 KB |
| Must never be in the eager closure | `vendor-charts, vendor-qr, vendor-webgl, Bundles, BundleDetail, BundlesShelf` (:213) | — | — |
| Must have their own chunks | Admin, MerchantDashboardPage, Wallet, Checkout… plus all vendor groups (:228-256) | — | — |

**Chunk inventory**
- 237 JS chunks, of which **112 are under 1 KB gz**. Most are lucide per-icon chunks shared between lazy routes. For example, the `MerchantDashboardPage` closure is 38 files and `Storefront` is 20.

**Entry composition** (sourcemap attribution, raw bytes of 214 KB)

| Area | Raw size |
|---|---|
| `src/lib` | 33.4 KB |
| `src/components/home` | 24.4 KB |
| `src/components/ui` | 24.1 KB |
| lucide icons | 20.2 KB |
| `App.tsx` | 14.4 KB |
| `pages` | 13.4 KB (Home 7.9) |
| `search` (LiveSearch) | 10.4 KB |
| `notifications` (Bell) | 7.6 KB |
| `EmailVerifyBanner` | 7.3 KB |
| `onboarding/strings` | 6.7 KB |
| `Header` | 5.9 KB |
| `useRail` | 5.5 KB |
| `BottomNav` | 4.2 KB |
| `subscription/tierMeta` | 4.1 KB |

About **95 KB raw (~44% of the entry, roughly 30 KB gz by proportion)** is main-shell and home-only code. A merchant-subdomain visitor downloads, parses and compiles it but never renders it.

**Merchant-subdomain first load, by code path**
1. `index.html` (17.8 KB)
2. The entry and the three preloaded vendor chunks plus 36.2 KB of render-blocking CSS and Google Fonts (Cairo, plus the 4.8 KB Kurdish patch for ckb only)
3. `GET /api/storefront/resolve`, after the JS has executed
4. The `Storefront` chunk, 11.5 KB own and **20.1 KB gz** of closure beyond the initial payload (24.0 KB with StorefrontProduct)
5. The storefront's own API calls

That is about **219 KB gz of JS** before the storefront can render. It includes three serial network phases after the HTML: JS → resolve → chunk → data.

**Afterwards:** the idle prefetch pulls **89.6 KB gz**, of which **47.7 KB gz** (the apex Product page and catalogue) a storefront visitor never uses. `StorefrontProduct` is *not* prefetched.

### 2.7 Rules that keep the storefront fast today (sources)

**Budgets and splitting rules**
- Budgets: entry 120, initial 240, chunk 250, CSS 60. The test builds `dist/` when it is stale and fails rather than skips (`bundleBudget.test.ts:1-30, 93-158`).
- A lazy-only list must never appear in the eager closure (:205-220). The split must be real (:223-260).
- Storefront pages must be lazy (`firstPaintAndFonts.test.ts:27-40`; `App.tsx:13-35`).
- The mascot is lazy and its fallback is `null`. Every lazy tree sits under a ChunkBoundary (only three exist).
- `manualChunks` groups by *when* code is needed, never "all of node_modules" (`vite.config.ts:18-42`). `ogl` is split from motion so it stays out of the eager closure (:22-29).

**Loading and fonts**
- Idle prefetch of the buying path rather than eager imports (`App.tsx:213-237`).
- The font is linked from `index.html`, not `@import`ed (`index.css:53-61`).
- `unicode-range` makes the Kurdish patch cost Arabic and English visitors nothing (`index.css:27-30`).
- The service worker registers after `load` (`main.tsx:43-95`).

**Things that must not ship to customers**
- No Studio code, iframe or prefetch (`store-isolation.test.ts:122-210`).
- No `dark:` variant.
- No merchant-controlled styling: an accent is a *preset name* (`Storefront.tsx:56-64`), there is no `dangerouslySetInnerHTML`, and no merchant value may appear in an inline style (`storefrontIsolation.test.ts:115-140`; `docs/MERCHANT_STORES.md:301-313`).
- Images must be platform-issued keys (`MERCHANT_STORES.md:315-344`).

**Gaps found (all by code reading)**
- Idle prefetch is not host-aware (`App.tsx:521`).
- Apex chrome sits in the entry for every host.
- Resolve blocks first render on every host (`App.tsx:527`).
- The `StorefrontApp` scroller is not `#main-scroll-container`. On subdomains, therefore:
  - the modal lock does not lock the actual scroller (`Overlay.tsx:97`)
  - scroll reset and restore on navigation is a no-op (`App.tsx:483-516`)
  - the language-swap animation has no `<main>` to target (`index.css:1207-1212`)
- The full-screen tree has no ChunkBoundary.

---

## 3. i18n conventions, the Sorani policy, RTL enforcement

### 3.1 `src/LanguageContext.tsx`

- **API** (:6-17): `lang: 'ar'|'en'|'ckb'`, `setLang`, `t(key)`, `loc(ar, en, ckb?)`, `dir`.
- **`loc` falls back to Arabic for ckb, never to a machine translation** (:10-15, :55-59, :111-112). There is also a module-level `loc` for non-component code.
- **`t(key)`** reads `translations[lang][key] || translations.en[key]` (:107-109). It falls back to **English**, which is inconsistent with `loc`.
  - It is latent today: `translations.ts` has 255 keys in each language, with no empty values; ckb equals ar only for 7 brand tokens (PETG, PLA, PLUS…).
  - It becomes live the moment someone adds a key with an empty ckb.
- **Default language** is Arabic (never the browser locale), stored under `localStorage 'levo_lang'`, with legacy `ku` migrated to `ckb` (:21, :29-48).
- An effect writes `document.documentElement.dir/lang` (:117-121). `index.html:39` ships `lang="ar" dir="rtl"`, so an en or ckb session paints RTL Arabic first and then flips.
- **`setLang` persists the choice to the account** (`PATCH /api/profile`), but boot never *reads* `user.locale` (`lib/api.ts:313`). Because storage is per origin, **a merchant subdomain does not inherit the apex language**. That will be visible when a merchant moves between `levonis-iq.com/merchant` and `store.levonis-iq.com/admin`.
- The language-change animation sets `html[data-lang-swap]` (:150-167, `index.css:1198-1218`).

### 3.2 String conventions (measured)

- **`loc(ar, en, ckb?)` inline** is the dominant pattern: **2,889 calls in 115 files**, about 502 of them two-argument, where ckb gets the Arabic.
- **Per-file `STRINGS/COPY = {ar, en, ckb}` tables** appear in about 64 files, e.g. `AsyncStates.tsx:74-144` and `DashboardLayout.tsx:76-128`.
- **`t('key')`** from `translations.ts` (255 keys × 3) has 183 call sites. It is its own chunk, `vendor-i18n`, 11.6 KB gz in the initial payload.
- **Legacy two-language ternaries** `dir === 'rtl' ? 'Arabic' : 'English'` appear 334 times in 24 files, e.g. `AdminHomeSettings.tsx:395`, and `lang === 'en' ? …` 68 times. Do not copy them. They are policy-compatible only by accident (ckb is RTL, so it gets the Arabic).
- **Numbers and LTR islands:** `dir="ltr"` appears 625 times, `dir="auto"` 95 and `<bdi>` 11 (e.g. Countdown). Price, SKU and URL runs are LTR islands.
- **Brand:** "Levonis" is always Latin script (`brandName.test.ts:49`, DECISIONS row 99).

### 3.3 The Sorani policy (quoted)

**Governing decision**
- `docs/DECISIONS.md:11`, row 2: *«الترجمة الآلية للنصوص الحرة ممنوعة (لا AI في الموقع): المعتمد قاموس محلي + قالب TXT خارجي، والنص المجهول يبقى بالعربية بحالة "بحاجة ترجمة".»* In English: machine translation of free text is forbidden and there is no AI in the site; the approved sources are a local dictionary and an external TXT template; unknown text stays in Arabic, marked "needs translation".
- The same file at `:10`, row 1: "Iraqi Kurdish" = Sorani (`ckb`, Arabic script).

**In code**
- `src/LanguageContext.tsx:11-14`: *"When no Sorani (ckb) text is supplied, ckb falls back to Arabic — the source language — never to a machine translation."*
- `src/components/ui/AsyncStates.tsx:123-127`: *"THESE FOUR CARRY THE ARABIC TEXT ON PURPOSE. Sorani is never generated here; a Kurdish sentence nobody who speaks Kurdish wrote is worse than an Arabic one the reader can follow. The owner writes these four by hand … and the Arabic stands in until they do."*
- `src/lib/busy.ts:41-45`: *"a new reason cannot be added without someone writing — not generating — the Arabic, the English and the Sorani for it."*
- `AppBusy.tsx:62-64` and `:117-125`: *"Every sentence here is copied verbatim from a place a human already wrote it … No Sorani was written for this file; all of it already existed."*
- `src/pages/Admin.tsx:225-226`: *"No third `loc` argument: a Kurdish-reading admin gets the Arabic label, and the Sorani is the owner's to write by hand."*
- **The marker convention:** `src/components/orders/ReviewSheet.tsx:122-126`: *"OWNER: the Kurdish (Sorani) wording is yours to write by hand. Every string added in this round carries the ARABIC text on purpose — it is never machine-translated Kurdish"*, with `// OWNER: Sorani to be written by hand.` on each line. The same marker appears at `OrderCard.tsx:70` and `AdminSerials.tsx:223-291`.
- **Authored content:** `worker/lib/homeContent.ts:12-16`: *"PER-LANGUAGE TEXT IS OWNER-AUTHORED, NEVER TRANSLATED … `pickText` falls back to the first one the owner actually filled in."* `LocalizedText` is at :19; `pickText` at :95-100 uses the fallback orders en→ar→ckb, ckb→ar→en and ar→en→ckb.
- `docs/TEMPLATE_GUIDE.md:36-44`: *"Do not machine-translate or invent — an empty field is honestly tracked as a missing translation."*

**Tests that pin the policy**
- `busyOverlay.test.ts:409-426`: "no Sorani was invented for this screen". Every ckb sentence must exist verbatim elsewhere.
- `cartPreorderQuotaWording.test.ts:284-303`: "NO SORANI IS INVENTED", and the ckb must equal the Arabic when nobody wrote Kurdish.
- `communityGate.test.ts:609-614` and `:638-648`: "NO NEW SORANI"; only existing keys may be used.
- `walletTypedDinars.test.ts:43-50`: "Sorani may never be machine written", so no new refusal string.
- `templateBrandResolve.test.ts:159`: "no invented Sorani".
- `translate.test.ts:70-78`: the deterministic product translator degrades ckb and never fabricates.
- `farmAdminPanel.test.ts:315`: "Sorani written by hand".
- **Nuance:** for the fixed customer-facing refusal codes, hand-written ckb exists and must *not* be a copy of the Arabic (`refusalStrings.test.ts:64-76`).

### 3.4 What this means for new merchant-workspace copy

1. **Reuse existing hand-written ckb verbatim.** The current merchant dashboard already carries ckb for almost every label (e.g. `MerchantDashboardPage.tsx:113-133`). Moving it into a shared nav table keeps those strings; do not "improve" them.
2. **For new phrases with no Kurdish,** use `loc(ar, en)` or `ckb: <arabic>` together with `// OWNER: Sorani to be written by hand.` Never generate Kurdish, whether by an LLM or from a dictionary.
3. **Do not add translations.ts keys with an empty ckb** while `t()` falls back to English. Fix `t()` to fall back to `ar` for ckb, or put the Arabic in.
4. **Merchant-authored storefront text** (block headings, banners, about) must be `LocalizedText{ar,en,ckb}` rendered with `pickText`. No auto-translate button.
5. **Any new busy reason** (e.g. `publish`) needs a human-written trilingual label (`busy.ts:41-45`). The same goes for new `ChunkBoundary`-style fallbacks.
6. **Keyboard shortcuts** must match on `e.code` (e.g. `KeyK`), not `e.key`, or they die on Arabic and Kurdish layouts.

### 3.5 RTL/LTR enforcement

**At runtime**
- `html[dir]` is set by LanguageContext.
- Portals copy `dir` (`Overlay.tsx:296`, `:529`; DashboardLayout root `:274`).
- `useMotion()` returns `dir` as ±1 and `inline(px)` (`motion.ts:127-143`). Tab panels, drawers and indicators travel in the writing direction.
- Segmented maps arrow keys to the writing direction (`Segmented.tsx:90-107`).
- `Anchored` aligns in logical terms and converts to physical coordinates only at the boundary (`Overlay.tsx:460-470`).

**In CSS**
- Arabic and Kurdish letter-spacing is neutralised and the tight line-heights have floors (`index.css:687-699`, `docs/MOTION.md:270-288`).
- `.lv-choice` mirrors its selected edge (`:241-245`).
- The Kurdish font patch (`:43-50`).

**The class convention**
- Logical utilities: 603 uses (`ms/me/ps/pe/start/end/text-start/border-s/rounded-e…`). Physical: 115, including 11 in `Storefront.tsx`, e.g. `:263, 278, 300, 877, 1636, 1647`.
- `rtl:rotate-180` is used on arrows 52 times.

**Enforced only per surface by tests (there is no global lint)**
- `subscriptionPage.test.ts:352-356`
- `adminMembershipsModal.test.ts:338-347`. The strictest: no `ml/mr/pl/pr`, no `left/right-N`, **no `rtl:`/`ltr:` branching**, no `toLocaleString(`/`Intl.` outside the shared helpers.
- `farmAdminPanel.test.ts:439-446`, the most complete physical regex.
- `stockAlertUi.test.ts:547`
- `productSignalsPlacement.test.ts:153`

**Input zoom:** a 16px coarse-pointer floor (`index.css:483-500`). `inputZoom.test.ts:74-90` forbids arbitrary sizes above 16px on text controls; pinch zoom must stay allowed (`:92-102`).

---

## 4. Test conventions that pin UI

### 4.1 How it works

- Plain `node --import tsx --test tests/*.test.ts` (`scripts/test-all.mjs`).
- **There is no DOM runner.** UI rules are **source-rule tests**: regexes over `src/`, with comments stripped where a rule is also described in prose, e.g. `darkOnlyTheme.test.ts:153`.
- The Playwright scripts `scripts/e2e-*.mjs` drive a real build plus `wrangler dev` (`e2e-ui.mjs:1-19`). They pin `data-*` hooks and computed styles.
- **Live verification greps the served bundles for string literals and `data-*` values.** `scripts/check-live-markers.mjs:19-58` runs inside `npm run build` and fails the build if any marker from the workflow's product-form step is missing. Those markers include SafeImage's `'تعذر تحميل الصورة'` (`SafeImage.tsx:14`; `verify-live-product-template.yml:304`).
- **House rule, from the tests' own messages:** when code moves, update the pin rather than delete it, e.g. `serviceSlots.test.ts:130` *"this check needs updating, not deleting"*.

### 4.2 Pins a new merchant shell or builder will touch or must satisfy

| Test | What it pins | Impact |
|---|---|---|
| `uiSystem.test.ts` | Semantic tokens and the restrained `lv-choice` (:16-27); portals and `UI_LAYERS` (:54-63); the modal hides the bottom nav, legacy z-values are lifted, the Sheet has safe-area padding (:65-73); `App.tsx` contains `h-[100dvh] min-h-0` (:78); in-flow bars and never `fixed bottom-0` (:99, :109); labelled fields (:113-119) | Keep `Overlay` and the full-screen wrapper strings. New merchant bars should be in-flow. |
| `darkOnlyTheme.test.ts:148-177` | No `dark:` anywhere; no tailwind config or custom dark variant | Store themes must not use `dark:`. Scope theme tokens with a data attribute or class. |
| `inputZoom.test.ts:60-102` | 16px floor; no `text-[>16px]` on inputs; pinch allowed | Builder inputs follow it. |
| `firstPaintAndFonts.test.ts:27-80` | Storefront pages are `React.lazy`; AppIntro is lazy; **exactly 3 `<ChunkBoundary>` in App.tsx** | Adding a boundary for a new full-screen or merchant tree means updating this count, and it should (§2.1). |
| `bloubNavigation.test.ts:54` | `<AppBootstrapLayer/>` within 100 characters of `<AppContent/>` | Do not insert a shell between them. |
| `busyOverlay.test.ts:428-485` | `AppBusy` is statically imported exactly once; `RouteFallback` holds `useBusy(true,'route')`; `NavigationRouter` wraps `AppBusy` | Keep these. New busy reasons need hand-written copy. |
| `bundleBudget.test.ts:172-272` | Budgets; the lazy-only list; required chunk names, including `MerchantDashboardPage` | If the page is renamed or split, update the names. Add new lazy-only names (§6.5). |
| `serviceSlots.test.ts:119-148` | Parses `const isFullScreenRoute = [...]` and the block between `if (isFullScreenRoute) {` and `const navHidden = isBottomNavHidden` | Moving `/merchant` into the full-screen tree must keep these literals, and every route under a listed prefix must be declared in that block (a missing one gives a blank page). |
| `bottomNavVisibility.test.ts:9-42` | The route set of `isBottomNavHidden` | If `/merchant` stays in shell C, adding it here needs new assertions. |
| `adminSurfaceDesign.test.ts:28-49` | `isMascotHiddenRoute('/admin')` is true, `'/administration'` is false; `data-route-hidden` | Hiding the mascot on `/merchant` needs `isMascotHiddenRoute` extended and asserted. |
| `storefrontIsolation.test.ts` | Host gate before `<Header />` (:102-113); no hostname parsing in StoreContext (:89-100); **merchant styling only via the preset table, no `dangerouslySetInnerHTML`, no merchant value in an inline style** (:115-140); `noopener noreferrer` (:142-156); **no tier-string decisions in `MerchantStart`, `MerchantDashboardPage` or `StoreCta`** (:158-175); restrictions explained through `reasonText` (:177-186) | The builder's block renderer files must obey the styling rules. Extend the rule to them instead of bypassing it. |
| `communityGate.test.ts:616-636, 710-717` | `useCommunityAccess` plus `may_enter === false` in DashboardLayout and Storefront; the `{communityAccess?.may_enter !== false && (<a href={mainHref('/requests')}` pattern in `MerchantDashboardPage.tsx` **and** `SalesTabs.tsx` | Moving Overview or quick actions to new files means moving the pin with them. |
| `printQuoteUi.test.ts:88-97` | `MerchantDashboardPage.tsx` mentions `CostingTab`; customer pages do not | Same. |
| `profilePrintersMoved.test.ts:62-75` | `MerchantDashboardPage.tsx` has `id: 'printers'` and `<PrintersTab` | Same. |
| `supportConsoleClient.test.ts:172-181` | DashboardLayout `badge?: number` and at least three `item.badge` | Keep them in AppShell and DashboardLayout. |
| `asyncStates.test.ts:63-91` | Bundles pages use `ErrorState` and the shared Skeletons, and have no `animate-spin` or `text-red-400` | Model the merchant equivalent on it (§4.4). |
| Sorani pins (§3.3), `brandName.test.ts:49`, `refusalStrings.test.ts` | No invented ckb; Latin "Levonis" | Every new string. |
| `store-isolation.test.ts:122-210, 355` | No Studio embed, iframe or prefetch; no runtime service imports | The builder must not iframe or preload Studio, or import `services/*`. |

### 4.3 Browser and live hooks that must survive

- **Playwright hooks:**
  - `[data-action="open-sidebar"]`, used by 8 e2e scripts
  - `data-tab`
  - `data-tab-indicator` (exactly one per strip), `data-tab-panel`
  - `data-overlay-panel`, `data-overlay-scrim`, `data-sheet-grabber`
  - `.material` with an unprefixed `backdrop-filter` in the served CSS
  - the press rule and the 100ms timing
  - The motion and material checks are in `scripts/e2e-motion.mjs:101-283`.
- **Live markers:** SafeImage `'تعذر تحميل الصورة'` is checked at build time; `admin-main-pb` is checked by the live workflow.

### 4.4 Proposed new pins for the merchant workspace (modelled on existing ones)

- **Merchant source rules:** merchant files import `AsyncStates` and `Skeleton`, and contain no `animate-spin`, no `text-red-400`, no `window.confirm`/`alert(`, and no `#hex` literals outside a token file. Model: `asyncStates.test.ts:63-80`.
- **Logical properties only in `src/**/merchant/**`**, including no `rtl:`/`ltr:` branching and no raw `toLocaleString(`. Model: `adminMembershipsModal.test.ts:338-347` plus the `farmAdminPanel` regex.
- **Touch targets:** every interactive class in the shell has `min-h-11` or `lv-button`. Model: `stockAlertUi.test.ts:529-531`.
- **Chunk isolation:** `MerchantShell`, `StoreBuilder`, `MerchantAnalytics` and any DnD vendor chunk go into the `lazyOnly` list, and the storefront block files may not import from `builder/`.
- **The Sorani rule:** new ckb strings must already exist in the repo or equal the Arabic, with the `OWNER` marker.

---

## 5. Reusable pieces vs what is missing

### 5.1 For the app shell

**Reusable now**
- Layout mechanics from `DashboardLayout` (grid, rail, drawer springs, sections, badges, topbar slot).
- `Overlay`, `Sheet`, `Anchored` and `UI_LAYERS`.
- `NotificationBell`. It is already in the entry. It is a desktop dropdown and a phone sheet, with polling paused when the tab is hidden. Its kinds already include merchant events: `print_request_match`, `offer_received`, `offer_accepted`, `order_update`.
- The `LiveSearch` combobox mechanics, for a scoped merchant search.
- `Segmented` and `TabStrip` for in-page segment controls.
- `FarmTabBar` as the model for a mobile bottom tab bar (in flow, not fixed; travelling indicator; locked tabs explain why).
- `useIsWide` for switching between table and cards.
- `AsyncStates`, `Skeleton`, `SafeImage`, `Spinner` (in-button).
- `AppBusy`/`useBusy`, only with new hand-written reasons.
- `pageCache` for stale-while-revalidate tab returns. Not for money (`lib/pageCache.ts:1-40`).
- `StoreCta.reasonText` for the store-status explanation.
- The `MerchantMe.can`/`selling` capabilities, for gated nav with reasons.
- `Storefront.tsx`'s accent presets, for status and brand.

**Missing:** everything listed in §1.5 under Shell/Controls/Feedback/Data. The most urgent:
- AppShell, SideDrawer, BottomTabBar
- ConfirmDialog, Toast
- Field, Switch
- DataList, Money
- Overlay focus management
- A shell-aware bottom inset variable (today toasts use the customer `--nav-stack`)
- One scroll-owner contract per shell

### 5.2 For the store builder

**Reusable**
- The block-list precedent: the admin home layout is ordered and toggled data (`sectionVisible` / `orderOf`, `Home.tsx:228-241`), and Home sorts its sections by it (`Home.tsx:320-371`).
- The server-side normalisation precedent: `worker/lib/homeContent.ts` validates on write *and* read, with `safeLink` :62, `safeImage` :72, caps `MAX_BANNERS_PER_SLOT`/`MAX_SECTION_ITEMS` :51-52, `LocalizedText` and `pickText`.
- The storefront's existing sections as candidate blocks: Products, Sections, Deals, Services, Showcase, Reviews, About (`Storefront.tsx:645-1412`).
- The accent preset table.
- `ImagePicker`, which accepts platform-issued keys only.
- The motion maths: `project`, `rubberband`, `nearestSnap`, `VelocityTracker`, `DRAG_THRESHOLD_PX` (`motion.ts:164-226`).
- `useRail`.
- The adminProducts `Modal` dirty guard and visualViewport logic.
- The `Segmented` control, for the device toggle.

**Missing**
- A typed block schema and registry.
- Draft vs published state.
- Undo/redo.
- Autosave with a conflict guard.
- An inspector panel: a side panel on desktop, a sheet on phones.
- DnD with a keyboard alternative. `AdminHomeSettings.tsx` pairs HTML5 drag (`:414-415`), which does not work reliably on touch, with ChevronUp/Down move buttons (`:434-447`). Its copy is two-language only (`:395`).
- **Container-query-based blocks.** There is no `@container` usage in `src/`.
- **An iframe preview is impossible.** The CSP is `frame-ancestors 'none'` and `X-Frame-Options: DENY` (`worker/lib/securityPolicy.ts:99, 122`), and `frame-src` allows Google only (:119).

### 5.3 Libraries present and absent (`package.json`, installed versions)

**Present**
- `motion` / `framer-motion` 12.43.0. `vendor-motion` is 44.0 KB gz, eager, already paid. It includes `Reorder.Group/Item` (`node_modules/framer-motion/dist/es/components/Reorder/`), `drag`, `useDragControls`, layout animation and `AnimatePresence`. That is enough for single-axis block reordering with touch.
- `gsap` 3.15. Its only importer is `ScrollReveal.tsx`, which is dead code (not imported). Eight decorative components are unimported: ScrollReveal, CircularGallery, Counter, GooeyNav, LogoLoop, PixelCard, Stack, TrueFocus.
- `recharts` 3.10 (`vendor-charts`, 116.8 KB gz, lazy only). The existing `Spark` is a hand-rolled SVG for tiny series.
- `lucide-react` 0.546 (per-icon ESM, producing many sub-1 KB chunks).
- React 19.2, react-router 7.18, Tailwind 4.3, Vite 6.4.

**Absent**
- Any DnD library (dnd-kit, react-beautiful-dnd, sortable)
- Headless UI, Radix or floating-ui
- Virtualisation
- A form or validation library
- An i18n library
- A state library (`immer` exists only transitively)

---

## 6. Recommendations

### 6.1 Design-system additions, prioritised (all in `src/components/ui/`, ar/en/ckb per §3.4)

1. **Overlay hardening.** It is shared, so the whole app benefits.
   - Port the adminProducts `Modal` behaviours into `Overlay`: a focus trap, opener focus restore, a global overlay **stack** so only the top layer handles Escape, `visualViewport` height, and an optional `dirty` guard.
   - Localise the default scrim label.
   - Accept `children` as a render function, or document the "guard your data" rule (the `AdminKyc` incident).
   - Keep the `data-overlay-*` hooks, the `UI_LAYERS` API and the `pb-[env(safe-area-inset-bottom)]` string.
2. **`Sheet` v2.**
   - `dragHandle` mode: `dragListener={false}` plus `useDragControls` started from the grabber or header, so scrollable content never throws the sheet away.
   - `detents: ['medium','large']` snapped with `project` and `nearestSnap`.
   - `overscroll-contain` on the body.
   - This is what builder inspectors and mobile filters need.
3. **`AppShell`**, presentational, extracted from DashboardLayout.
   - Slots: `sidebar`, `topBar`, `bottomTabs`, `drawer`, `children`.
   - A single scroll owner with an id prop.
   - Breakpoints: phone under 640px (top bar plus in-flow bottom tab bar), 640–1023px (icon rail), 1024px and up (full collapsible sidebar).
   - It uses `UI_LAYERS` and `acquireModalLock` for the drawer and exposes `--shell-bottom-inset` for toasts and sticky bars.
   - Keep `data-action="open-sidebar"`, `data-tab`, badges and `--admin-main-pb` for the admin adapter.
4. **`BottomTabBar`**, generalising FarmTabBar.
   - At most 5 items plus "More", which opens a Sheet listing the remaining nav.
   - Items are 44px or taller, with a travelling indicator and `aria-current`.
   - Locked items use `aria-disabled` and state their reason.
   - They are links (NavLink), not tabs.
5. **`ConfirmDialog`** (title, consequence, destructive styling, cancel) and **`Toast`/`useToast`** (a live region, stacked above the shell inset, auto-dismiss, undo slot). Together these replace about 20 `confirm()`/`alert()` calls.
6. **The form kit:**
   - `Field` wrapper: label `htmlFor`, hint, error with `aria-describedby`, `aria-invalid`.
   - `Input`, `Textarea`, `Select` on `.lv-input`.
   - `Switch`, with `role="switch"` and `aria-checked`, 44px.
   - `Checkbox`.
   - `Button` and `IconButton` components over the `lv-button` classes. IconButton draws small but hits 44px, per `docs/MOTION.md:44-46`.
7. **`DataList`.** A generic list that renders a `<table>` when wide and `<ul>` cards when narrow, only one mounted (the `useIsWide` pattern). It has a sticky action column (the adminTaxonomy pattern), an empty, error and skeleton trio, and row actions in a menu or sheet.
8. **`Card`, `Badge`/`StatusChip`, `KpiTile`**, the last with one accent (not five tints) and tabular numbers. **`Money`**: one formatter (IQD with `ar`/`en` suffix rules, LTR island, `tabular-nums`) replacing `iqd`, `formatIqd` and `DinarPrice`.
9. **`Menu`** on `Anchored`, with a real menu keyboard (roving focus, arrows, Home/End, typeahead, Escape returns focus), and a responsive wrapper: Anchored on pointer-fine or wide screens, Sheet on phones (the NotificationBell pattern). Plus **`useMediaQuery`/`useIsPhone`** to replace the duplicated hooks.
10. **`CommandPalette`**, built from the LiveSearch or CountryPicker combobox mechanics. Matches `e.code` for the shortcut. It is the base for global merchant search.
11. **Dashboard skeletons:** list rows, table rows, KPI row, form and card.
12. **Tabs a11y:** roving focus and arrow keys, `aria-controls` / `role="tabpanel"`, and a `link` mode.

### 6.2 Token work

- Add **semantic app-chrome tokens** used by *all* shells: `--color-accent` (gold), `--color-accent-contrast`, `--shadow-1/2/3`, `--z-*` mirroring `UI_LAYERS` as CSS variables, `--duration-press/quick/ui`, and a **type scale**: `--text-2xs` 11px, `xs` 12px, `sm` 13px, `base` 15px, `lg` 17px, `xl` 20px. Adopt the scale in new code and do not rewrite the 3,440 arbitrary sizes.
- **Retire DashboardLayout's private palette.** `#708238` and `#D4AF37` become tokens.
- Either converge `.ap` onto the semantic tokens or explicitly scope it to admin-only lazy CSS. Do not let merchant UI adopt the purple accent.
- **Density:** a `data-density="compact"` scope. Compact reduces visual size on `pointer:fine` only; the hit area stays at least 44px. This reconciles the owner's admin density requests (`adminProducts/ui.tsx:19-22`) with the ≥44px requirement.
- **Storefront theme tokens.** Turn `Storefront.tsx:56-64` into a module, e.g. `storefront/themes.ts` plus `storefront/themes.css`, exposing `[data-store-theme="teal"] { --store-accent…; --store-surface… }`. Blocks consume `var(--store-*)`. Merchants still choose a **preset name only**, so no merchant string reaches CSS or inline styles and `storefrontIsolation.test.ts:115-140` keeps holding; extend that test to the new files.

### 6.3 Merchant shell architecture

**Routes and placement**
- **URL-driven**, with one config shared by both hosts:
  - `/merchant` Overview, `/merchant/orders[/:id]`, `/merchant/products[/:id]`
  - `/merchant/customers`, `/merchant/reviews`, `/merchant/money`
  - `/merchant/marketing/coupons`, `/merchant/services`, `/merchant/showcase`, `/merchant/sections`
  - `/merchant/printers`, `/merchant/costing`, `/merchant/notifications`
  - `/merchant/store/settings`, `/merchant/store/design` (the builder), `/merchant/analytics`
  - On the subdomain the same tree lives under `/admin/*`. Today only exact `/admin` is routed (`App.tsx:404`); change it to `/admin/*`.
  - The nav config (`{id, to, icon, label: loc(...), section, badge?, requires?: keyof MerchantMe['can'], lockedReason?}`) feeds the sidebar, the drawer, the bottom tabs, "More" and the command palette from **one table**. That table is also where the pinned `id: 'printers'` and `CostingTab` references move, so update those tests.
- **Take `/merchant/*` out of the customer shell.**
  - Add `'/merchant'` to `isFullScreenRoute` and declare the routes inside that block. Keep the `serviceSlots.test.ts` markers, and keep `/merchant/start` declared there too.
  - Extend `isMascotHiddenRoute` to `/merchant`.
  - The full-screen tree currently has **no ChunkBoundary**. Add one, updating `firstPaintAndFonts.test.ts:75-79` from 3 to 4.
  - Result: the customer BottomNav, EmailVerifyBanner and CompleteProfileSheet no longer overlap the workspace.
- **One scroll owner per shell.** Either give the merchant shell's content column an id that `acquireModalLock` also knows, or generalise `acquireModalLock` to lock `[data-scroll-owner]`. Apply the same fix to `StorefrontApp`. Mirror the App's per-location scroll restore inside the shell.

**Layout by viewport**
- **Desktop (1024px and up):**
  - A collapsible sidebar with sections: Operations (Overview, Orders, Custom orders), Catalogue (Products, Sections, Services, Showcase), Marketing (Coupons), Store (Design, Settings, Printers, Costing), Money, Customers and Reviews, Notifications.
  - A top bar with, from start to end: store identity and a status pill (Open/Paused plus the `reasonText` sheet), global search / command palette (⌘K via `e.code`), a Quick actions menu (new product, new coupon, add section), **View store** (`store.url`, new tab, noopener), **Design store**, `NotificationBell`, language, account.
- **Tablet (640–1023px):** an icon rail with the same top bar condensed; search collapses to an icon.
- **Phone (under 640px):**
  - A compact top bar: store avatar with a status dot, title, search icon, bell.
  - An in-flow **bottom tab bar**: Overview · Orders · Products · Store (Design) · More.
  - Lists render as **cards** through `DataList`. Filters, row actions, confirms and inspectors are **bottom sheets** (Sheet v2).
  - Primary actions use a sticky in-flow bar (no `fixed bottom-0`, `uiSystem.test.ts:99`).
  - Use `overflow-x-clip` and `min-w-0` everywhere and no wide tables. Targets are at least 44px.

**Per-section code splitting** (the Admin pattern)
- `MerchantShell` itself is small: layout, nav config, top bar.
- Each section is `React.lazy`, under a section-scoped `Suspense` with a skeleton fallback, so the shell never flickers (`pages/Admin.tsx:101-113, 249`).
- Overview loads first. The rest can be prefetched at idle *inside the workspace only*.

**Data and state**
- Keep capabilities server-driven (`/api/merchant/me`). Never branch on tier strings (`storefrontIsolation.test.ts:158-175`).
- Gate nav items on `can.*` and explain locks.
- Use `pageCache` for non-money lists.
- Put a hold (`useBusy`) only on real commits, with new hand-written reasons.

**Remove**
- The glow blob and the hard-coded hexes.
- The legacy "Merchant Mode" dashboard in `/edit-profile`, or redirect it to `/merchant`.

### 6.4 Store builder architecture

**Blocks as data**
- `StoreDraft = { theme: PresetName, blocks: Block[] }`, where `Block = {id, type: 'hero'|'products'|'sections'|'deals'|'services'|'showcase'|'reviews'|'about'|'banner'|'text', props}`.
- Props are typed per block and hold only `LocalizedText`, platform media keys, internal links and preset enums.
- Normalise on write *and* read on the server, in the style of `homeContent.ts`: `safeLink`, `safeImage`, caps, `pickText`.
- Draft and published versions; publish is explicit.

**One renderer, two consumers**
- `src/components/storefront/blocks/*` is imported by `Storefront` and by the builder preview.
- **Blocks never import builder code.** Editor affordances (selection outline, handles, inline "edit" buttons) wrap blocks from the builder side, e.g. a `BlockFrame`.
- Add a source-rule test for this.

**Preview**
- An in-page `PreviewFrame` (`@container` root, device widths 390 / 768 / 1280 chosen with `Segmented`). Blocks use Tailwind v4 **container-query variants** (`@sm:`, `@lg:`) instead of viewport breakpoints, so the preview is faithful at any editor width.
- An iframe is ruled out by the CSP (§5.2).

**Editing**
- Desktop: a three-pane layout: block list (outline with Reorder), preview, inspector.
- Phone: preview first, with a "Blocks" sheet (reorder, add, remove) and an inspector sheet with `detents`.
- Reorder with `motion`'s `Reorder` and `useDragControls` from a grip handle only, **plus** move-up/down buttons and a keyboard path for accessibility.
- Undo/redo stack.
- Autosave the draft with a dirty guard.
- A publish hold with a new busy reason (hand-written copy).

**Theming:** preset-only (§6.2). Merchants cannot enter a colour or class.

### 6.5 Keeping builder, dashboard and analytics out of the customer's first load

**Hard rules to add as tests (extend `bundleBudget.test.ts`)**
1. Add `MerchantShell`, `StoreBuilder`, `MerchantAnalytics` and any `vendor-dnd` (only if a library is added later) to the **lazy-only list** (:213). `vendor-charts` is already there; merchant analytics must reuse it, not inline recharts.
2. Add a **Storefront closure budget**: for example, `Storefront` plus `StorefrontProduct` beyond the initial payload at 30 KB gz or less (24.0 today).
3. Add a **MerchantShell chunk budget**: 25 KB gz or less for the shell, and 60 KB or less for any section chunk.
4. Keep `MerchantDashboardPage`, or its successor, as a named chunk.
5. Source rule: nothing under `src/pages/Storefront*`, `src/components/storefront/**` or the entry may import `merchant/**`, `builder/**` or `recharts`.

**CSS**
- Tailwind v4 compiles every scanned utility into the render-blocking `index-*.css` (36.2 KB gz; CSS headroom is 15.7 KB).
- Build merchant and builder UI from **existing** utilities, tokens and `lv-*` classes.
- Put bespoke builder or workspace CSS in a CSS file imported by the lazy module. Precedents: `adminProducts/theme.css` → `theme-*.css` at 1.0 KB, and `auth/auth.css` → `Auth-*.css`.
- Avoid one-off arbitrary values.

**No new eager dependencies.** `motion` is already in the initial payload; use it for DnD and sheets. `gsap` should stay unused and could be removed with the dead decorative components (a separate cleanup).

**Storefront wins found in this audit, each a small change**
- **Host-aware idle prefetch.** On a merchant host, prefetch `StorefrontProduct` and `Cart`, not `Products` or `Product`. That saves **47.7 KB gz** per storefront visit. It needs the resolve answer, so run it after `resolved` and key it on `store`, not on the hostname (pinned).
- **Start the resolve request earlier.** Options:
  - `<link rel="preload" as="fetch" href="/api/storefront/resolve" crossorigin>` in `index.html`. Verify that it matches `api.get`'s request mode and credentials.
  - Or the planned `/api/v1/boot`.
  - Longer term: serve `/` through the Worker so it can embed the host answer as a CSP-safe `<script type="application/json">` data block (`script-src 'self'` forbids inline scripts, `securityPolicy.ts:113`) and emit host-specific `modulepreload`. Cost: one Worker invocation per document request.
- **Optional, measure first.** Move apex-only chrome (Header, BottomNav, LiveSearch, NotificationBell, EmailVerifyBanner, CompleteProfileSheet, Home, `home/*`) out of the entry into a `MainShell` chunk, started in parallel with the resolve on the apex. This takes about 95 KB raw / ~30 KB gz out of every merchant-storefront parse, but it adds a chunk to the apex critical path unless it overlaps the resolve wait. Decide with a real-device trace.
- **Give `StorefrontApp` a scroll owner and a `<main>` landmark** (§2.7 gaps).
- **Consider a `manualChunks` group for lucide icons shared by lazy routes.** 112 chunks under 1 KB gz mean many requests; a storefront visit fetches about 20 small files after resolve.

### 6.6 Suggested sequencing and risks

1. **Primitives first:** Overlay hardening, Sheet v2, ConfirmDialog, Toast, Field, Switch, Button, DataList, Money, useMediaQuery. Each is additive, so existing pins stay green. Add the §4.4 pins for new code.
2. **Extract `AppShell`** from DashboardLayout behind the same props, keeping the e2e and test hooks. Admin keeps working.
3. **`MerchantShell`:**
   - Nav config and URL routes (`/merchant/*` in the full-screen tree; `/admin/*` on subdomains), plus a ChunkBoundary. Update `firstPaintAndFonts`, `serviceSlots`, `adminSurfaceDesign`, `printQuoteUi`, `profilePrintersMoved` and `communityGate` where their pins move.
   - Wrap the existing tabs as lazy sections unchanged.
   - Then migrate each tab off the local kit (native `confirm`/`alert` → ConfirmDialog/Toast; table → DataList; tokens).
4. **Storefront blocks and themes:** extract the renderer from `Storefront.tsx` into blocks with container queries and preset themes, and extend `storefrontIsolation` to the new files.
5. **Builder** (lazy): outline with Reorder, preview frame, inspector sheets, draft and publish.
6. **Throughout:** keep the Sorani rule. Reuse existing ckb verbatim, otherwise Arabic with the `OWNER` marker.

**Risks**
- Pins keyed to file paths and exact strings will fail loudly as code moves. That is intended; move them, don't delete them.
- The language is not shared across origins, so a merchant switching between apex and subdomain may see different languages. Consider adopting `user.locale` at boot when there is no local choice.
- `t()`'s English fallback will contradict the policy the day an empty ckb key is added.
