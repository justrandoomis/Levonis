# Google Sign-In: fixing `Error 400: origin_mismatch`

Status: **the fix requires a change in the Google Cloud Console that only the
project owner can make.** Nothing in this repository can fix it by itself.
This document explains the exact cause and the exact steps, and how to verify
them honestly.

---

## 1. What the error means

`Error 400: origin_mismatch` is raised by Google Identity Services (GIS)
**in the browser, before any credential is issued**. It means:

> The page that tried to start Google Sign-In is served from an origin that
> is **not listed** under **Authorized JavaScript origins** of the OAuth 2.0
> client whose `client_id` the page sent.

It is purely a mismatch between:

- the **origin** the sign-in starts from (e.g. `https://levonis-iq.com`), and
- the origin list configured on the **OAuth 2.0 Web application client** in
  Google Cloud Console for that specific `client_id`.

The Worker backend never sees these requests — no server-side change can
resolve this error.

## 1b. What changed on 31 August, and why this document got shorter

The client id used to live in TWO places: `VITE_GOOGLE_CLIENT_ID`, baked into
the JavaScript bundle at build time, and `GOOGLE_CLIENT_ID`, a variable on the
Worker that verifies the token. Either could be missing on its own, and when
the build one was missing the site told customers "Google sign-in is not
enabled on this deployment" — a sentence about a build pipeline, shown on a
login screen, on a deployment that may have been configured perfectly.

There is now ONE value, read at runtime from the Worker:

```
GET https://levonis-iq.com/api/auth/capabilities
```

The bundle carries no provider configuration at all. Two consequences worth
knowing:

- **Checking which client id is live no longer needs DevTools.** `curl` the
  endpoint above (§2).
- **Pointing the platform at a different Google project is a variable change,
  not a rebuild.** Set `GOOGLE_CLIENT_ID` on the Worker (or the
  `VITE_GOOGLE_CLIENT_ID` repository secret, which workflow 7 now writes to
  that variable) and re-run workflow 7.

There is **no client secret and no callback URL** in this architecture, and
nothing here needs one. LEVONIS verifies a Google Identity Services **ID
token** against Google's published JWKS (`worker/lib/google.ts`) — there is no
authorization-code exchange, so there is nothing for a `redirect_uri` to
protect. The only Google Console setting that matters is **Authorized
JavaScript origins**.

## 2. First: confirm which `client_id` the DEPLOYED site actually sends

One request, no DevTools:

```bash
curl -s https://levonis-iq.com/api/auth/capabilities | jq '{google, googleClientId}'
```

`googleClientId` is the value the live site hands to Google, and the value the
Worker will require the token's audience to match — they cannot disagree any
more, because they are the same value.

If it is empty, the Google button is not rendered at all (rather than rendered
and broken), and the fix is §5 rather than anything in the Google Console.

<details>
<summary>The old way, if you want to confirm it in the browser</summary>

1. Open `https://levonis-iq.com/auth` in Chrome.
2. Open DevTools → **Network** tab → reload the page.
3. Filter for `accounts.google.com`. The requests to
   `https://accounts.google.com/gsi/button?...` and/or `gsi/iframe/select`
   carry a `client_id=XXXXXXXX.apps.googleusercontent.com` query parameter.
   That value is the client id the deployed bundle really uses.
   - Alternative without DevTools: view the page source, open the hashed
     `/assets/index-*.js` bundle it references, and search for
     `apps.googleusercontent.com`.
4. Note the value. Every console change below must be made on the OAuth
   client **with exactly this id** — not on whichever client looks likely.

The bundle no longer contains the id at all, so step 3's fallback (searching
the built JavaScript) will find nothing. That is expected.

</details>

Every console change below must be made on the OAuth client **with exactly
the id the endpoint reported** — not on whichever client looks likely.

## 3. Console change (owner action)

