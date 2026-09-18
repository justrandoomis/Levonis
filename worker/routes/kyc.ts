import { Hono } from 'hono';
import type { AppContext } from '../lib/types';
import {
  requireAuth,
  requireAdmin,
  badRequest,
  notFound,
  conflict,
  unavailable,
  str,
  oneOf,
} from '../lib/http';
import { newId } from '../lib/crypto';
import { seal, unseal, sealboxConfigured } from '../lib/sealbox';
import { audit } from '../lib/audit';
import { rateLimit } from '../lib/ratelimit';
import { safeParse } from '../lib/types';
import { sniff } from './uploads';
import { getMediaObject, storeMedia } from '../lib/mediaStorage';

/**
 * PRO KYC (final-phase brief §9) + approved-address versioning.
 *
 * - Identity fields (name / DOB / document number) are sealbox-encrypted
 *   (worker/lib/sealbox.ts, KYC_ENC_KEY). When the key is unset the whole
 *   feature returns an honest 503 KYC_NOT_CONFIGURED — no plaintext storage.
 * - Evidence images live in private R2 under kyc/<uid>/ and are reachable
 *   ONLY through the audited admin route below; the public /files handler
 *   404s that prefix by design (worker/routes/uploads.ts).
 * - Uploading an image is NOT verification: only an authorized human admin
 *   decision transitions a case to 'verified'. No face recognition, no
 *   external vendor, no government-database claim.
 * - approved_addresses stores an immutable SNAPSHOT of the nominated saved
 *   address per version (state='approved' = current, prior versions become
 *   'superseded'); editing the saved address later never changes it.
 * - Role separation note: the codebase currently has a single 'admin' role,
 *   so all reviewer endpoints are admin-only; finer identity-review/support/
 *   finance separation is pending a roles model (documented honest gap).
 */

const IMAGE_MAX = 8 * 1024 * 1024;
const MAX_EVIDENCE = 6;
const FRESH_PROOF_MINUTES = 30;

const IDENTITY_STATES = ['draft', 'submitted', 'reviewing', 'changes_requested', 'rejected', 'verified'] as const;
const DECISIONS = ['reviewing', 'changes_requested', 'rejected', 'verified'] as const;

interface KycCaseRow {
  id: string;
  user_id: string;
  full_name_enc: string;
  dob_enc: string;
  doc_type: 'national_id' | 'passport' | null;
  doc_number_enc: string;
  evidence_keys: string;
  state: (typeof IDENTITY_STATES)[number];
  reason: string;
  case_type: 'identity' | 'phone_change';
  payload: string;
  submitted_at: string | null;
  decided_by: string | null;
  decided_at: string | null;
  retention_until: string | null;
  created_at: string;
}

interface ApprovedAddressRow {
  id: string;
  user_id: string;
  version: number;
  name: string;
  phone_e164: string;
  address: string;
  landmark: string;
  state: 'pending' | 'approved' | 'superseded' | 'rejected';
  reason: string;
  source_address_id: string;
  requested_at: string;
  approved_by: string | null;
  approved_at: string | null;
}

interface SavedAddressRow {
  id: string;
  user_id: string;
  label: string;
  name: string;
  phone: string;
  address: string;
  landmark: string;
}

// --------------------------------------------------------------- comparison

function normText(s: string): string {
  return (s || '').replace(/\s+/g, ' ').trim();
}

/** Digits-only Iraqi-tolerant phone comparison (0770… == +964 770…). */
function normPhoneDigits(s: string): string {
  let d = (s || '').replace(/[^0-9]/g, '');
  if (d.startsWith('00964')) d = d.slice(5);
  else if (d.startsWith('964')) d = d.slice(3);
  while (d.startsWith('0')) d = d.slice(1);
  return d;
}

/**
 * Does a saved address still match the immutable approved snapshot?
 * Harmless whitespace differences never count as a mismatch (§9: formatting
 * normalization must not trigger sanctions); substantive content changes do.
 * Exported for worker/routes/addresses.ts.
 */
export function addressMatchesSnapshot(
  addr: Pick<SavedAddressRow, 'name' | 'phone' | 'address' | 'landmark'>,
  snap: Pick<ApprovedAddressRow, 'name' | 'phone_e164' | 'address' | 'landmark'>
): boolean {
  return (
    normText(addr.name) === normText(snap.name) &&
    normPhoneDigits(addr.phone) === normPhoneDigits(snap.phone_e164) &&
    normText(addr.address) === normText(snap.address) &&
    normText(addr.landmark) === normText(snap.landmark)
  );
}

