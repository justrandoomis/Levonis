# P1-06 design critiques

**P1-06 design critique: UX, mobile, RTL and three languages, ranked.** I checked every point against the code in /home/user/levonis-requi at 53c0401d. Nothing was edited. Paths are relative to the worktree; `design §` points into the design file. Items 1–9 must change before building, items 10–16 should change before building, and items 17–21 are smaller.

**Must change before building**

1. **The session mirror is wiped on every reload, so reload recovery never works.**
   - `src/AuthContext.tsx:38-50`: `sessionScope` starts as `null`. The first `/me` after a page load therefore counts as an identity change and runs `privateDrafts.clear()` at line 50.
   - `ProtectedRoute` (`src/App.tsx:548-552`) waits for `isLoaded`, so the editor mounts after that clear has run.
   - Design §3.4 hooks the mirror clear "beside `privateDrafts.clear()`". A session that expires and the same user signing back in (scope goes user → '' → user) also wipes it.
   - Fix: key the mirror as `levonis.request-editor.<userId>.<requestId>`. On load, drop only keys of another user. Clear only on a real change of user id (`sessionScope.current !== null` and the id differs), never on role or `can_view_cost` changes.
   - The e2e fixture must mount the real `AuthProvider` with a fake `/me`, or this bug stays invisible.

2. **Editing a published request has no way to save.**
   - The draft PUT refuses anything that is not a draft (`worker/routes/printRequests.ts:1658`, `REQUEST_NOT_DRAFT`). Autosave, every flush point and the `pagehide` keepalive (§3.3) would answer 409 forever, and the status would sit at «لم يُحفظ — أعد المحاولة».
   - The mirror keeps text fields only (§3.4), and title and description are read-only in edit mode. So edits to parts, materials, colours and links are lost on reload, on sign-in, or on Back.
   - The commit model is also mixed: adding or removing a file revises the live job at once (`worker/lib/requestFileHooks.ts:235-262`), while everything else waits for «احفظ التعديلات».
   - Fix:
     - Edit mode has no autosave.
     - Mirror the whole `editorBody` (a few KB), keyed by request and revision.
     - The status reads «تعديلات لم تُنشر بعد».
     - A persistent banner says file changes apply now and other changes apply on «احفظ التعديلات». Better still, hold file removals until that save.

3. **Leaving the page cannot be blocked in this app.**
   - The app uses a declarative `<Router>` (`src/components/NavigationRouter.tsx:2`), so `useBlocker` is not available.
   - `setLeaveGuard` is only checked by `src/components/DashboardLayout.tsx:148,247,260`. §3.3 «an in-app back first flushes, and only asks when the flush failed» cannot be built as written.
   - Fix:
     - Flush with keepalive on unmount, not only on `pagehide`.
     - Mirror the full body.
     - Open «عرض ثلاثي الأبعاد» in a new tab, so the editor is not unmounted.
   - The keepalive flush must not send `expected_updated_at`. A same-tab save in flight changes `updated_at`, and the flush would then get `DRAFT_CHANGED` and be dropped.
   - There is no global 401 handler (nothing in `src/lib/api.ts`). Spec a 401 on save as: write the mirror, show «انتهت جلستك — سجّل الدخول لنحفظ», sign in with the return path, and restore. Add this sign-in case to the e2e (§12 tests reload only).

4. **Draft field minimums bring deleted text back, and a blank page is unprotected.**
   - The PUT validates title at 4 or more characters and description at 10 or more whenever they are sent (`printRequests.ts:1671-1672`). So §3.1 sends them only when long enough.
   - A user who clears the description to rewrite it sends nothing. The server keeps the old text, and it comes back on another device or once the mirror is discarded.
   - A blank `/requests/new` has no mirror key before the draft id exists, and §3.2 does not settle when typing alone creates the draft ("2 s idle" against "30 s").
   - Fix:
     - Drafts accept title 0–140 and description 0–6000. The minimums apply only at publish, which already gets `REQUEST_TITLE_REQUIRED` / `REQUEST_DESCRIPTION_REQUIRED`. This is a server change, with no migration.
     - Create the draft on the first input event.
     - Use a `.new` mirror key until the id exists.