In [Google Cloud Console](https://console.cloud.google.com/apis/credentials):

1. Select the Google Cloud **project** that owns the client id from step 2.
2. **APIs & Services → Credentials → OAuth 2.0 Client IDs** → open the
   **Web application** client whose *Client ID* equals the value from step 2.
3. Under **Authorized JavaScript origins**, make sure the list includes:

   | Origin | Why |
   | --- | --- |
   | `https://levonis-iq.com` | Production — sign-in happens here. |
   | ~~`https://www.levonis-iq.com`~~ | **Not needed.** Since 29 September `www` no longer serves the app: every page there moves to the apex before Google's script loads (§8), so no sign-in starts on `www`. Do not add other subdomains "just in case" — wildcards are not accepted and unused origins widen the attack surface. |
   | `https://levonis-staging.just-randoomis.workers.dev` | Staging — needed so the acceptance test (section 7) can run on staging first. |

4. An origin is **scheme + host (+ port when non-default)** only.
   `https://levonis-iq.com/auth` is invalid — never include a path.
5. **NEVER add a merchant storefront host** — not `ali3d.levonis-iq.com`, not
   any other `*.levonis-iq.com` shop, and Google does not accept a wildcard
   anyway. A merchant controls the CONTENT of their storefront; an authorized
   origin there would let a page they wrote start a Google sign-in carrying
   this platform's client id. Sign-in belongs on the apex, and the Worker
   builds every token-bearing link from the canonical origin regardless of
   which host the request arrived on (`worker/lib/appOrigin.ts`).
6. Save. Google states changes can take **from 5 minutes to a few hours** to
   propagate; a hard reload after a few minutes usually suffices.

## 4. Authorized redirect URIs: none are needed

This integration uses the **GIS credential (ID-token popup/One Tap) flow**,
not the authorization-code redirect flow:

- `src/main.tsx` wraps the app in `<GoogleOAuthProvider clientId={import.meta.env.VITE_GOOGLE_CLIENT_ID}>`.
- `src/pages/Auth.tsx` renders `<GoogleLogin onSuccess=...>` from
  `@react-oauth/google`. On success the browser receives a **signed ID token
  (JWT credential)** directly from Google and POSTs it to our own endpoint
  `POST /api/auth/google` as `{ credential }`.
- The Worker verifies that JWT server-side in `worker/lib/google.ts`
  (RS256 signature against Google's JWKS, issuer, **audience =
  `GOOGLE_CLIENT_ID`**, expiry, `email_verified`) — it never just decodes it.

At no point does Google redirect the browser to a callback URL of ours, so
**Authorized redirect URIs can be left empty for this client**. Do not invent
one; adding a bogus redirect URI does nothing for `origin_mismatch`.

## 5. Build-time coupling: `VITE_GOOGLE_CLIENT_ID` ↔ server audience

- The client id is **baked into the JS bundle at build time**. Both deploy
  workflows (`.github/workflows/deploy-production.yml` and
  `deploy-staging.yml`) build the frontend with
  `VITE_GOOGLE_CLIENT_ID: ${{ secrets.VITE_GOOGLE_CLIENT_ID }}` and set the
  **same value** as the Worker var `GOOGLE_CLIENT_ID`
  (`--var GOOGLE_CLIENT_ID:"$VITE_GOOGLE_CLIENT_ID"`). So the browser's
  client id and the server's expected token audience match **by
  construction — as long as the site was rebuilt after the secret changed**.
- Changing the GitHub secret does **nothing** to the already-deployed bundle.
  You must re-run the deploy workflow so both the bundle and the Worker var
  pick up the new value. (Both origins share one OAuth client and one secret;
  if staging and production ever need different clients, that requires a
  second secret and a workflow change — decide explicitly, don't improvise.)
- A **stale cached bundle** (browser cache, or an old service worker if one
  was ever registered) can keep serving an old client id after a redeploy.
  When testing, hard-reload (Ctrl/Cmd+Shift+R), and confirm via section 2
  that the *network requests* carry the expected id.
- If the frontend was built **without** the secret, the new `/auth` page
  shows an explicit "Google sign-in is not enabled on this deployment"
  notice instead of a broken button (it also treats the literal placeholder
  `YOUR_GOOGLE_CLIENT_ID` from `src/main.tsx` as unconfigured).

## 6. What NOT to do

- **Never share or paste the OAuth client secret anywhere** — this flow does
  not use it, the repo does not need it, and nobody should ask for it.
  Anyone requesting the client secret "to fix sign-in" is wrong or phishing.
- Don't add wildcard or unused origins.
- Don't weaken site-wide CSP/COOP headers to "fix" Google — the current
  integration works within the existing policies; `origin_mismatch` is not a
  header problem.

## 7. Acceptance test (run by the owner after the console change)

On **staging** first, then production:

1. Open `https://levonis-staging.just-randoomis.workers.dev/auth` in a fresh
   browser profile (no cache). The Google button must render with **no**
   `[GSI_LOGGER]` origin error in the DevTools console.
2. Sign in with an approved **test** Google account. Expect: the popup
   completes, DevTools shows `POST /api/auth/google` → **200** with a `user`
   object, and the page navigates to the return destination.
3. Refresh the page: `GET /api/auth/me` must still return the user (session
   cookie persisted).
4. Sign out; confirm `/api/auth/me` returns `user: null`.
5. Repeat steps 1–4 on `https://levonis-iq.com/auth`.

Only a **real successful sign-in** on the real origin counts as fixed.
A rejected forged credential, or the button merely rendering, proves nothing.

## 8. Live diagnosis — 29 September 2026

Run against the deployed site, not assumed (a headless Chromium clicking the
real Google button and reading the popup):

| Check | Result |
| --- | --- |
| `GET https://levonis-iq.com/api/auth/capabilities` | `google: true`, `googleClientId` = the Web client of project **552307303785** (`552307303785-dn2m6k9g….apps.googleusercontent.com`). The button and the server audience use this one value. |
| Sign-in begun on `https://levonis-iq.com/auth` | **Accepted by Google.** The popup opened on «Sign in to continue to levonis-iq.com» with that client id and `scope=openid email profile`. The apex origin is authorized; there is no Access-blocked page for this client. |
| Sign-in begun on `https://www.levonis-iq.com/auth` | **Refused.** `www` served the whole application (200, no redirect), and GSI logged «The given origin is not allowed for the given client ID» — **`origin_mismatch`**. This is the live bug: anyone who arrived through a `www` link could not sign in. |

**The fix (in code, no console change needed):** `www` is no longer a second
home for the app.

- The Worker answers every document it serves first on `www.<root>` (`/`,
  product, store and bundle pages, the manifest, the crawler files) with a
  **301** to the same path and query on the apex
  (`worker/lib/hosts.ts` `apexRedirectFor`, mounted in `worker/index.ts`).
- The SPA does the same for every page the asset layer answers without the
  Worker — `/auth` among them — before anything renders and before Google's
  script can load (`src/lib/canonicalHost.ts`, called first in
  `src/main.tsx`; no service worker is registered on the way out).
- Never redirected: `/api/*` and `/files/*` (a page already open on `www`
  keeps working until its next navigation; a POST would lose its body), and
  never any host but `www.<root>` — merchant shops, system hosts and foreign
  hosts are untouched, so this is not an open redirect.
- The server's verification is unchanged: RS256 signature against Google's
  keys, issuer, audience = the one client id, expiry and a verified e-mail
  are all still required (`worker/lib/google.ts`).

Pinned by `tests/canonicalHost.test.ts` (both halves, driven through the real
Worker entry point).

**Owner checks that remain (Google Cloud Console, project 552307303785):**

1. The client is of type **Web application**.
2. **Authorized JavaScript origins** = `https://levonis-iq.com` and the staging
   origin actually used for testing
   (`https://levonis-staging.just-randoomis.workers.dev`). No `www` (see
   above), no path such as `/auth`, no wildcard, no merchant subdomain.
3. **Authorized redirect URIs**: empty — the app uses Google Identity Services
   ID tokens, never the authorization-code redirect (§4).
4. **If a user ever sees «Access blocked» / «تم حظر إمكانية الوصول» / «Error
   granting permission»** (not seen in this diagnosis, but checked for):
   open **OAuth consent screen** and check the **publishing status**. In
   **Testing**, only the listed **Test users** can sign in — either add the
   account or **Publish app** (Production). The scopes must be only `openid`,
   `email`, `profile` (non-sensitive: no verification review needed). And the
   client id from `/api/auth/capabilities` must belong to this same project.

---

## ملخص بالعربية (خطوات المالك)

سبب الخطأ `origin_mismatch`: النطاق الذي تبدأ منه صفحة الدخول غير مسجَّل ضمن
**Authorized JavaScript origins** لعميل OAuth الذي يطابق `client_id` الذي
يرسله الموقع المنشور فعلًا (تحقق منه من تبويب Network كما في القسم 2).

الخطوات في Google Cloud Console → **APIs & Services → Credentials** → عميل
**Web application** المطابق للمعرّف:

1. أضف إلى Authorized JavaScript origins:
   - `https://levonis-iq.com`
   - **لا حاجة** لإضافة `https://www.levonis-iq.com`: منذ 29 سبتمبر ينقل الموقع
     كل زيارة لـ `www` إلى `levonis-iq.com` قبل تحميل زر Google (القسم 8).
   - `https://levonis-staging.just-randoomis.workers.dev` — لاختبار staging.
2. الأصل = بروتوكول + مضيف فقط، **بدون** مسار `/auth`.
3. حقل **Authorized redirect URIs** يبقى فارغًا — التكامل يستخدم تدفق
   credential (نافذة GIS المنبثقة) ولا يوجد redirect إطلاقًا.
4. لا تشارك client secret مع أي أحد — هذا التدفق لا يحتاجه.
5. بعد الحفظ انتظر دقائق، ثم نفّذ اختبار القبول في القسم 7 بحساب اختبار
   حقيقي على staging ثم على الإنتاج. لا يُعتبر Google «مُصلَحًا» قبل نجاح
   دخول حقيقي.

**التشخيص الحي (29 سبتمبر):** الدخول من `levonis-iq.com` يقبله Google وتفتح
نافذته «Sign in to continue to levonis-iq.com». الخطأ الفعلي كان عند الدخول من
`www.levonis-iq.com`: كان يعرض التطبيق كاملًا، فيرفضه Google بـ
`origin_mismatch`. الإصلاح في الكود: كل صفحة على `www` تنتقل إلى النطاق الرئيسي
(301 من الخادم، وتحويل فوري في التطبيق)، وتحقق الخادم من توقيع Google لم يتغيّر.
إن ظهرت يومًا رسالة «تم حظر إمكانية الوصول»: افحص حالة شاشة الموافقة (Testing أو
Production) ومستخدمي الاختبار، كما في القسم 8.
