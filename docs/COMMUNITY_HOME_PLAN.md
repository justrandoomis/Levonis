## Levo Community Home V3 — build plan («العدد», rebuilt on the measured repo)

Synthesised from the aggregate winner «العدد» (72 pts vs 71 / 60), with the Workbench's budget process, in-page products list, `--nav-stack` docking, count-roll/follow micro-interactions and "empty state is the task"; and Open Workshop's one post card with `kind`, commerce row on the post, «منشورات جديدة» pill, hidden-at-zero counts and «إبلاغ/إخفاء». Every class below was checked against the fresh build (`dist/assets/index-DuN1lTsq.css`); every file path exists unless marked **NEW**.

**Measured constraints.** All stylesheets gzip to **61,387 B against 61,440 B** (`tests/bundleBudget.test.ts` `CSS_BUDGET = 60*1024`): 53 B headroom. Absent from the build, so never used: `text-ui-*`, `text-snow/90|70`, `ring-border-subtle`, `sm:rounded-3xl`, `sm:aspect-[16/10]`, `lg:aspect-[4/3]`, `col-span-3`, `lg:col-span-2|3`, `inline-grid`, `pb-40`, `bg-sage/20`, `w-80`. Present and used instead: `text-[11px]…text-[28px]`, `text-snow/80`, `aspect-video`, `lg:aspect-[12/5]`, `sm:aspect-[4/3]`, `grid-cols-[auto_minmax(0,1fr)]`, `lg:grid-cols-[minmax(0,1fr)_20rem]`, `h-px`, `snap-mandatory`, `overscroll-x-contain`, `w-[132px]`, `w-[148px] sm:w-[168px]`, `w-[200px]`. Data that exists uncommitted: `migrations/0153_community_posts.sql` (one `community_posts` table, `kind IN project|post|tutorial|timelapse|before_after`, `community_post_media`), `worker/routes/communityPosts.ts` (`GET /api/community/posts|posts/trending|posts/:id|creators/:username`, `postHref = /community/projects/:id`). Likes/saves/comments/creator-follows (0154) do not exist yet.

### 1) Concept

The community home is typeset like an issue of a maker magazine: a masthead, four verbs, one cover story, then numbered sections in the owner's order — photographs on the canvas separated by hairlines, never boxes on boxes. Gold is the ink (kickers, section numbers, the tab underline, the budget figure, the liked heart) and the one accent verb «اطلب طباعته»; sage stays the Follow verb the directory already speaks. Every card is one stretched link with its buttons as siblings, every post is a `kind` of the same row 0153 defines, and commerce reads as a spec caption (printer · material · store) that is itself a link. It is built from what ships — Community.tsx's floating bar, TabStrip/TabPanels, StoreCard's link pattern, the home banners' scrim treatment — and adds one CSS rule.

### 2) First viewport

Mobile 390×844 (usable ≈ 728 above `--nav-stack`; on 360×640 the same stack ends at 502 ≤ 524):

```
┌───────────────────────────────────┐ 0
│ ⟵  [🔍 ابحث في المشاريع         ] │ 64   material scroll-edge sticky top-0 h-16
│ ── مجتمع ليفو · ما صنعه الصنّاع    │      kicker: h-px w-4 bg-gold + text-[11px] text-gold
│ مجتمع ليفو                        │ 127  h1 text-[24px] font-black leading-tight
│  (◎)      (◎)      (◎)     (◎)    │      Shortcut discs 48px (sage disc = primary)
│ اطلب طباعة  شارك مشروعًا  طلباتي  أتابعهم │ 223
│ لك │ أتابعهم │ المشاريع │ طلبات الط… │ 283  strip sticky top-16, bg-gold underline, scrolls
│ ┌───────────────────────────────┐ │      cover: -mx-4 aspect-video (219px)
│ │ photo · lv-bleed-scrim-deep   │ │
│ │ مشروع الغلاف (text-snow/80)   │ │
│ │ عنوان المشروع 22px font-black │ │
│ │ ◯ الصانع · Bambu P1S · PLA    │ │ 518
│ └───────────────────────────────┘ │
│ ── ٠١  الرائج هذا الأسبوع   الكل ⟵ │ 578  h2 text-[22px] font-black
│ ▭148×185 ▭ ▭ ▭  (aspect-[4/5] rail)│ ~728 fold, rail cut mid-tile
└───────────────────────────────────┘
```