/** Current approved snapshot for a user (state='approved'; at most one). */
export async function getApprovedAddress(db: D1Database, userId: string): Promise<ApprovedAddressRow | null> {
  return db
    .prepare(
      "SELECT * FROM approved_addresses WHERE user_id = ? AND state = 'approved' ORDER BY version DESC LIMIT 1"
    )
    .bind(userId)
    .first<ApprovedAddressRow>();
}

function maskPhone(p: string): string {
  const d = (p || '').replace(/[^0-9]/g, '');
  return d.length >= 4 ? `•••${d.slice(-4)}` : '•••';
}

function requireConfigured(env: { KYC_ENC_KEY?: string }): void {
  if (!sealboxConfigured(env.KYC_ENC_KEY)) {
    throw unavailable(
      'التحقق من الهوية غير مفعّل بعد على هذا الخادم (KYC_ENC_KEY غير مضبوط) / Identity verification is not enabled on this server yet (KYC_ENC_KEY is not configured)',
      'KYC_NOT_CONFIGURED'
    );
  }
}

async function getTelegramLink(db: D1Database, userId: string) {
  return db
    .prepare('SELECT phone_e164, verified_at FROM telegram_links WHERE user_id = ? AND revoked_at IS NULL')
    .bind(userId)
    .first<{ phone_e164: string; verified_at: string }>();
}

function latestCase(db: D1Database, userId: string, caseType: 'identity' | 'phone_change') {
  return db
    .prepare('SELECT * FROM kyc_cases WHERE user_id = ? AND case_type = ? ORDER BY created_at DESC LIMIT 1')
    .bind(userId, caseType)
    .first<KycCaseRow>();
}

export const kycRoutes = new Hono<AppContext>();
kycRoutes.use('*', requireAuth);
kycRoutes.use('/admin/*', requireAdmin);

// ------------------------------------------------------------------ upload

/**
 * KYC evidence upload — images only, stored under the private kyc/<uid>/
 * prefix which the public /files handler never serves. Returns the key only;
 * there is intentionally no URL.
 */
kycRoutes.post('/upload', async (c) => {
  await rateLimit(c, 'kyc-upload', 20, 3600);
  requireConfigured(c.env);
  const user = c.get('user')!;

  const form = await c.req.formData().catch(() => null);
  if (!form) throw badRequest('Expected multipart form data');
  const file = form.get('file');
  if (!(file instanceof File)) throw badRequest('No file uploaded');
  if (file.size > IMAGE_MAX) throw badRequest('File is too large (max 8 MB)');

  const buf = new Uint8Array(await file.arrayBuffer());
  const kind = sniff(buf);
  if (!kind || !kind.mime.startsWith('image/')) {
    throw badRequest('Unsupported file type — please upload a JPEG, PNG, WebP or GIF image');
  }

  /**
   * THROUGH THE ONE DOOR. This built `kyc/<userId>/<id>.jpg` by hand — three
   * segments where the layout is four — and stored the photograph exactly as
   * the phone produced it.
   *
   * Converting it matters more here than anywhere else on the site, and not
   * for the bytes: a camera JPEG carries EXIF, and EXIF carries the GPS
   * coordinates where the picture was taken. A photograph of an identity
   * document, filed with the place it was photographed, is a worse thing to
   * hold than the document. The WebP this produces has no EXIF at all, because
   * the transform re-encodes the pixels and nothing else.
   *
   * `no-store` stays: this is the one kind of object that must never sit in
   * any cache, however private.
   */
  const stored = await storeMedia(c.env, {
    placement: {
      visibility: 'private',
      domain: 'kyc',
      entityId: user.id,
      kind: 'identity',
      objectId: newId(),
    },
    bytes: buf,
    mime: kind.mime,
    ownerId: user.id,
    originalName: file.name,
    cacheControl: 'private, no-store',
  });
  return c.json({ success: true, key: stored.key });
});

// -------------------------------------------------------------------- mine

