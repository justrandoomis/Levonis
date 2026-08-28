# Levonis

Storefront + community + admin platform for 3D-printing products, built as a
React (Vite) single-page app served by a Cloudflare Worker with native D1
(SQLite) and R2 (object storage) bindings.

- Languages: English, Arabic (RTL), Sorani Kurdish (RTL)
- Money: catalog and orders in **IQD (integer dinars)**; wallet in **USD
  (integer cents)**; points (1 pt = 1 IQD at checkout)
- Auth: server-managed sessions in Secure HttpOnly cookies; optional Google
  Sign-In verified server-side

## Layout

| Path | What it is |
| --- | --- |
| `src/` | React frontend (pages, components, contexts, `lib/api.ts` typed API client) |
| `worker/` | Cloudflare Worker backend (Hono): all API routes, auth, authorization, uploads |
| `migrations/` | Versioned D1 schema migrations |
| `wrangler.jsonc` | Worker + D1 + R2 + static-assets configuration |
| `docs/` | Feature matrix, security notes, cleanup manifest, Cloudflare setup guide, test results |

## Local development

Prerequisites: Node.js 20+.

```bash
npm install
npm run db:migrate:local   # applies migrations to the local emulated D1
npm run dev                # wrangler dev → http://127.0.0.1:8787 (API + built assets)
```

`wrangler dev` emulates D1 and R2 locally (no Cloudflare account or network
resources needed). For frontend iteration with hot reload, run in a second
terminal:

```bash
npm run dev:web            # Vite on http://localhost:5173, proxying /api + /files to :8787
```

Optional local secrets: copy `.dev.vars.example` to `.dev.vars`. Optional
frontend config: copy `.env.example` to `.env`.

## Build & checks

```bash
npm run check              # TypeScript (frontend + worker)
npm run build              # Vite production build into dist/
```

## Deployment

Deployment to Cloudflare (Workers + D1 + R2) is a guided, dashboard-first
procedure — see **docs/CLOUDFLARE_SETUP.md**. Do not deploy before creating
the resources and secrets described there.

## Documentation

- `docs/FEATURE_MATRIX.md` — every route/control, its behavior and status
- `docs/SECURITY.md` — security model, fixed vulnerabilities, remaining risks
- `docs/CLEANUP.md` — what was removed from the original project and why
- `docs/CLOUDFLARE_SETUP.md` — Phase 2 configuration + Phase 3 deployment
- `docs/TEST_RESULTS.md` — what was verified locally and what remains