5. **Two publish paths skip the review, and Back after publishing lands in the editor.**
   - `src/pages/community/Request.tsx:456-469` publishes a draft with an empty body in one tap. That skips «ما يراه الآخرون» and the budget switch (`17.public-private-preview`), and a blank-born draft now fails there on a page with no description field.
     - Fix: the button becomes «أكمل وانشر» and goes to `/requests/new/:id?review=1`.
   - §8 publish does `navigate(requestPath(id))` without replace. Back from the published request then returns to the editor, now in edit mode.
     - Fix: copy the wizard's order (`src/pages/Requests.tsx:246-251`): replace with `/requests?view=mine`, then push the request page. Do the same for the direct "sent" screen.

6. **The action bar cannot fit at 360 px in Sorani or English.**
   - The design keeps the wizard's pattern: `whitespace-nowrap` buttons in one fixed row (`src/components/community/requests/RequestWizard.tsx:1194-1214`). The new bar adds a status line, «احفظ» and a long primary label.
   - In Sorani that is «گۆڕانکاریی پاشەکەوتنەکراو» + «پاشەکەوت بکە» + «پێدابچۆرەوە و بڵاوی بکەرەوە» (or «…بینێرە بۆ فرۆشگاکە»). That is roughly 450 px against 328 px available.
   - Fix:
     - Status sits on its own small line, or as an icon plus a short word.
     - Short primary labels: «مراجعة» / "Review" / «پێداچوونەوە».
     - No separate «احفظ» on phones; the status is the tap-to-retry. Drop the duplicate save toast too.
     - The review sheet puts «انشر» in Sheet v2's `footer` (`src/components/ui/Sheet.tsx:60-62`).
     - The e2e checks that no button text is clipped (`scrollWidth > clientWidth`) in all three languages.

7. **The product page has no place for «اطلب طباعته».**
   - §9.2 puts it "under the buy controls", but those controls are a fixed bottom bar: quantity plus «أضف إلى السلة» (`src/pages/StorefrontProduct.tsx:419-466`). There is no "under", and a third control does not fit at 360 px.
   - Fix: place it in the page flow, inside or next to the files block (`:410-414`), never in the fixed bar.
   - Labels: ar «اطلب من المتجر طباعته» with the line «لهذا المتجر فقط»; en "Have this store print it", not "Ask to have it printed".

8. **The same screen uses two different words for a part.**
   - Cards are titled «القطعة {n}» / «پارچەی {n}» (`src/components/community/requests/strings.ts:131/858`).
   - The header line from `jobCountWords` says «عدد الأجزاء 2 · القطع في الطقم 3» / «2 بەش» (`src/components/community/requests/mirrors.ts:127-128`). There, a part is «جزء» and «قطعة» means a piece.
   - The design's own `addPartHint` uses «قطعة من عدة أجزاء» right under the «أضف قطعة أخرى» button.
   - §16.1 leaves this to the owner, but it cannot ship contradictory on one screen.
   - Fix: the editor does not use `jobCountWords`. It writes its own header in card vocabulary («قطعتان · 3 نسخ في الطقم»), and the hint becomes «لطلب من عدة قطع بمواد أو ألوان مختلفة.».

9. **Sorani errors, and words that differ from the server's.**
   - «ڕەسەنە دەستکاریکراوەکە» (`originalToggle`, `rowOriginal`) means "the *edited* original". In this app «دەستکاریکراو» is the past participle (`strings.ts:829` «ئۆفەری دەستکاریکراو»; `src/components/adminProducts/dataFileStrings.ts:29`).
   - The refusal the server returns already says «الملف الأصلي» / «فایلی ڕەسەن» / "the original file" (`src/lib/refusalStrings.ts:736-745`). The new «الأصل القابل للتعديل» means the toggle and the error use different words.
     - Fix: «هذا هو الملف الأصلي» / «ئەمە فایلی ڕەسەنە» / "This is the original file", with a hint naming the kind (STEP, CAD project) and «يصل إلى التاجر الذي تقبل عرضه فقط».
   - `traitAbrasive` «لووتکەی پتەو»: «لووتکە» means summit. The app's word for nozzle is «نۆزڵ» (`src/components/community/projects/strings.ts:298`), so use «نۆزڵی پتەو».