kycRoutes.get('/mine', async (c) => {
  const user = c.get('user')!;
  const db = c.env.DB;
  const configured = sealboxConfigured(c.env.KYC_ENC_KEY);

  const [link, identity, phoneChange, approved, pendingAddr] = await Promise.all([
    getTelegramLink(db, user.id),
    latestCase(db, user.id, 'identity'),
    latestCase(db, user.id, 'phone_change'),
    getApprovedAddress(db, user.id),
    db
      .prepare("SELECT * FROM approved_addresses WHERE user_id = ? AND state = 'pending' ORDER BY version DESC LIMIT 1")
      .bind(user.id)
      .first<ApprovedAddressRow>(),
  ]);

  let approvedOut: Record<string, unknown> | null = null;
  if (approved) {
    let matchesSaved: boolean | null = null;
    let sourceExists = false;
    if (approved.source_address_id) {
      const saved = await db
        .prepare('SELECT id, name, phone, address, landmark FROM addresses WHERE id = ? AND user_id = ?')
        .bind(approved.source_address_id, user.id)
        .first<SavedAddressRow>();
      sourceExists = !!saved;
      matchesSaved = saved ? addressMatchesSnapshot(saved, approved) : null;
    }
    approvedOut = {
      version: Number(approved.version),
      name: approved.name,
      phone_e164: approved.phone_e164,
      address: approved.address,
      landmark: approved.landmark,
      approved_at: approved.approved_at,
      source_address_id: approved.source_address_id || null,
      source_address_exists: sourceExists,
      matches_saved_address: matchesSaved,
    };
  }

  return c.json({
    success: true,
    configured,
    phone: {
      linked: !!link,
      phone_masked: link ? maskPhone(link.phone_e164) : null,
      verified_at: link?.verified_at ?? null,
    },
    identity: identity
      ? {
          id: identity.id,
          state: identity.state,
          reason: identity.reason,
          doc_type: identity.doc_type,
          evidence_count: safeParse<string[]>(identity.evidence_keys, []).length,
          submitted_at: identity.submitted_at,
          decided_at: identity.decided_at,
          created_at: identity.created_at,
          // Decision register row 24: retention period not decided yet.
          retention_status: identity.retention_until ? 'scheduled' : 'pending_owner_decision',
        }
      : null,
    phone_change: phoneChange
      ? {
          id: phoneChange.id,
          state: phoneChange.state,
          reason: phoneChange.reason,
          new_phone_masked: maskPhone(String(safeParse<Record<string, unknown>>(phoneChange.payload, {}).new_phone_e164 || '')),
          submitted_at: phoneChange.submitted_at,
          decided_at: phoneChange.decided_at,
        }
      : null,
    approved_address: approvedOut,
    pending_address_request: pendingAddr
      ? {
          id: pendingAddr.id,
          version: Number(pendingAddr.version),
          name: pendingAddr.name,
          address: pendingAddr.address,
          landmark: pendingAddr.landmark,
          reason: pendingAddr.reason,
          requested_at: pendingAddr.requested_at,
        }
      : null,
  });
});

// ------------------------------------------------------------------ submit

