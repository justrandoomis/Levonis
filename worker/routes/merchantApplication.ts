import { Hono, type Context } from 'hono';
import type { AppContext, Env } from '../lib/types';
import { safeParse } from '../lib/types';
import { requireAuth, badRequest, conflict, notFound, unavailable } from '../lib/http';
import { newId } from '../lib/crypto';
import { seal, unseal, sealboxConfigured } from '../lib/sealbox';
import { auditStatements } from '../lib/audit';
import { rateLimit } from '../lib/ratelimit';
import { sniff } from './uploads';
import { deleteMediaObject, storeMedia } from '../lib/mediaStorage';
import { webpConversionAvailable } from '../lib/imageConvert';
import { announceAfterResponse } from '../lib/adminTopicRouting';
import { normalizeGovernorate } from '../lib/iraqGovernorates';
import { changedExactlyOne, isLostRace } from '../lib/gifts/fence';
import {
  ACTIVITY_KINDS,
  MIN_APPLICANT_AGE,
  ageOn,
  applyTransition,
  baghdadToday,
  eventStatement,
  isLiveState,
  isMissingSchema,
  merchantApprovalOf,
  operationIdFrom,
  parseDob,
  parseLegalName,
  parsePublicLinks,
  parseSocialLink,
  submittedNoticeText,
  transitionRefusal,
  type LegalName,
} from '../lib/merchantApproval';

/**
 * THE MERCHANT APPLICATION — the applicant's side (Community V3 push 1.1,
 * DECISIONS row 256; gap §3.1–§3.2, §3.7).
 *
 *   GET  /api/merchant-application           the applicant's application (latest), its state and what is missing
 *   PUT  /api/merchant-application           save the draft (creates one; re-applies after a rejection — C8)
 *   POST /api/merchant-application/photo     the private review photo (WebP re-encode strips EXIF)
 *   POST /api/merchant-application/submit    draft → submitted (verified phone + 18+, C6)
 *   POST /api/merchant-application/withdraw  any live state → withdrawn
 *
 * NEVER PLUS-GATED (owner decision C3): applying is open to every signed-in
 * account; selling after approval still needs PLUS at /onboard.
 *
 * PRIVATE BY CONSTRUCTION.
 *   - The legal name, the date of birth and the activity link are sealed with
 *     the KYC_ENC_KEY ring before they reach D1; no column holds them in
 *     plaintext, and with no usable key or no private bucket every write
 *     answers 503 MERCHANT_REVIEW_NOT_CONFIGURED instead of storing anything.
 *   - No response carries them back, not even to the applicant: the answer
 *     says which were PROVIDED (booleans), never what they are — the same
 *     model as KYC's /mine. Nor do audit rows, notices, logs or refusals.
 *   - The photo lives under `merchant-review/<application id>/photo/…` in the
 *     private bucket, re-encoded to WebP so no EXIF/GPS survives; /files
 *     serves no such prefix (worker/routes/uploads.ts 404s it), and the upload
 *     answers with no key and no URL.
 *   - `note_internal` is never selected for the applicant.
 */
export const merchantApplicationRoutes = new Hono<AppContext>();
merchantApplicationRoutes.use('*', requireAuth);

const PHOTO_MAX = 8 * 1024 * 1024;
const PHOTO_TYPES = new Set(['image/jpeg', 'image/png']);

/** Every column the applicant's own answer may be built from. `note_internal` and `decided_by` are not here. */
const APPLICANT_COLUMNS = `id, user_id, state, revision, created_at, updated_at, submitted_at,
  legal_name_enc, dob_enc, social_link_enc, photo_key,
  governorate, activity_kind, activity_description,
  public_name, public_bio, public_links, reason_public, decided_at, purged_at`;

interface ApplicationRow {
  id: string;
  user_id: string;
  state: string;
  revision: number;
  created_at: string;
  updated_at: string;
  submitted_at: string | null;
  legal_name_enc: string;
  dob_enc: string;
  social_link_enc: string;
  photo_key: string | null;
  governorate: string;
  activity_kind: string;
  activity_description: string;
  public_name: string;
  public_bio: string;
  public_links: string;
  reason_public: string;
  decided_at: string | null;
  purged_at: string | null;
}

