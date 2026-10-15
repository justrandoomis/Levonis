/**
 * «استلام الجهاز» — THE DEVICE REACHES THE SHOP (owner decision 2, «الجهاز أولاً»;
 * Services S-P2 spec §6.5, §6.17-B; DECISIONS row 238).
 *
 * The old «inspect» step, done for real. Any admin may record it — an assistant
 * included: no money moves at intake — except on their OWN request (four eyes,
 * TRADE_IN_OWN_REQUEST). The desk scans the serial, reads the hours off the
 * screen, records the condition, the findings and the handover, and the server:
 *
 *   - checks the serial against the slot's LIVE unit (`liveUnitOfSlot` →
 *     `device_serials.serial_norm`): match / mismatch (refused unless the OWNER
 *     records why) / unrecorded (accepted and flagged: approving it is the
 *     owner's) / not_applicable (an AMS on its own);
 *   - flags hours above what the customer declared beyond the policy's
 *     tolerance (max(+10 %, +50 h) by default);
 *   - recomputes the CEILING = min(the reference figure, the formula on the
 *     intake facts and TODAY's prices) — the most a financial admin may fix;
 *   - re-values a credit minted on photos before S-P2 (cut-over): the same
 *     coupon gets a fresh 7-day end when the ceiling covers it, else the
 *     request goes back to the customer at the ceiling (the coupon switched
 *     off until they accept — the one row for life, row 237).
 *
 * ONE BATCH, fenced: the conditional UPDATE (`intake_at IS NULL`, and 0192's
 * `trg_trade_in_intake_once` behind it), the token fence, the one-money-process
 * fence, the intake answers, the owner's valuation row, the cut-over moves,
 * the event, the customer's notice and the audit row.
 */
import type { Env } from './types';
import { safeParse } from './types';
import { randomToken } from './crypto';
import { notifyStatement } from './notifications';
import { auditStatements } from './audit';
import { sanitizeUserText } from './walletNotify';
import { getSetting } from './settings';
import { liveUnitOfSlot } from './deviceCustody';
import { offerFor, valuationStatement } from './tradeInOffer';
import { tradeInV2Installed } from './tradeInSchema';
import {
  creditOrders,
  eventStatement,
  fence,
  iqdText,
  isAbort,
  loadComponents,
  loadRequest,
  loadRuleBook,
  referenceOf,
  refuse,
  requestPath,
  resolveUnit,
  serviceBlocker,
  serviceFence,
  slotOf,
  type RequestRow,
} from './tradeIn';
import { validateInputs, type ComponentInputs, type ComponentRole } from '@levonis/pricing/tradeIn';
import { normalizeSerial } from '@levonis/catalog/deviceSerials';

export type SerialMatch = 'match' | 'mismatch' | 'unrecorded' | 'not_applicable';

export interface IntakeInput {
  serial: string;
  hours: number | null;
  components: Partial<Record<ComponentRole, unknown>>;
  findings: string;
  handover: 'store' | 'pickup';
  /** The owner's reason for receiving a device whose serial does not match the unit sold. */
  serialOverrideReason: string | null;
  /**
   * Asked ONLY when the serial does not match and a reason was sent: throws unless the caller is the
   * owner (moneyAuthority act `trade_in_serial_override`). A matching serial never asks, so a desk
   * that sends a reason by mistake is not refused for it.
   */
  authorizeSerialOverride?: (reason: string) => void;
}

/** Statuses a device may be received in (§6.5): sent; legacy «inspected», proposed or credited without intake. */
const RECEIVABLE = new Set(['submitted', 'under_review', 'value_changed', 'awaiting_payment', 'completed']);

/** The serial the shop has on record for the slot's live device, or null (none recorded). */
export async function recordedSerial(db: D1Database, req: Pick<RequestRow, 'order_item_id' | 'unit_index'>): Promise<string | null> {
  const unit = await liveUnitOfSlot<{ id: string; replaced_by_unit_id: string | null }>(db, req.order_item_id, req.unit_index, 'u.id');
  if (!unit) return null;
  const row = await db.prepare('SELECT serial_norm FROM device_serials WHERE unit_id = ?').bind(unit.id).first<{ serial_norm: string }>();
  return row?.serial_norm ? String(row.serial_norm) : null;
}

export interface IntakeOutcome {
  request: RequestRow;
  /** A credit fixed on photos before S-P2 went back to the customer at the lower ceiling (the value prompt follows). */
  revalued: boolean;
}