kycRoutes.post('/submit', async (c) => {
  await rateLimit(c, 'kyc-submit', 5, 3600);
  requireConfigured(c.env);
  const user = c.get('user')!;
  const db = c.env.DB;

  // Phone must already be Telegram-verified (read-only check; the linking
  // flow itself lives in worker/routes/telegram.ts).
  const link = await getTelegramLink(db, user.id);
  if (!link) {
    throw badRequest(
      'وثّق رقم هاتفك عبر تيليغرام أولًا من الإعدادات / Verify your phone number through Telegram first (Settings → Security)',
      'PHONE_NOT_VERIFIED'
    );
  }

  const body = await c.req.json().catch(() => ({}));
  const fullName = str(body.fullName, 'fullName', { min: 5, max: 150 });
  if (fullName.split(/\s+/).filter(Boolean).length < 3) {
    throw badRequest(
      'الاسم الثلاثي الكامل مطلوب (ثلاثة مقاطع على الأقل) / The full three-part name is required (at least three parts)',
      'NAME_THREE_PARTS'
    );
  }
  const dob = str(body.dob, 'dob', { min: 10, max: 10 });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dob)) throw badRequest('dob must be YYYY-MM-DD');
  const dobMs = Date.parse(`${dob}T00:00:00Z`);
  const year = Number(dob.slice(0, 4));
  if (!Number.isFinite(dobMs) || dobMs > Date.now() || year < 1900) {
    throw badRequest('dob is not a valid past date');
  }
  // Minimum accepted age is decision-register row 24 (pending owner) — the
  // date is stored encrypted and no invented threshold is enforced here.

  // Exactly ONE document — the single field enforces "ID or passport, never both".
  const docType = oneOf(body.docType, 'docType', ['national_id', 'passport'] as const);
  const docNumber = str(body.docNumber, 'docNumber', { min: 3, max: 60 });

  const rawKeys = Array.isArray(body.evidenceKeys) ? body.evidenceKeys : [];
  if (rawKeys.length < 1 || rawKeys.length > MAX_EVIDENCE) {
    throw badRequest(`evidenceKeys must contain 1 to ${MAX_EVIDENCE} uploaded document images`);
  }
  const prefix = `kyc/${user.id}/`;
  const evidenceKeys: string[] = [];
  for (const k of rawKeys) {
    if (typeof k !== 'string' || !k.startsWith(prefix) || k.includes('..') || k.length > 200) {
      throw badRequest('evidenceKeys must be keys returned by POST /api/kyc/upload for your own account');
    }
    if (!evidenceKeys.includes(k)) evidenceKeys.push(k);
  }

  const existing = await latestCase(db, user.id, 'identity');
  if (existing && (existing.state === 'submitted' || existing.state === 'reviewing')) {
    throw badRequest(
      'لديك طلب تحقق قيد المراجعة بالفعل / You already have a verification request under review',
      'ALREADY_PENDING'
    );
  }
  if (existing && existing.state === 'verified') {
    throw badRequest('حسابك موثَّق بالفعل / Your account is already verified', 'ALREADY_VERIFIED');
  }

  const secret = c.env.KYC_ENC_KEY;
  const [nameEnc, dobEnc, docEnc] = await Promise.all([
    seal(secret, fullName),
    seal(secret, dob),
    seal(secret, docNumber),
  ]);
  const now = new Date().toISOString();

  let caseId: string;
  if (existing && (existing.state === 'draft' || existing.state === 'changes_requested')) {
    // Resubmission continues the same case (conditional on the state we read
    // so a concurrent admin decision cannot be overwritten).
    const res = await db
      .prepare(
        `UPDATE kyc_cases SET full_name_enc = ?, dob_enc = ?, doc_number_enc = ?, doc_type = ?,
           evidence_keys = ?, state = 'submitted', reason = '', submitted_at = ?,
           decided_by = NULL, decided_at = NULL
         WHERE id = ? AND state = ?`
      )
      .bind(nameEnc, dobEnc, docEnc, docType, JSON.stringify(evidenceKeys), now, existing.id, existing.state)
      .run();
    if (res.meta.changes === 0) throw conflict('Your case changed concurrently — reload and retry');
    caseId = existing.id;
  } else {
    caseId = newId('kyc');
    await db
      .prepare(
        `INSERT INTO kyc_cases (id, user_id, full_name_enc, dob_enc, doc_number_enc, doc_type,
           evidence_keys, state, case_type, payload, submitted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'submitted', 'identity', '{}', ?)`
      )
      .bind(caseId, user.id, nameEnc, dobEnc, docEnc, docType, JSON.stringify(evidenceKeys), now)
      .run();
  }

  // Audit without any identity PII.
  await audit(db, user.id, 'kyc.submit', caseId, { doc_type: docType, evidence_count: evidenceKeys.length });
  return c.json({ success: true, id: caseId, state: 'submitted' });
});

// -------------------------------------------------- approved address (§9)

