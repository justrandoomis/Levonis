# Signing in: what is configured, and where that is decided

One endpoint answers the whole question:

```bash
curl -s https://levonis-iq.com/api/auth/capabilities | jq
```

```json
{
  "emailPassword": true,
  "passwordReset": false,
  "emailVerification": false,
  "google": false,
  "googleClientId": "",
  "telegram": false,
  "telegramBot": "",
  "phoneSignIn": true,
  "phoneOtp": false,
  "phoneSignup": false,
  "emailOtp": false,
  "whatsappOtp": false,
  "defaultCountry": "IQ"
}
```

The auth page renders exactly the methods this says are available. A method
that is off is **not shown at all** — there is no disabled button and no panel
whose content is an explanation of why it cannot work.

Nothing secret is in the response. A Google client id is public by
construction (Google puts it in the page, the redirect and every token's
audience); everything else is a boolean.

---

## 1. Why this endpoint exists

Both production failures had the same shape: a value that decided whether a
button appeared, and a *different* value that decided whether pressing it
could work.

| Provider | What the browser checked | What the server checked | Failure the customer saw |
| --- | --- | --- | --- |
| Google | `VITE_GOOGLE_CLIENT_ID`, baked into the bundle at build time | `GOOGLE_CLIENT_ID`, a variable on the Worker | "Google sign-in is not enabled on this deployment" — on a deployment that may have been configured correctly |
| Email | nothing | `EMAIL_API_KEY` + `EMAIL_FROM` on the Worker | "Password reset is unavailable because no mail service is configured" |

There is now one source: the Worker, read at runtime. The build carries no
provider configuration at all, so a build made on a runner without a
repository secret can no longer produce a site that lies about its own
capabilities.

An operator gets more detail from `GET /api/admin/providers` (admin only),
which additionally reports whether the Telegram bot actually **answered**
and whether the staging email allowlist is on.

---

## 2. Google

**Architecture: Identity Services ID token, verified server-side.** The
browser gets a signed JWT from Google and posts it to `POST /api/auth/google`;
the Worker verifies the RS256 signature against Google's published JWKS, plus
issuer, audience, expiry and `email_verified` (`worker/lib/google.ts`).

Two things follow, and both remove a category of configuration error:

- **There is no client secret.** No authorization-code exchange happens, so
  none is needed and none is stored.
- **There is no callback / redirect URI.** Nothing to register, nothing to
  keep in sync with a domain. The only Google Console setting that matters is
  **Authorized JavaScript origins**.

### What the owner sets

| Where | Name | Value |
| --- | --- | --- |
| GitHub → repository secrets | `VITE_GOOGLE_CLIENT_ID` | `<id>.apps.googleusercontent.com` |
| Google Cloud Console → OAuth client → Authorized JavaScript origins | — | `https://levonis-iq.com` |

Workflow 7 writes that secret to the Worker's `GOOGLE_CLIENT_ID` variable, so
the two halves cannot drift apart. Step-by-step console instructions, and the
`origin_mismatch` failure mode, are in **`docs/GOOGLE_SIGNIN_FIX.md`**.

> **A merchant storefront host is never an authorized origin.** A merchant
> controls the content of their storefront; an authorized origin there would
> let a page they wrote start a Google sign-in carrying this platform's client
> id. Google does not accept wildcards, which helps, but the rule is the point.

### Account matching

`resolveGoogleIdentity` (in `worker/routes/auth.ts`, extracted so it can be
tested without a live Google token) decides whether two identities are one
person:

1. **Known `google_sub`** → that account. Signing in twice is one account, and
   a changed display name at Google does not fork it.
2. **An existing account with the same address that PROVED it**
   (`email_verified_at` set) → Google is linked to that account.
3. **An existing account with the same address that never proved it** →
   **refused**, with the recovery path named. Anyone can type an address into
   a signup form, so an unverified local account is not evidence that its
   owner and the Google identity are the same person; merging would hand that
   account — its orders, its wallet — to whichever of the two signed up first.
4. **Nothing matches** → a new account, with a handle derived from the address
   that must pass the same rules a typed one does (so `admin@gmail.com` does
   not become the handle `admin`).

---

## 3. Email — password reset and verification

**Provider: Resend**, via `EMAIL_API_KEY` (a Worker *secret*) and `EMAIL_FROM`
(a variable). Both must be present; either alone is off.

### The bug that kept this off in production

Worker **secrets are not carried forward by a deploy** the way plain-text vars
are — they have to be uploaded. The only workflows that uploaded
`EMAIL_API_KEY` target a Worker named `levonis`, which does not exist on this
account (`docs/DECISIONS.md` row 52): the Worker actually serving
levonis-iq.com is `levonis-staging`, deployed by **workflow 7**, which never
uploaded it. So the key never reached the running site, and every reset
refused itself — correctly, and forever.

