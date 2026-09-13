# Levonis continuation checkpoint — 13 September 2026

Repository: justrandoomis/Levonis. Draft PR: #3. Branch: codex/persistent-bloub-policy.
Original Main: 865492f7c6ac34b69b3828fa4b69236cdea0f344.
Saved integration commit: aa30a8bd08ff59db9914778afbb5cde43fa4c903.
Requirement source: Pasted text(3).txt from the preceding project conversation.

## Implemented in this checkpoint

- One existing app-level Bloub SVG, physical transform-only geometry, measured header/bottom slots, genuine bootstrap and route loading, bounded event timers, reduced-motion and visibility handling, static accessible Home fallback, removed outer Home circle.
- Product, bundle, platform checkout and merchant checkout header integration; no order/payment/reward rules replaced.
- Policy links pin version and locale; stale fetch results are discarded; invalid version never silently selects current text; historical reading and heading navigation retained.
- Atomic publication assertion protects reviewed content from concurrent edit/delete/added locale/newer publication. Prior accepted text and hashes remain unchanged. No schema migration and no production data write.
- 20 focused tests passed locally with Node 22 and TypeScript transpilation, including real SQLite constraints. Focused regression tests also passed in GitHub Actions run 34770973479 after the integration commit was pushed.

## Still outstanding — do not mark complete

- Complete the requested 25-section policy content and approved business rules in Arabic, English and Sorani; qualified local legal review before publication.
- Publication/effective-date fields and full locale/order-bound acceptance improvements requested in the original brief.
- Full browser/device QA: iOS/Android, RTL/LTR, overlay/focus, route handoff and actual SVG identity/geometry.
- Check the full CI results and resolve any failures. Do not infer TypeScript/build success from the focused tests.
- No Main merge, deployment, policy publication or production database migration has been performed.

## Recovery and verification

Resume directly from this branch, not a fresh system. The one-time branch-only integration workflow successfully applied the hash-pinned patch and saved the separate integration commit without force pushing. Its workflow and transport patch were removed afterwards; only the read-only verification workflow remains. No production secrets or databases were accessed by it. The PR remains a draft.

Run npm ci, npm run check, npm run test:unit, and npm run build; inspect all results before considering merge or deployment. Preserve existing data and accepted policy history.