/** The customer nominates one of their saved addresses as the PRO default. */
kycRoutes.post('/address-request', async (c) => {
  await rateLimit(c, 'kyc-address', 10, 3600);
  const user = c.get('user')!;
  const db = c.env.DB;
  const body = await c.req.json().catch(() => ({}));
  const addressId = str(body.addressId, 'addressId', { min: 1, max: 60 });
  const reason = str(body.reason, 'reason', { min: 5, max: 500 });

  const addr = await db
    .prepare('SELECT id, user_id, label, name, phone, address, landmark FROM addresses WHERE id = ? AND user_id = ?')
    .bind(addressId, user.id)
    .first<SavedAddressRow>();
  if (!addr) throw notFound('Address not found');

  const pending = await db
    .prepare("SELECT id FROM approved_addresses WHERE user_id = ? AND state = 'pending' LIMIT 1")
    .bind(user.id)
    .first();
  if (pending) {
    throw badRequest(
      'لديك طلب عنوان قيد المراجعة بالفعل / You already have an address request under review',
      'REQUEST_PENDING'
    );
  }

  const current = await getApprovedAddress(db, user.id);
  if (current && addressMatchesSnapshot(addr, current)) {
    throw badRequest(
      'هذا العنوان مطابق للعنوان المعتمد الحالي / This address already matches your current approved address',
      'ALREADY_APPROVED'
    );
  }

  const maxV = await db
    .prepare('SELECT COALESCE(MAX(version), 0) AS v FROM approved_addresses WHERE user_id = ?')
    .bind(user.id)
    .first<{ v: number }>();
  const version = Number(maxV?.v ?? 0) + 1;
  const id = newId('apa');
  try {
    // SNAPSHOT of the address CONTENTS — an immutable copy, never a live
    // reference. Later edits of the saved row cannot change this.
    await db
      .prepare(
        `INSERT INTO approved_addresses (id, user_id, version, name, phone_e164, address, landmark,
           state, reason, source_address_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`
      )
      .bind(id, user.id, version, addr.name, addr.phone, addr.address, addr.landmark, reason, addr.id)
      .run();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes('UNIQUE')) throw conflict('A concurrent request took this version — please retry');
    throw e;
  }
  await audit(db, user.id, 'kyc.address.request', id, { version, source_address_id: addr.id });
  return c.json({ success: true, id, version, state: 'pending' });
});

/** Current approved snapshot — the same data checkout/commerce compares. */
kycRoutes.get('/approved-address', async (c) => {
  const user = c.get('user')!;
  const db = c.env.DB;
  const approved = await getApprovedAddress(db, user.id);
  if (!approved) return c.json({ success: true, approved_address: null });
  let matchesSaved: boolean | null = null;
  if (approved.source_address_id) {
    const saved = await db
      .prepare('SELECT id, name, phone, address, landmark FROM addresses WHERE id = ? AND user_id = ?')
      .bind(approved.source_address_id, user.id)
      .first<SavedAddressRow>();
    matchesSaved = saved ? addressMatchesSnapshot(saved, approved) : null;
  }
  return c.json({
    success: true,
    approved_address: {
      version: Number(approved.version),
      name: approved.name,
      phone_e164: approved.phone_e164,
      address: approved.address,
      landmark: approved.landmark,
      approved_at: approved.approved_at,
      source_address_id: approved.source_address_id || null,
      matches_saved_address: matchesSaved,
    },
  });
});

// ------------------------------------------------------ phone change (§9)

/**
 * PRO phone change = fresh Telegram ownership proof + admin approval,
 * modeled as a kyc_cases row of case_type='phone_change'. Fresh proof means
 * the verified telegram_links row was (re)verified within the last
 * FRESH_PROOF_MINUTES, or a phone_change link challenge completed recently
 * (both are READ-ONLY checks — this route never writes telegram tables).
 */
kycRoutes.post('/phone-change-request', async (c) => {
  await rateLimit(c, 'kyc-phone-change', 5, 3600);
  const user = c.get('user')!;
  const db = c.env.DB;

  const approved = await getApprovedAddress(db, user.id);
  if (!approved) {
    throw badRequest(
      'لا يوجد عنوان معتمد لهذا الحساب — تغيير الهاتف الإداري يخص سجل PRO المعتمد / No approved address exists for this account — the reviewed phone change applies to the approved PRO record',
      'NO_APPROVED_ADDRESS'
    );
  }

  const link = await getTelegramLink(db, user.id);
  if (!link) {
    throw badRequest(
      'وثّق رقم هاتفك الجديد عبر تيليغرام أولًا / Verify your new phone number through Telegram first',
      'PHONE_NOT_VERIFIED'
    );
  }

  const freshSince = new Date(Date.now() - FRESH_PROOF_MINUTES * 60_000).toISOString();
  const linkIsFresh = link.verified_at >= freshSince;
  let proof = linkIsFresh ? 'telegram_relink' : '';
  if (!proof) {
    const challenge = await db
      .prepare(
        `SELECT id FROM link_challenges
          WHERE user_id = ? AND purpose = 'phone_change'
            AND state IN ('phone_verified','browser_confirmed','linked')
            AND consumed_at IS NOT NULL AND consumed_at >= ?
          ORDER BY created_at DESC LIMIT 1`
      )
      .bind(user.id, freshSince)
      .first<{ id: string }>();
    if (challenge) proof = 'phone_change_challenge';
  }
  if (!proof) {
    throw badRequest(
      'مطلوب إثبات ملكية حديث: أعد توثيق الرقم الجديد عبر تيليغرام ثم أرسل الطلب خلال 30 دقيقة / Fresh ownership proof required: re-verify the new number through Telegram, then submit within 30 minutes',
      'PHONE_PROOF_REQUIRED'
    );
  }

  if (normPhoneDigits(link.phone_e164) === normPhoneDigits(approved.phone_e164)) {
    throw badRequest(
      'الرقم الموثَّق الحالي مطابق للرقم المعتمد — لا يوجد تغيير / The currently verified number already matches the approved one — nothing to change',
      'SAME_PHONE'
    );
  }

  const existing = await latestCase(db, user.id, 'phone_change');
  if (existing && (existing.state === 'submitted' || existing.state === 'reviewing')) {
    throw badRequest(
      'لديك طلب تغيير هاتف قيد المراجعة بالفعل / You already have a phone-change request under review',
      'ALREADY_PENDING'
    );
  }

  const id = newId('kyc');
  const now = new Date().toISOString();
  await db
    .prepare(
      `INSERT INTO kyc_cases (id, user_id, state, case_type, payload, submitted_at)
       VALUES (?, ?, 'submitted', 'phone_change', ?, ?)`
    )
    .bind(id, user.id, JSON.stringify({ new_phone_e164: link.phone_e164, proof, proof_at: now }), now)
    .run();
  await audit(db, user.id, 'kyc.phone_change.request', id, {
    proof,
    new_phone_masked: maskPhone(link.phone_e164),
  });
  return c.json({ success: true, id, state: 'submitted' });
});

