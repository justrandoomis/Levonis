# The support assistant's AI layer (push B)

Push B adds an optional AI layer to the support assistant that push A rebuilt
(`worker/lib/assist`). It ships **switched off** (migration 0210,
`ai_settings.enabled = 0`): until the owner turns it on in admin, every reply
is push A's, byte for byte. This file is the design as built. The full plan is
`docs/handoff/assist-ai-layer-B1-plan.md`.

> **The repository is public.** No file names a model, a model line or family,
> or a Workers AI model path, and none holds a key. Model ids live only in D1
> rows (`ai_task_models`) that the owner picks in admin from the provider's
> live list. `tests/aiNoModelNames.test.ts` enforces this.

## What it does

| Task | Provider | What the customer sees |
|---|---|---|
| `understand` | Anthropic (structured output) | A typed message nothing else could place is answered by push A's own search, triage or a read-only intent, with `mode: 'ai'` and a «ليس هذا ما قصدته» chip. |
| `vision` | Anthropic (structured output) | A photo or 2–4 frames of a clip → candidate chips (a code, a symptom, a part, a printer) the customer confirms, or exact catalogue cards for a printed label code. |
| `speech` | Workers AI | An Arabic or English voice note → an editable draft in the customer's own composer. |

## Invariants (plan §2)

1. **No model text reaches a reply (I1).** Every `text` is `tr(loc, key, vars)`;
   a var is a closed-set token or its curated label, a code that passed push
   A's `readHmsCode`, a count, or a storefront card. The only exception is the
   voice transcript, returned in its own top-level `transcript` field.
2. **No price, stock, compatibility verdict, HMS meaning, id, URL or SQL comes
   from a model (I2).** No schema field can carry one.
3. **Every answer is validated by hand (I3)** in
   `worker/lib/assist/ai/validate.ts`: exact keys, enums, patterns, lengths.
   Invalid means basic mode.
4. **Search terms are whole tokens of the customer's own text (I4).** Sizes and
   HMS codes in text come only from push A's `understand()`.
5. **Only reads (I5).** A model picks an action or one read-only intent from
   `ROUTABLE_INTENTS`; `open_ticket`, `cancel_order` and every write are
   excluded. Every handler keeps its own session and ownership checks.
6. **Nothing derived from customer media or text is stored (I6).** The ledger
   holds codes and counts only, with no user id or address.
7. **Logs carry codes and counts only (I7):** one `assist_ai` line per provider
   call.
8. **No model name in any file (I8).**
9. **Budget reserved before every call (I9)**, fail closed.
10. **Sorani is never machine-written (I10).** Sorani speech is never sent;
    Sorani text only with the owner's toggle (off by default).
11. **Basic replies are byte-identical to push A (I11).** No new field, no new
    chip. `tests/aiBasicModeParity.test.ts` replays push A's acceptance and
    price-parity corpora under every basic condition.

## Where the code is