**Should change before building**

10. **Mixed-direction text needs the app's bidi tools.**
    - §14 only says "names in `<bdi>`/`dir=ltr` as today". The new lines mix Latin and numbers into right-to-left sentences: «82×64×41 ملم», «≈ {range}», «TPU مرن», «أرسل إلى {store}», «لم يُنسخ «{name}»…».
    - `src/lib/bidi.ts:15-18` documents exactly how «82×64×41» reorders in a right-to-left line. The wizard avoided it with a Latin «mm» (`RequestWizard.tsx:1083-1086`).
    - Fix:
      - Every display line goes through `BidiText` / `bidiContent` (`src/components/ui/BidiText.tsx`), never `dir="auto"` (`bidi.ts:6-11`).
      - Search and link inputs are `dir="auto"` / `ltr`.
      - Shorten file names in the middle so the extension (`.stl`) stays visible.

11. **The keyboard and landscape design is not reliable, and the e2e would not catch it.**
    - §14 hides the bar when the visible height is under 75% of "the largest seen". Rotating from portrait to landscape with a field focused (360 < 0.75 × 740) hides the bar for good.
      - Fix: reset the largest height per orientation, or compare `innerHeight - visualViewport.height > 150`. With this site's viewport tag (`index.html:51`, no `interactive-widget`) the layout viewport does not shrink.
    - §12's keyboard pass resizes the whole viewport to 360×420. That mimics a resized layout, which this site never gets. Add a unit test with a stubbed `visualViewport`.
    - At 740×360, `useIsPhone` is false (`(max-width: 639px)`, `src/lib/useMediaQuery.ts:23`). Sheets are then centred windows with no detents (`Sheet.tsx:302`), so §12's "picker sheets reach their large detent" in landscape is wrong. Row actions also go inline on a screen only 360 px tall.
      - Fix: treat `(max-height: 480px)` as a phone, and add a landscape-with-keyboard pass.

12. **The pickers use the wrong accessibility pattern and are overbuilt.**
    - A `listbox` with `aria-activedescendant` while focus stays in the search input does not work. It would need `role=combobox` on the input, and VoiceOver handles `aria-activedescendant` poorly.
      - Fix: materials as native radios, colours as `Checkbox` (`src/components/ui/Switch.tsx`), filtered by the search field. «أي لون مناسب» acts as a radio-like exclusive choice.
    - The palette has 7 colours (`packages/contracts/src/requestModel.ts:69-77`), yet the sheet has a search field plus a separate «لون آخر» name field. Merge them into one «اسم اللون» field that filters the 7 and offers «أضف "{x}" كلونٍ آخر».
    - Searchable sheets open at `large`, since the keyboard halves `medium`.

13. **Too many controls by default (Apple: simplicity).**
    - Each source row has main, original, note, 3D and delete. Each part card has about 14 fields.
    - Fix:
      - The main source is chosen automatically and shown as a badge; all row actions go through `src/components/ui/Menu.tsx`, which already switches to a sheet on phones.
      - With more than one part, cards fold to a one-line summary.
      - Region, requirements, assembly and references sit behind «تفاصيل أكثر».
      - Show the process segment only when the material is «لست متأكدًا»; today it duplicates the picker's process chips.
    - Specify where focus goes after add, duplicate, move up/down and delete part, announced politely.

14. **Image grid and viewer problems.**
    - Grid:
      - The «⋯» button must not sit inside the tile `<button>` (nested controls); use `li > button + button`.
      - A 44 px «⋯» plus badges plus two 44 px failure buttons with text cannot fit a 104 px tile. Use icon buttons with names, or drop the per-tile «⋯» on phones and use the viewer panel.
    - Viewer:
      - `touch-action: pinch-zoom` zooms the page behind the overlay and fights the swipe.
      - Swipe should navigate only at 1×, and its direction must mirror in right-to-left like the arrow keys.
      - When the note field is focused, collapse the picture so the keyboard does not cover the field.