Workflow 7 now uploads it, opt-in: unset means the feature stays honestly
disabled rather than pretending to send.

### `EMAIL_ALLOWED_RECIPIENTS` — the silent outage

A staging guard. When it is non-empty, every message to an address outside the
list is **dropped**, with a console warning and an **unchanged HTTP response**
— so a password reset reports itself as sent and never arrives. Workflow 7
now **refuses to deploy** while it is set, and `GET /api/admin/providers`
reports it as a warning.

### What the reset flow guarantees

| Rule | Where |
| --- | --- |
| The response is identical whether or not the account exists | `POST /api/auth/forgot-password` |
| The token is stored as a SHA-256 hash — the database never holds the link | `password_reset_tokens.token_hash` |
| 30-minute expiry | same |
| Single use, enforced by a conditional UPDATE so two concurrent submissions cannot both win | `POST /api/auth/reset-password` |
| Every existing session is destroyed on success | same |
| Invalid, used and expired all produce the SAME wording | same |
| The link is built on the canonical origin, never on the host the request arrived at | `worker/lib/appOrigin.ts` |

That last row is the one that matters most since wildcard subdomains went
live: a reset link built from the request host would deliver a customer's
token to a page a merchant wrote.

---

## 4. Telegram

`TELEGRAM_BOT_TOKEN` (secret) plus a webhook secret. `capabilities.telegram`
is true only when the bot **answered** `getMe` — a revoked or mistyped token
looks identical to a working one otherwise.

Telegram is also how a phone number is proven. The browser never proves
anything about a number typed into it: the person shares their own contact
inside the private bot chat, the server verifies it, and a one-time code
completes the flow.

---

## 4b. Sign-in codes — email and WhatsApp

**Two endpoints, and they SIGN IN only.**

```
POST /api/auth/otp/start    { channel: "email" | "whatsapp", identifier, lang }
POST /api/auth/otp/verify   { channel, identifier, code }
```

A code proves control of an address or a number. It does not answer the
questions a NEW account needs answered — a username, a referral, whether a
password is wanted — so creating one here would make a half-account nobody
asked for. Sign-up stays where those questions are asked.

| Channel | Where the code goes | Why that is enough |
| --- | --- | --- |
| `email` | `users.email` | Receiving it IS the mailbox proof — the same proof `/verify-email/confirm` accepts, so a successful sign-in also stamps `email_verified_at`. |
| `whatsapp` | `users.phone_e164` | Migration 0013 is explicit that this column is only ever written after Telegram contact verification: *"a phone typed into a form is never stored here"*. The number is already proven; WhatsApp on it is a second factor of the same ownership. |

**`/start` cannot be used to find out who has an account.** An address with no
account writes a *decoy* challenge — `user_id NULL`, nothing sent — so the
response, its shape and the 60-second resend cooldown are identical either
way. The cooldown is keyed on the DESTINATION rather than a user id, because a
per-user cooldown is itself an oracle. `/verify` has one uniform failure for
every cause, exactly like `/login`.

**The one thing `/start` does not hide** is that the channel is switched off:
a shop with no mail provider, or no WhatsApp key, answers 503 with a reason.
Pretending to send a code that can never arrive leaves the customer waiting on
nothing.

The rules are the Telegram OTP's, deliberately — unbiased WebCrypto digits,
only a salted SHA-256 digest stored, 10-minute TTL, 5 attempts claimed BEFORE
the comparison, timing-safe compare, supersede-on-resend, conditional consume
(`worker/lib/authOtp.ts`, table `auth_otp`, migration 0087). A six-digit code
that behaves differently depending on which channel carried it is a code
nobody can reason about.

### WhatsApp: WasenderAPI

`WASENDER_API_KEY` (a Worker *secret*). The provider drives a **real WhatsApp
account** — the shop's own number, linked by QR or passkey — and three
consequences run through everything:

1. **A key present is not a working channel.** The session can be logged out
   while the token stays valid, so `capabilities.whatsappOtp` means *a key is
   set*, and only **Admin → Customer channels** asks the provider for the
   session's real state.
2. **The send ceiling is tiny and per-session:** 256/minute on a paid plan,
   but **one message per five seconds** with Account Protection on, and
   1/minute and 50/day on a trial. Notifications therefore go through the
   durable outbox; only the sign-in code sends directly, and a 429 is reported
   with the provider's own retry hint rather than swallowed.
3. **`to` also accepts group and channel JIDs.** A stored "phone" of
   `120363…@g.us` would broadcast a customer's code to a group, so E.164
   validation happens before the network and is a security boundary, not
   tidiness.

---

## 5. Phone

