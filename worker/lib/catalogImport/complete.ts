/**
 * `/items/:sid/complete`: COMPLETE ONLY WHEN BOTH SIDES PASS AND AGREE (Bambu
 * import spec §I.1, §I.1.10; review finding 29 "COMPLETE self-attested").
 *
 * The runner sends what it saw on the public site (`edge_evidence`, built by
 * scripts/bambu-import/verify.ts `edgeEvidence`); the Worker recomputes the
 * D1-side facts itself (./verifyD1.ts, price-request eligibility through the
 * POST's own validator, creating no row). COMPLETE needs all of:
 *
 *   1. the evidence is the runner's for THIS item: version 1, the live URL is
 *      this item's `/product/<slug>` on the origin the call came to;
 *   2. every check the runner marks hard is ok, every expected check is there
 *      (the merge check for a merge), and the browser check is there and passed;
 *      a merge also needs the write's own recorded `before_fp_equal` true;
 *   3. the evidence's counts equal the counts of the payload this item WROTE
 *      (`stage_data.payload_counts`, recorded by the write's checkpoint): the
 *      runner verified what was written, not another build of the page;
 *   4. every hard D1 check is true, its counts included (`stage_data.written`
 *      against D1).
 *
 * Then one batch moves VERIFYING_LIVE → COMPLETE with `live_url`,
 * `verified_at`, `d1_checks`, `edge_evidence`, and the lease-fenced COMPLETED
 * event. Otherwise nothing moves: the answer is `VERIFYING_LIVE` with the
 * failed check NAMES, and the two records are kept for the owner's dashboard —
 * the runner's cache rule purges, waits and asks again, and blocks with
 * VERIFY_FAILED_PERSISTENT on the second disagreement (§I.1.9).
 *
 * What is stored is counts, booleans, check names, public section slugs and
 * the public live URL: a check's free `detail` is never kept.
 */
import type { Env } from '../types';
import { newId } from '../crypto';
import { fence, isFenceMiss } from '../operations';
import { NOW_SQL, OpsRefusal, type ImportRun } from './auth';
import { stageDataOf, type ItemRow } from './items';
import type { ReviewedBundle } from './reviewed';
import { recomputeD1Checks, type CheckedSelection, type D1Checks } from './verifyD1';
import { refusalOfBatch } from './writer';

/** The checks the runner's VERIFY records (scripts/bambu-import/verify.ts), the merge check for a merge. */
export const EXPECTED_EDGE_CHECKS = ['v1', 'structure', 'knowledge', 'fingerprint', 'listings', 'search', 'sellable', 'media', 'compare'] as const;
const MAX_EVIDENCE_BYTES = 64 * 1024;
const MAX_SELECTIONS = 60;

export interface EdgeCheck {
  ok: boolean;
  hard: boolean;
  status?: number;
  counts?: Record<string, number>;
}