/** The applicant's answer: their own public draft and review context, and booleans for the private values. */
function applicantView(r: ApplicationRow) {
  const decided = r.state === 'changes_requested' || r.state === 'approved' || r.state === 'rejected';
  return {
    id: r.id,
    state: r.state,
    revision: Number(r.revision),
    created_at: r.created_at,
    updated_at: r.updated_at,
    submitted_at: r.submitted_at,
    decided_at: decided ? r.decided_at : null,
    reason_public: decided ? r.reason_public : '',
    public: { name: r.public_name, bio: r.public_bio, links: safeParse<string[]>(r.public_links, []) },
    review: { governorate: r.governorate, activity_kind: r.activity_kind, activity_description: r.activity_description },
    provided: {
      legal_name: r.legal_name_enc !== '',
      dob: r.dob_enc !== '',
      social_link: r.social_link_enc !== '',
      photo: !!r.photo_key,
    },
    purged: !!r.purged_at,
  };
}

const schemaUnavailable = () =>
  unavailable(
    'طلبات اعتماد التجار غير متاحة على هذا الخادم بعد / Merchant applications are not available on this server yet',
    'MERCHANT_APPLICATIONS_UNAVAILABLE'
  );

/** A read or write of 0204's tables, with their absence answered as an honest 503 (fails closed). */
async function guarded<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (isMissingSchema(e)) throw schemaUnavailable();
    throw e;
  }
}

/** The application the applicant is looking at: the live one if any, else the newest finished one. */
async function latestApplication(db: D1Database, userId: string): Promise<ApplicationRow | null> {
  return db
    .prepare(
      `SELECT ${APPLICANT_COLUMNS} FROM merchant_applications WHERE user_id = ?
        ORDER BY CASE WHEN state IN ('draft','submitted','in_review','changes_requested') THEN 0 ELSE 1 END,
                 created_at DESC, rowid DESC
        LIMIT 1`
    )
    .bind(userId)
    .first<ApplicationRow>();
}

async function applicationById(db: D1Database, id: string): Promise<ApplicationRow> {
  const row = await db.prepare(`SELECT ${APPLICANT_COLUMNS} FROM merchant_applications WHERE id = ?`).bind(id).first<ApplicationRow>();
  if (!row) throw notFound('Application not found');
  return row;
}

async function phoneVerified(db: D1Database, userId: string): Promise<boolean> {
  const link = await db
    .prepare('SELECT 1 AS x FROM telegram_links WHERE user_id = ? AND revoked_at IS NULL LIMIT 1')
    .bind(userId)
    .first();
  return !!link;
}

/** A key ring that actually seals — `sealboxConfigured` only says the secret is non-empty. */
async function sealWorks(secret: string | undefined): Promise<boolean> {
  if (!sealboxConfigured(secret)) return false;
  try {
    await seal(secret, 'probe');
    return true;
  } catch {
    return false;
  }
}

/** Ready to hold private review data: a usable key ring, the dedicated private bucket and, for a photo, the re-encoder. */
async function readiness(env: Env, photo: boolean): Promise<boolean> {
  if (!(await sealWorks(env.KYC_ENC_KEY))) return false;
  if (!env.R2_PRIVATE) return false;
  if (photo && !webpConversionAvailable(env)) return false;
  return true;
}

async function requireReady(env: Env, photo = false): Promise<void> {
  if (await readiness(env, photo)) return;
  throw unavailable(
    'استقبال طلبات اعتماد التجار غير مفعّل بعد على هذا الخادم / Merchant applications cannot be received on this server yet',
    'MERCHANT_REVIEW_NOT_CONFIGURED'
  );
}

const changedNow = () =>
  conflict('تغيّر الطلب للتو؛ حدّث الصفحة ثم أعد المحاولة / The application just changed; refresh and try again', 'APPLICATION_CHANGED');

const fieldInvalid = (field: string) =>
  badRequest('أحد حقول الطلب غير صالح / One of the application fields is not valid', 'APPLICATION_FIELD_INVALID', { field });

const underAge = () =>
  badRequest(
    `يجب أن يكون عمر مقدّم الطلب ${MIN_APPLICANT_AGE} سنة على الأقل / The applicant must be at least ${MIN_APPLICANT_AGE} years old`,
    'APPLICANT_UNDER_18'
  );

interface DraftPatch {
  legal_name?: LegalName;
  dob?: string;
  social_link?: string;
  governorate?: string;
  activity_kind?: string;
  activity_description?: string;
  public_name?: string;
  public_bio?: string;
  public_links?: string[];
}