| Path | Role |
|---|---|
| `worker/lib/ai/*` | The only I/O to a provider: transport, providers, config memo, budget, health, run, readiness, prompts, schemas, redaction, JPEG checks, the log line. Never builds a reply text. |
| `worker/lib/assist/ai/*` | Pure: the seam types (`adapter.ts`), the validators (`validate.ts`), the printer aliases (`aliases.ts`), the photo and voice replies (`media.ts`). Never names a provider. |
| `worker/lib/assist/orchestrator.ts` | `handleReading` (a validated reading → push A's own paths), the `code` chip step, the part chip without a printer, and `via` → `ai_read`. |
| `worker/routes/assistAi.ts` | `maybeUnderstand` (the one consult point), and the readiness, read and read-frames routes. |
| `worker/routes/support.ts` | Calls `maybeUnderstand` in NOTHING MATCHED, after the strong lookup; falls through to the legacy switch for a routable intent; marks AI-assisted replies with `markAi`. |
| `worker/routes/adminAssistAi.ts` | The owner's tab API (`/api/admin/assist-ai`). |
| `worker/lib/imageConvert.ts` | `visionRendition`: the photo re-encoded to a 1568 px JPEG (the only `IMAGES` reader). |
| `worker/lib/policies/assistant_ai.ts` | The customer-facing document (version 1), in force only while reading is on. |

## The text path (`POST /api/support/assistant`)

Push A's order is unchanged: `handleTurn`, the legacy `readIntent`, the
pending slot, then NOTHING MATCHED with the strong catalogue lookup. Only when
that lookup shows no card does `maybeUnderstand` run. It returns `null`
(push A's clarify reply, byte for byte) unless all of these hold, in this
order, so nothing is written before the cheap checks:

1. `aiReady('understand')` for this viewer (the switch, a model row with rates,
   the key, the 0210 tables, the cap, the circuit, and the guest toggle for a
   signed-out viewer);
2. the text is at least 4 characters;
3. the page is not Sorani and the text holds no Sorani-only letter, unless the
   owner allowed Sorani reading;
4. 20 per 5 minutes and 60 a day per visitor (`rateLimitAllows`).

A printer the customer says they own («عندي اي ون») was read by the rules and
is not sent. The redacted text goes to the model; the answer is validated
against the unredacted text. Then:

| Reading | What answers | Reply |
|---|---|---|
| `products` | push A's `products()` (the rules win wherever they read something) | `mode: 'ai'` + chip, or clarify when no card |
| `triage` | push A's `runTriage` start | `mode: 'ai'` + chip |
| `outcome` | push A's `runTriage` outcome, only with the steps on screen | `mode: 'ai'` + chip |
| `intent` | the legacy switch, `params = {}` | the handler's reply, follow-ups, then `mode: 'ai'` + chip |
| `none` / invalid / any failure | push A's clarify reply | unchanged |

The «ليس هذا ما قصدته» chip is `{ intent: 'menu' }`. `menu` is no intent the
route knows, so tapping it reaches the route's clarify reply (the topic menu).

## The read routes

All three send `Cache-Control: private, no-store`. The gateway lets guests
through to `/api/support/assistant/*`; each handler checks the session itself,
except readiness, which is public.

### `GET /api/support/assistant/readiness`

```json
{ "success": true, "mode": "basic" | "ai", "text": false, "photo": false, "clip": false,
  "voice": false, "voice_locales": ["ar", "en"], "photo_provider": "anthropic" | null,
  "voice_provider": "cloudflare" | null }
```

`photo`, `clip` and `voice` are false for guests; `photo` also needs `IMAGES`.
Never a model id, cost, cap or rate. A missing table, key or binding reads as
basic.

### `POST /api/support/assistant/read`

Body `{ kind: 'photo' | 'voice', key, consent: true, locale, context }`.

| Status | Code | When |
|---|---|---|
| 401 | `UNAUTHORIZED` | no session |
| 400 | `AI_READ_INVALID` | not a JSON object, an unknown kind, a malformed key |
| 400 | `AI_CONSENT_REQUIRED` | `consent` is not `true` |
| 403 | `ATTACHMENT_NOT_YOURS` | the key is not under the caller's own `assist/<uid>/` |
| 400 | `AI_READ_KIND` | the key is not in the folder of the kind asked for |
| 400 | `ATTACHMENT_NOT_FOUND` | not stored |

Otherwise 200 with `{ success: true, reply }`, or for a voice note heard,
`{ success: true, transcript }`.

**Photo:** the vision task must be ready and `IMAGES` bound (else
`photo_unavailable`), then 10 an hour and 15 a day. The stored picture is
re-encoded in memory (`visionRendition`), its metadata stripped and checked
(SOI, a frame header, sides ≤ 1600, ≤ 1.5 MB, no APP1; else `photo_unclear`),
then read.

**Voice:** `ckb` → `voice_ckb`, no call. Over 1.5 MB in the ledger →
`voice_too_long`. Not ready, or over 20 an hour → `voice_unavailable`. The
transcript passes `readTranscript` (1–500 characters, Arabic or English, a
language probability ≥ 0.6 when given, mostly speech, ≤ 75 s, no Sorani-only
letter) or the reply is `voice_unclear`. No `language` is ever sent.

### `POST /api/support/assistant/read-frames`

Multipart: `key` (the clip's own), `consent=1`, `locale`, `context`, and
`f0`…`f3`. The body is read under a 2 MB cap (413 `AI_FRAMES_TOO_LARGE`);
2–4 frames, each ≤ 400 KB, a JPEG with sides ≤ 1280 and no APP1 (else 400
`AI_FRAMES_INVALID`); the same session, consent and ownership checks (kind
`video`). Frames are read in memory, never stored, and count against no
attachment limit. Not ready or over the limits → `clip_unavailable`.

### The reply fields the page renders

| Field | Where | Meaning |
|---|---|---|
| `mode: 'ai'` | an AI-assisted text reply; a photo or clip reply built from a reading | show `ai_tag` under the bubble |
| `choices[]` with `intent: 'menu'` | «ليس هذا ما قصدته», «لا، ليس هذا» | send `{ intent: 'menu' }`: the topic menu |
| `choices[].params.step: 'code'` | a code read from a photo | send as a printer-problem chip; the server reads the code again |
| `choices[].params.via: 'photo' \| 'clip'` | every candidate chip | send back untouched; it sets `ai_read` |
| `cards` | a printed label code that matched exactly | storefront cards; the code is never shown |
| `context` | a photo reply with cards | replaces the page's context (`shown`) |
| `transcript` | voice, top level | put in the composer under `voice_heard`; never a bubble |
| `intent: 'attachment_read'` | every read reply | |

Photo and clip replies are, first match wins: one code (`photo_code_one`),
several codes (`photo_code_many`, a chip per code), an exact label match
(`photo_label_match`), a symptom (`photo_symptom`), a part (`photo_part`), a
printer at high confidence (`photo_printer`), else `photo_unclear`. A clip's
reply starts with `video_frames_note`. Nothing is auto-selected, and a chip
names only what its sentence named (the photo's printer rides on no symptom or
part chip).

## The ticket

A candidate chip carries `via`; the turn it starts adds the field it set to
the context's `ai_read` (`code`, `symptom`, `printer`, `part`). A later turn
that sets the field another way drops it. «تحدث مع الفريق» then writes the
handoff summary as **version 2** with `read_by_ai` naming the fields the
summary carries; with none it is version 1, byte for byte as push A wrote it.
`readHandoff` and `handoffForStaff` read both; the desk gets `read_by_ai` (only
when present) for its «قرأه المساعد من مرفق وأكّده الزبون» line. The customer's
own `GET /tickets/:id` never returns the summary. Like the rest of the summary,
`read_by_ai` is closed-set data the customer's form sends back; it is a label
for staff, never a permission.

## Basic mode

Basic mode is push A's reply whenever any of these holds: no key, no binding,
no `IMAGES` (photo), no model row, no rates, the switch off, the cap spent, a
limit hit, an open circuit, a provider fault, a timeout, a refusal, a
truncation, or any invalid output. Rollback is `enabled = 0` in admin; it
reaches every isolate within 30 s with no deploy.

## Tests (plan §16)

| File | Proves |
|---|---|
| `tests/aiNoModelTextInReplies.test.ts` | A marker the fake provider plants in every slot never reaches a reply or a chip's answer (I1). |
| `tests/aiValidate.test.ts` | The hand-written validators (I3, I4). |
| `tests/aiBasicModeParity.test.ts` | Push A's acceptance and price-parity corpora replayed under every basic condition, byte for byte (I11). |
| `tests/aiRulesFirst.test.ts` | The model is asked only at the clarify point. |
| `tests/aiInjection.test.ts` | Acceptance test 44. |
| `tests/aiNoActions.test.ts` | Acceptance test 45: no write intent, a SQL spy, no ticket without the customer's confirmed POST. |
| `tests/aiReadRoutes.test.ts` | The read routes' refusals, the rendition strip, frames, voice. |
| `tests/aiReadiness.test.ts` | The readiness flags per configuration and viewer; nothing private in it. |
| `tests/aiHandoffV2.test.ts` | `ai_read` and the version 2 summary. |
| `tests/aiStrings.test.ts` | The server sentences in three languages. |
| `tests/aiLogsNoContent.test.ts`, `tests/aiSingleReaders.test.ts`, `tests/aiNoModelNames.test.ts` | Logs, single readers, no model names. |

`aiBasicModeParity` runs push A's two corpora itself, so it is one of the
slowest files of the suite: each turn is replayed under a permissive probe
first, and only a turn the probe sends to the provider is replayed under all
eighteen conditions (a turn the probe never sends cannot reach the consult
point under a stricter one).

## Pending owner decisions (plan §20)

1. **Vision during triage.** May the vision task be configured? Until yes,
   leave it without a model; Smart Diagnose works without it.
2. **Voice.** Server-side speech-to-text behind the consent sheet, with the
   editable transcript in the composer.
3. **Wording.** The consent texts, the AI greeting and the policy document
   `assistant_ai` in all three languages, including "not used to train any
   model", which must match each provider's terms. Support policy chapter 3
   describes the assistant as rules-only; it is true while the layer is off
   and needs the owner's rewording (a version bump) before `enabled = 1`.
4. **Account.** Workers AI permission on workflow 7's token (B0 showed it),
   and Workers Paid for speech beyond the daily free allocation.

Defaults the owner can keep or change in admin: cap $1.00 a day (UTC), guests
off with a 25 % share, Sorani text reading off.
