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

## 2. First: confirm which `client_id` the DEPLOYED site actually sends

Do **not** trust repository files or GitHub secret names for this — the
production bundle may have been built with a different value than what you
expect. Read it off the live site:

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

If the live page sends a *different* id than the current GitHub secret
`VITE_GOOGLE_CLIENT_ID`, the deployed bundle is stale — see section 5.

## 3. Console change (owner action)

In [Google Cloud Console](https://console.cloud.google.com/apis/credentials):

1. Select the Google Cloud **project** that owns the client id from step 2.
2. **APIs & Services → Credentials → OAuth 2.0 Client IDs** → open the
   **Web application** client whose *Client ID* equals the value from step 2.
3. Under **Authorized JavaScript origins**, make sure the list includes:

   | Origin | Why |
   | --- | --- |
   | `https://levonis-iq.com` | Production — sign-in happens here. |
   | `https://www.levonis-iq.com` | **Only** if sign-in actually starts on the `www` host (i.e. `www` serves the app instead of redirecting to the apex before the user reaches `/auth`). Do not add other subdomains "just in case" — wildcards are not accepted and unused origins widen the attack surface. |
   | `https://levonis-staging.just-randoomis.workers.dev` | Staging — needed so the acceptance test (section 7) can run on staging first. |

4. An origin is **scheme + host (+ port when non-default)** only.
   `https://levonis-iq.com/auth` is invalid — never include a path.
5. Save. Google states changes can take **from 5 minutes to a few hours** to
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

---

## ملخص بالعربية (خطوات المالك)

سبب الخطأ `origin_mismatch`: النطاق الذي تبدأ منه صفحة الدخول غير مسجَّل ضمن
**Authorized JavaScript origins** لعميل OAuth الذي يطابق `client_id` الذي
يرسله الموقع المنشور فعلًا (تحقق منه من تبويب Network كما في القسم 2).

الخطوات في Google Cloud Console → **APIs & Services → Credentials** → عميل
**Web application** المطابق للمعرّف:

1. أضف إلى Authorized JavaScript origins:
   - `https://levonis-iq.com`
   - `https://www.levonis-iq.com` — فقط إذا كان الدخول يبدأ فعلًا من `www`.
   - `https://levonis-staging.just-randoomis.workers.dev` — لاختبار staging.
2. الأصل = بروتوكول + مضيف فقط، **بدون** مسار `/auth`.
3. حقل **Authorized redirect URIs** يبقى فارغًا — التكامل يستخدم تدفق
   credential (نافذة GIS المنبثقة) ولا يوجد redirect إطلاقًا.
4. لا تشارك client secret مع أي أحد — هذا التدفق لا يحتاجه.
5. بعد الحفظ انتظر دقائق، ثم نفّذ اختبار القبول في القسم 7 بحساب اختبار
   حقيقي على staging ثم على الإنتاج. لا يُعتبر Google «مُصلَحًا» قبل نجاح
   دخول حقيقي.
