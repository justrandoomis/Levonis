# Performance log

One entry per measured state of the site. The lab is Playwright Chromium on a
360×800 mobile context, CPU ×4, Slow-4G (150 ms RTT, 1.6 Mbps down), cold cache,
served from a production build (`npm run build`; note when a bare `vite build`
was used — it lacks `dist/_headers`). PageSpeed Insights mobile scores are
recorded when run (`scripts/psi.mjs`, owner key) — see
docs/MERCHANT_PLATFORM_V2.md §B.4 for the tooling plan.

## 2026-09-29 — baseline at HEAD 1444169f (before the merchant programme)

Measured by the survey lab (docs/MERCHANT_PLATFORM_V2_SURVEY.md «perf-measure»);
`/api/*` answered 500 in the lab, so every route rendered its no-API state.

| route | TTFB | FCP | LCP | CLS | long tasks (n / ms) | requests @load | KB @load (wire) |
|---|---|---|---|---|---|---|---|
| `/` | 5 | 4756 | **4964** | **0.081** | 4 / 442 | 7 | 271 |
| `/community` | 5 | 10960 | **11164** | 0 | 5 / 362 | 7 | 270 |
| `/products` | 4 | 5540 | 6092 | 0.001 | 4 / 376 | 7 | 271 |
| `/product/x` | 5 | 5068 | 5228 | **0.075** | 3 / 232 | 7 | 271 |
| `/requests` | 5 | 6204 | 6408 | 0.001 | 5 / 549 | 7 | 271 |
| `/auth` | 6 | 5332 | 5332 | 0 | 4 / 306 | 7 | 271 |

What the numbers say:

- The same seven requests precede every first paint (document 7.6 KB,
  entry 82.2, vendor-react 73.2, vendor-motion 46.1, vendor-i18n 12.0,
  index.css 48.9, the Google Fonts stylesheet) and everything waits for the
  third-party stylesheet: with it served locally the home's LCP falls from
  4.96 s to **2.63 s** and the community's from 11.2 s to **2.5 s**. That is
  fix #1 (self-host Cairo, preload the Arabic subset).
- The idle prefetch pulls 57 chunks / 119.5 KB while the woff2 and the LCP
  are still in flight (the Arabic font finished at 9.4 s).
- CLS 0.08 on the home (the sheet under the hero shifting when AppIntro and
  the marquee settle) and 0.075 on the product page (loading → content swap).
- No boot API answer carries `Cache-Control`; D1 is a single primary of
  unknown region; `/files` Range responses are never edge-cached.

Targets for the programme's exit (P0–P2): home LCP ≤ 2.5 s and CLS < 0.01 in
this lab; initial payload ≤ 190 KB gzip; every anonymous boot GET cached at the
edge with `s-maxage`; the Cloudflare-side switches (Smart Placement measured,
Argo/Tiered Cache, Early Hints, Image Transformations, Cache Rules for the
viewer-independent documents) recorded with their measured effect.