// ------------------------------------------------------------- admin queue

kycRoutes.get('/admin/queue', async (c) => {
  const state = str(c.req.query('state'), 'state', { max: 30, required: false });
  const caseType = str(c.req.query('case_type'), 'case_type', { max: 20, required: false });
  let sql = `SELECT k.id, k.user_id, k.state, k.case_type, k.doc_type, k.reason, k.evidence_keys,
                    k.submitted_at, k.decided_by, k.decided_at, k.created_at,
                    u.email AS user_email, u.username AS user_username
               FROM kyc_cases k JOIN users u ON u.id = k.user_id`;
  const where: string[] = [];
  const params: unknown[] = [];
  if (state) {
    if (!(IDENTITY_STATES as readonly string[]).includes(state)) throw badRequest('Unknown state filter');
    where.push('k.state = ?');
    params.push(state);
  }
  if (caseType) {
    if (caseType !== 'identity' && caseType !== 'phone_change') throw badRequest('Unknown case_type filter');
    where.push('k.case_type = ?');
    params.push(caseType);
  }
  if (where.length > 0) sql += ' WHERE ' + where.join(' AND ');
  sql += ' ORDER BY k.created_at DESC LIMIT 200';
  const { results } = await c.env.DB.prepare(sql).bind(...params).all<Record<string, unknown>>();
  // Queue listing carries NO decrypted identity fields (response
  // minimization) — the audited per-case detail view decrypts.
  return c.json({
    success: true,
    cases: results.map((r) => ({
      id: r.id,
      user_id: r.user_id,
      user_email: r.user_email,
      user_username: r.user_username,
      state: r.state,
      case_type: r.case_type,
      doc_type: r.doc_type,
      reason: r.reason,
      evidence_count: safeParse<string[]>(r.evidence_keys as string, []).length,
      submitted_at: r.submitted_at,
      decided_by: r.decided_by,
      decided_at: r.decided_at,
      created_at: r.created_at,
    })),
  });
});