15. **Draft lifecycle.**
    - `?store=` and `?product=` create a draft on page load; replay only covers 10 minutes (§9.2–9.3). Every idle visit leaves another draft in «طلباتي».
      - Fix: create these drafts on the first durable act (the project copy may stay on page load), or replay any untouched draft from the same origin.
    - «طلباتي» opens drafts on the request page (`src/pages/Requests.tsx:181`), so e2e step 11 ("→ `/requests/new/<id>`") fails as specified.
      - Fix: route drafts and repeat-drafts to the editor.
    - Add «احذف المسودة» to the editor's top bar. The top bar itself (back, title) is not specified.

16. **Missing Sorani in blocks this push edits.**
    - `STORE_UNAVAILABLE` has no words; it appears only in a comment (`src/lib/refusalStrings.ts:860`). Both the product and store entries return it, so write ar/en/ckb now; do not leave it as "verify".
    - These blocks fall back to the Arabic (`loc` returns the ar text when ckb is missing):
      - `src/components/storefront/blocks/CustomRequestCta.tsx:29,33`
      - `src/pages/Storefront.tsx:551,580`
      - `src/pages/StorefrontProduct.tsx:456`
      - `src/components/print/MyRequestsList.tsx:107-112`
    - The design touches all four files, so fix them under row 183.

**Smaller**

17. **Sorani verb forms are mixed on one screen.** Nouns («لابردن», «بڵاوکردنەوە», «داخستن») sit next to imperatives («لاببە», «زیاد بکە», «پاشەکەوت بکە»), and the wizard's own word for delete is «سڕینەوە» (`RequestWizard.tsx:552-556`). Pick one form per action.

18. **The planned strings test would fail correct Sorani.** The rule in `requestEditorStrings` ("every Sorani sentence carries a Sorani-only letter") rejects «داخستن», «لینک», «وردی» and «ستاندارد», and «≈ {range}» equals the English. Use a reviewed allow-list instead.

19. **Status and budget details.**
    - Polite live announcements on every «يُحفظ…»/«محفوظ» flood screen readers; announce only failure, offline and conflict.
    - Turn the budget switch on, or show it, only once a budget is typed.
    - The «يراه الجميع: 6 · التجار: 3…» counts mean nothing to a customer. Use one plain line instead, for example «رقمك وعنوانك وميزانيتك لا تظهر للعموم».
    - «احفظ نسختي» overwrites the other window's changes, so its confirm must say so.

20. **Page order and routes.**
    - Put «صف طلبك» before «ما لديك»: it holds the required fields and names the draft.
    - Use `/requests/:id/edit` rather than `/requests/new/:id` for editing a published request.
    - The e2e harness needs `BrowserRouter`, not `MemoryRouter`, for reload.

21. **Rule breach in the e2e plan.** §12 writes screenshots to `/tmp/claude-0/shots/request-editor/`; they must go under `<old-session-scratch>/p106/`.

Design file: <old-session-scratch>/p106/design.md

---

The design needs 14 changes before building, ranked below. The two most serious: the direct-request entries would show the customer's identity to the store before anything is sent, and the "merchant" budget reader is wider than the contract says. None of the fixes needs a migration.

**Must change, most severe first** (design lines are in `<old-session-scratch>/p106/design.md`)

1. **Direct drafts tell the store about the customer before anything is sent.**
   - The product and store entries call `openStoreThread` when the editor page loads (design.md:465, :477).
   - The store inbox lists empty threads with the customer's name and username (`worker/routes/merchantInbox.ts:85-130`). The general chat list does too (`worker/routes/chats.ts:303-333`).
   - So opening `/requests/new?store=` or `?product=` and walking away still shows the customer to the store. The editor promises «لا يراها أحد غيرك».
   - Separately, `isDirectMerchant` never checks the request state (`worker/lib/communityRequests.ts:151-157`). The target store can therefore read a direct draft, including the customer's name, through `worker/routes/marketplace.ts:390`, `worker/routes/printRequests.ts:1955` and `:1825`.
   - Change:
     - Create the direct draft with `origin_chat_id` NULL; that column is nullable and not locked by 0151.
     - Open the thread and set `origin_chat_id` only in the send step, in the same batch as the card.
     - Allow the direct merchant to read the request only when `state <> 'draft'`, at all three sites.
     - Do not create anything just because the page loaded: make the product and store entries wait for the first real action, as the blank entry does.

