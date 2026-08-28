# Cleanup manifest

All removals are recoverable: the original archive was committed unchanged as
the first commit of this branch (`Baseline: import original levonis-3d 3.zip
contents unchanged`), so `git show <baseline>:<path>` restores any file.

## Removed: one-off codemod / patch scripts (~250 files, repo root)

`add_*.cjs/.py`, `fix_*.cjs/.py/.sh/.js`, `patch_*.cjs/.py`, `update_*.cjs/.py/.js`,
`seed_*.cjs/.js/.ts`, `generate_*.cjs/.js`, `check_*.cjs`, `find_*.cjs`,
`replace_*.cjs/.js`, `remove_*.cjs/.py`, `wipe_*.py`, `force_*.py`,
`revert_*.py`, `clean_*.py/.cjs`, `append_points.cjs`, `hide_claimed_missions.cjs`,
`inject_modal.cjs`, `load_home_ads.cjs`, `restore_rewards.cjs`,
`enforce_uploads_only.cjs`, `query.cjs/.js`, `test*.cjs/.js`, `init_db.js`,
`make_investor.js`, `read_*.py`, `get_home.py`, `modify_fields.py`, `patch.cjs`

Why: they were single-use scripts that edited source files in place or called
the now-removed open SQL endpoint (`/api/d1/query`). Nothing imports them;
`package.json` never referenced them. Several were live backdoors if ever
re-run (`make_investor.js`, `set_admin_pass.cjs` — which set the admin
password to a known value, `seed_*` — which fabricated production data), so
the runnable deliverable must not contain them.

## Removed: legacy server & data-access layer

- `server.ts` — Express server exposing arbitrary SQL (`/api/d1/query`),
  public schema changes (`/api/d1/init`), a public privilege-change endpoint
  (`/api/make-all-investors`), unverified Google auth, and unvalidated
  uploads. Replaced by `worker/` (see docs/SECURITY.md).
- `src/lib/db.ts` — browser-side SQL tunnel. Replaced by `src/lib/api.ts`.
- `schema.sql` — incomplete (3 tables) and unversioned. Replaced by
  `migrations/0001_init.sql` (complete, versioned).

## Removed: stale artifacts

- `src/pages/Subscription.tsx.bak`, `src/pages/Product.tsx.backup` — editor backups.
- `bun.lock` — the project is standardized on npm (`package-lock.json`).
- `metadata.json`, `assets/.aistudio/`, `app/applet/` — Google AI Studio
  export leftovers; `app/applet` duplicated one component.
- The AI-Studio HMR toggle in `vite.config.ts` and the "My Google AI Studio
  App" page title.

## Removed dependencies

`express`, `multer`, `multer-s3`, `@aws-sdk/client-s3` (replaced by native R2
binding), `jsonwebtoken`, `jwt-decode` (replaced by cookie sessions),
`sql.js`, `@types/sql.js` (unused), `cheerio` (replaced by a bounded
server-side parser), `@google/genai` (replaced by a direct REST call),
`dotenv`, `tsx`, `esbuild` (wrangler bundles the worker), `autoprefixer`
(unneeded with Tailwind v4). Added: `hono`, `wrangler`,
`@cloudflare/workers-types`, `bcryptjs` (verify-and-upgrade of legacy
password hashes only).

## Deliberately kept

- All React pages/components and visual/animation components (GooeyNav,
  PixelCard, CircularGallery, …) — the brand and layouts are preserved.
- `src/types.ts` is retained but stale (predates the real product shape);
  the API types in `src/lib/api.ts` are authoritative.

## Recorded for review (not removed)

- None of the uncertain items turned out to hold real product/order/user
  data — the archive contained no database dump; all catalog/mock content
  lived in code and was replaced by API data or honest empty states.
