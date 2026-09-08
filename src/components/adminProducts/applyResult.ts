/**
 * Reading the TXT apply result HONESTLY (docs/TXT_IMPORT_PARITY.md §5.4).
 *
 * `POST /api/admin/template/apply` answers with counts the server READ BACK
 * from the relation tables and the product document after the batch
 * committed — never with what the parser accepted. This module turns that
 * answer into the row the import window shows, under three rules:
 *
 *   1. A count is only ever a number the response carried. When a response
 *      has no verification block (an older server, a proxy that stripped it)
 *      the row says "unreported", never 0 — a zero the server did not state
 *      is the exact lie this round exists to end.
 *   2. Any `mismatches` entry makes the row FAILED, naming the section, even
 *      though the HTTP status was 200 and `created` was true.
 *   3. `APPLY_VERIFY_FAILED` (the server refused after committing) is shown
 *      with the server's message verbatim, plus the product id it names, so
 *      the admin knows the product exists and what is missing from it.
 *
 * Pure functions, no React: tests/adminProductHydration.test.ts runs them over
 * fixtures shaped exactly like the server's response.
 */

import { ApiError } from '../../lib/api';
import type { ApplyMismatch, ApplyResponse, ApplyVerifyFailure, NeedsReviewEntry, TemplateError } from './types';