2. **The budget's "merchant" reader is wider than the contract.**
   - The design's `budgetReaderOf` returns "merchant" for any active merchant account (design.md:515, :525).
   - The contract defines `merchants` as "an eligible merchant and the accepted one" (`packages/contracts/src/requestModel.ts:192-199, :225-226`). The switch wording also says «التجار الذين يمكنهم صنع طلبك».
   - Change:
     - `publicRequest` (`worker/routes/marketplace.ts:202`) always returns budget null, with no reader parameter.
     - Show the budget only where eligibility is already known: the workshop board (`merchantWorkshop.ts:134/187`, `m.eligible = 1`), the "for me" list (`community.ts:498`), and the request page when the file reader is eligible, engaged or the direct store after send.
     - `communitySearch.ts:357` is missing from the design's table.
     - `marketplace.ts:364` calls `results.map(publicRequest)`. Adding a parameter would pass the array index as the reader.

3. **The chat print-request sheet would silently hide a budget the customer typed for the store.**
   - The sheet sends `budget_iqd` (`PrintRequestSheet.tsx:115, :201`). The draft insert never sets `budget_visible` (`chatCommerce.ts:171-186`), so it defaults to 0.
   - With Q2 applied to cards, that store would never see it. Yet the design keeps the sheet "as it is" (design.md:479).
   - Change: add the switch and its line to the sheet in ar/en/ckb, or treat a budget typed in a one-store sheet as shown. Say which in row 268.

4. **The project copy must follow the upload doors' rules, and the streaming as written fails in the Worker.**
   - **Quota:** the copy never checks the upload quota. The session door does (`uploadSessions.ts:657`, `assertQuota` at `uploadEntity.ts:453`, 1 GB per customer at `settings.ts:723`). Combined with copying on page load, a shared `?project=` link can fill a victim's quota. Call `assertQuota(db, customer, 'request', bytes)` before each copy. Reuse any untouched draft from the same post, not only within 10 minutes.
   - **File type:** classify each file the way the doors do. The extension must be accepted by `requestFileKind(name)` and must match what `classifyRequestFile` finds in the bytes (`marketplace.ts:513-551`). Store the post's checked type, never one derived from the name. Posts accept more document types than requests do (`uploadEntity.ts:67`).
   - **Streaming:** the R2 binding's `put` rejects a stream of unknown length, and a stream split into two branches by `tee()` has none. `tee()` also buffers whatever the slower R2 branch has not read yet, up to the whole file (design.md:445).
     - Instead, put `obj.body.pipeThrough(new FixedLengthStream(obj.size))`.
     - Then hash the new object with the existing `sha256OfObject` (`uploadSessions.ts:315-332`, which already has a streaming fallback), and compare with the post's digest.
     - This also makes design §16.5's buffering fallback unnecessary.
   - **Ledger row:** `putMediaObject` already writes a `file_objects` row without `purpose` or `sha256` (`mediaStorage.ts:589-590`, `:375-396`). The batch statement must be the session door's upsert (`uploadSessions.ts:666-678`). When the guard refuses a file, delete both the object and its ledger row so the bytes stop counting.
   - **Pattern:** do not copy the repeat door's pattern (`printRequests.ts:2444-2458`). It reads whole files into memory, records no `purpose` and checks no quota.

5. **The chat send step does not check a blank-born direct draft.**
   - Title ≥ 4 and description ≥ 10 are checked only when the chat draft is created (`chatCommerce.ts:99-100`). The send step (`chatCommerce.ts:196-245`) opens any draft.
   - An entry-born direct draft (title from the product, description '') would reach the store empty, and skip the publish-only `PART_*` refusals (`printRequests.ts:1314-1328`).
   - Change: the send step runs the same `REQUEST_TITLE_REQUIRED`, `REQUEST_DESCRIPTION_REQUIRED` and v3 publish checks as `publishRequest`.