export async function intakeRequest(env: Env, req: RequestRow, admin: { id: string }, input: IntakeInput): Promise<IntakeOutcome> {
  const db = env.DB;
  if (!(await tradeInV2Installed(db))) throw refuse('TRADE_IN_BAD_STATE', { status: req.status });
  if (req.user_id === admin.id) throw refuse('TRADE_IN_OWN_REQUEST');
  if (req.intake_at) throw refuse('TRADE_IN_ALREADY_RECEIVED');
  if (!RECEIVABLE.has(req.status)) throw refuse('TRADE_IN_BAD_STATE', { status: req.status });
  const nowIso = new Date().toISOString();
  // §16 D-3: no grace — an offer past its end is gone (the sweep cancels it); a credit already fixed is not an offer.
  if (req.offer_expires_at && Date.parse(req.offer_expires_at) < Date.parse(nowIso) && req.status !== 'awaiting_payment' && req.status !== 'completed') {
    throw refuse('TRADE_IN_OFFER_EXPIRED');
  }
  // A legacy credit already spent on a live order (cut-over, §7): the device is received and the
  // facts recorded, but money that moved is not re-valued — the delivery completes it.
  const orders = req.status === 'awaiting_payment' ? await creditOrders(db, req.id) : [];
  const spent = orders.some((o) => o.status !== 'cancelled');

  const [comps, book, policy, slot] = await Promise.all([loadComponents(db, req.id), loadRuleBook(db), getSetting(db, 'tradeInPolicy'), slotOf(db, req.order_item_id, req.unit_index)]);

  // ---- the serial
  const scanned = normalizeSerial(input.serial ?? '').slice(0, 64);
  const recorded = req.scope === 'ams_only' ? null : await recordedSerial(db, req);
  if (req.scope !== 'ams_only' && !scanned) throw refuse('TRADE_IN_INPUTS_INVALID', { errors: { serial: ['serial'] } });
  const match: SerialMatch = req.scope === 'ams_only' ? 'not_applicable' : recorded === null ? 'unrecorded' : scanned === recorded ? 'match' : 'mismatch';
  const override = match === 'mismatch' && policy.require_serial_match ? (input.serialOverrideReason ?? '').trim() : '';
  if (match === 'mismatch' && policy.require_serial_match) {
    if (!override) throw refuse('TRADE_IN_SERIAL_MISMATCH');
    // The owner's alone (decision 3, act `trade_in_serial_override`), recorded and flagged.
    if (!input.authorizeSerialOverride) throw refuse('TRADE_IN_SERIAL_MISMATCH');
    input.authorizeSerialOverride(override);
  }

  // ---- the condition, as the desk records it
  const errors: Record<string, string[]> = {};
  const inputs = new Map<ComponentRole, ComponentInputs>();
  for (const c of comps) {
    // The desk confirms or corrects the customer's answers: what it sends replaces those keys, the rest stand.
    const sent = input.components[c.role];
    const rawIn = {
      ...safeParse<Record<string, unknown>>(c.inputs_json, {}),
      ...(typeof sent === 'object' && sent !== null && !Array.isArray(sent) ? (sent as Record<string, unknown>) : {}),
    };
    const withHours = c.role === 'device' && input.hours !== null && input.hours !== undefined ? { ...rawIn, hours: input.hours } : rawIn;
    const checked = validateInputs(withHours, book[c.family]);
    if (!checked.ok) errors[c.role] = checked.errors;
    else inputs.set(c.role, checked.value);
  }
  if (Object.keys(errors).length) throw refuse('TRADE_IN_INPUTS_INVALID', { errors });
  const deviceComp = comps.find((c) => c.role === 'device');
  const declaredChecked = deviceComp ? validateInputs(safeParse(deviceComp.inputs_json, {}), book[deviceComp.family]) : null;
  const declared = declaredChecked && declaredChecked.ok ? declaredChecked.value.hours : null;
  const seen = deviceComp ? inputs.get('device')?.hours ?? null : null;
  const tolerance = declared !== null ? Math.max(Math.ceil((declared * policy.hours_tolerance_pct) / 100), policy.hours_tolerance_abs) : 0;
  const hoursFlag = declared !== null && seen !== null && seen > declared + tolerance;

  // ---- the ceiling: min(the reference, the formula on the intake facts and today's prices)
  const unit = await resolveUnit(env, req.user_id, req.order_item_id, req.unit_index, nowIso);
  const o = await offerFor(env, {
    req,
    unit,
    comps,
    book,
    phase: 'intake',
    inputsOf: (c) => inputs.get(c.role)!,
    slotUnitIds: slot.unitIds,
    nowIso,
  });
  const reference = referenceOf(req);
  const ceiling = Math.max(0, Math.min(reference, o.offer_iqd ?? 0));
  const handover = input.handover;
  const pickupFee = handover === 'pickup' ? policy.pickup_fee_iqd : 0;
  const findings = sanitizeUserText(String(input.findings ?? ''), { max: 1000, singleLine: false });
  const intakeJson = JSON.stringify({
    hours_declared: declared,
    hours_seen: seen,
    hours_flag: hoursFlag,
    findings,
    serial_override: !!override,
    by: admin.id,
  });

  // ---- the cut-over: a credit minted on photos before S-P2
  const legacyCredit = req.status === 'awaiting_payment' && !spent;
  const revalueDown = legacyCredit && ceiling < (req.final_value_iqd ?? 0);
  const nextStatus = req.status === 'submitted' || req.status === 'under_review' ? 'under_review' : revalueDown ? 'value_changed' : req.status;
  const creditEnds = new Date(Date.parse(nowIso) + policy.credit_valid_days * 86_400_000).toISOString();
  const token = randomToken(12);
  const offerNo = revalueDown ? req.offer_no + 1 : req.offer_no;
  const reason = 'بعد فحص الجهاز في المتجر';

  const stmts: D1PreparedStatement[] = [
    db
      .prepare(
        `UPDATE trade_in_requests
            SET intake_at = ?2, intake_by = ?3, intake_serial_norm = ?4, intake_serial_match = ?5, intake_json = ?6,
                handover = ?7, pickup_fee_iqd = ?8, ceiling_iqd = ?9, ceiling_at = ?2, inspected_at = COALESCE(inspected_at, ?2),
                status = ?10, updated_at = ?2, decision_token = ?11,
                admin_value_iqd = CASE WHEN ?12 = 1 THEN ?9 ELSE admin_value_iqd END,
                admin_reason = CASE WHEN ?12 = 1 THEN ?13 ELSE admin_reason END,
                offer_no = ?14, valued_at = CASE WHEN ?12 = 1 THEN ?2 ELSE valued_at END,
                tg_chat_id = CASE WHEN ?12 = 1 THEN NULL ELSE tg_chat_id END,
                tg_message_id = CASE WHEN ?12 = 1 THEN NULL ELSE tg_message_id END
          WHERE id = ?1 AND status = ?15 AND intake_at IS NULL`
      )
      .bind(req.id, nowIso, admin.id, scanned || null, match, intakeJson, handover, pickupFee, ceiling, nextStatus, token, revalueDown ? 1 : 0, reason, offerNo, req.status),
    fence(db, req.id, token),
    serviceFence(db, req.id, slot),
    ...comps.map((c) =>
      db.prepare('UPDATE trade_in_components SET intake_inputs_json = ?1 WHERE request_id = ?2 AND role = ?3').bind(JSON.stringify(inputs.get(c.role)), req.id, c.role)
    ),
    valuationStatement(db, req.id, { ...o.owner, phase: 'intake', ceiling_iqd: ceiling }, admin.id, nowIso),
  ];
  if (legacyCredit && req.coupon_id) {
    stmts.push(
      revalueDown
        ? db.prepare('UPDATE coupons SET active = 0 WHERE id = ?1 AND trade_in_id = ?2').bind(req.coupon_id, req.id)
        : // The one coupon for life gets a fresh week from the day the device was received (never shorter).
          db
            .prepare('UPDATE coupons SET ends_at = CASE WHEN ends_at IS NULL OR ends_at < ?3 THEN ?3 ELSE ends_at END WHERE id = ?1 AND trade_in_id = ?2')
            .bind(req.coupon_id, req.id, creditEnds)
    );
  }
  stmts.push(
    eventStatement(db, req.id, { id: admin.id, role: 'admin' }, 'intake', req.status, nextStatus, { serial_match: match, hours_flag: hoursFlag, handover }, nowIso)
  );
  if (revalueDown) {
    stmts.push(
      eventStatement(db, req.id, { id: admin.id, role: 'admin' }, 'change_value', req.status, 'value_changed', { value_iqd: ceiling, reason, offer_no: offerNo }, nowIso),
      notifyStatement(db, {
        userId: req.user_id,
        kind: 'trade_in',
        title_ar: 'قيمة جديدة لجهازك — مطلوب موافقتك',
        title_en: 'A new value for your device — your decision is needed',
        body_ar: `${iqdText(req.final_value_iqd ?? 0, 'ar')} ← ${iqdText(ceiling, 'ar')} — ${reason}.`,
        body_en: `${iqdText(req.final_value_iqd ?? 0, 'en')} → ${iqdText(ceiling, 'en')} — after the device was inspected at the store.`,
        meta: {
          offer_no: offerNo,
          title_ckb: 'بەهایەکی نوێ بۆ ئامێرەکەت — پێویستە بڕیار بدەیت',
          body_ckb: `${iqdText(req.final_value_iqd ?? 0, 'ckb')} ← ${iqdText(ceiling, 'ckb')} — دوای پشکنینی ئامێرەکە لە فرۆشگا.`,
        },
        link: requestPath(req.id),
        entity_type: 'trade_in',
        entity_id: req.id,
        eventKey: `trade_in:${req.id}:offer:${offerNo}`,
      }).stmt
    );
  }
  stmts.push(
    notifyStatement(db, {
      userId: req.user_id,
      kind: 'trade_in',
      title_ar: match === 'match' ? 'استلمنا جهازك وطابق رقمه التسلسلي' : 'استلمنا جهازك',
      title_en: match === 'match' ? 'We received your device and its serial matches' : 'We received your device',
      meta: { title_ckb: match === 'match' ? 'ئامێرەکەتمان وەرگرت و ژمارە زنجیرەییەکەی گونجا' : 'ئامێرەکەتمان وەرگرت' },
      link: requestPath(req.id),
      entity_type: 'trade_in',
      entity_id: req.id,
      eventKey: `trade_in:${req.id}:received`,
    }).stmt,
    ...(
      await auditStatements(db, admin.id, 'trade_in.intake', req.id, {
        serial_match: match,
        hours_flag: hoursFlag,
        ceiling_iqd: ceiling,
        ...(override ? { serial_override_reason: override } : {}),
        ...(revalueDown ? { revalued_to_iqd: ceiling } : {}),
      })
    ).statements
  );
  try {
    await db.batch(stmts);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/TRADE_IN_ALREADY_RECEIVED/.test(msg)) throw refuse('TRADE_IN_ALREADY_RECEIVED');
    if (isAbort(e)) {
      const again = await loadRequest(db, req.id);
      if (again?.intake_at) throw refuse('TRADE_IN_ALREADY_RECEIVED');
      throw refuse((await serviceBlocker(db, slot)) ?? 'TRADE_IN_STALE');
    }
    throw e;
  }
  return { request: (await loadRequest(db, req.id))!, revalued: revalueDown };
}

