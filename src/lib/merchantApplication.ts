/**
 * THE MERCHANT APPLICATION, CLIENT SIDE (Community V3 push 1.2, DECISIONS row
 * 257): the applicant's API (`/api/merchant-application`), the reviewer's API
 * (`/api/admin/merchant-applications`), their answer shapes, and the few pure
 * rules the forms check before the server checks them again.
 *
 * PRIVATE VALUES NEVER COME BACK. The applicant's own answer says which of the
 * legal name, date of birth, activity link and photo were PROVIDED (booleans),
 * never what they are; this module keeps nothing in storage, and the form
 * forgets what it sent the moment the server accepted it.
 */
import { api } from './api';
import type { ApplicationState } from './merchant';

export type { ApplicationState } from './merchant';

export const ACTIVITY_KINDS = ['print_services', 'products', 'both'] as const;
export type ActivityKind = (typeof ACTIVITY_KINDS)[number];

/** Owner decision C6, mirrored for the form (the server decides). */
export const MIN_APPLICANT_AGE = 18;

export interface ApplicantView {
  id: string;
  state: ApplicationState;
  revision: number;
  created_at: string;
  updated_at: string;
  submitted_at: string | null;
  decided_at: string | null;
  reason_public: string;
  public: { name: string; bio: string; links: string[] };
  review: { governorate: string; activity_kind: string; activity_description: string };
  provided: { legal_name: boolean; dob: boolean; social_link: boolean; photo: boolean };
  purged: boolean;
}

export interface ApplicantAnswer {
  available: boolean;
  application: ApplicantView | null;
  approved: boolean;
  requirements?: { phone_verified: boolean; min_age: number; ready: boolean };
  can?: { apply: boolean; edit: boolean; submit: boolean; withdraw: boolean };
}

export interface DraftPatch {
  legal_name?: { given: string; father: string; grandfather: string };
  dob?: string;
  social_link?: string;
  governorate?: string;
  activity_kind?: string;
  activity_description?: string;
  public_name?: string;
  public_bio?: string;
  public_links?: string[];
}