export interface EdgeEvidence {
  version: 1;
  live_url: string;
  round: number;
  checks: Record<string, EdgeCheck>;
  browser: { ok: boolean; checks: number; failed: number } | null;
  sections: { leaf: string; root: string; secondary: string[] };
  selections_checked: number;
  counts: Record<string, number>;
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const numbers = (v: unknown): Record<string, number> => {
  const out: Record<string, number> = {};
  if (!isObj(v)) return out;
  for (const [k, x] of Object.entries(v)) if (/^[a-z][a-z0-9_]{0,39}$/.test(k) && typeof x === 'number' && Number.isFinite(x)) out[k] = x;
  return out;
};
const slugText = (v: unknown): string => (typeof v === 'string' && v.length <= 200 ? v : '');

/** The live URL the runner names must be this item's page on the origin it called. */
export function liveUrlOf(raw: unknown, requestUrl: string, slug: string): string | null {
  if (typeof raw !== 'string' || raw.length > 1000 || !slug) return null;
  try {
    const u = new URL(raw);
    const self = new URL(requestUrl);
    if (u.origin !== self.origin || u.search || u.hash) return null;
    return decodeURIComponent(u.pathname) === `/product/${slug}` ? u.toString() : null;
  } catch {
    return null;
  }
}

/**
 * The evidence, normalised to what may be stored (no `detail`), and the selections the runner checked.
 * Malformed evidence is a refusal (400), never a stored half.
 */
export function edgeEvidenceOf(raw: unknown, liveUrl: string): { evidence: EdgeEvidence; selections: CheckedSelection[] } {
  if (!isObj(raw)) throw new OpsRefusal(400, 'IMPORT_BAD_REQUEST');
  if (JSON.stringify(raw).length > MAX_EVIDENCE_BYTES) throw new OpsRefusal(413, 'IMPORT_BODY_TOO_LARGE');
  if (raw.version !== 1 || raw.live_url !== liveUrl || !isObj(raw.checks)) throw new OpsRefusal(400, 'IMPORT_BAD_REQUEST');
  const checks: Record<string, EdgeCheck> = {};
  let browser: EdgeEvidence['browser'] = null;
  for (const [name, c] of Object.entries(raw.checks)) {
    if (!/^[a-z][a-z0-9_]{0,39}$/.test(name) || !isObj(c)) continue;
    if (name === 'browser') {
      const inner = isObj(c.checks) ? Object.values(c.checks) : [];
      browser = { ok: c.ok === true, checks: inner.length, failed: inner.filter((x) => x !== true).length };
      continue;
    }
    checks[name] = {
      ok: c.ok === true,
      hard: c.hard === true,
      ...(typeof c.status === 'number' ? { status: c.status } : {}),
      ...(isObj(c.counts) ? { counts: numbers(c.counts) } : {}),
    };
  }
  const sec = isObj(raw.sections) ? raw.sections : {};
  const selections: CheckedSelection[] = [];
  if (Array.isArray(raw.selections_checked)) {
    for (const s of raw.selections_checked.slice(0, MAX_SELECTIONS)) {
      if (!Array.isArray(s) || s.length > 24 || !s.every((x) => typeof x === 'string' && x.length <= 80)) throw new OpsRefusal(400, 'IMPORT_BAD_REQUEST');
      if (s.length) selections.push({ option_value_ids: s as string[] });
    }
  }
  return {
    evidence: {
      version: 1,
      live_url: liveUrl,
      round: typeof raw.round === 'number' && Number.isInteger(raw.round) ? raw.round : 0,
      checks,
      browser,
      sections: {
        leaf: slugText(sec.leaf),
        root: slugText(sec.root),
        secondary: Array.isArray(sec.secondary) ? sec.secondary.map(slugText).filter(Boolean).slice(0, 20) : [],
      },
      selections_checked: selections.length,
      counts: numbers(raw.counts),
    },
    selections,
  };
}

export interface Agreement {
  /** The runner's side: every hard check ok, every expected check present, the browser (if any) ok. */
  edge_ok: boolean;
  /** The runner verified the payload this item wrote: its counts equal stage_data.payload_counts. */
  counts_agree: boolean;
  /** Names of what failed on either side (never a value). */
  failed: string[];
}

export function agreementOf(
  evidence: EdgeEvidence,
  d1: D1Checks,
  payloadCounts: Record<string, number>,
  merged: boolean,
  written: { before_fp_equal?: unknown } = {}
): Agreement {
  const failed: string[] = [];
  for (const name of [...EXPECTED_EDGE_CHECKS, ...(merged ? ['merge'] : [])]) {
    if (!evidence.checks[name]) failed.push(`edge.${name}.missing`);
  }
  for (const [name, c] of Object.entries(evidence.checks)) if (c.hard && !c.ok) failed.push(`edge.${name}`);
  // §I.1.7: the browser check is part of the evidence, always — a COMPLETE never rests on the API checks alone.
  if (!evidence.browser) failed.push('edge.browser.missing');
  else if (!evidence.browser.ok) failed.push('edge.browser');
  // §A.4 step 7, §I.1.8: a merge completes only on the protected-fields result the WRITE recorded (stage_data,
  // after its commit) — never on a runner's assumption when its /write answer was lost. Absent counts as not equal.
  if (merged && written.before_fp_equal !== true) failed.push('write.before_fp_equal');
  const edgeOk = failed.length === 0;
  const keys = new Set([...Object.keys(payloadCounts), ...Object.keys(evidence.counts)]);
  const countsAgree = keys.size > 0 && [...keys].every((k) => evidence.counts[k] === payloadCounts[k]);
  if (!countsAgree) failed.push('counts.edge_vs_written_payload');
  for (const name of d1.failed) failed.push(`d1.${name}`);
  return { edge_ok: edgeOk, counts_agree: countsAgree, failed };
}

/** A batch fenced on the item: a fence miss is the stale 409 the runner re-leases on; a trigger refusal its own code. */
async function fenced(item: Pick<ItemRow, 'id'>, run: () => Promise<unknown>): Promise<void> {
  try {
    await run();
  } catch (e) {
    if (isFenceMiss(e)) throw new OpsRefusal(409, 'IMPORT_ILLEGAL_TRANSITION', [item.id]);
    const mapped = refusalOfBatch(e);
    if (mapped !== e && mapped instanceof Error && 'code' in mapped) throw new OpsRefusal(409, String((mapped as { code: unknown }).code), [item.id]);
    throw e;
  }
}

export interface CompleteAnswer {
  state: 'COMPLETE' | 'VERIFYING_LIVE';
  seq: number | null;
  d1_checks: D1Checks & { agreement: Agreement };
}

/** POST /items/:sid/complete (after holdLease). */
export async function completeItem(
  env: Pick<Env, 'DB' | 'BUCKET' | 'R2_PUBLIC' | 'R2_PRIVATE'>,
  requestUrl: string,
  run: ImportRun,
  item: ItemRow,
  bundle: ReviewedBundle,
  body: Record<string, unknown>
): Promise<CompleteAnswer> {
  if (item.processing_state !== 'VERIFYING_LIVE') throw new OpsRefusal(409, 'IMPORT_ILLEGAL_TRANSITION', [item.id]);
  const liveUrl = liveUrlOf(body.live_url, requestUrl, item.slug);
  if (!liveUrl) throw new OpsRefusal(400, 'IMPORT_BAD_REQUEST', [item.id]);
  const { evidence, selections } = edgeEvidenceOf(body.edge_evidence, liveUrl);
  const db = env.DB;
  const d1 = await recomputeD1Checks(db, { bundle, runId: run.id, itemId: item.id, selections, media: env });
  const stageData = stageDataOf(item);
  const agreement = agreementOf(evidence, d1, numbers(stageData.payload_counts), item.match_kind === 'merged', { before_fp_equal: stageData.before_fp_equal });
  const d1Checks = { ...d1, agreement };
  const complete = d1.ok && agreement.edge_ok && agreement.counts_agree;
  // Both batches are fenced on the state and the lease this call read: the recompute is slow, and an item that
  // moved meanwhile (a retry or a block under the same lease) gets no COMPLETED event and no record (409, stale).
  const [fenceIn, fenceOut] = fence(db, `EXISTS (SELECT 1 FROM catalog_import_items WHERE id = ? AND processing_state = 'VERIFYING_LIVE' AND lease_token = ?)`, [item.id, item.lease_token]);
  if (!complete) {
    // Nothing moves; the latest records are kept for the owner, with an info event naming the code.
    await fenced(item, () =>
      db.batch([
        fenceIn,
        db
          .prepare(`UPDATE catalog_import_items SET d1_checks = ?, edge_evidence = ?, updated_at = ${NOW_SQL} WHERE id = ? AND lease_token = ? AND processing_state = 'VERIFYING_LIVE'`)
          .bind(JSON.stringify(d1Checks), JSON.stringify(evidence), item.id, item.lease_token),
        db
          .prepare(
            `INSERT INTO catalog_import_events (id, run_id, item_id, seq, stage, outcome, code, message, detail, lease_token, github_run_id)
             VALUES (?, ?, ?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM catalog_import_events WHERE run_id = ?), 'VERIFYING_LIVE', 'info', 'IMPORT_VERIFY_DISAGREES', '', ?, ?, ?)`
          )
          .bind(newId('cie'), run.id, item.id, run.id, JSON.stringify({ failed: agreement.failed.length, round: evidence.round }), item.lease_token, run.github_run_id),
        fenceOut,
      ])
    );
    return { state: 'VERIFYING_LIVE', seq: null, d1_checks: d1Checks };
  }
  await fenced(item, () =>
    db.batch([
      fenceIn,
      db
        .prepare(
          `UPDATE catalog_import_items
              SET processing_state = 'COMPLETE', last_completed_stage = 'VERIFYING_LIVE', live_url = ?, verified_at = ${NOW_SQL},
                  completed_at = ${NOW_SQL}, d1_checks = ?, edge_evidence = ?, stage_attempts = 0, retry_at = '', updated_at = ${NOW_SQL}
            WHERE id = ? AND lease_token = ? AND processing_state = 'VERIFYING_LIVE'`
        )
        .bind(liveUrl, JSON.stringify(d1Checks), JSON.stringify(evidence), item.id, item.lease_token),
      // Fenced by trg_cie_lease_fence (stage COMPLETED): a stale executor's COMPLETE aborts whole.
      db
        .prepare(
          `INSERT INTO catalog_import_events (id, run_id, item_id, seq, stage, outcome, code, message, detail, lease_token, github_run_id)
           VALUES (?, ?, ?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM catalog_import_events WHERE run_id = ?), 'COMPLETED', 'ok', '', '', ?, ?, ?)`
        )
        .bind(newId('cie'), run.id, item.id, run.id, JSON.stringify({ round: evidence.round, selections: evidence.selections_checked }), item.lease_token, run.github_run_id),
      fenceOut,
    ])
  );
  const seq = await db
    .prepare("SELECT seq FROM catalog_import_events WHERE run_id = ? AND item_id = ? AND stage = 'COMPLETED' ORDER BY seq DESC LIMIT 1")
    .bind(run.id, item.id)
    .first<{ seq: number }>();
  return { state: 'COMPLETE', seq: seq?.seq ?? null, d1_checks: d1Checks };
}