function plainText(v: unknown, field: string, max: number, min = 0): string {
  if (typeof v !== 'string') throw fieldInvalid(field);
  const t = v.replace(/\s+/g, ' ').trim();
  if (t.length < min || t.length > max) throw fieldInvalid(field);
  return t;
}

/**
 * Text written in paragraphs (a textarea): line breaks are KEPT — the reviewer
 * reads it with its lines — while each line's spaces collapse and a run of
 * blank lines becomes one.
 */
function paragraphText(v: unknown, field: string, max: number): string {
  if (typeof v !== 'string') throw fieldInvalid(field);
  const t = v
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (t.length > max) throw fieldInvalid(field);
  return t;
}

/** Only the fields present are validated and saved. A refusal names the FIELD, never its value. */
function parseDraft(body: Record<string, unknown>): DraftPatch {
  const out: DraftPatch = {};
  if (body.legal_name !== undefined) {
    const n = parseLegalName(body.legal_name);
    if (!n) throw fieldInvalid('legal_name');
    out.legal_name = n;
  }
  if (body.dob !== undefined) {
    const today = baghdadToday();
    const d = parseDob(body.dob, today);
    if (!d) throw fieldInvalid('dob');
    if (ageOn(d, today) < MIN_APPLICANT_AGE) throw underAge();
    out.dob = d;
  }
  if (body.social_link !== undefined) {
    const l = parseSocialLink(body.social_link);
    if (!l) throw fieldInvalid('social_link');
    out.social_link = l;
  }
  if (body.governorate !== undefined) {
    const raw = plainText(body.governorate, 'governorate', 60);
    const g = raw ? normalizeGovernorate(raw) : '';
    if (raw && !g) throw fieldInvalid('governorate');
    out.governorate = g;
  }
  if (body.activity_kind !== undefined) {
    if (body.activity_kind !== '' && !(ACTIVITY_KINDS as readonly unknown[]).includes(body.activity_kind)) throw fieldInvalid('activity_kind');
    out.activity_kind = String(body.activity_kind);
  }
  if (body.activity_description !== undefined) out.activity_description = paragraphText(body.activity_description, 'activity_description', 1000);
  if (body.public_name !== undefined) {
    const n = plainText(body.public_name, 'public_name', 60);
    if (n.length === 1) throw fieldInvalid('public_name');
    out.public_name = n;
  }
  if (body.public_bio !== undefined) {
    if (typeof body.public_bio !== 'string' || body.public_bio.trim().length > 500) throw fieldInvalid('public_bio');
    out.public_bio = body.public_bio.trim();
  }
  if (body.public_links !== undefined) {
    const links = parsePublicLinks(body.public_links);
    if (!links) throw fieldInvalid('public_links');
    out.public_links = links;
  }
  return out;
}

/** The patch as column → stored value, the three private values SEALED. */
async function storedColumns(env: Env, p: DraftPatch): Promise<Array<[string, string]>> {
  const key = env.KYC_ENC_KEY;
  const cols: Array<[string, string]> = [];
  if (p.legal_name) cols.push(['legal_name_enc', await seal(key, JSON.stringify(p.legal_name))]);
  if (p.dob) cols.push(['dob_enc', await seal(key, p.dob)]);
  if (p.social_link) cols.push(['social_link_enc', await seal(key, p.social_link)]);
  if (p.governorate !== undefined) cols.push(['governorate', p.governorate]);
  if (p.activity_kind !== undefined) cols.push(['activity_kind', p.activity_kind]);
  if (p.activity_description !== undefined) cols.push(['activity_description', p.activity_description]);
  if (p.public_name !== undefined) cols.push(['public_name', p.public_name]);
  if (p.public_bio !== undefined) cols.push(['public_bio', p.public_bio]);
  if (p.public_links !== undefined) cols.push(['public_links', JSON.stringify(p.public_links)]);
  return cols;
}

/**
 * THE APPLICATION THE APPLICANT MAY EDIT NOW, in state `draft`.
 *
 *   - none live (none at all, or the last one finished): a NEW draft at
 *     revision 1 — this is how a rejected applicant re-applies, at once (C8);
 *     refused only when this user is already approved;
 *   - a draft: itself;
 *   - submitted or changes_requested: reopened to a draft at revision + 1, so
 *     a reviewer never decides on a revision that changed under them;
 *   - in review: locked until the reviewer decides.
 */
