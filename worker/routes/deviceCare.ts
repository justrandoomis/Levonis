/**
 * THE CLAIM'S MONEY — Levo Care on the warranty desk, and what a claim cost the shop (printer services
 * phase 3, owner rulings 2026-11-18; DECISIONS row 347; migration 0236). Mounted on the device router
 * (worker/routes/devices.ts, `/api/devices`), so the admin doors sit behind its main-host + admin guard.
 *
 * Customer:
 *   POST /claims/:id/care-quote/accept        the claimant accepts THE quote they saw { version }
 * Admin (any admin — class op):
 *   GET  /admin/claims/:id/care               the claim's Care panel: entitlement, caps, quote, costs
 *   POST /admin/claims/:id/care-quote         write or re-write the Care quote (marks the claim 'care')
 * Money (finance scope; an assistant is refused at the door — requireMoneyAuthority):
 *   POST /admin/claims/:id/care-approve       care_claim_decision: approve the accepted quote; caps re-checked
 *                                             in the write; the claim → approved, decision repair
 *   POST /admin/claims/:id/care-void          care_claim_decision: void the quote / approval (before the claim
 *                                             is resolved, never after the co-pay was collected)
 *   POST /admin/claims/:id/care-copay         service_claim_cost: the co-pay collected in cash, once —
 *                                             journal care-copay:<claim> 1000 Dr / 4300 Cr (service income)
 *   POST /admin/claims/:id/costs              service_claim_cost: an out-of-pocket cost — a GENERAL expense of
 *                                             its cost day (never written back to an order), idempotent by operation_id
 *   POST /admin/claims/:id/costs/:costId/void service_claim_cost: void it (the expense and its journal reversed)
 *
 * A database without 0236 answers 503 CARE_NOT_INSTALLED on every door here (CLAUDE.md rule 2).
 */
import type { Context, Hono } from 'hono';
import type { AppContext } from '../lib/types';
import { HttpError, badRequest, notFound, str } from '../lib/http';
import { auditStatements } from '../lib/audit';
import { newId } from '../lib/crypto';
import { canMoveMoney, canViewCost } from '../lib/adminScope';
import { assertMoneyAuthority, requireMoneyAuthority } from '../lib/moneyAuthority';
import { baghdadDay, dateValue, fence, isFenceMiss, journalPlan, operationsInstalled, periodOpen, whole } from '../lib/operations';
import { planExpenseAccounting } from '../lib/expenseAccounting';
import { unitCoverage } from '../lib/deviceCustody';
import { claimFiledColumnsInstalled, effectiveClaimStage, effectiveClaimStageSql, stageToLegacyStatus } from '../lib/deviceOps';
import { notifyClaimStage } from '../lib/engagementNotify';
import {
  CLAIM_COST_CATEGORY,
  CLAIM_COST_KINDS,
  CLAIM_COST_KIND_TEXT,
  SERVICE_INCOME_ACCOUNT,
  careBenefitOf,
  careClaimsInstalled,
  careEntitlements,
  careQuotePublic,
  careRefusal,
  claimCostPublic,
  parseCareQuote,
  priceCareQuote,
  type CareBenefitRow,
  type ClaimCostKind,
  type ServiceClaimCostRow,
} from '../lib/careClaims';

interface ClaimHead extends Record<string, unknown> {
  id: string;
  user_id: string;
  unit_id: string | null;
  stage: string | null;
  status: string;
  created_at: string;
  claim_kind: string | null;
  decision_reason: string | null;
  admin_note: string | null;
  /** The cover the claim was filed under (0191, frozen by trigger); absent / NULL on older claims. */
  filed_cover_state?: string | null;
  filed_cover_via?: string | null;
  filed_cover_end_at?: string | null;
}

const OPEN_FOR_QUOTE = ['received', 'diagnosing'] as const;

function afterResponse(c: Context<AppContext>, work: Promise<void>): void {
  try {
    c.executionCtx.waitUntil(work);
  } catch {
    // No ExecutionContext (a test harness): the work is already in flight and never rejects.
  }
}

async function requireInstalled(db: D1Database) {
  if (!(await careClaimsInstalled(db))) throw careRefusal('CARE_NOT_INSTALLED', 503);
}

async function claimHead(db: D1Database, id: string): Promise<ClaimHead> {
  const filed = (await claimFiledColumnsInstalled(db)) ? ', filed_cover_state, filed_cover_via, filed_cover_end_at' : '';
  const claim = await db
    .prepare(`SELECT id, user_id, unit_id, stage, status, created_at, claim_kind, decision_reason, admin_note${filed} FROM warranty_claims WHERE id = ?`)
    .bind(id)
    .first<ClaimHead>();
  if (!claim) throw notFound('Claim not found');
  return claim;
}