/** Audited decrypted detail view for one case. */
kycRoutes.get('/admin/cases/:id', async (c) => {
  const admin = c.get('user')!;
  const id = c.req.param('id');
  const row = await c.env.DB.prepare(
    `SELECT k.*, u.email AS user_email, u.username AS user_username
       FROM kyc_cases k JOIN users u ON u.id = k.user_id WHERE k.id = ?`
  )
    .bind(id)
    .first<KycCaseRow & { user_email: string; user_username: string | null }>();
  if (!row) throw notFound('Case not found');

  const secret = c.env.KYC_ENC_KEY;
  const [fullName, dob, docNumber] = await Promise.all([
    row.full_name_enc ? unseal(secret, row.full_name_enc) : Promise.resolve(null),
    row.dob_enc ? unseal(secret, row.dob_enc) : Promise.resolve(null),
    row.doc_number_enc ? unseal(secret, row.doc_number_enc) : Promise.resolve(null),
  ]);
  const evidence = safeParse<string[]>(row.evidence_keys, []);
  const payload = safeParse<Record<string, unknown>>(row.payload, {});

  // Every decrypted view is audited (actor, target, time) — §1/§9.
  await audit(c.env.DB, admin.id, 'kyc.case.view', id, { case_type: row.case_type, state: row.state });

  return c.json({
    success: true,
    case: {
      id: row.id,
      user_id: row.user_id,
      user_email: row.user_email,
      user_username: row.user_username,
      state: row.state,
      case_type: row.case_type,
      doc_type: row.doc_type,
      reason: row.reason,
      submitted_at: row.submitted_at,
      decided_by: row.decided_by,
      decided_at: row.decided_at,
      created_at: row.created_at,
      retention_until: row.retention_until,
      // Honest unreadable flag: unseal returns null when the key is missing
      // or the ciphertext version is unknown — never a fake value.
      full_name: fullName,
      dob,
      doc_number: docNumber,
      fields_readable: !(row.full_name_enc && fullName === null),
      evidence_count: evidence.length,
      evidence_indexes: evidence.map((_, i) => i),
      payload: row.case_type === 'phone_change' ? { new_phone_e164: payload.new_phone_e164, proof: payload.proof } : {},
    },
  });
});

/**
 * Evidence images are served ONLY here: admin-only, per-view audit log,
 * no-store. There is no public URL for the kyc/ prefix anywhere.
 */
kycRoutes.get('/admin/cases/:id/evidence/:idx', async (c) => {
  const admin = c.get('user')!;
  const id = c.req.param('id');
  const idx = Number(c.req.param('idx'));
  if (!Number.isInteger(idx) || idx < 0 || idx >= MAX_EVIDENCE) throw notFound();

  const row = await c.env.DB.prepare('SELECT evidence_keys FROM kyc_cases WHERE id = ?')
    .bind(id)
    .first<{ evidence_keys: string }>();
  if (!row) throw notFound('Case not found');
  const keys = safeParse<string[]>(row.evidence_keys, []);
  const key = keys[idx];
  if (!key || !key.startsWith('kyc/')) throw notFound('No evidence at this index');

  const obj = await getMediaObject(c.env, 'private', key);
  if (!obj) throw notFound('Evidence file is missing from storage');

  await audit(c.env.DB, admin.id, 'kyc.evidence.view', id, { idx });

  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set('Cache-Control', 'no-store');
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Content-Security-Policy', "default-src 'none'; sandbox");
  return new Response(obj.body, { headers });
});

/**
 * The human admin decision — the ONLY path to 'verified'. Reason required
 * for changes_requested/rejected; every decision is audited. Approving a
 * phone_change case also writes the new approved-address snapshot version
 * carrying the proven phone (the address contents stay identical).
 */
kycRoutes.post('/admin/cases/:id/decision', async (c) => {
  const admin = c.get('user')!;
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => ({}));
  const decision = oneOf(body.decision, 'decision', DECISIONS);
  const reason = str(body.reason, 'reason', {
    max: 1000,
    min: decision === 'changes_requested' || decision === 'rejected' ? 5 : 0,
    required: decision === 'changes_requested' || decision === 'rejected',
  });

  const db = c.env.DB;
  const row = await db.prepare('SELECT * FROM kyc_cases WHERE id = ?').bind(id).first<KycCaseRow>();
  if (!row) throw notFound('Case not found');
  if (row.state !== 'submitted' && row.state !== 'reviewing') {
    throw badRequest(`No decision possible from state '${row.state}'`, 'INVALID_TRANSITION');
  }
  if (decision === 'reviewing' && row.state === 'reviewing') {
    throw badRequest('Case is already in review', 'INVALID_TRANSITION');
  }

  const now = new Date().toISOString();
  const isFinal = decision !== 'reviewing';
  const res = await db
    .prepare(
      `UPDATE kyc_cases SET state = ?, reason = ?, decided_by = ?, decided_at = ?
       WHERE id = ? AND state = ?`
    )
    .bind(decision, reason, isFinal ? admin.id : null, isFinal ? now : null, id, row.state)
    .run();
  if (res.meta.changes === 0) throw conflict('Case changed concurrently — reload and retry');

  let addressVersion: number | null = null;
  if (decision === 'verified' && row.case_type === 'phone_change') {
    const payload = safeParse<Record<string, unknown>>(row.payload, {});
    const newPhone = typeof payload.new_phone_e164 === 'string' ? payload.new_phone_e164 : '';
    const approved = await getApprovedAddress(db, row.user_id);
    if (newPhone && approved) {
      const maxV = await db
        .prepare('SELECT COALESCE(MAX(version), 0) AS v FROM approved_addresses WHERE user_id = ?')
        .bind(row.user_id)
        .first<{ v: number }>();
      addressVersion = Number(maxV?.v ?? 0) + 1;
      await db.batch([
        db
          .prepare("UPDATE approved_addresses SET state = 'superseded' WHERE user_id = ? AND state = 'approved'")
          .bind(row.user_id),
        db
          .prepare(
            `INSERT INTO approved_addresses (id, user_id, version, name, phone_e164, address, landmark,
               state, reason, source_address_id, approved_by, approved_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, 'approved', ?, ?, ?, ?)`
          )
          .bind(
            newId('apa'),
            row.user_id,
            addressVersion,
            approved.name,
            newPhone,
            approved.address,
            approved.landmark,
            `phone change approved (case ${id})`,
            approved.source_address_id,
            admin.id,
            now
          ),
      ]);
    }
  }

  await audit(db, admin.id, 'kyc.decision', id, {
    case_type: row.case_type,
    from: row.state,
    decision,
    reason,
    address_version: addressVersion,
  });
  return c.json({ success: true, state: decision, address_version: addressVersion });
});