async function editableApplication(c: Context<AppContext>, userId: string): Promise<ApplicationRow> {
  const db = c.env.DB;
  const latest = await latestApplication(db, userId);
  if (latest && latest.state === 'draft') return latest;
  if (latest && latest.state === 'in_review') {
    throw conflict(
      'طلبك قيد المراجعة الآن ولا يمكن تعديله حتى يصدر القرار / Your application is being reviewed and cannot be edited until a decision',
      'APPLICATION_LOCKED'
    );
  }
  if (latest && isLiveState(latest.state)) {
    const out = await applyTransition(db, {
      application: latest,
      action: 'reopen',
      actor: { id: userId, kind: 'applicant' },
      operationId: operationIdFrom(undefined),
    });
    if (!out.ok) throw transitionRefusal(out.code);
    return applicationById(db, latest.id);
  }
  if (latest?.state === 'approved' || (await merchantApprovalOf(db, userId)).approved) {
    throw conflict('أنت تاجر معتمد بالفعل / You are already an approved merchant', 'MERCHANT_ALREADY_APPROVED');
  }
  const id = newId('mapp');
  const now = new Date().toISOString();
  const { statements: auditRows } = await auditStatements(db, userId, 'merchant_application.created', id, { revision: 1 });
  try {
    await db.batch([
      db
        .prepare(
          `INSERT INTO merchant_applications (id, user_id, state, revision, created_at, updated_at)
           VALUES (?, ?, 'draft', 1, ?, ?)`
        )
        .bind(id, userId, now, now),
      eventStatement(db, {
        applicationId: id,
        revision: 1,
        actorId: userId,
        actorKind: 'applicant',
        action: 'created',
        at: now,
        operationId: `create:${id}`,
      }),
      ...auditRows,
    ]);
  } catch (e) {
    // A second tab created it a moment ago: the partial unique index kept it to one.
    const msg = e instanceof Error ? e.message : String(e);
    if (!/UNIQUE constraint failed: merchant_applications\.user_id/.test(msg)) throw e;
    const again = await latestApplication(db, userId);
    if (again && again.state === 'draft') return again;
    throw changedNow();
  }
  return applicationById(db, id);
}

/**
 * One guarded write to a DRAFT at the revision it was read at, with its audit
 * row. `photoKeyWas` (the photo write) also fences on the photo it replaces:
 * draft writes keep the revision, so two overlapping uploads would otherwise
 * both win and the first one's object would be left unreferenced.
 */
async function writeDraft(
  db: D1Database,
  app: ApplicationRow,
  cols: Array<[string, string | null]>,
  actorId: string,
  auditAction: string,
  auditDetail: Record<string, unknown>,
  photoKeyWas?: string | null
): Promise<void> {
  const now = new Date().toISOString();
  const { statements: auditRows } = await auditStatements(db, actorId, auditAction, app.id, auditDetail);
  const photoFence = photoKeyWas === undefined ? '' : ' AND photo_key IS ?';
  const photoBind = photoKeyWas === undefined ? [] : [photoKeyWas];
  try {
    await db.batch([
      db
        .prepare(
          `UPDATE merchant_applications SET ${cols.map(([k]) => `${k} = ?`).join(', ')}, updated_at = ?
            WHERE id = ? AND state = 'draft' AND revision = ?${photoFence}`
        )
        .bind(...cols.map(([, v]) => v), now, app.id, app.revision, ...photoBind),
      ...changedExactlyOne(db),
      ...auditRows,
    ]);
  } catch (e) {
    if (isLostRace(e)) {
      throw changedNow();
    }
    throw e;
  }
}

// --------------------------------------------------------------------- read

merchantApplicationRoutes.get('/', async (c) => {
  const user = c.get('user')!;
  const db = c.env.DB;
  let latest: ApplicationRow | null;
  try {
    latest = await latestApplication(db, user.id);
  } catch (e) {
    if (!isMissingSchema(e)) throw e;
    return c.json({ success: true, available: false, application: null, approved: false });
  }
  const [approval, phone, ready] = await Promise.all([
    merchantApprovalOf(db, user.id),
    phoneVerified(db, user.id),
    readiness(c.env, false),
  ]);
  const live = !!latest && isLiveState(latest.state);
  const approved = approval.approved || latest?.state === 'approved';
  return c.json({
    success: true,
    available: true,
    application: latest ? applicantView(latest) : null,
    approved,
    requirements: { phone_verified: phone, min_age: MIN_APPLICANT_AGE, ready },
    can: {
      apply: !live && !approved,
      edit: !!latest && (latest.state === 'draft' || latest.state === 'submitted' || latest.state === 'changes_requested'),
      submit: latest?.state === 'draft',
      withdraw: live,
    },
  });
});

