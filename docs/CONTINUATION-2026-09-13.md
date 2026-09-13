# Levonis continuation — 13 September 2026

Repository: justrandoomis/Levonis. PR #3. Branch: codex/persistent-bloub-policy.
Original Main: 865492f7c6ac34b69b3828fa4b69236cdea0f344.
Final code integration: c31313c0751bf4a802311025847a4642e3d9f010.
Requirements: Pasted text(3).txt from the project conversation. The owner explicitly requested completion and live deployment.

## Implemented

- One persistent global Bloub SVG; measured bottom/header/fallback slots, larger genuine loading state, compositor-only travel, reduced motion, visibility handling and accessible Home controls. Product, bundle and both checkouts retain existing business logic.
- Version- and locale-pinned policy reader, stale-response protection, invalid-version rejection, heading navigation, legacy /policy alias and display of publication/effective dates. Unrecorded historical dates remain unknown.
- Twenty-five original purchase-policy sections in Arabic, English and Sorani, aligned to the existing warranty, seven-day eligible item return and order workflows. Existing admin action prepares a fresh trilingual draft version without overwriting owner edits or already published text.
- Additive migration 0070 records publication/effective timestamps and consent document ID, order ID, actual/requested locale and event. Database triggers prevent changes/deletion/revival of published/archived text.
- Checkout acceptance and its current-policy concurrency guard execute in the SAME transaction as order/inventory/payment writes. A failed order or concurrent policy change rolls back the consent too. Language/quote changes require renewed acknowledgement.
- Real-component browser regression fixture covering Chromium/WebKit, 320–1440 widths, Arabic/English, actual SVG identity, routes, late headers, resize, overlays, focus, Home and reduced motion. The fixture calls no production API.

## Verified before this checkpoint

- CI run 34773859534 passed complete type/lint/architecture checks, 2,502 root + 361 workspace tests (2,863 total) and production build after the missing Studio installation was corrected.
- The subsequent new policy code passed 32 focused offline Node/real-SQLite tests and syntax diagnostics. These are NOT a substitute for the new complete CI/browser run.
- Final source transfer verified SHA-256 of the entire payload and the before/after image of every existing file. No force push or production write was used. The temporary transport and write workflow are now removed.

## Release gate and live target

Run and inspect the read-only verification workflow on this checkpoint, including both browser engines. Resolve failures before merging. Do not infer current CI success from the preceding green run.

The existing deploy-staging-code.yml workflow deploys the actual live main site levonis-iq.com (historically named Worker levonis-staging). It preserves current vars and data and applies additive migrations before deployment. Dispatch on Main with confirm=DEPLOY-CODE after merge. Do NOT use deploy-production.yml: that is the alternate Worker without the live domain.

## Policy approval boundary

Code deployment does not silently publish new contractual text or change a previously accepted version. The owner prepares/reviews/publishes policy drafts through the existing audited admin flow. The qualified-local-counsel review note remains visible; no statutory claim or completed legal review is asserted. Real-device hardware testing remains distinct from Chromium/WebKit emulation.