/**
 * «أُعيد الجهاز للزبون» — a received device handed back after the request was
 * cancelled or declined (§6.5): any admin, once. Moves no money.
 */
export async function deviceReturned(env: Env, req: RequestRow, adminId: string): Promise<RequestRow> {
  const db = env.DB;
  if (!(await tradeInV2Installed(db))) throw refuse('TRADE_IN_BAD_STATE', { status: req.status });
  if (!((req.status === 'cancelled' || req.status === 'customer_rejected') && req.intake_at && !req.device_returned_at)) {
    throw refuse('TRADE_IN_BAD_STATE', { status: req.status });
  }
  const now = new Date().toISOString();
  const res = await db
    .prepare(
      `UPDATE trade_in_requests SET device_returned_at = ?2, device_returned_by = ?3, updated_at = ?2
        WHERE id = ?1 AND status IN ('cancelled','customer_rejected') AND intake_at IS NOT NULL AND device_returned_at IS NULL`
    )
    .bind(req.id, now, adminId)
    .run();
  if (!res.meta?.changes) throw refuse('TRADE_IN_STALE');
  await db.batch([
    eventStatement(db, req.id, { id: adminId, role: 'admin' }, 'device_returned', req.status, req.status, {}, now),
    ...(await auditStatements(db, adminId, 'trade_in.device_returned', req.id, {})).statements,
  ]);
  return (await loadRequest(db, req.id))!;
}