// -------------------------------------------------------------------- draft

merchantApplicationRoutes.put('/', async (c) => {
  await rateLimit(c, 'merchant-application-save', 60, 3600);
  await requireReady(c.env);
  const user = c.get('user')!;
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const patch = parseDraft(body && typeof body === 'object' ? body : {});
  const cols = await storedColumns(c.env, patch);
  const db = c.env.DB;
  if (cols.length === 0) {
    // Nothing to save: a live application is answered as it is — an empty
    // save never reopens a submitted one. With none live, this STARTS one.
    const latest = await guarded(() => latestApplication(db, user.id));
    if (latest && isLiveState(latest.state)) return c.json({ success: true, application: applicantView(latest) });
  }
  const app = await guarded(() => editableApplication(c, user.id));
  if (cols.length > 0) {
    // The audit names WHICH fields changed — never a value.
    await guarded(() => writeDraft(db, app, cols, user.id, 'merchant_application.updated', { revision: app.revision, fields: Object.keys(patch) }));
  }
  return c.json({ success: true, application: applicantView(await applicationById(db, app.id)) });
});

// -------------------------------------------------------------------- photo

/**
 * THE PERSONAL REVIEW PHOTO. JPEG or PNG only, because those are the formats
 * the Images binding RE-ENCODES: the WebP it writes carries no EXIF, so no GPS
 * position of where the photo was taken survives. A photo that was not
 * re-encoded is deleted and refused — storing a camera original here is
 * exactly what this route exists not to do. The original file name is not
 * recorded (it is often the person's name). No key and no URL are returned.
 */
merchantApplicationRoutes.post('/photo', async (c) => {
  await rateLimit(c, 'merchant-application-photo', 20, 3600);
  await requireReady(c.env, true);
  const user = c.get('user')!;

  const form = await c.req.formData().catch(() => null);
  const file = form?.get('file');
  if (!(file instanceof File)) throw badRequest('Expected a photo in the "file" field', 'PHOTO_TYPE_UNSUPPORTED');
  if (file.size > PHOTO_MAX) throw badRequest('The photo is too large (max 8 MB)', 'PHOTO_TOO_LARGE');
  const buf = new Uint8Array(await file.arrayBuffer());
  const kind = sniff(buf);
  if (!kind || !PHOTO_TYPES.has(kind.mime)) {
    throw badRequest('ارفع صورة JPEG أو PNG / Upload a JPEG or PNG photo', 'PHOTO_TYPE_UNSUPPORTED');
  }

  const db = c.env.DB;
  // A SUBMITTED application is reopened only once the new photo is stored and
  // re-encoded: a refused photo never moves it back to draft. (Its id does not
  // change on a reopen, so the object goes under the right prefix either way.)
  const latest = await guarded(() => latestApplication(db, user.id));
  const reopens = !!latest && (latest.state === 'submitted' || latest.state === 'changes_requested');
  const target = reopens ? latest! : await guarded(() => editableApplication(c, user.id));
  let stored: { key: string; converted: boolean };
  try {
    stored = await storeMedia(c.env, {
      placement: { visibility: 'private', domain: 'merchant-review', entityId: target.id, kind: 'photo', objectId: newId() },
      bytes: buf,
      mime: kind.mime,
      ownerId: user.id,
      originalName: null,
      cacheControl: 'private, no-store',
    });
  } catch (e) {
    // The re-encoder refused these bytes (IMAGE_CONVERT_FAILED / IMAGE_TOO_LARGE_TO_CONVERT);
    // anything else (a bucket that is down) is the server's failure, not the photo's.
    if (!/^IMAGE_/.test(e instanceof Error ? e.message : '')) throw e;
    throw badRequest('تعذّرت قراءة الصورة؛ جرّب صورة أخرى / The photo could not be read; try another one', 'PHOTO_UNREADABLE');
  }
  if (!stored.converted) {
    await deleteMediaObject(c.env, 'private', stored.key).catch(() => console.error('merchant application: unconverted photo left for the C7 purge', target.id));
    throw unavailable(
      'استقبال طلبات اعتماد التجار غير مفعّل بعد على هذا الخادم / Merchant applications cannot be received on this server yet',
      'MERCHANT_REVIEW_NOT_CONFIGURED'
    );
  }
  let app: ApplicationRow;
  try {
    app = reopens ? await guarded(() => editableApplication(c, user.id)) : target;
    if (app.id !== target.id) throw changedNow();
    // Compare-and-set on the photo it replaces: of two overlapping uploads one wins, the other's object is deleted.
    await guarded(() =>
      writeDraft(db, app, [['photo_key', stored.key]], user.id, 'merchant_application.photo_set', { revision: app.revision }, app.photo_key)
    );
  } catch (e) {
    // Any object left here sits under the application's prefix, which the C7 purge empties.
    await deleteMediaObject(c.env, 'private', stored.key).catch(() => console.error('merchant application: orphan photo left for the C7 purge', target.id));
    throw e;
  }
  if (app.photo_key && app.photo_key !== stored.key) {
    // The replaced photo: deleted now; a failure leaves an object under the application's prefix, which the C7 purge empties.
    await deleteMediaObject(c.env, 'private', app.photo_key).catch(() => console.error('merchant application: replaced photo left for the C7 purge', app.id));
  }
  return c.json({ success: true, application: applicantView(await applicationById(db, app.id)) });
});