/** What the read-back said, or `reported: false` when the server said nothing. */
export interface ApplyVerification {
  reported: boolean;
  groups: number | null;
  values: number | null;
  colors: number | null;
  links: number | null;
  variants: number | null;
  images: number | null;
  primary_image: string | null;
  inventory_mode: string | null;
  spec_stored: number | null;
  spec_visible: number | null;
  spec_outside: string[];
  /** The template family the section resolved to, or null when it has none. */
  spec_family: string | null;
  /** Per-field notes the spec check produced (also part of `warnings`). */
  spec_warnings: string[];
  /** requested → stored, per collection, when the server compared them. */
  requested: { images: number | null; option_groups: number | null; option_values: number | null; colors: number | null };
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const strList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

/** The verification block of a response (or of a refusal's details). */
export function summarizeApply(out: Partial<ApplyResponse> | ApplyVerifyFailure | null | undefined): ApplyVerification {
  const rel = out?.relations;
  const full = (out ?? null) as (Partial<ApplyResponse> & ApplyVerifyFailure) | null;
  const spec = full?.spec_fields;
  return {
    reported: !!rel && typeof rel === 'object',
    groups: num(rel?.groups),
    values: num(rel?.values),
    colors: num(rel?.colors),
    links: num(rel?.links),
    variants: num(rel?.variants),
    images: num(rel?.images),
    primary_image: typeof rel?.primary_image === 'string' ? rel.primary_image : null,
    inventory_mode: typeof rel?.inventory_mode === 'string' ? rel.inventory_mode : null,
    spec_stored: num(spec?.stored),
    spec_visible: num(spec?.visible_in_form),
    spec_outside: strList(spec?.outside_section),
    spec_family: typeof spec?.family === 'string' ? spec.family : null,
    spec_warnings: strList(spec?.warnings),
    requested: {
      images: num(full?.images?.requested),
      option_groups: num(full?.option_groups?.requested),
      option_values: num(full?.option_values?.requested),
      colors: num(full?.colors?.requested),
    },
  };
}

/** Words the summary line is written with — the panel passes its own language. */
export interface VerificationWords {
  groups: string;
  values: string;
  colors: string;
  links: string;
  images: string;
  specs: string;
  /** «(3 visible in the form)» — the spec fields the section's template DOES
   *  render, shown beside the stored count. */
  outside: string;
  /** «outside the section template» — the ids the template does NOT render.
   *  A separate word on purpose: reusing `outside` for both labelled the
   *  hidden ids with the phrase that means the opposite. */
  outsideSection: string;
  variants: string;
  inventory: string;
  unreported: string;
}

/**
 * One line: «1 مجموعة · 4 قيمة · 1 لون · 1 ربط · 3 صورة · 7 مواصفة · OPTION».
 * A count the server did not report is written as the `unreported` word, and
 * when the whole block is missing the line is that word alone.
 */
export function verificationLine(v: ApplyVerification, w: VerificationWords): string {
  if (!v.reported) return w.unreported;
  const n = (x: number | null) => (x === null ? '?' : String(x));
  const parts = [
    `${n(v.groups)} ${w.groups}`,
    `${n(v.values)} ${w.values}`,
    `${n(v.colors)} ${w.colors}`,
    `${n(v.links)} ${w.links}`,
    `${n(v.images)} ${w.images}`,
  ];
  if (v.spec_stored !== null) {
    parts.push(
      `${v.spec_stored} ${w.specs}` +
        (v.spec_visible !== null && v.spec_visible !== v.spec_stored ? ` (${v.spec_visible} ${w.outside})` : '')
    );
  }
  if (v.variants !== null && v.variants > 0) parts.push(`${v.variants} ${w.variants}`);
  if (v.inventory_mode) parts.push(`${w.inventory} ${v.inventory_mode}`);
  return parts.join(' · ');
}

/** «options: requested 3, stored 0» — one clause per mismatch, section first. */
export function mismatchText(ms: ApplyMismatch[] | undefined | null): string {
  if (!ms || ms.length === 0) return '';
  const show = (x: unknown) => (x === null || x === undefined ? '—' : typeof x === 'object' ? JSON.stringify(x) : String(x));
  return ms.map((m) => `${m.section}${m.key ? `.${m.key}` : ''}: requested ${show(m.requested)}, stored ${show(m.stored)}`).join(' ; ');
}

/** The sections a mismatch list touches, for the failed row's short label. */
export function mismatchSections(ms: ApplyMismatch[] | undefined | null): string[] {
  return [...new Set((ms ?? []).map((m) => m.section))];
}

export interface ApplyOutcome {
  action: 'created' | 'updated' | 'skipped' | 'failed';
  /** The product the server wrote or found. */
  productId: string;
  /** What the row's detail column says — an id, a section name, a refusal. */
  detail: string;
  verify: ApplyVerification;
  warnings: string[];
  unknownKeys: string[];
  appliedFields: string[];
  preservedFields: string[];
  clearedFields: string[];
  mismatches: ApplyMismatch[];
  /**
   * Row-level reasons a refusal carried — validation messages, template errors
   * and unresolved references. The server sends them beside the sentence; a
   * row that only repeated the sentence would hide which rows were rejected.
   */
  issues: string[];
}

/** `errors` / `needs_review` of a refusal, as readable lines. */
/**
 * The row-level reasons inside a refusal body — used by the import window AND
 * by ProductForm's save, because a `VALIDATION` answer carries its lines in
 * `errors` and nothing else, and showing only «Server error (400)» hides the
 * one thing the admin needs.
 */
export function refusalIssues(body: ApplyVerifyFailure): string[] {
  const out: string[] = [];
  for (const err of body.errors ?? []) {
    if (typeof err === 'string') out.push(err);
    else if (err && typeof err === 'object') {
      const t = err as TemplateError;
      out.push(`${t.line ? `${t.line}: ` : ''}${t.key ? `${t.key} — ` : ''}${t.message}`);
    }
  }
  for (const nr of body.needs_review ?? []) {
    const r = nr as NeedsReviewEntry;
    if (r && typeof r === 'object') out.push(`${r.line ? `${r.line}: ` : ''}${r.key}="${r.value}" — ${r.message}`);
  }
  return out;
}

/**
 * A 200 response → the row. `already_applied` is a skip; a non-empty
 * `mismatches` is a failure named by section, whatever `created` says.
 */
export function applyOutcome(out: ApplyResponse, words: { alreadyApplied: string; mismatched: string }): ApplyOutcome {
  const mismatches = Array.isArray(out.mismatches) ? out.mismatches : [];
  const verify = summarizeApply(out);
  const base = {
    productId: out.product_id ?? '',
    verify,
    warnings: strList(out.warnings),
    unknownKeys: strList(out.unknown_keys),
    appliedFields: strList(out.applied_fields),
    preservedFields: strList(out.preserved_fields),
    clearedFields: strList(out.cleared_fields),
    mismatches,
    issues: [],
  };
  if (mismatches.length > 0) {
    return { ...base, action: 'failed', detail: `${words.mismatched} ${mismatchSections(mismatches).join(', ')} — ${mismatchText(mismatches)}` };
  }
  if (out.already_applied) return { ...base, action: 'skipped', detail: words.alreadyApplied };
  return { ...base, action: out.created ? 'created' : 'updated', detail: out.product_id };
}

/**
 * A thrown ApiError → the failed row. The server's message is kept VERBATIM,
 * and everything it attached beside the message is kept with it: the section
 * and field that did not persist, the mismatch list, the read-back counts, the
 * validation errors and the unresolved references. The route sends those at
 * the TOP LEVEL of the refusal body, which is why `ApiError` carries the body
 * as well as `details` — reading only `details` would show the sentence and
 * silently drop every number in it.
 */
export function applyFailure(
  e: unknown,
  words: { duplicate: string; inProgress: string; productExists: string }
): ApplyOutcome {
  const err = e instanceof ApiError ? e : null;
  const code = err?.code ?? '';
  const body = { ...((err?.body ?? {}) as ApplyVerifyFailure), ...((err?.details ?? {}) as ApplyVerifyFailure) };
  const mismatches = Array.isArray(body.mismatches) ? body.mismatches : [];
  const verify = summarizeApply(body);
  let detail =
    code === 'DUPLICATE'
      ? words.duplicate
      : code === 'APPLY_IN_PROGRESS'
        ? words.inProgress
        : err
          ? err.message
          : String(e);
  // The section / field the server named, when its sentence does not already
  // carry them (a relations refusal names `section: 'relations'`).
  if (code !== 'DUPLICATE' && code !== 'APPLY_IN_PROGRESS' && body.section && !detail.includes(body.section)) {
    detail = `${body.section}${body.field ? `.${body.field}` : ''}: ${detail}`;
  }
  if (code === 'APPLY_VERIFY_FAILED') {
    const extra = mismatchText(mismatches);
    if (extra && !detail.includes(extra)) detail = `${detail} — ${extra}`;
    if (body.product_id) detail = `${detail} (${words.productExists} ${body.product_id})`;
  }
  return {
    action: 'failed',
    productId: typeof body.product_id === 'string' ? body.product_id : '',
    detail,
    verify,
    warnings: strList(body.warnings),
    unknownKeys: strList(body.unknown_keys),
    appliedFields: [],
    preservedFields: [],
    clearedFields: [],
    mismatches,
    issues: refusalIssues(body),
  };
}