| | State | Why |
| --- | --- | --- |
| Sign IN with a phone number | **works** | The identifier field takes an email, a username or a phone; the server matches it against the account's verified `phone_e164`. |
| Sign UP with a phone number alone | **refused** | A typed number proves nothing. Account creation on a number goes through Telegram. |
| SMS / OTP provider | **none** | `capabilities.phoneOtp` is `false`, so no SMS flow is advertised. |
| A CODE on a phone | **works, over WhatsApp** | §4b. Not SMS: nothing here talks to a carrier. It goes to the number the account already proved it owns. |

There is no separate "Phone" tab any more. Signing up there always failed —
the panel's only possible outcome was an error telling you to use Telegram —
and signing in never needed one.

### Validation

`worker/lib/phone.ts` and `src/components/auth/PhoneField.tsx` both use
**libphonenumber** metadata, so each country's real numbering plan decides.
The previous rule was Iraq-strict plus "8–15 digits" for everywhere else,
which accepted `+971000000000` as a UAE number.

Deliberately **not** checked: whether the number is a mobile line. The bundled
metadata cannot tell mobile from fixed line in every country (the whole US
range is `FIXED_LINE_OR_MOBILE`), so requiring it would be strict in some
countries and meaningless in others. Ownership is proven by Telegram
answering, not by a number range.

Country names in the picker come from `Intl.DisplayNames`, so all 245
countries are listed in Arabic, English and Kurdish with no translation table
to fall out of date.

---

## 6. Account setup and the completion prompt

Signup asks for what it needs. `/welcome` asks for the rest in two steps that
can each be skipped, and the whole wizard can be left at once — the account
already exists and works before that page is ever rendered.

**Completion is computed, never stored** (`worker/lib/profileCompletion.ts`).
A stored boolean goes stale the first time a field is edited by a path that
forgets to update it; a derived one cannot disagree with the fields.

**Whether to show the prompt is decided server-side**, from
`users.profile_prompt_at`. A dismissal kept in `localStorage` is per-device
and per-browser — the same person is asked again on their phone, and again
after clearing site data. The interval widens **3 → 7 → 30 → 90 days**, and
the prompt never appears in the cart, at checkout, on the auth page, or on top
of the wizard that is already asking the same questions.

Fields counted: name, username, avatar, locale, country, phone, email. Birth
date and gender are **not** — the platform does not use them, and putting them
in the score would turn "complete your profile" into pressure to hand over
data for nothing.


---

## 8. Opening an account on a phone number

For a long time a phone could sign you IN and could not sign you UP, unless you
went through Telegram. That was never a policy — it is which flow was built
first — and what it looked like from outside was the owner standing on their
own sign-in page holding a number the shop can reach, told
«لا يوجد حساب موثّق بهذا الرقم» with nothing to do about it.

### The shape

```
/auth  →  «المتابعة برقم الهاتف»
          ├─ the number            (PhoneField + CountryPicker)
          └─ where should the code go?
             ├─ WhatsApp  → POST /api/auth/otp/start   { intent: 'signup' }
             │              POST /api/auth/otp/verify  { allow_signup: true }
             │                → signed in, if the number already has an account
             │                → a TICKET, if it does not
             │              POST /api/auth/signup/otp-complete { ticket, name }
             └─ Telegram  → the existing /telegram/* flow, which already creates
                            accounts and proves the number its own way
```

**One button for the phone, not one per channel.** "WhatsApp or Telegram" is a
question about a number that already exists, so it is asked after the number
and not instead of it.

### Why a ticket and not a session

A six-digit code proves one thing — that the person is holding the phone — and
`auth_otp` consumes it the instant it does, because single use is what a code is
for. Creating an account needs more: a name, maybe a handle, maybe a password,
and typing those takes longer than a code should live.

So the proof is exchanged for a row in `signup_tickets`: fifteen minutes, one
use, and it authorises **exactly one thing** — creating one account on the one
destination it names.

* It carries no user id, because no user exists yet.
* It is consumed by the same batch that inserts the account, guarded by
  `consumed_at IS NULL`, so two submissions racing make one account.
* **The destination is read from the ticket and never from the request body.**
  A ticket earned on one number creating an account on another is the whole
  attack this shape exists to prevent, and a "convenience" `phone` field in the
  body would be exactly that hole. `tests/authPhoneSignup.test.ts` sends four of
  them at once and asserts the proven number wins.

### What did not change

`/otp/start` still keeps its decoy on the **sign-in** path: an unknown
destination gets a row, gets no message, and gets the same response, so the
endpoint cannot be used to ask whether an address has an account. Only
`intent: 'signup'` really sends, because there the destination is a stranger by
definition — and that is answered by the two rate limits (eight per IP per
quarter hour, four per destination per hour), not by refusing to have the
feature.