// ------------------------------------------------------------------- submit

/**
 * SUBMIT FREEZES THE REVISION the reviewer will decide on. Requirements are
 * checked on the server, every time: a verified phone (a live Telegram link,
 * as KYC requires) and an age of at least 18 by the sealed date (owner
 * decision C6), the three private values, the photo and a public name. A
 * replay of the same `operation_id` answers with the submitted application.
 */
merchantApplicationRoutes.post('/submit', async (c) => {
  await rateLimit(c, 'merchant-application-submit', 10, 3600);
  await requireReady(c.env);
  const user = c.get('user')!;
  const db = c.env.DB;
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const operationId = operationIdFrom(body?.operation_id);
  const app = await guarded(() => latestApplication(db, user.id));
  if (!app) throw notFound('No application to submit');

  if (app.state === 'draft') {
    if (!(await phoneVerified(db, user.id))) {
      throw badRequest(
        'وثّق رقم هاتفك عبر تيليغرام أولًا من الإعدادات / Verify your phone number through Telegram first (Settings → Security)',
        'PHONE_NOT_VERIFIED'
      );
    }
    const missing: string[] = [];
    if (!app.legal_name_enc) missing.push('legal_name');
    if (!app.dob_enc) missing.push('dob');
    if (!app.social_link_enc) missing.push('social_link');
    if (!app.photo_key) missing.push('photo');
    if (app.public_name.trim().length < 2) missing.push('public_name');
    const dob = app.dob_enc ? await unseal(c.env.KYC_ENC_KEY, app.dob_enc) : null;
    if (app.dob_enc && !dob) missing.push('dob');
    if (missing.length > 0) {
      throw badRequest('الطلب غير مكتمل بعد / The application is not complete yet', 'APPLICATION_INCOMPLETE', {
        missing: [...new Set(missing)],
      });
    }
    if (ageOn(dob!, baghdadToday()) < MIN_APPLICANT_AGE) throw underAge();
  }

  const out = await guarded(() =>
    applyTransition(db, { application: app, action: 'submit', actor: { id: user.id, kind: 'applicant' }, operationId })
  );
  if (!out.ok) throw transitionRefusal(out.code);
  // «توثيق التجار»: ids only — no name, no link, no date (gap §3.7).
  if (!out.replay) announceAfterResponse(c, 'merchant_verification', submittedNoticeText(app.id, out.revision));
  return c.json({ success: true, application: applicantView(await applicationById(db, app.id)) });
});

// ----------------------------------------------------------------- withdraw

/**
 * Withdraw from any live state. The private values stay sealed for the C7
 * period (90 days, `retention_until`) and are then blanked by the scheduled
 * sweep, the photo deleted. Re-applying needs no wait (C8).
 */
merchantApplicationRoutes.post('/withdraw', async (c) => {
  await rateLimit(c, 'merchant-application-withdraw', 10, 3600);
  const user = c.get('user')!;
  const db = c.env.DB;
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const operationId = operationIdFrom(body?.operation_id);
  const app = await guarded(() => latestApplication(db, user.id));
  if (!app) throw notFound('No application to withdraw');
  const out = await guarded(() =>
    applyTransition(db, { application: app, action: 'withdraw', actor: { id: user.id, kind: 'applicant' }, operationId })
  );
  if (!out.ok) throw transitionRefusal(out.code);
  return c.json({ success: true, application: applicantView(await applicationById(db, app.id)) });
});
