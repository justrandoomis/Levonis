# P1-06 build part 1 report

P1-06 part 1 is committed once as `9d45dcb3` on `feat/req-v3-ui`, on top of `53c0401d`. Nothing was pushed and no migration was needed. `npm run check` passes, the four money tests pass unchanged, and the bundle budgets hold without being raised.

**Test results:**
- The five `requestEditor*` files: 61/61.
- claySystem, refusalStrings, communityGate, imageRenderSites, requestFileThumbsUi, uploadSession.client, uploadSessions, requestModelWriters, requestScenarioD and printRequestsV2: 145/145.
- Money tests (escrow, merchantLedgerFlows, offersV2, communityAcceptIntegrity): 55/55.
- 32 request, offer and print test files: 347/347.
- 54 more files that read the shared files I touched (App, AuthContext, Sheet, Request page, privateDrafts): 834/834.
- Final rerun after the last edits: 104/104, including bundleBudget 16/16.

**Bundle:**
- Storefront app payload is 242,629 B against 242,688 B, only 59 B under the limit.
- Workspace closure is 33,247 B against 33,280 B, only 33 B under.

Three decisions you should know about:
- **The editor loads through the request page's module.** App.tsx loads it via `loadRequestEditor` in `/home/user/levonis-requi/src/pages/community/Request.tsx`. A normal lazy import in App.tsx went 147 B over the storefront budget, because the editor's dependency list and four newly split shared chunks landed in the entry. The cost of this route is a slower first open of the editor: from the board it downloads about 41 KB more gzip and waits one extra round trip. Opening it from the request page costs nothing extra.
- **The phone-held-sideways rule needed no new Sheet code.** Sheet only gained a `placement?: 'bottom' | 'dock'` type. On compact screens the editor's sheets dock at a fixed `h-[85dvh]`. In landscape they cannot be dragged or resized by detent; on a portrait phone they behave as before.
- **The Sorani words on the sheet's expand/collapse button are still the Arabic placeholder.** This was already the case in `Sheet.tsx`. Writing them costs 53 B the workspace closure does not have. Every editor sheet has a single detent, so a Sorani reader of the editor never sees those words, and a test enforces that.

The tab copy of unsaved text is now cleared by a small `forgetTabEntries` helper in `privateDrafts.ts`, called from AuthContext. It clears every copy on sign-out and other accounts' copies when an account signs in. It keeps them on a reload and when a session simply expires. `src/lib/requestEditorMirror.ts` is gone.

**Left for part 2:**
- Delivery and budget fields, and the full review sheet with the audience panel and estimate.
- Entries from project, product and store pages, plus the old-address aliases.
- In `Request.tsx`, «أكمل وانشر» → `/requests/new/:id?review=1` and «تعديل» → `/requests/:id/edit`.
- Retire `RequestWizard.tsx` and re-point its tests.
- e2e, DECISIONS row 268 and the docs.
- After the wizard leaves the board, re-measure where the editor should load from. The budget margins above are small.

Files are in /home/user/levonis-requi:
- `worker/routes/requestEntries.ts`
- `worker/routes/printRequests.ts`
- `worker/routes/uploadSessions.ts`
- `worker/lib/requestModel.ts`
- `src/components/community/requests/editor/`
- `src/pages/community/RequestEditor.tsx`
- `src/pages/community/Request.tsx`
- `src/App.tsx`
- `src/AuthContext.tsx`
- `src/lib/privateDrafts.ts`
- `src/components/ui/Sheet.tsx`
- `tests/requestEditorDraft.test.ts`
- `tests/requestEditorState.test.ts`
- `tests/requestEditorSources.test.ts`
- `tests/requestEditorStrings.test.ts`
- `tests/requestEditorUi.test.ts`