Desktop 1280 (column `max-w-6xl` = 1152):

```
┌ ⟵ [search lg:max-w-2xl] ───────────────────────────────────────┐ 64
│ ── kicker / مجتمع ليفو          (◎)(◎)(◎)(◎) sm:max-w-lg         │
│ لك │ أتابعهم │ المشاريع │ طلبات الطباعة │ المتاجر │ الصنّاع      │ strip, natural widths
│ ┌──────────── cover lg:aspect-[12/5] = 1152×480 lg:rounded-2xl ─┐│
│ │ copy in reading half (lg:max-w-[50%], 32px) │  photograph      ││
│ └────────────────────────────────────────────────────────────────┘│
│ ── ٠١ الرائج                                            الكل ⟵   │
│ ▭ ▭ ▭ ▭ ▭   lg:grid lg:grid-cols-5 lg:gap-4                      │ ~720
```

`.lv-bleed-scrim-deep`'s `lg` override is tuned for 12:5 banners (`src/index.css:1686`), which is exactly this cover. While `?q=` is set, cover, quick actions and rails step aside (today's rule).

### 3) Section order and data

URL `/community?tab=foryou|following|projects|requests|stores|creators&q=`; `?tab=products` → `foryou&list=products` (mounts today's ProductsPanel, `PRODUCT_GRID` stays in Community.tsx); `?tab=merchants` → `stores` (`src/pages/FollowedStores.tsx:115` and `tests/followedStores.test.ts` link it). Tabs are history entries; `q` debounced 300 ms, server search.

| # | Section (For You) | Source |
|---|---|---|
| 0 | Cover story | first of `GET /api/community/posts/trending?limit=8` with `cover.width ≥ 800`; fallback newest `/api/community/works` image; else typeset cover. Phase 2: admin pin in `src/components/adminCommunity/AdminCommunity.tsx` |
| 1 | «الرائج هذا الأسبوع» rail (8) | `/posts/trending?limit=8` (exists) |
| 2 | «طلبات تناسبك» (merchant viewer, `merchantApi.me().store`) else «طلبات الطباعة» — 3 compact rows | `/api/community/requests?limit=3` (exists); `&for=me` **NEW** |
| 3 | «صنّاع مميزون» rail (6) | `/api/community/creators?featured=1&limit=6` **NEW**; phase 1: distinct `author`s of trending |
| 4 | «متاجر مميزة» rail (6) | `/api/community/merchants?limit=6` (exists), `accepts_custom_requests` first; 3-print strip from `/works?limit=12` grouped by `store.id` |
| 5 | «منتجات المجتمع» 6 tiles | `/api/community/products?limit=6` (exists); «الكل» → `?tab=foryou&list=products` |
| 6 | «أحدث المشاريع» — the feed, cursor-paged | `/api/community/feed?scope=foryou&cursor=&limit=10` **NEW**; phase 1 = `/posts?limit=10` |
| 7 | «أدوات الصانع» | static (Studio `community-studio-link`, `/tools`, library coming soon) |
| 8 | Colophon «صُنع هذا العدد من N مشروعًا وM ورشة» | `total` of `/posts` and `/merchants` first pages |

Other tabs: **Following** `/feed?scope=following` **NEW** (needs 0154 creator follows; until then the empty state with two rails). **Projects** `/api/community/projects?sort=new|trending&material=&printer=&tag=&q=&cursor=` **NEW** (phase 1: `/posts?kind=project&tag=&q=`); chips are `lv-choice` buttons, state in URL. **Print Requests** = today's RequestsPanel. **Stores** = today's StoresPanel (WorksRail, YourStore). **Creators** `/api/community/creators?q=&cursor=` **NEW**. Pages: `/community/projects/:id` ← `/posts/:id` (exists, returns `media[]`); `/community/creators/:username` ← `/creators/:username` + `/posts?author=` (exist) + `StoreReviews` when `creator.store`. Both routes **NEW** in `src/App.tsx` under `CommunityGate`; `/p/:id` is the storefront product route and is not touched. A failed section hides itself (WorksRail's rule); the feed alone shows ErrorState.

Reads live in `hub/api.ts` + `hub/useCommunityFeed.ts` LOADERS (new kinds `feed:foryou`, `feed:following`, `projects`, `creators`); `hub/feedCache.ts` is not touched (storefront closure is at its 47 KB budget). The home composite is cached with `readPageCache/writePageCache('community:home')` (`src/lib/pageCache.ts`) so Back paints first and corrects.

### 4) Card anatomy

Shared: `<article class="relative …">`, title link carries `after:absolute after:inset-0 after:content-['']`, `has-[a:focus-visible]:ring-2 has-[a:focus-visible]:ring-focus`; every button `relative z-10`; a swipeable strip is `relative z-10` with each slide its own `<Link>`. User text `dir="auto"`, names in `<bdi>`, numbers `tabular-nums`, counts hidden at 0. Photos on the canvas with `rounded-2xl`, image wells `bg-surface-selected` (SafeImage `bgClassName`).

| Card | Fields (from `postCard` / hub types) | Actions (siblings) | Link |
|---|---|---|---|
| **Project, compact** (`w-[148px] sm:w-[168px]`, grid fluid) | `cover.url` 4:5, `title` line-clamp-2 `text-[13.5px] font-semibold`, `author.name`+avatar 16px, `counts.likes` (12px heart), play disc `bg-black/60 text-snow size-6` when `cover.kind==='video'`, print-time chip `text-[11px]` | none | `url` |
| **Project, cover** | + `printer.name`, `material.name`, `counts.comments`; kicker `text-snow/80`, title `text-[22px] sm:text-[28px] lg:text-[32px] font-black text-snow [text-shadow:0_1px_8px_rgb(0_0_0/0.35)]` | none | `url` |
| **Post** (feed; `lv-section` rows, no box) | header: avatar 36 (link), `author.name` `text-[14.5px] font-bold`, kind kicker `text-[11px] text-text-muted` («مشروع مطبوع / طبعة زمنية / شرح / قبل‑بعد / صورة»), `timeAgo(published_at)`; media strip `aspect-[4/3]` (single portrait `aspect-[4/5]`), `-mx-4 sm:mx-0 sm:rounded-xl overflow-hidden`, dots `h-[5px] w-[5px]`; `title` `text-[15px] font-bold`, `excerpt` `text-[13px] text-text-secondary line-clamp-3` + «المزيد»; spec chips (≤6): `printer.product.url`, `material.product.url`, `product.url` with `price_iqd`, `store.url`, `tags` → `?tab=projects&tag=`; `counts` | «⋯» `Menu` (copy link, report, mute) · like `aria-pressed` · comment (Link `#comments`) · save · share — each `min-h-11 min-w-11 rounded-full`; project kind adds `lv-button lv-button-sm lv-button-accent` «اطلب طباعته» + `lv-button-secondary` «اشترِ المواد» (only with `material.product`) | `url` |
| **Request** (RequestCard + `compact`) | title, budget chip `font-semibold text-gold tabular-nums`, `×quantity`, material, place, deadline, `file_count`, `offersLabel`, `timeAgo`; compact = title + one horizontally scrolling chip row (`flex overflow-x-auto hide-scrollbar gap-1.5`) + footer, `lv-section` | none (whole card is the link) | `/requests?request=<id>` |
| **Store** (StoreCard + `rail` 200px) | as CommunityStore; rail adds `grid grid-cols-3 gap-1` strip of 3 works `aspect-square rounded-lg` | Follow (existing sage pill, `aria-pressed`, `data-community-follow`) | `storeHref` |
| **Creator** (rail `w-[132px]`; row = StoreCard rhythm) | `avatarUrl` 64/48, `name`, badges `pro/premium/verified_merchant`, `bio` line-clamp-1, `stats.projects`, `stats.completed_jobs`, `printers[]` truncate, 3 thumbs (row) | Follow (0154) — hidden until the route exists, never disabled | `/community/creators/:username` |
| **Product** (ProductTile unchanged) | as today | none | `p.url` |

### 5) Motion spec

All through `useMotion()` from `src/lib/motion.ts`; CSS transitions for colour/opacity only. `src/components/AnimatedItem.tsx` (scale 0.8, stiffness 100, stagger) is not used.

| Moment | Motion | Reduced motion |
|---|---|---|
| Tab change | TabStrip underline `layoutId` + `spring('move')`; TabPanels `travel(20)·dir` + `spring('ui')`; active tab `scrollIntoView({inline:'nearest'})` | jumps; cross-fade (built in) |
| Cover arrival | none — LCP; SafeImage opacity fade only | same |
| Section reveal | head + first row once: `opacity 0→1, y travel(12)→0`, `spring('ui')`, `useInView({amount:0.2, once:true})`; no stagger, no scale | `travel()`=0 → 150 ms fade |
| Like / save | heart `scale 1→1.15→1` `spring('quick')`, fill = 150 ms CSS colour; count swaps via `AnimatePresence mode="popLayout"` inside `relative inline-flex overflow-hidden min-w-5`, exit `y −6`, enter `y +6`, `spring('quick')`; optimistic `patch`, reverted on error | colour only; count cross-fades |
| Follow | label cross-fade «متابعة»↔«تتابعه», `layout` width with `spring('quick')` | fade |
| Media strip | native `snap-x snap-mandatory overscroll-x-contain`; mouse via `useRail({snap:true})`; active dot one `layoutId`, `spring('move')` | dot jumps |
| Composer / comments | `Sheet` v2 (`src/components/ui/Sheet.tsx`) `detents={['medium','large']}`, `dragHandle`, `dirty`; `spring('sheet')` internal | built-in fade |
| Composer dock | static, sticky; arrives with the feed section (`y travel(16)`, `spring('ui')`), no scroll-direction hiding; hidden while an overlay is open | fade |
| «منشورات جديدة ↑» pill | enters under the strip `y −8→0`, `spring('ui')`; tap → `scrollTo` top + prepend | fade; instant scroll |
| Load more / skeleton swap | opacity only (`CROSS_FADE`), heights reserved | same |
| Press / hover | base `:active` dim; `press-scale` on discs, chips, compact cards, action buttons; img `group-hover:scale-[1.03] duration-500 motion-reduce:transition-none` | dim stays |

Never: parallax, Ken Burns, autoplay, `letter-spacing`, layout animation on list items.

### 6) Theming (token names only)

Page `bg-canvas text-text-primary` (today's `bg-black text-zinc-300` goes). Headlines `text-text-primary`, body `text-text-secondary`, captions/time `text-text-muted`. Ink: `text-gold` / `bg-gold` (kickers, numbers, underline, budget, liked heart) and `lv-button-accent` for «اطلب طباعته» (`--color-accent`). Follow keeps `text-sage bg-sage/10 border-sage/40`. Grounds: `bg-surface` for chips, dock pill and typeset cover; `bg-surface-raised` via `lv-button-secondary`; `bg-surface-selected` image wells; hairlines `border-border-subtle/60` and `lv-section`; chrome `material`/`material-thin`/`material-thick` with `scroll-edge`. Photograph text is `text-snow`/`text-snow/80` over `lv-bleed-scrim-deep` + `lv-bleed-ground` in both themes (no gold on photographs: light-theme gold is dark bronze). Cream: the same classes flip by `html[data-theme='light']` (`--color-gold`, `--color-sage`, `--color-focus`, `--color-border-subtle`, `--color-primary-fill`); `scroll-edge` already becomes the hairline; ProductTile/thumb strips take `border border-border-subtle/60`. No `dark:` variants, no hex, no new theme-conditional CSS. Zinc literals in hub cards (`border-zinc-800/60 bg-zinc-900/40`, RequestCard `CHIP`) are retokened to `border-border-subtle/60 bg-surface`.

### 7) Components and files

- `src/pages/Community.tsx` (route chunk, kept): bar, masthead, `QuickActions`, strip (six ids), panel switch, and — unchanged, because `tests/communityHubUi.test.ts` pins them here — `ProductsPanel` (`PRODUCT_GRID`), `StoresPanel`, `RequestsPanel` with their two `grid grid-cols-1 gap-3 md:grid-cols-2` lists, `NEW_REQUEST_PATH`, no Overlay import.
- `hub/parts.tsx`: + `SectionHead` (kicker + h2 + dek + «الكل» using `ArrowGlyph` from `src/components/home/v2/SectionHead.tsx`), `ProjectRailSkeleton`, `PostSkeleton`, `CreatorRailSkeleton`. `hub/copy.ts`: + `Forms` for إعجاب، تعليق، مشروع، مهمة. `hub/api.ts`: + `CommunityPost`, `CommunityCreator`, loaders. `hub/useCommunityFeed.ts`: + kinds. `hub/StoreCard.tsx` (+`variant="rail"`), `hub/RequestCard.tsx` (+`compact`), `hub/ProductTile.tsx` (retoken), `hub/WorksRail.tsx` (kept).
- **NEW** `hub/ForYouPanel.tsx` (sections 0–8, in-view mounting), `hub/CoverStory.tsx`, `hub/ProjectCard.tsx`, `hub/QuickActions.tsx` (Shortcut moved; «شارك» is a `<button>`), `hub/ToolsSection.tsx`.
- **NEW** `feed/`: `PostCard.tsx`, `MediaStrip.tsx`, `ActionRow.tsx`, `LinkChips.tsx`, `FeedList.tsx`, `NewPostsPill.tsx`, `ComposerDock.tsx` — **lazy chunk** mounted when section 6 approaches (`useInView` margin 200px) and for Following; `Composer.tsx` — **lazy** (Sheet v2; kinds = five `lv-choice` chips mapping 0153's `kind`, plus rows linking out to the wizard and the merchant product form; media via `POST /api/uploads purpose=post`; entity pickers stacked on `overlayStack`), prefetched on «شارك» pointerdown; `CommentsSheet.tsx` — **lazy** (0154).
- **NEW** `projects/`: `ProjectsPanel.tsx` — **lazy tab**, `ProjectFilters.tsx`, `SpecList.tsx` (`<dl class="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1">`), `ProjectActionBar.tsx`.
- **NEW** `creators/`: `CreatorCard.tsx`, `CreatorsPanel.tsx` — **lazy tab**, `CreatorHeader.tsx`, `FollowButton.tsx`.
- **NEW** pages: `src/pages/community/Project.tsx` (**lazy route** `/community/projects/:id`; media strip, byline + Follow, SpecList, tags, linked ProductTile/StoreCard/RequestCard, model files as rows only, comments preview, sticky action bar `material material-thick scroll-edge-up` with «اطلب طباعته» → `/requests?view=new&project=<id>` — the wizard gains a `?project=` prefill beside its existing `?link=`), `src/pages/community/Creator.tsx` (**lazy route**; TabStrip «المشاريع | المنشورات | التقييمات | نبذة», «المحفوظات» for `viewer.mine`).
- Worker: `/feed`, `/projects`, `/creators`, `/requests?for=me`, 0154 social tables; later `/api/community/home` collapsing section reads to one round trip.
- Tests: extend `tests/communityHubUi.test.ts` with an `a … button` nesting check over `src/components/community/**`; `scripts/e2e-rails.mjs` gains the media strip in ar+en.

### 8) CSS strategy

Reuse (all present): `material material-thin material-thick scroll-edge scroll-edge-up press-scale no-press hide-scrollbar nav-clearance lv-button lv-button-primary lv-button-secondary lv-button-accent lv-button-ghost lv-button-sm lv-choice lv-surface lv-section lv-hit lv-input lv-alert lv-alert-info lv-bleed-scrim-deep lv-bleed-ground`; `-mx-4 px-4 snap-x snap-center snap-mandatory snap-start overscroll-x-contain shrink-0 min-w-0 w-[148px] sm:w-[168px] w-[132px] w-[200px] lg:w-auto lg:grid lg:grid-cols-5 lg:grid-cols-4 xl:grid-cols-5 lg:gap-4 lg:overflow-visible lg:px-0 lg:mx-0 lg:grid-cols-[minmax(0,1fr)_20rem] lg:gap-8 lg:items-start hidden lg:block grid-cols-2 grid-cols-3 gap-1 gap-3 gap-x-3 gap-y-1 grid-cols-[auto_minmax(0,1fr)] max-w-2xl max-w-6xl sm:max-w-lg lg:max-w-[50%] sticky top-0 top-16 z-10 z-30 z-40 h-16 h-px w-4 min-h-11 min-w-11 min-w-5 size-6 size-8 size-11 aspect-video lg:aspect-[12/5] aspect-[4/5] aspect-[4/3] aspect-square rounded-2xl rounded-xl rounded-lg rounded-full lg:rounded-2xl sm:rounded-xl overflow-hidden text-[11px] text-[12px] text-[12.5px] text-[13px] text-[13.5px] text-[14.5px] text-[15px] text-[22px] text-[24px] sm:text-[28px] lg:text-[32px] font-black font-bold font-semibold leading-tight leading-snug line-clamp-1 line-clamp-2 line-clamp-3 tabular-nums text-balance bg-canvas bg-surface bg-surface-raised bg-surface-selected bg-gold bg-black/60 bg-sage/10 border-sage/40 text-sage text-gold fill-gold text-snow text-snow/80 text-text-primary text-text-secondary text-text-muted border-border-subtle border-border-subtle/60 divide-y divide-border-subtle/60 after:absolute after:inset-0 after:content-[''] after:rounded-2xl has-[a:focus-visible]:ring-2 has-[a:focus-visible]:ring-focus focus-visible:ring-2 focus-visible:ring-focus group-hover:scale-[1.03] duration-500 motion-reduce:transition-none motion-reduce:animate-none rtl:-scale-x-100 [text-shadow:0_1px_8px_rgb(0_0_0/0.35)] opacity-0 pointer-events-none`.

New (one rule, `@layer components` beside `.lv-surface`; ≈180 B raw / ≈100 B gzip):

```css
.lv-community-dock {
  position: sticky;
  inset-block-end: calc(max(var(--shell-bottom-inset, 0px), var(--nav-stack)) + 0.5rem);
  z-index: calc(var(--z-bottom-nav) - 10);
}
```

and the existing selector at `src/index.css:1008` becomes `html[data-overlay-open='true'] :is([data-bottom-nav], .lv-community-dock)` (+≈25 B). Placed last inside the feed section, sticky-bottom shows the composer pill only while the feed is on screen — no scroll listener. The kicker (`h-px w-4 bg-gold`), spec table, hairlines and count roll need no CSS.

Payback: retire both `[data-theme='light'] .lv-community-tile` rules (`src/index.css:1599–1606`) and the Community-only utilities `from-olive/25`, `from-olive/20`, `hover:border-olive`, `group-hover:bg-sage/20` (each used in `src/pages/Community.tsx` alone) ≈ 150–240 B gzip freed → net ≤ 0 against the 53 B headroom. Gate: every PR runs `npm run build` + `node --test tests/bundleBudget.test.ts`; any class new to the build is swapped for one in the list above; if still over, the dock becomes `className="sticky"` with the same `insetBlockEnd`/`zIndex` inline (Toast's pattern) and the CSS delta is zero.

### 9) Empty / loading / error copy (all new strings carry `// OWNER: Sorani to be written by hand`)

| State | Arabic | English |
|---|---|---|
| Feed empty | «العدد الأول يُكتب الآن» / «شارك أول مشروع، وسيظهر هنا» · «شارك مشروعًا» | "The first issue is being written" / "Share the first project and it appears here" · "Share a project" |
| No photograph anywhere | typeset cover: masthead grows to `text-[36px]` on `bg-surface` with the four verbs | same |
| Following, guest | «سجّل الدخول لمتابعة الصنّاع» (`lv-alert lv-alert-info` + link) | "Sign in to follow makers" |
| Following, nobody | «لا تتابع أحدًا بعد» / «ابدأ بهؤلاء» + creators/stores rails | "You follow nobody yet" / "Start with these" |
| Projects filtered | «لا مشاريع بهذه الخامة بعد» · «مسح الفلاتر» | "No projects with this material yet" · "Clear filters" |
| Creators empty | «لا صنّاع بعد — كن أول من ينشر مشروعه» | "No makers yet — be the first to publish" |
| Search | existing `NoResults`/`SearchLine` («لا نتائج لـ «q»») | existing |
| Section failed | hidden; feed: `ErrorState` «تعذّر تحميل المشاريع» + retry | "Projects could not be loaded" |
| Loading | `ProjectRailSkeleton` (4:5 + two lines), `PostSkeleton` (36px disc, 4:3, three lines), `CreatorRailSkeleton`, existing `StoreListSkeleton`/`RequestListSkeleton`/`ProductGridSkeleton`; each the section's exact height | — |
| Load more | existing `LoadMore` «عرض المزيد N»; auto-load twice via IntersectionObserver, then the button | "Load more" |
| New posts | «منشورات جديدة ↑» | "New posts ↑" |
| Follow error | existing «تعذّر تحديث المتابعة. حاول مرة أخرى.» | existing |

### 10) Accessibility checklist

- Every card one Tab stop (stretched link) plus its own buttons; no `<button>` inside `<a>` (test guards it); media slides are links, strip `relative z-10`.
- All controls ≥44 px (`min-h-11`, `lv-hit` on drawn-smaller icons); `press-scale` never on full-width controls.
- TabStrip roving `tabIndex`, arrow keys follow computed direction, `aria-controls`/`role="tabpanel"` via `group`; active tab scrolled into view on load and change.
- Sections `aria-labelledby` their h2; kicker rule `aria-hidden`; one `<h1>`.
- `aria-pressed` on like/save/follow/filter chips; counts in `<bdi>` with `sr-only` nouns from `copy.ts`.
- Images: `alt=""` decorative in rails, the cover's alt = project title; video `poster`, `preload="none"`, `playsInline muted`, tap-to-play, one at a time, paused off-screen; no 3D file bytes in any list.
- Reduced motion: `useMotion()` collapses springs, `travel()`=0, `motion-reduce:*` on img/skeleton; press dim stays.
- RTL: logical utilities only (`ps/pe/ms/me/start/end`), `dir="auto"` on user text, `ArrowGlyph` mirrors, `useMotion().dir` signs travel, `useRail` handles `scrollLeft`.
- Contrast: gold only on `bg-canvas`/`bg-surface`, never on photographs; light theme checked with `scripts/theme-tokens.mjs` and `scripts/e2e-light-mode.mjs`.
- Sheets: Sheet v2 focus trap, Escape one level, `dirty` guard, `visualViewport` pinning; dock and bottom nav hide together under `data-overlay-open`.
- Keyboard-visible focus: `focus-visible:ring-2 focus-visible:ring-focus` on every link/button; `has-[a:focus-visible]` ring on cards.