/**
 * The warranty that covered the claimed unit WHEN THE CLAIM WAS FILED (the desk's no-stacking rule: a claim is
 * warranty OR Care, judged at its filing — owner ruling). The cover the claim recorded at filing (0191's
 * filed_cover_*, frozen by trigger) when it has one; else the unit's cover recomputed at the claim's created_at.
 * Never today's clock: a claim filed inside the warranty stays a warranty claim after the warranty ends.
 */
export async function warrantyAtFiling(
  db: D1Database,
  claim: Pick<ClaimHead, 'unit_id' | 'created_at' | 'filed_cover_state' | 'filed_cover_via' | 'filed_cover_end_at'>
) {
  if (!claim.unit_id) return null;
  if (claim.filed_cover_state) {
    return {
      state: claim.filed_cover_state,
      covered_via: claim.filed_cover_via === 'used_sale' ? ('used_sale' as const) : ('original' as const),
      end_at: claim.filed_cover_end_at ?? null,
    };
  }
  const unit = await db
    .prepare('SELECT delivered_at, warranty_end_at, policy_version, warranty_closed_at FROM order_item_units WHERE id = ?')
    .bind(claim.unit_id)
    .first<{ delivered_at: string | null; warranty_end_at: string | null; policy_version: string | null; warranty_closed_at: string | null }>();
  if (!unit) return null;
  const filedAt = Date.parse(claim.created_at);
  const at = Number.isFinite(filedAt) ? filedAt : Date.now();
  // A device that came back AFTER the claim was filed was still covered at its filing.
  const closedAt = unit.warranty_closed_at && Date.parse(unit.warranty_closed_at) <= at ? unit.warranty_closed_at : null;
  const cov = unitCoverage(unit, at, closedAt);
  return { state: cov.state as string, covered_via: cov.via, end_at: cov.end_at };
}

/** The claim's Care, judged on the day it was filed (W-1: a claim is counted at its filing). */
async function entitlementAtFiling(db: D1Database, claim: ClaimHead) {
  if (!claim.unit_id) return null;
  const at = Date.parse(claim.created_at);
  return (await careEntitlements(db, [claim.unit_id], Number.isFinite(at) ? at : Date.now())).get(claim.unit_id) ?? null;
}

async function costsOf(db: D1Database, claimId: string): Promise<ServiceClaimCostRow[]> {
  return (
    (await db.prepare('SELECT * FROM service_claim_costs WHERE claim_id = ? ORDER BY created_at, id').bind(claimId).all<ServiceClaimCostRow>()).results ?? []
  );
}

/** The Care panel's whole answer (GET, and the answer of every write here). */
async function carePanel(c: Context<AppContext>, claimId: string) {
  const db = c.env.DB;
  const claim = await claimHead(db, claimId);
  const [entitlement, benefit, warranty] = await Promise.all([
    entitlementAtFiling(db, claim),
    careBenefitOf(db, claim.id),
    warrantyAtFiling(db, claim),
  ]);
  // What a claim cost the shop is a general expense, and expenses are cost (owner decision 2: the finance pages sit
  // behind requireCostRead): only a cost reader sees the list. A financial admin RECORDS costs (owner ruling D3) and
  // decides Care (`can_decide`); an assistant does neither.
  const money = canMoveMoney(c.env, c.get('user'));
  const costs = canViewCost(c.env, c.get('user')) ? await costsOf(db, claim.id) : null;
  return {
    success: true,
    installed: true,
    claim: {
      id: claim.id,
      stage: effectiveClaimStage(claim.stage, claim.status),
      claim_kind: claim.claim_kind ?? 'warranty',
      unit_id: claim.unit_id,
      user_id: claim.user_id,
      created_at: claim.created_at,
    },
    warranty,
    care: entitlement
      ? {
          ...entitlement,
          // The caps the quote is priced against: this claim's own approval is not «used» by itself.
          used_excluding_this_claim:
            benefit?.state === 'approved'
              ? { claims: Math.max(0, entitlement.used_claims - 1), benefit_iqd: Math.max(0, entitlement.used_benefit_iqd - benefit.benefit_iqd) }
              : { claims: entitlement.used_claims, benefit_iqd: entitlement.used_benefit_iqd },
        }
      : null,
    quote: careQuotePublic(benefit, entitlement?.terms ?? null, { admin: true }),
    costs: costs ? costs.map(claimCostPublic) : null,
    costs_total_iqd: costs ? costs.filter((r) => !r.voided_at).reduce((s, r) => s + Number(r.amount_iqd || 0), 0) : null,
    can_decide: money,
    service_income_account: SERVICE_INCOME_ACCOUNT,
  };
}