/** A fresh id for one intended transition: a retry of the same tap reuses it, so it is applied once. */
export function newOperationId(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return `op-${c.randomUUID()}`;
  return `op-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

export const applicationApi = {
  get: () => api.get<{ success: true } & ApplicantAnswer>('/api/merchant-application'),
  save: (patch: DraftPatch) => api.put<{ application: ApplicantView }>('/api/merchant-application', patch),
  photo: (file: File) => {
    const form = new FormData();
    form.set('file', file);
    return api.post<{ application: ApplicantView }>('/api/merchant-application/photo', form);
  },
  submit: (operationId: string) =>
    api.post<{ application: ApplicantView }>('/api/merchant-application/submit', { operation_id: operationId }),
  withdraw: (operationId: string) =>
    api.post<{ application: ApplicantView }>('/api/merchant-application/withdraw', { operation_id: operationId }),
};

// ---------------------------------------------------------------- reviewer

export interface ReviewQueueRow {
  id: string;
  state: ApplicationState;
  revision: number;
  created_at: string;
  updated_at: string;
  submitted_at: string | null;
  decided_at: string | null;
  public: { name: string; bio: string; links: string[] };
  review: { governorate: string; activity_kind: string };
  purged: boolean;
  /** The reviewer's OWN application: the panel offers no decision on it. */
  own: boolean;
}

export interface ReviewDetail extends Omit<ReviewQueueRow, 'review'> {
  decided_revision: number | null;
  reason_public: string;
  note_internal: string;
  retention_until: string | null;
  /** The applicant opened a store: an approval is revocable only before one exists. */
  has_store: boolean;
  review: { governorate: string; activity_kind: string; activity_description: string };
  private: {
    legal_name: { given: string; father: string; grandfather: string } | null;
    dob: string | null;
    age: number | null;
    social_link: string | null;
    has_photo: boolean;
    readable: boolean;
  };
  applicant: { id: string; username: string | null };
  checks: { pro_identity_verified: boolean; phone_verified: boolean };
  events: Array<{ revision: number; actor_kind: string; action: string; reason_public: string; at: string }>;
}

export type ReviewAction = 'start-review' | 'request-changes' | 'approve' | 'reject';

/**
 * A decision's answer: always the id, state and revision; the queue row's
 * public fields only while the current revision is one the applicant sent
 * (a replay, or a reopen landing first, answers with the three alone).
 */
export type ReviewDecisionAnswer = Pick<ReviewQueueRow, 'id' | 'state' | 'revision'> & Partial<ReviewQueueRow>;

/** The owner's grants (C5; DECISIONS row 261): each opens one desk to an assistant admin, nothing financial. */
export type CapabilityKey = 'MERCHANT_REVIEW' | 'KYC_REVIEW' | 'DISPUTES';

export interface ReviewerRow {
  id: string;
  username: string | null;
  name: string | null;
  scope: 'assistant' | 'full';
  by_default: boolean;
  /** MERCHANT_REVIEW. */
  granted: boolean;
  granted_at: string | null;
  /** Every capability, keyed; absent from a server older than row 261. */
  grants?: Partial<Record<CapabilityKey, boolean>>;
}

const REVIEW_BASE = '/api/admin/merchant-applications';

export const reviewApi = {
  list: (state: string) =>
    api.get<{ success: true; available: boolean; applications: ReviewQueueRow[] }>(`${REVIEW_BASE}?state=${encodeURIComponent(state)}`),
  detail: (id: string) => api.get<{ success: true; application: ReviewDetail }>(`${REVIEW_BASE}/${encodeURIComponent(id)}`),
  photoUrl: (id: string) => `${REVIEW_BASE}/${encodeURIComponent(id)}/photo`,
  decide: (
    id: string,
    action: ReviewAction,
    body: { revision: number; operation_id: string; reason_public?: string; note_internal?: string; revoke?: true }
  ) => api.post<{ success: true; replay: boolean; application: ReviewDecisionAnswer }>(`${REVIEW_BASE}/${encodeURIComponent(id)}/${action}`, body),
  reviewers: () => api.get<{ success: true; available: boolean; reviewers: ReviewerRow[] }>(`${REVIEW_BASE}/reviewers`),
  grant: (userId: string, operationId: string, grantKey: CapabilityKey = 'MERCHANT_REVIEW') =>
    api.post<{ success: true; granted: boolean; already: boolean }>(`${REVIEW_BASE}/reviewers/${encodeURIComponent(userId)}/grant`, {
      operation_id: operationId,
      grant_key: grantKey,
    }),
  revoke: (userId: string, grantKey: CapabilityKey = 'MERCHANT_REVIEW') =>
    api.post<{ success: true; granted: boolean; already: boolean }>(`${REVIEW_BASE}/reviewers/${encodeURIComponent(userId)}/revoke`, {
      grant_key: grantKey,
    }),
};

// -------------------------------------------------------------- the rules

/** Baghdad's calendar date (UTC+3, no daylight saving) — the applicant's own "today". */
export function baghdadToday(nowMs: number = Date.now()): string {
  return new Date(nowMs + 3 * 3_600_000).toISOString().slice(0, 10);
}

/**
 * Whole years between two `YYYY-MM-DD` dates, by the calendar only — the
 * string is never handed to `new Date(local)`, which shifts a date by the
 * viewer's zone. Null for anything that is not a real past date.
 */
export function ageOn(dob: string, today: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dob)) return null;
  const [y, m, d] = dob.split('-').map(Number) as [number, number, number];
  const check = new Date(Date.UTC(y, m - 1, d));
  if (y < 1900 || check.getUTCFullYear() !== y || check.getUTCMonth() !== m - 1 || check.getUTCDate() !== d) return null;
  if (dob > today) return null;
  const years = Number(today.slice(0, 4)) - y;
  return today.slice(5) >= dob.slice(5) ? years : years - 1;
}

/** The latest date of birth that is 18 today — the date input's `max`. */
export function latestAdultDob(today: string): string {
  const y = Number(today.slice(0, 4)) - MIN_APPLICANT_AGE;
  const md = today.slice(5);
  // 29 February in a year without one: the 28th is the last adult birthday.
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  return `${String(y).padStart(4, '0')}-${md === '02-29' && !leap ? '02-28' : md}`;
}

/** One part of the three-part name: a NAME, so «عبد الله» is one part (spaces allowed). */
export function namePartOk(v: string): boolean {
  const t = v.normalize('NFC').replace(/\s+/g, ' ').trim();
  return t.length >= 2 && t.length <= 60 && /^[\p{L}\p{M}](?:[\p{L}\p{M}'’.\- ]{0,58}[\p{L}\p{M}.])?$/u.test(t);
}

/** EXACTLY the server's host set (`parseSocialLink`, worker/lib/merchantApproval.ts); a parity test holds them together. */
const SOCIAL_HOSTS = new Set([
  'instagram.com',
  'www.instagram.com',
  'm.instagram.com',
  'facebook.com',
  'www.facebook.com',
  'm.facebook.com',
  'web.facebook.com',
  'fb.com',
  'www.fb.com',
]);

/** An Instagram or Facebook page link — the activity link the reviewer opens. The server's rule, checked first here. */
export function socialLinkOk(v: string): boolean {
  const t = v.trim();
  if (!t || t.length > 300) return false;
  let u: URL;
  try {
    u = new URL(/^[a-z][a-z0-9+.-]*:/i.test(t) ? t : `https://${t}`);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
  if (u.username || u.password || u.port) return false;
  if (!SOCIAL_HOSTS.has(u.hostname.toLowerCase())) return false;
  const path = u.pathname.replace(/\/+$/, '');
  return !!path && path !== '/';
}