It does not become an existence oracle either: both paths answer the same
shape, and which of the two happens next — a session or a ticket — is learned
only by somebody holding the code.

### What the account is

A phone account stores the number in `users.phone_e164` and nothing in the email
column but the non-routable placeholder (§2.3, decision row 27). A phone is not
an address, and inventing `+9647xx@something` would make every later "is this a
real mailbox" test wrong. A person who also gives a real address gets it stored
**unverified**: a WhatsApp code proves the phone and says nothing whatever about
the mailbox. A password is optional — the account can live on codes alone.

---

## 9. Names a customer may not use

`worker/lib/nameGuard.ts` refuses a display name or a handle that is not
something the next customer should have to read, and
`worker/lib/decency.ts` adds the owner's own words from `blocked_terms`
(`GET/POST/DELETE /api/admin/blocked-terms`, no deploy needed).

The whole difficulty is the Scunthorpe problem, so every term declares **how**
it may match: `word` only between non-letters, `any` anywhere. «كس» is `word`
because «مكسور» exists; `fuck` is `any` because nothing ordinary contains it.
Arabic takes its article as a prefix, so «الحمار» matches «حمار» — and takes
real names as suffixes, so «خولة» and «زبيدة» do **not** match «خول» and «زب».

Evasion is spelling, not meaning, so it is answered by normalising: repeated
letters (`fuuuck`), one separator between letters (`f.u.c.k`), and Latin
leetspeak (`sh1t`, `a$$`). The Arabizi digits `3 5 7` are deliberately **not**
folded — `5` is خ, not `s`, and folding it would reject everyone named Sara.

The message never names what was found. A filter that quotes the word back
teaches people exactly which letter to change, and repeats the insult to
whoever is holding the phone.


---

## 10. Why the providers keep switching themselves off

**Every push to the default branch blanks Google sign-in and all outbound email
on the live shop, silently.** It is not the secrets, it is not the code, and
re-running the deploy fixes it only until the next push.

### The evidence

Workflow 7 (run 109) finished at **03:37:56** on 2026-09-18, and its own
verification step read the live site back:

```
passwordReset: true          googleClientId: present and Google-shaped
emailVerification: true      plain-text vars: 9 before, 9 after
google: true                 APP_ORIGIN, EMAIL_FROM, GOOGLE_CLIENT_ID, …
```

A push to the default branch at **03:57**. Three minutes later:

```json
{ "google": false, "googleClientId": "", "emailOtp": false, "whatsappOtp": true }
```

### The mechanism

There are **two deployers** for `levonis-staging`:

| Deployer | Fires on | Vars |
|---|---|---|
| `.github/workflows/deploy-staging-code.yml` (workflow 7) | manual dispatch | reads the RUNNING Worker's vars first and passes every one back with `--var` |
| Cloudflare **Workers Builds** Git integration | every push to the default branch | reads `wrangler.jsonc` and passes **no** `--var` |

`wrangler deploy` replaces a Worker's plain-text vars **wholesale**, and
`wrangler.jsonc` declares them as empty strings:

```jsonc
"GOOGLE_CLIENT_ID": "",  "EMAIL_FROM": "",  "APP_ORIGIN": "",  "STORE_ROOT_DOMAIN": "", …
```

An empty string there is not "unset" — it is an instruction to blank the live
value. So the Git integration writes `""` over nine working vars on every push.

**Secrets survive, vars do not.** `WASENDER_API_KEY`, `EMAIL_API_KEY` and the
Telegram tokens live in a separate store that `wrangler deploy` does not touch,
which is exactly why `whatsappOtp` stayed `true` while `google` went `false` —
and why the failure looks random until you sort the configuration by which
store it lives in.

`emailOtp` needs **both** halves: `EMAIL_API_KEY` (a secret, survived) **and**
`EMAIL_FROM` (a var, blanked). One of the two being wiped is enough.

### The fix is one deployer

Disconnect the Git integration in Cloudflare — **Workers & Pages →
`levonis-staging` → Settings → Builds** — and deploy through workflow 7, which
reads the running Worker first and refuses outright if that read fails. This is
the whole reason workflow 7's header says `wrangler deploy` replaces vars
wholesale: the file was written against this exact failure, and the Git
integration walks into it from the other side.

The alternative is committing the real values into `wrangler.jsonc`. The Google
client id is public by construction and `APP_ORIGIN` / `STORE_ROOT_DOMAIN` are
the shop's own domain, so that would work — but it puts the owner's
configuration in the repository, which is the owner's decision and not a default
this repo takes on its own.

### How to tell, in one request

```bash
curl -s https://levonis-iq.com/api/auth/capabilities | jq '{google, emailOtp, whatsappOtp}'
```

`google:false` with `whatsappOtp:true` is this bug, every time: a var was lost
and a secret was not.