6. **The chat card budget is stripped at the wrong place.**
   - The design strips it in `printRequestCurrents` (design.md:531). But readers receive the stored snapshot through `cardPublic(...).original` (`chatCards.ts:943-952`, via `chats.ts:905-910`).
   - Change: strip `original.budget_iqd` there for the store side when the request is not visible now. `printRequestCurrents` can supply `budget_visible`. Staff keep it.

7. **"What others see" must be truthful.**
   - Identity row "name, phone, address → accepted merchant only" (design.md:395) is wrong in two cases:
     - Any merchant with a pending offer can open the request thread and see the customer's name (`chats.ts:565-595`).
     - A direct store sees the name from the start (`partyRequest`, `marketplace.ts:229`).
     - Split the row: name goes to merchants you deal with; phone and address go to the accepted merchant (contact snapshot at acceptance).
   - `budgetOff` and `savedToast` say «لا يراها أحد غيرك» (design.md:765, :813), but admins see budgets and drafts. Say "hidden from merchants and the public".
   - The «الأصل» hint should say that the original's file name is listed publicly. The contract states this at `packages/contracts/src/requestModel.ts:197-199`.

8. **The tab-local copy of unsaved text is wiped on every reload, or leaks between accounts.**
   - `AuthContext.setUser` clears its caches on the first sign-in check after every load, because `sessionScope` starts as null (`src/AuthContext.tsx:39-49`).
   - Clearing the mirror "beside `privateDrafts.clear()`" (design.md:219) therefore loses it on every reload, which breaks D4.
   - Change: store the user id in each entry and apply it only when it matches. Clear all entries on sign-out or account change, but not on the first sign-in check after a reload.

9. **`copy-from-project` is broader than "retry".**
   - It accepts any post id (design.md:453).
   - Change:
     - Accept only post ids already recorded as an `origin_id` on this request. Check each `file_id` against `post_id`.
     - Run `afterRequestFileAdded` for published requests, as both upload doors do (`requestFileHooks.ts:353-362`).
     - Count and audit each copy like the download door (`communityPosts.ts:1068-1080`: 120/h, `downloads + 1`, `community.post_file_downloaded`).
   - Consider allowing copies only from a published post or the reader's own, not through the consent-party path (`communityPosts.ts:377-386`).

10. **Retry can still create a second copy (acceptance 13).**
    - If `complete` commits but its response is lost, the next try finds the session marked `completed` and opens a new one (`src/lib/uploadSession.ts:370-385`). The resume record is not cleared on a network error (`:449`).
    - Change: before re-sending, refresh the draft and match by sha256, or have `GET /api/uploads/sessions/:id` return the file of a completed request session. A whole-body retry needs the same check.

11. **`DRAFT_CHANGED` is checked by reading and then writing** (design.md:502). Put `AND updated_at = ?expected` in the update itself (`printRequests.ts:1690-1695`).

12. **Product cover copy.** Read it from `community_product_media` (kind `image`, by position). Accept only a key that passes `ownedMediaKey(key, store.user_id)` (`mediaRefs.ts:51`). Read it with `getMediaObject('public', key)`, never by fetching a URL from `images` (`catalog/product.ts:529`).

13. **Restrict the new write routes to the main site** with `requireMainHost`. Store subdomains share the session cookie (`worker/index.ts:389-414`), and the design already links store hosts to `${MAIN_SITE}`.

14. **A link's provenance survives a URL edit.** Editing a link keeps the old `origin_*` (`requestModel.ts:1675-1681, :1702-1712`), so product replay and provenance would describe a URL the customer changed. Clear `origin_*` when `canonical_url` changes.

**Claims that check out:**
- The new routes are behind `requireCommunityOpen`, so the gate stays closed.
- A client cannot reference another request's file (`requestModel.ts:1685-1690`) or create a `project_post` source (`:1668-1670`).
- `projectModel` and `projectSpec` remove `sha256` and `origin_*` below owner (`requestModel.ts:910-920, :968-1009`). No other route exposes the sha256.
- Matching does not use the budget, and nothing sorts or filters by it.
- The storefront already loads `useCommunityAccess` (`Storefront.tsx:37`), so the new storefront links add nothing heavy.
- 0208 carries every column the design and these fixes need (`budget_visible` at :132, `origin_*` at :62-65, index at :143).