// ------------------------------------------------- admin address requests

kycRoutes.get('/admin/address-queue', async (c) => {
  const state = str(c.req.query('state'), 'state', { max: 20, required: false }) || 'pending';
  if (!['pending', 'approved', 'superseded', 'rejected'].includes(state)) throw badRequest('Unknown state filter');
  const { results } = await c.env.DB.prepare(
    `SELECT a.*, u.email AS user_email, u.username AS user_username
       FROM approved_addresses a JOIN users u ON u.id = a.user_id
      WHERE a.state = ? ORDER BY a.requested_at DESC LIMIT 200`
  )
    .bind(state)
    .all<Record<string, unknown>>();
  return c.json({ success: true, requests: results });
});

/**
 * Approval snapshots become the current approved version (prior 'approved'
 * rows become 'superseded'); the row is already an immutable copy of the
 * nominated address contents. Rejection records the reason.
 */
kycRoutes.post('/admin/address/:id/decision', async (c) => {
  const admin = c.get('user')!;
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => ({}));
  if (typeof body.approve !== 'boolean') throw badRequest('approve must be a boolean');
  const reason = str(body.reason, 'reason', {
    max: 500,
    min: body.approve ? 0 : 5,
    required: !body.approve,
  });

  const db = c.env.DB;
  const row = await db.prepare('SELECT * FROM approved_addresses WHERE id = ?').bind(id).first<ApprovedAddressRow>();
  if (!row) throw notFound('Request not found');
  if (row.state !== 'pending') throw badRequest(`Request is already '${row.state}'`, 'INVALID_TRANSITION');

  const now = new Date().toISOString();
  if (body.approve) {
    const results = await db.batch([
      db
        .prepare("UPDATE approved_addresses SET state = 'superseded' WHERE user_id = ? AND state = 'approved'")
        .bind(row.user_id),
      db
        .prepare(
          "UPDATE approved_addresses SET state = 'approved', approved_by = ?, approved_at = ? WHERE id = ? AND state = 'pending'"
        )
        .bind(admin.id, now, id),
    ]);
    if ((results[1]?.meta.changes || 0) === 0) throw conflict('Request changed concurrently — reload and retry');
    await audit(db, admin.id, 'kyc.address.approve', id, {
      user_id: row.user_id,
      version: Number(row.version),
      superseded: results[0]?.meta.changes || 0,
    });
    return c.json({ success: true, state: 'approved', version: Number(row.version) });
  }

  const res = await db
    .prepare(
      "UPDATE approved_addresses SET state = 'rejected', reason = ?, approved_by = ?, approved_at = ? WHERE id = ? AND state = 'pending'"
    )
    .bind(reason, admin.id, now, id)
    .run();
  if (res.meta.changes === 0) throw conflict('Request changed concurrently — reload and retry');
  // The customer's original request reason is preserved in the audit record.
  await audit(db, admin.id, 'kyc.address.reject', id, {
    user_id: row.user_id,
    reason,
    original_request_reason: row.reason,
  });
  return c.json({ success: true, state: 'rejected' });
});