const reasonOf = (v: unknown) => str(v, 'reason', { min: 5, max: 1000 });

async function runFenced(db: D1Database, statements: D1PreparedStatement[], onMiss: () => HttpError, other?: (message: string) => HttpError | null) {
  try {
    await db.batch(statements);
  } catch (e) {
    const message = String((e as Error)?.message ?? e);
    if (isFenceMiss(e) || /CARE_BENEFIT_FROZEN/.test(message)) throw onMiss();
    const mapped = other?.(message);
    if (mapped) throw mapped;
    throw e;
  }
}

export function mountDeviceCareRoutes(r: Hono<AppContext>): void {
  // ------------------------------------------------------------ admin: the panel and the quote
  r.get('/admin/claims/:id/care', async (c) => {
    if (!(await careClaimsInstalled(c.env.DB))) {
      if (!(await c.env.DB.prepare('SELECT 1 AS x FROM warranty_claims WHERE id = ?').bind(c.req.param('id')).first())) throw notFound('Claim not found');
      return c.json({ success: true, installed: false, care: null, quote: null, costs: null, costs_total_iqd: null });
    }
    return c.json(await carePanel(c, c.req.param('id')));
  });

  r.post('/admin/claims/:id/care-quote', async (c) => {
    const db = c.env.DB;
    await requireInstalled(db);
    const admin = c.get('user')!;
    const body = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
    const claim = await claimHead(db, c.req.param('id'));
    const stage = effectiveClaimStage(claim.stage, claim.status);
    if (!(OPEN_FOR_QUOTE as readonly string[]).includes(stage) || !claim.unit_id) throw careRefusal('CARE_CLAIM_NOT_OPEN');
    const input = parseCareQuote(body);
    // No stacking (plan §E): while the warranty covers the device, the fault is a warranty claim —
    // unless the desk found misuse, which the warranty never covers.
    const misuse = body.misuse === true;
    const warranty = await warrantyAtFiling(db, claim);
    if (warranty?.state === 'active' && !misuse) throw careRefusal('CARE_NOT_WARRANTY');
    const ent = await entitlementAtFiling(db, claim);
    if (!ent || ent.state !== 'active' || !ent.terms) {
      throw ent?.state === 'terms_missing' ? careRefusal('CARE_TERMS_MISSING') : careRefusal('CARE_NOT_ACTIVE', 409, { state: ent?.state ?? 'none' });
    }
    const existing = await careBenefitOf(db, claim.id);
    if (existing?.state === 'approved') throw careRefusal('CARE_ALREADY_APPROVED');
    const priced = priceCareQuote(ent.terms, input, { claims: ent.used_claims, benefit_iqd: ent.used_benefit_iqd });
    const now = new Date().toISOString();
    const quoteJson = JSON.stringify({ ...priced, misuse, terms_policy_version: ent.policy_version });
    const statements: D1PreparedStatement[] = [
      ...fence(db, "NOT EXISTS (SELECT 1 FROM care_claim_benefits WHERE claim_id = ? AND state = 'approved')", [claim.id]),
      db
        .prepare(
          `INSERT INTO care_claim_benefits (id, claim_id, entitlement_unit_id, order_item_id, policy_version, quote_json, list_iqd, eligible_iqd,
              discount_pct, benefit_iqd, copay_iqd, state, version, quoted_by, quoted_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'quoted', 1, ?, ?)
           ON CONFLICT(claim_id) DO UPDATE SET
              entitlement_unit_id = excluded.entitlement_unit_id, order_item_id = excluded.order_item_id,
              policy_version = excluded.policy_version, quote_json = excluded.quote_json, list_iqd = excluded.list_iqd,
              eligible_iqd = excluded.eligible_iqd, discount_pct = excluded.discount_pct, benefit_iqd = excluded.benefit_iqd,
              copay_iqd = excluded.copay_iqd, state = 'quoted', version = care_claim_benefits.version + 1,
              quoted_by = excluded.quoted_by, quoted_at = excluded.quoted_at, customer_accepted_at = NULL,
              decided_by = NULL, decided_at = NULL, decided_day = NULL, voided_at = NULL, voided_by = NULL, void_reason = NULL
            WHERE care_claim_benefits.state <> 'approved'`
        )
        .bind(
          newId('ccb'), claim.id, ent.root_unit_id, ent.order_item_id ?? '', ent.policy_version ?? 1, quoteJson,
          priced.list_iqd, priced.eligible_iqd, priced.discount_pct, priced.benefit_iqd, priced.copay_iqd, admin.id, now
        ),
      db.prepare("UPDATE warranty_claims SET claim_kind = 'care' WHERE id = ?").bind(claim.id),
      ...(await auditStatements(db, admin.id, 'warranty.care_quote', claim.id, {
        list_iqd: priced.list_iqd, eligible_iqd: priced.eligible_iqd, benefit_iqd: priced.benefit_iqd, copay_iqd: priced.copay_iqd,
        misuse, entitlement_unit_id: ent.root_unit_id, policy_version: ent.policy_version,
      })).statements,
    ];
    await runFenced(db, statements, () => careRefusal('CARE_ALREADY_APPROVED'));
    if (claim.user_id !== admin.id) {
      afterResponse(c, notifyClaimStage(c.env, claim.id, stage, {
        at: now,
        reason: 'عرض ليفو كير جاهز لموافقتك / Your Levo Care quote is ready to accept / پێشنیاری لیڤۆ کێرەکەت ئامادەیە بۆ قبوڵکردن',
      }));
    }
    return c.json(await carePanel(c, claim.id));
  });

  // ------------------------------------------------------------ customer: accept the quote
  r.post('/claims/:id/care-quote/accept', async (c) => {
    const db = c.env.DB;
    await requireInstalled(db);
    const user = c.get('user')!;
    const body = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
    const claim = await db.prepare('SELECT id, user_id, stage, status, created_at, unit_id FROM warranty_claims WHERE id = ?').bind(c.req.param('id')).first<ClaimHead>();
    // Only the claimant accepts; anyone else learns nothing about the claim.
    if (!claim || claim.user_id !== user.id) throw notFound('Claim not found');
    const version = Number(body.version);
    const benefit = await careBenefitOf(db, claim.id);
    if (!benefit) throw notFound('No Levo Care quote on this claim');
    if (benefit.state === 'accepted' && benefit.version === version) {
      return c.json({ success: true, already: true, quote: careQuotePublic(benefit, (await entitlementAtFiling(db, claim))?.terms ?? null) });
    }
    if (benefit.state !== 'quoted' || !Number.isInteger(version) || benefit.version !== version) throw careRefusal('CARE_QUOTE_CHANGED');
    if (!(OPEN_FOR_QUOTE as readonly string[]).includes(effectiveClaimStage(claim.stage, claim.status))) throw careRefusal('CARE_CLAIM_NOT_OPEN');
    const now = new Date().toISOString();
    await runFenced(
      db,
      [
        ...fence(db, "EXISTS (SELECT 1 FROM care_claim_benefits WHERE claim_id = ? AND state = 'quoted' AND version = ?)", [claim.id, version]),
        db.prepare("UPDATE care_claim_benefits SET state = 'accepted', customer_accepted_at = ? WHERE claim_id = ? AND state = 'quoted' AND version = ?").bind(now, claim.id, version),
        ...(await auditStatements(db, user.id, 'warranty.care_quote_accepted', claim.id, { version, copay_iqd: benefit.copay_iqd })).statements,
      ],
      () => careRefusal('CARE_QUOTE_CHANGED')
    );
    const after = await careBenefitOf(db, claim.id);
    return c.json({ success: true, quote: careQuotePublic(after, (await entitlementAtFiling(db, claim))?.terms ?? null) });
  });

  // ------------------------------------------------------------ money: approve / void
  r.post('/admin/claims/:id/care-approve', requireMoneyAuthority('care_claim_decision'), async (c) => {
    const db = c.env.DB;
    await requireInstalled(db);
    const admin = c.get('user')!;
    const body = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
    const reason = reasonOf(body.reason);
    const claim = await claimHead(db, c.req.param('id'));
    const stage = effectiveClaimStage(claim.stage, claim.status);
    if (!(OPEN_FOR_QUOTE as readonly string[]).includes(stage)) throw careRefusal('CARE_CLAIM_NOT_OPEN');
    const benefit = await careBenefitOf(db, claim.id);
    if (!benefit || benefit.state === 'void') throw careRefusal('CARE_QUOTE_CHANGED');
    if (benefit.state === 'approved') throw careRefusal('CARE_ALREADY_APPROVED');
    if (benefit.state !== 'accepted') throw careRefusal('CARE_QUOTE_NOT_ACCEPTED');
    const version = Number(body.version);
    if (!Number.isInteger(version) || version !== benefit.version) throw careRefusal('CARE_QUOTE_CHANGED');
    const ent = await entitlementAtFiling(db, claim);
    if (!ent || ent.state !== 'active' || !ent.terms) {
      throw ent?.state === 'terms_missing' ? careRefusal('CARE_TERMS_MISSING') : careRefusal('CARE_NOT_ACTIVE', 409, { state: ent?.state ?? 'none' });
    }
    // Approving gives the claimant the shop's money: an admin who IS the claimant leaves it to the owner.
    const authority = assertMoneyAuthority(c, { act: 'care_claim_decision', amountIqd: benefit.benefit_iqd, beneficiaryUserId: claim.user_id, reason });
    const now = new Date().toISOString();
    const cap = ent.terms.max_benefit_iqd ?? null;
    const used = (alias: string, what: string) =>
      `(SELECT ${what} FROM care_claim_benefits ${alias} WHERE ${alias}.entitlement_unit_id = ? AND ${alias}.state = 'approved')`;
    // THE CAPS, RE-CHECKED IN THE WRITE: two approvals racing on one device cannot both pass.
    const statements: D1PreparedStatement[] = [
      ...fence(
        db,
        `${used('b1', 'COUNT(*)')} < ?
          AND (? IS NULL OR ${used('b2', 'COALESCE(SUM(b2.benefit_iqd), 0)')} + ? <= ?)
          AND EXISTS (SELECT 1 FROM care_claim_benefits WHERE claim_id = ? AND state = 'accepted' AND version = ?)
          AND EXISTS (SELECT 1 FROM warranty_claims wc WHERE wc.id = ? AND ${effectiveClaimStageSql('wc')} IN ('received','diagnosing'))`,
        [ent.root_unit_id, ent.terms.max_claims, cap, ent.root_unit_id, benefit.benefit_iqd, cap, claim.id, version, claim.id]
      ),
      db
        .prepare("UPDATE care_claim_benefits SET state = 'approved', decided_by = ?, decided_at = ?, decided_day = ? WHERE claim_id = ? AND state = 'accepted' AND version = ?")
        .bind(admin.id, now, baghdadDay(new Date(now)), claim.id, version),
      db
        .prepare(
          `UPDATE warranty_claims SET stage = 'approved', status = ?, decision = 'repair', decision_reason = ?, assigned_staff = ?, admin_note = ?, claim_kind = 'care'
            WHERE id = ?`
        )
        .bind(stageToLegacyStatus('approved'), reason, admin.id, reason, claim.id),
      ...(await auditStatements(db, admin.id, 'warranty.care_approved', claim.id, {
        from: stage, to: 'approved', benefit_iqd: benefit.benefit_iqd, copay_iqd: benefit.copay_iqd, list_iqd: benefit.list_iqd,
        entitlement_unit_id: ent.root_unit_id, reason, authority: authority.audit,
      })).statements,
    ];
    await runFenced(db, statements, () => careRefusal('CARE_QUOTE_CHANGED', 409, { claims_left: ent.claims_left, benefit_left_iqd: ent.benefit_left_iqd }));
    if (claim.user_id !== admin.id) afterResponse(c, notifyClaimStage(c.env, claim.id, 'approved', { at: now, reason }));
    return c.json(await carePanel(c, claim.id));
  });

  r.post('/admin/claims/:id/care-void', requireMoneyAuthority('care_claim_decision'), async (c) => {
    const db = c.env.DB;
    await requireInstalled(db);
    const admin = c.get('user')!;
    const body = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
    const reason = reasonOf(body.reason);
    const claim = await claimHead(db, c.req.param('id'));
    const benefit = await careBenefitOf(db, claim.id);
    if (!benefit) throw notFound('No Levo Care quote on this claim');
    if (benefit.state === 'void') return c.json({ ...(await carePanel(c, claim.id)), already: true });
    if (benefit.copay_collected_at) throw careRefusal('CARE_COPAY_COLLECTED');
    const stage = effectiveClaimStage(claim.stage, claim.status);
    if (stage === 'resolved' || stage === 'replaced') throw careRefusal('CARE_VOID_TOO_LATE');
    const authority = assertMoneyAuthority(c, { act: 'care_claim_decision', reason });
    const now = new Date().toISOString();
    /**
     * A claim is warranty OR Care, never both (owner ruling): with its Care voided it is no longer a Care
     * claim (claim_kind back to NULL = warranty), so the desk can decide it as an ordinary warranty claim.
     * An APPROVED benefit also took the claim's decision (care-approve: stage approved, decision repair):
     * voiding it hands the claim back to diagnosis with no decision — in the same batch, and only while
     * no co-pay was collected (the fence; the trigger refuses it too).
     */
    const undoApproval = benefit.state === 'approved' && (stage === 'approved' || stage === 'repairing');
    await runFenced(
      db,
      [
        ...fence(
          db,
          `EXISTS (SELECT 1 FROM care_claim_benefits WHERE claim_id = ? AND state = ? AND version = ? AND copay_collected_at IS NULL)
            AND EXISTS (SELECT 1 FROM warranty_claims wc WHERE wc.id = ? AND ${effectiveClaimStageSql('wc')} = ?)`,
          [claim.id, benefit.state, benefit.version, claim.id, stage]
        ),
        db.prepare("UPDATE care_claim_benefits SET state = 'void', voided_at = ?, voided_by = ?, void_reason = ? WHERE claim_id = ? AND state = ? AND copay_collected_at IS NULL").bind(now, admin.id, reason, claim.id, benefit.state),
        undoApproval
          ? db
              .prepare(
                `UPDATE warranty_claims SET stage = 'diagnosing', status = ?, decision = NULL, decision_reason = NULL, assigned_staff = ?, admin_note = ?, claim_kind = NULL
                  WHERE id = ?`
              )
              .bind(stageToLegacyStatus('diagnosing'), admin.id, reason, claim.id)
          : db.prepare('UPDATE warranty_claims SET claim_kind = NULL WHERE id = ?').bind(claim.id),
        ...(await auditStatements(db, admin.id, 'warranty.care_voided', claim.id, {
          from_state: benefit.state, benefit_iqd: benefit.benefit_iqd, reason, authority: authority.audit,
          ...(undoApproval ? { stage_from: stage, stage_to: 'diagnosing' } : {}),
        })).statements,
      ],
      () => careRefusal('CARE_QUOTE_CHANGED')
    );
    if (undoApproval && claim.user_id !== admin.id) afterResponse(c, notifyClaimStage(c.env, claim.id, 'diagnosing', { at: now, reason }));
    return c.json(await carePanel(c, claim.id));
  });

  // ------------------------------------------------------------ money: the co-pay collected
  r.post('/admin/claims/:id/care-copay', requireMoneyAuthority('service_claim_cost'), async (c) => {
    const db = c.env.DB;
    await requireInstalled(db);
    const admin = c.get('user')!;
    const body = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
    const operationId = str(body.operation_id, 'operation_id', { min: 8, max: 100 });
    const claim = await claimHead(db, c.req.param('id'));
    const benefit = await careBenefitOf(db, claim.id);
    if (benefit?.copay_collected_at) {
      if (benefit.copay_operation_id === operationId) return c.json({ ...(await carePanel(c, claim.id)), already: true });
      throw careRefusal('CARE_COPAY_COLLECTED');
    }
    // A rejected claim takes no co-pay (rejecting voids its Care; an older row may still read approved).
    const stage = effectiveClaimStage(claim.stage, claim.status);
    if (stage === 'rejected') throw careRefusal('CARE_COPAY_CLAIM_REJECTED');
    if (!benefit || benefit.state !== 'approved' || !(benefit.copay_iqd > 0)) throw careRefusal('CARE_NO_COPAY');
    // The operation id is the click's own key: one already spent on another claim's co-pay is refused, not a 500.
    if (await db.prepare('SELECT 1 AS x FROM care_claim_benefits WHERE copay_operation_id = ? AND claim_id <> ?').bind(operationId, claim.id).first()) {
      throw careRefusal('CLAIM_COST_OPERATION_REUSED');
    }
    const day = dateValue(body.day, baghdadDay());
    if (day > baghdadDay()) throw careRefusal('CLAIM_COST_DAY_FUTURE', 400);
    await periodOpen(db, day);
    const authority = assertMoneyAuthority(c, { act: 'service_claim_cost', amountIqd: benefit.copay_iqd });
    const now = new Date().toISOString();
    // The co-pay is SERVICE INCOME (owner ruling D2): cash in, account 4300 — never the order's revenue.
    const journal = (await operationsInstalled(db))
      ? journalPlan(
          db,
          { key: `care-copay:${claim.id}`, day, title: `مساهمة ليفو كير — مطالبة ${claim.id}`, source: 'care_copay', sourceId: claim.id, actor: admin.id },
          [
            { account: '1000', debit: benefit.copay_iqd },
            { account: SERVICE_INCOME_ACCOUNT.code, credit: benefit.copay_iqd },
          ]
        ).statements
      : [];
    await runFenced(
      db,
      [
        ...fence(
          db,
          `EXISTS (SELECT 1 FROM care_claim_benefits WHERE claim_id = ? AND state = 'approved' AND copay_collected_at IS NULL)
            AND EXISTS (SELECT 1 FROM warranty_claims wc WHERE wc.id = ? AND ${effectiveClaimStageSql('wc')} <> 'rejected')`,
          [claim.id, claim.id]
        ),
        db
          .prepare(
            `UPDATE care_claim_benefits SET copay_collected_at = ?, copay_collected_by = ?, copay_collected_day = ?, copay_operation_id = ?
              WHERE claim_id = ? AND state = 'approved' AND copay_collected_at IS NULL`
          )
          .bind(now, admin.id, day, operationId, claim.id),
        ...journal,
        ...(await auditStatements(db, admin.id, 'warranty.care_copay_collected', claim.id, {
          copay_iqd: benefit.copay_iqd, day, operation_id: operationId, authority: authority.audit,
        })).statements,
      ],
      () => careRefusal('CARE_COPAY_COLLECTED'),
      // Two clicks racing with one operation id on two claims: the second meets the UNIQUE key.
      (e) => (/UNIQUE constraint failed: care_claim_benefits\.copay_operation_id/.test(e) ? careRefusal('CLAIM_COST_OPERATION_REUSED') : null)
    );
    return c.json(await carePanel(c, claim.id));
  });

  // ------------------------------------------------------------ money: what a claim cost the shop
  r.post('/admin/claims/:id/costs', requireMoneyAuthority('service_claim_cost'), async (c) => {
    const db = c.env.DB;
    await requireInstalled(db);
    const admin = c.get('user')!;
    const body = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
    const operationId = str(body.operation_id, 'operation_id', { min: 8, max: 100 });
    const claim = await claimHead(db, c.req.param('id'));
    const kind = String(body.kind ?? '') as ClaimCostKind;
    if (!(CLAIM_COST_KINDS as readonly string[]).includes(kind)) throw badRequest(`kind must be one of: ${CLAIM_COST_KINDS.join(', ')}`, 'CLAIM_COST_INVALID');
    const amount = whole(body.amount_iqd, 'amount_iqd', 1, 1_000_000_000);
    const day = dateValue(body.cost_day, baghdadDay());
    if (day > baghdadDay()) throw careRefusal('CLAIM_COST_DAY_FUTURE', 400);
    const note = typeof body.note === 'string' ? body.note.trim().slice(0, 500) : '';
    const prior = await db.prepare('SELECT * FROM service_claim_costs WHERE operation_id = ?').bind(operationId).first<ServiceClaimCostRow>();
    if (prior) {
      if (prior.claim_id === claim.id && prior.kind === kind && Number(prior.amount_iqd) === amount && prior.created_by === admin.id) {
        return c.json({ ...(await carePanel(c, claim.id)), already: true, cost: claimCostPublic(prior) });
      }
      throw careRefusal('CLAIM_COST_OPERATION_REUSED');
    }
    await periodOpen(db, day);
    const authority = assertMoneyAuthority(c, { act: 'service_claim_cost', amountIqd: amount });
    const claimKind: 'warranty' | 'care' = claim.claim_kind === 'care' ? 'care' : 'warranty';
    const now = new Date().toISOString();
    const expenseId = newId('expense');
    const costId = newId('scc');
    const title = `${claimKind === 'care' ? 'مطالبة ليفو كير' : 'مطالبة ضمان'} ${claim.id} — ${CLAIM_COST_KIND_TEXT[kind].ar}`;
    // A GENERAL expense of its cost day (owner ruling): no order link, so no order's profit — and no
    // investor's or staff member's share — ever moves.
    const statements: D1PreparedStatement[] = [
      db
        .prepare('INSERT INTO operating_expenses (id, category_id, amount_iqd, expense_day, title, note, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .bind(expenseId, CLAIM_COST_CATEGORY[claimKind], amount, day, title.slice(0, 200), note, admin.id, now, now),
      ...(await planExpenseAccounting(db, { id: expenseId, actor: admin.id, title, day, amount, fresh: true })),
      db
        .prepare(
          `INSERT INTO service_claim_costs (id, claim_id, claim_kind, kind, amount_iqd, cost_day, expense_id, operation_id, note, created_by, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(costId, claim.id, claimKind, kind, amount, day, expenseId, operationId, note, admin.id, now),
      ...(await auditStatements(db, admin.id, 'warranty.claim_cost_added', claim.id, {
        cost_id: costId, kind, amount_iqd: amount, cost_day: day, claim_kind: claimKind, expense_id: expenseId, authority: authority.audit,
      })).statements,
    ];
    try {
      await db.batch(statements);
    } catch (e) {
      if (/UNIQUE constraint/.test(String((e as Error)?.message ?? e))) throw careRefusal('CLAIM_COST_OPERATION_REUSED');
      throw e;
    }
    const cost = await db.prepare('SELECT * FROM service_claim_costs WHERE id = ?').bind(costId).first<ServiceClaimCostRow>();
    return c.json({ ...(await carePanel(c, claim.id)), cost: cost ? claimCostPublic(cost) : null });
  });

  r.post('/admin/claims/:id/costs/:costId/void', requireMoneyAuthority('service_claim_cost'), async (c) => {
    const db = c.env.DB;
    await requireInstalled(db);
    const admin = c.get('user')!;
    const body = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
    const reason = reasonOf(body.reason);
    const claimId = c.req.param('id');
    const cost = await db.prepare('SELECT * FROM service_claim_costs WHERE id = ? AND claim_id = ?').bind(c.req.param('costId'), claimId).first<ServiceClaimCostRow>();
    if (!cost) throw notFound('Cost not found');
    if (cost.voided_at) return c.json({ ...(await carePanel(c, claimId)), already: true });
    await periodOpen(db, cost.cost_day);
    const authority = assertMoneyAuthority(c, { act: 'service_claim_cost', amountIqd: Number(cost.amount_iqd) });
    const now = new Date().toISOString();
    const title = `مطالبة ${claimId} — ${CLAIM_COST_KIND_TEXT[cost.kind]?.ar ?? cost.kind}`;
    await runFenced(
      db,
      [
        ...fence(db, 'EXISTS (SELECT 1 FROM service_claim_costs WHERE id = ? AND voided_at IS NULL)', [cost.id]),
        db.prepare('UPDATE service_claim_costs SET voided_at = ?, voided_by = ?, void_reason = ? WHERE id = ? AND voided_at IS NULL').bind(now, admin.id, reason, cost.id),
        db.prepare('UPDATE operating_expenses SET voided_at = ?, voided_by = ?, void_reason = ?, updated_at = ? WHERE id = ?').bind(now, admin.id, reason, now, cost.expense_id),
        ...(await planExpenseAccounting(db, { id: cost.expense_id, actor: admin.id, title, day: cost.cost_day, amount: Number(cost.amount_iqd), void: true })),
        ...(await auditStatements(db, admin.id, 'warranty.claim_cost_voided', claimId, {
          cost_id: cost.id, amount_iqd: cost.amount_iqd, cost_day: cost.cost_day, reason, authority: authority.audit,
        })).statements,
      ],
      () => notFound('Cost not found')
    );
    return c.json(await carePanel(c, claimId));
  });
}

/**
 * Asked by PATCH /admin/claims/:id before a move to `approved` (CARE_APPROVAL_REQUIRED): does the claim carry a
 * LIVE Care quote (quoted / accepted — not void, not yet approved)? Then it is accepted only through care-approve.
 * A claim whose Care was voided is an ordinary warranty claim again (a claim is warranty OR Care, never both).
 * False before 0236.
 */
export async function careApprovalPending(db: D1Database, claimId: string): Promise<boolean> {
  if (!(await careClaimsInstalled(db))) return false;
  const b = await db
    .prepare("SELECT 1 AS x FROM care_claim_benefits WHERE claim_id = ? AND state IN ('quoted', 'accepted')")
    .bind(claimId)
    .first<{ x: number }>();
  return !!b;
}

/**
 * A move to `rejected` (PATCH /admin/claims/:id) takes the claim's live Care with it: the benefit is voided and the
 * claim is no longer a Care claim, in the SAME batch as the stage move — fenced on «no co-pay collected» (the money
 * the customer paid for that Care stays with an approved benefit: CARE_REJECT_COPAY_COLLECTED). Returns the
 * statements to run after the claim's own UPDATE (each conditional on the claim now being rejected), or [] when the
 * claim carries no live Care / the database has no 0236.
 */
export async function careVoidOnReject(
  db: D1Database,
  claimId: string,
  actor: string,
  reason: string
): Promise<D1PreparedStatement[]> {
  if (!(await careClaimsInstalled(db))) return [];
  const benefit = await careBenefitOf(db, claimId);
  if (!benefit || benefit.state === 'void') return [];
  if (benefit.copay_collected_at) throw careRefusal('CARE_REJECT_COPAY_COLLECTED');
  const now = new Date().toISOString();
  const rejected = `EXISTS (SELECT 1 FROM warranty_claims wc WHERE wc.id = ? AND ${effectiveClaimStageSql('wc')} = 'rejected')`;
  return [
    db
      .prepare(
        `UPDATE care_claim_benefits SET state = 'void', voided_at = ?, voided_by = ?, void_reason = ?
          WHERE claim_id = ? AND state <> 'void' AND copay_collected_at IS NULL AND ${rejected}`
      )
      .bind(now, actor, reason, claimId, claimId),
    db.prepare(`UPDATE warranty_claims SET claim_kind = NULL WHERE id = ? AND ${rejected}`).bind(claimId, claimId),
    // The co-pay collected between the read above and this batch: nothing moves (the claim's UPDATE rolls back too).
    ...fence(db, 'NOT EXISTS (SELECT 1 FROM care_claim_benefits WHERE claim_id = ? AND copay_collected_at IS NOT NULL)', [claimId]),
    ...(await auditStatements(db, actor, 'warranty.care_voided', claimId, {
      from_state: benefit.state, benefit_iqd: benefit.benefit_iqd, reason, on: 'claim_rejected',
    })).statements,
  ];
}

export type { CareBenefitRow };
