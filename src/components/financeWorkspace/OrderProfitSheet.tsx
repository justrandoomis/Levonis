import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { Check, Clock3, Pencil, Package, ShieldCheck } from 'lucide-react';
import { api } from '../../lib/api';
import { useLanguage } from '../../LanguageContext';
import { useFreshOnReturn } from '../../lib/useFreshOnReturn';
import { Button, Field, Loading, Money, Row, Sheet, Status, Surface, formatMoney } from './ui';
import { financeDay, monthRange, statusName, WORKSPACE_API, type OrderProfit, type ProfitLine, type ProfitCost, type ProfitReviewIssue } from './types';
import { hasPendingWagesWithConfirmedCosts, displayedCostAmount, groupOrderCosts } from './orderCostGroups';
import { orderFinancePresentation, projectedLineCost, visibleOrderReviewReasons } from './orderFinancePresentation';
import { PA_STRINGS, tri } from './displayCurrencyStrings';
import ReportDeductions from './ReportDeductions';
import { DisplayMoney, UsdBasisNote, centsAt, useDisplayCurrency } from './displayCurrency';

const FinanceOperationsPanel = lazy(() => import('../adminOperations/FinanceOperationsPanel'));

type EditableField = 'net_goods_iqd' | 'cogs_iqd' | 'shipping_iqd' | 'cod_tax_iqd' | 'courier_fee_iqd' | 'payment_fee_iqd' | 'manual_direct_iqd' | 'staff_cost';
type Edit = { field: EditableField; label: string; line_id?: string; cost_id?: string; value: string };

export default function OrderProfitSheet({ orderId, onClose, onChanged }: {
  orderId: string; onClose: () => void; onChanged: () => void;
}) {
  const { loc } = useLanguage();
  // «عملة العرض» (design P-A §8): the workspace's choice; display only, edits stay in dinars.
  const currency = useDisplayCurrency();
  const display = currency === 'USD' ? '?display=USD' : '';
  const [data, setData] = useState<OrderProfit | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [edit, setEdit] = useState<Edit | null>(null);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState('');
  const [noticePending, setNoticePending] = useState(false);
  const [revision, setRevision] = useState(0);
  const [advanced, setAdvanced] = useState<'collections' | 'payroll' | null>(null);
  const requestId = useRef<string>(crypto.randomUUID());
  const saveLock = useRef(false);
  const readGeneration = useRef(0);
  const refreshPaused = useRef(false);
  refreshPaused.current = loading || saving || !!edit;
  const verificationIds = useRef(new Map<string, string>());
  const presentationOrder = data && { ...data.order, ...data.totals, has_financial_activity: data.has_financial_activity, projected_finance: data.projected_finance,
    review_reasons: [...data.lines.flatMap(line => line.cost_review?.issues ?? []), ...data.costs.flatMap(cost => cost.review_reasons ?? [])] };
  const view = presentationOrder && orderFinancePresentation(presentationOrder);
  useEffect(() => {
    let active = true;
    const generation = ++readGeneration.current;
    setLoading(true);
    setError('');
    api.get<OrderProfit>(`${WORKSPACE_API}/orders/${encodeURIComponent(orderId)}${display}`)
      .then((r) => { if (active) setData(r); })
      .catch((e) => { if (active) setError(e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; readGeneration.current = generation + 1; };
  }, [orderId, revision, display]);
  useFreshOnReturn(async () => {
    const generation = readGeneration.current;
    const refreshed = await api.get<OrderProfit>(`${WORKSPACE_API}/orders/${encodeURIComponent(orderId)}${display}`, { mascot: 'silent' });
    if (generation !== readGeneration.current || refreshPaused.current) return;
    setData(refreshed); onChanged();
  }, { pollWhileVisibleMs: 30_000, minIntervalMs: 30_000,
    enabled: !!data && data.order.status === 'delivered' && data.costs.some(cost => displayedCostAmount(cost) == null) && !loading && !saving && !edit });
  const beginEdit = useCallback((field: EditableField, label: string, line_id?: string, cost_id?: string) => {
    requestId.current = crypto.randomUUID();
    setNotice('');
    setEdit({ field, label, line_id, cost_id, value: '' });
  }, []);
  const save = async (candidate: Edit | null = edit, operationId = requestId.current) => {
    if (!candidate || saveLock.current || candidate.value.trim() === '') return;
    const value = Number(candidate.value);
    if (!Number.isSafeInteger(value) || value < 0) { setError(loc('أدخل مبلغًا صحيحًا بالدينار', 'Enter a whole IQD amount')); return; }
    saveLock.current = true; setSaving(true); setError('');
    try {
      let reconciliationPending = false;
      let carryforward = 0;
      if (candidate.field === 'staff_cost') {
        const result = await api.patch<{ carryforward_iqd?: number; reconciliation_pending?: boolean }>(`/api/admin/finance-people/costs/${encodeURIComponent(candidate.cost_id!)}`, { amount_iqd: value });
        carryforward = result.carryforward_iqd ?? 0;
        reconciliationPending = result.reconciliation_pending ?? false;
      } else {
        const result = await api.post<{ reconciliation_pending?: boolean }>(`${WORKSPACE_API}/orders/${encodeURIComponent(orderId)}/adjustments`, {
          operation_id: operationId, field: candidate.field, value_iqd: value,
          ...(candidate.line_id ? { line_id: candidate.line_id } : {}), version: data?.version,
        });
        reconciliationPending = result.reconciliation_pending ?? false;
      }
      setNoticePending(reconciliationPending);
      setEdit(null); setNotice(reconciliationPending ? loc('حُفظت القيمة، وتسوية الاستحقاقات ما زالت معلقة. راجع تنبيهات المحاسبة.', 'Value saved; entitlement reconciliation is still pending. Review the accounting alerts.') : carryforward > 0 ? `${loc('حُفظ الأجر، وسيُسوّى المبلغ المدفوع الزائد من الاستحقاقات التالية:', 'Wage saved; the overpayment will be settled from future earnings:')} ${formatMoney(carryforward)}` : loc('تم الحفظ وإعادة حساب الأرباح', 'Saved and profits recalculated'));
      setRevision((v) => v + 1); onChanged();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { saveLock.current = false; setSaving(false); }
  };
  const verifyCost = (line: ProfitLine, total: number) => {
    const key = `${orderId}:${data?.version}:${line.id}:${total}`;
    let operationId = verificationIds.current.get(key);
    if (!operationId) { operationId = crypto.randomUUID(); verificationIds.current.set(key, operationId); }
    void save({ field: 'cogs_iqd', label: loc('تكلفة القطع', 'Goods cost'), line_id: line.id, value: String(total) }, operationId);
  };
  const editor = (lineId?: string) => edit && edit.line_id === lineId && <div className="fw-inline-editor">
    <Field label={edit.label} hint={loc('أدخل القيمة الجديدة فقط. يُحفظ سجل التغيير تلقائيًا.', 'Enter the new value only. History is saved automatically.')}>
      <input className="fw-input" type="number" inputMode="numeric" min="0" step="1" autoFocus
        aria-label={loc('القيمة الجديدة بالدينار', 'New IQD value')} value={edit.value} disabled={saving}
        placeholder={loc('القيمة الجديدة', 'New value')} onChange={(e) => { requestId.current = crypto.randomUUID(); setEdit({ ...edit, value: e.target.value }); }}
        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void save(); } }} />
    </Field>
    <div className="fw-inline-editor-actions"><Button variant="ghost" onClick={() => setEdit(null)} disabled={saving}>{loc('إلغاء', 'Cancel')}</Button>
      <Button variant="primary" busy={saving} disabled={edit.value.trim() === ''} onClick={() => void save()}><Check size={16} />{loc('حفظ القيمة', 'Save value')}</Button></div>
  </div>;
  const reviewReason = (issue: ProfitReviewIssue, line?: ProfitLine) => ({
    fifo_missing: loc('لا توجد تكلفة شراء مؤكدة مرتبطة بالقطع المصروفة لهذا المنتج.', 'The issued units have no linked confirmed purchase cost.'),
    fifo_quantity_incomplete: loc(`تخصيص المخزون غير مكتمل: ${line?.cost_review?.allocated_qty ?? '—'} من ${line?.cost_review?.required_qty ?? '—'} قطعة.`, `Inventory allocation is incomplete: ${line?.cost_review?.allocated_qty ?? '—'} of ${line?.cost_review?.required_qty ?? '—'} units.`),
    fifo_cost_missing: loc('تكلفة دفعة المخزون المصروفة غير مثبتة.', 'The issued inventory lot cost is not confirmed.'),
    historical_cost_unverified: loc('التكلفة المرجعية محفوظة، لكنها لم تُعتمد لهذا الطلب بعد.', 'A reference cost is saved but has not been verified for this order.'),
    return_cost_missing: loc('تكلفة القطع المرتجعة غير مثبتة؛ راجع تكلفة المرتجع.', 'Returned unit costs are missing; review the return cost.'),
    refund_amount_missing: loc('مبلغ الاسترداد أو التعويض غير مثبت؛ راجع بيانات المرتجع.', 'The refund or compensation amount is missing; review the return.'),
    verified_goods_cost_required: loc('نسبة الأجر من الربح تنتظر اعتماد تكلفة المنتجات المشمولة أدناه.', 'Profit-based pay awaits verified costs for the eligible products below.'),
    wage_reconciliation_pending: loc('الحساب التلقائي لهذا الأجر لم يكتمل بعد. تُطبّق قاعدة الموظف المحفوظة، وتظهر أي بيانات ناقصة أو عوائق في تفاصيل الطلب وتنبيهات المحاسبة.', 'Automatic calculation of this wage is not complete yet. The saved employee rule applies; missing inputs or blockers appear in order details and accounting alerts.'),
  } as Record<string, string>)[issue.code] ?? loc('بيانات هذا البند تحتاج مراجعة قبل اعتماد الربح.', 'This line needs review before profit can be confirmed.');
  const costLines = (cost: ProfitCost) => data?.lines.filter((line) => (cost.line_ids ?? (cost.order_item_id ? [cost.order_item_id] : [])).includes(line.id)) ?? [];
  const payMethod = (cost: ProfitCost) => {
    if (cost.rate == null) return cost.rule_name;
    if (cost.basis === 'unit') return <>{formatMoney(cost.rate)} {loc('لكل قطعة', 'per unit')}</>;
    if (cost.basis === 'order') return <>{formatMoney(cost.rate)} {loc('لكل طلب', 'per order')}</>;
    if (cost.basis === 'profit_percent' || cost.basis === 'revenue_percent') return <>{cost.rate / 100}% {cost.basis === 'profit_percent' ? loc('من الربح', 'of profit') : loc('من المبيعات', 'of sales')} {cost.base_iqd != null && <> · {loc('أساس الاستحقاق الأصلي قبل التسويات', 'Original accrual base before adjustments')}: {formatMoney(cost.base_iqd)}</>}</>;
    return cost.rule_name;
  };
  const reviewCost = (line: ProfitLine) => {
    const review = line.cost_review;
    const projection = data && projectedLineCost(data.order, line);
    const projectionNote = projection && <p className="fw-note">{projection.source === 'confirmed_lot' ? loc('تقدير من تكلفة دفعة مؤكدة متاحة', 'Estimate from an available confirmed lot cost') : loc('تقدير من تكلفة الخيار واللون في بطاقة المنتج الحالية', 'Estimate from the current catalogue option and colour cost')}: <Money value={projection.unit_cost_iqd} /> {loc('للقطعة', 'per unit')} · {loc('الكمية', 'Quantity')}: {line.qty}{projection.as_of && <> · {financeDay(projection.as_of)}</>}. {loc('تكلفة للتوقع فقط؛ تُثبت التكلفة الفعلية عند صرف المخزون، ولا ينشأ منها استحقاق للسحب.', 'Forecast only; the actual cost is confirmed when stock is issued and this estimate creates no withdrawable earnings.')}</p>;
    if (!review || !review.issues.length && !review.suggestion && !review.sources.length && review.source !== 'recorded_snapshot') return projectionNote;
    const issues = presentationOrder ? visibleOrderReviewReasons(presentationOrder, review.issues) : review.issues;
    const suggestion = view?.hasFinancialActivity && !projection ? review.suggestion : null;
    if (!issues.length && !suggestion && !review.sources.length && review.source !== 'recorded_snapshot') return projectionNote;
    return <div className="fw-note">
      {projectionNote}
      {review.source === 'recorded_snapshot' && <p>{loc('تكلفة القطعة المثبتة وقت إنشاء الطلب', 'Unit cost recorded when the order was created')}: <Money value={review.snapshot_unit_iqd} /> · {loc('كمية الطلب', 'Order quantity')}: {line.qty}. {loc('تخص الخيار واللون المحفوظين في هذا الطلب؛ تغيير تكلفة المنتج الحالية لا يغيرها.', 'This belongs to the option and colour saved in this order; current catalogue changes do not alter it.')}</p>}
      {issues.map((issue, index) => <p key={`${issue.code}:${issue.source_id}:${index}`}>{reviewReason(issue, line)}</p>)}
      {/* P-A F2: a delivered sale with no recorded cost is never re-costed from today — manual entry only. */}
      {!suggestion && !projection && view?.hasFinancialActivity && data?.order.status === 'delivered' && line.cogs_iqd == null && <p data-finance-no-recorded-cost>{tri(loc, PA_STRINGS.noRecordedCost)}</p>}
      {suggestion && <p>{suggestion.source === 'order_snapshot' ? loc('التكلفة المقترحة من لقطة الطلب', 'Suggested cost from the order snapshot') : suggestion.source === 'confirmed_lot' ? loc('التكلفة المقترحة من دفعة مؤكدة متاحة', 'Suggested cost from an available confirmed lot') : loc('التكلفة المقترحة من بطاقة المنتج الحالية', 'Suggested cost from the current catalogue')}: <Money value={suggestion.total_cost_iqd} /> {loc('إجمالي هذا البند', 'for this entire line')} · <Money value={suggestion.unit_cost_iqd} /> {loc('للقطعة', 'per unit')}{suggestion.as_of && <> · {financeDay(suggestion.as_of)}</>}. {loc('قيمة مرجعية تحتاج موافقتك وليست تكلفة مؤكدة بعد.', 'This reference requires your confirmation and is not a verified cost yet.')}</p>}
      {review.sources.length > 0 && <details className="fw-advanced"><summary>{loc('مصادر تكلفة القطع', 'Unit cost sources')}</summary>{review.sources.map((source) => <div key={source.allocation_id}><Row label={<>{loc('دفعة المخزون', 'Inventory lot')} <bdi>{source.lot_id}</bdi><small>{loc('الكمية المصروفة', 'Issued quantity')}: {source.qty}{!!source.returned_qty && <> · {loc('المرتجع', 'Returned')}: {source.returned_qty}</>}{!!source.late_cost_iqd && <> · {loc('تصحيح تكلفة لاحق', 'Later cost correction')}: {formatMoney(source.late_cost_iqd)}</>}</small></>} value={<Money value={source.retained_cogs_iqd === undefined ? source.cogs_iqd : source.retained_cogs_iqd} />} hint={source.retained_cogs_iqd === undefined ? loc('تكلفة المصدر الأصلية', 'Original source cost') : loc('التكلفة الحالية بعد المرتجع وتصحيحات الدفعة', 'Current cost after returns and lot corrections')} />{source.purchase_id && <p>{loc('مرجع الشراء', 'Purchase reference')}: <bdi>{source.purchase_id}</bdi></p>}</div>)}</details>}
      <div className="fw-list">
        {suggestion && review.can_verify && <Button disabled={saving} onClick={() => verifyCost(line, suggestion.total_cost_iqd)}>{loc('اعتماد هذه التكلفة لهذا الطلب', 'Verify this cost for this order')}</Button>}
        {view?.hasFinancialActivity && !['fifo', 'manual_verified', 'recorded_snapshot'].includes(review.source) && <Button variant="ghost" disabled={saving} onClick={() => beginEdit('cogs_iqd', `${loc('إجمالي تكلفة القطع', 'Total goods cost')} · ${line.name_snapshot}`, line.id)}>{loc('إدخال أو تعديل تكلفة القطع', 'Enter or edit goods cost')}</Button>}
      </div>
    </div>;
  };
  const usd = currency === 'USD' && data?.display_usd?.available ? data.display_usd : undefined;
  const orderCents = (field: string) => usd ? centsAt(usd.cents, field) : undefined;
  const lineCents = (line: ProfitLine, field: string) => usd ? centsAt(usd.lines?.[line.id] ?? {}, field) : undefined;
  const metric = (line: ProfitLine, label: string, field: EditableField, value: number | null | undefined, editable = true, pending = false, centsField?: string) => {
    const cents = centsField ? lineCents(line, centsField) : undefined;
    const content = <><span className="fw-line-metric-label">{label}{editable && <Pencil size={11} aria-hidden />}</span>{pending ? <>{value != null && value !== 0 && <DisplayMoney iqd={value} cents={cents} />}<Status tone="warning">{loc('أجور معلقة', 'Wages pending')}</Status></> : <DisplayMoney iqd={value} cents={cents} />}</>;
    return editable ? <button type="button" className="fw-line-metric fw-line-metric--editable" onClick={() => beginEdit(field, label, line.id)}
      aria-label={`${loc('تعديل', 'Edit')} ${label} · ${line.name_snapshot}`}>{content}</button> : <div className="fw-line-metric">{content}</div>;
  };
  const amountLabel = view?.amountKind === 'projected_goods_margin' ? loc('هامش البضاعة المتوقع قبل المصاريف', 'Forecast goods margin before expenses') : loc('صافي المالك', 'Owner net');
  const warnings = data?.warnings?.filter(warning => !warning.startsWith('cost:') || view?.needsReview) ?? [];
  return <Sheet title={`${loc('تفاصيل ربح الطلب', 'Order profit')} · ${orderId}`} subtitle={data?.order?.customer_name || loc('كل قطعة، وتكلفتها وربحها', 'Each product, its cost and profit')}
    onClose={onClose} footer={view && <><span className="fw-muted">{view.amountKind === 'not_earned' ? loc('لا ربح مستحق من هذا الطلب', 'No earned profit from this order') : amountLabel}</span>{view.amountKind !== 'not_earned' && <DisplayMoney iqd={view.amount} cents={view.amountKind === 'owner_net' ? orderCents('owner_net_iqd') : undefined} compact />}</>}>
    {loading && !data ? <Loading text={loc('تحميل تفاصيل الطلب…', 'Loading order details…')} /> : null}
    {error && <div className="fw-error" role="alert">{error}<Button variant="ghost" onClick={() => setRevision((v) => v + 1)}>{loc('تحديث', 'Refresh')}</Button></div>}
    {notice && <p className={noticePending ? 'fw-note' : 'fw-success'} role="status">{noticePending ? <Status tone="warning">{loc('التسوية معلقة', 'Reconciliation pending')}</Status> : <Check size={16} />}{notice}</p>}
    {data && <>
      {data.order.status !== 'delivered' && <p className="fw-note"><Status>{statusName(data.order.status, loc)}</Status> {view?.expectsDelivery ? loc('توقع قبل المصاريف وليس ربحًا مستحقًا. يُعتمد الربح بعد التسليم وتثبيت التكاليف واستيفاء شروط التحصيل.', 'A forecast before expenses, not earned profit. Profit is recognised after delivery, confirmed costs and collection requirements.') : view?.hasFinancialActivity ? loc('تظهر الحركات المالية السابقة وتسوياتها؛ لا يُنشأ توقع بيع جديد لهذا الطلب.', 'Prior financial activity and its adjustments remain visible; this order creates no new sale forecast.') : loc('لا ربح متوقع أو مستحق من هذا الطلب.', 'This order has no expected or earned profit.')}</p>}
      {warnings.length > 0 && <div className="fw-error">{warnings.some((w) => w.startsWith('cost:')) && <p>{loc('بعض التكاليف تحتاج تثبيتًا. يظهر الحقل الناقص ومصدر التكلفة وخيار تصحيحه تحت المنتج المعني.', 'Some costs need verification. Missing fields, cost sources and correction actions appear under the affected product.')}</p>}{warnings.filter((w) => !w.startsWith('cost:')).map((w) => <p key={w}>{w === 'investor:pending' ? loc('توزيع حصة المستثمر بانتظار تثبيت التكلفة وتسوية الطلب.', 'Investor distribution is awaiting verified costs and order reconciliation.') : w}</p>)}</div>}
      {currency === 'USD' && data.display_usd && <UsdBasisNote available={data.display_usd.available} todayRate={data.display_usd.today_rate}
        single={data.display_usd.usd_basis && data.display_usd.fx_rate_snapshot ? { usd_basis: data.display_usd.usd_basis, fx_rate_snapshot: data.display_usd.fx_rate_snapshot } : undefined} />}
      <div className="fw-metrics">
        <div className="fw-metric"><span>{loc('صافي بيع البضاعة', 'Net goods sales')}</span><DisplayMoney iqd={data.totals.net_goods_iqd} cents={orderCents('net_goods_iqd')} /></div>
        <div className="fw-metric"><span>{view?.expectsDelivery ? loc('تكلفة البضاعة التقديرية', 'Forecast goods cost') : loc('تكلفة البضاعة', 'Goods cost')}</span><DisplayMoney iqd={view?.expectsDelivery ? view.projection?.cogs_iqd : data.totals.cogs_iqd} cents={view?.expectsDelivery ? undefined : orderCents('cogs_iqd')} /></div>
        {!view?.expectsDelivery && view?.hasFinancialActivity && <div className="fw-metric"><span>{loc('حصة المستثمر', 'Investor share')}</span><DisplayMoney iqd={data.totals.investor_iqd} cents={orderCents('investor_iqd')} /></div>}
        {view?.amountKind !== 'not_earned' && <div className="fw-metric"><span>{amountLabel}</span><DisplayMoney iqd={view?.amount} cents={view?.amountKind === 'owner_net' ? orderCents('owner_net_iqd') : undefined} /></div>}
      </div>
      {data.order.status === 'delivered' && <ReportDeductions totals={data.totals} net={data.totals.net_after_report_adjustments_iqd} cents={usd ? { coupon: orderCents('coupon_iqd'), credit: orderCents('price_protection_iqd'), net: orderCents('net_after_report_adjustments_iqd') } : undefined} />}
      {data.lines.map((line) => <Surface className="fw-line-item" key={line.id}>
        <div className="fw-line-heading">
          {line.image_snapshot || line.product_image || line.image_url ? <img className="fw-product-image" src={line.image_snapshot || line.product_image || line.image_url} alt="" /> : <span className="fw-order-icon"><Package size={20} /></span>}
          <div><h3>{line.name_snapshot}</h3><p>{[line.option_snapshot, line.color_snapshot, line.sku_snapshot].filter(Boolean).join(' · ')}</p>
            <p>{loc('الكمية', 'Quantity')}: {line.qty}{line.returned_qty > 0 ? ` · ${loc('مرتجع', 'Returned')}: ${line.returned_qty}` : ''}</p></div>
        </div>
        <Status tone={projectedLineCost(data.order, line) ? 'neutral' : ['fifo', 'manual_verified', 'recorded_snapshot'].includes(line.cost_confidence) ? 'positive' : view?.hasFinancialActivity ? 'warning' : 'neutral'}>{projectedLineCost(data.order, line) ? loc('تكلفة تقديرية · غير مستحقة', 'Forecast cost · not earned') : line.cost_confidence === 'fifo' ? <><ShieldCheck size={12} />{loc('تكلفة من دفعات الشراء', 'Purchase lot cost')}</> : line.cost_confidence === 'manual_verified' ? loc('تكلفة ثبتها المدير', 'Cost verified by admin') : line.cost_confidence === 'recorded_snapshot' ? loc('تكلفة المنتج المثبتة وقت الطلب', 'Product cost recorded at order time') : !view?.hasFinancialActivity ? view?.expectsDelivery ? loc('التكلفة الفعلية بانتظار صرف المخزون', 'Actual cost awaits stock issue') : loc('لا تكلفة بضاعة مصروفة', 'No issued goods cost') : line.cogs_iqd == null ? loc('التكلفة غير مكتملة', 'Cost incomplete') : loc('تكلفة مرجعية', 'Reference cost')}</Status>
        {reviewCost(line)}
        <div className="fw-line-metrics">
          {metric(line, loc('صافي البيع', 'Net sales'), 'net_goods_iqd', line.net_goods_iqd, true, false, 'net_goods_iqd')}
          {metric(line, projectedLineCost(data.order, line) ? loc('تكلفة القطع التقديرية', 'Forecast goods cost') : loc('تكلفة القطع', 'Goods cost'), 'cogs_iqd', projectedLineCost(data.order, line)?.total_cost_iqd ?? line.cogs_iqd, !projectedLineCost(data.order, line) && !!view?.hasFinancialActivity, false, projectedLineCost(data.order, line) ? undefined : 'cogs_iqd')}
          {metric(line, loc('أجور الموظفين', 'Staff wages'), 'manual_direct_iqd', line.wages_iqd, false, data.costs.some((cost) => cost.state === 'pending_cost' && !!(cost.staff_id || cost.staff_user_id) && (cost.line_ids ?? (cost.order_item_id ? [cost.order_item_id] : data.lines.map((item) => item.id))).includes(line.id)), 'wages_iqd')}
          {metric(line, loc('المواد', 'Materials'), 'manual_direct_iqd', line.materials_iqd, false, false, 'materials_iqd')}
          {metric(line, loc('تكلفة إضافية', 'Additional cost'), 'manual_direct_iqd', line.manual_direct_iqd, true, false, 'manual_direct_iqd')}
          {metric(line, loc('نصيب الترويج', 'Promotion share'), 'manual_direct_iqd', line.promotion_iqd, false, false, 'promotion_iqd')}
        </div>
        {editor(line.id)}
        {(line.refund_iqd ?? 0) > 0 && <><Row label={loc('المبلغ المرتجع', 'Refunded amount')} value={<DisplayMoney iqd={line.refund_iqd} cents={lineCents(line, 'refund_iqd')} />} /><Row label={loc('البيع المتبقي بعد المرتجع', 'Sales retained after returns')} value={<DisplayMoney iqd={line.retained_revenue_iqd} cents={lineCents(line, 'retained_revenue_iqd')} />} /></>}
        {!view?.expectsDelivery && view?.hasFinancialActivity && <><div className="fw-line-profit"><span>{loc('ربح البضاعة', 'Goods profit')}</span><DisplayMoney iqd={line.gross_profit_iqd} cents={lineCents(line, 'gross_profit_iqd')} /></div>
        <Row label={loc('حصة المستثمر', 'Investor share')} value={<DisplayMoney iqd={line.investor_iqd} cents={lineCents(line, 'investor_iqd')} />} />
        <Row label={loc('صافي المالك', 'Owner net')} value={<DisplayMoney iqd={line.owner_net_iqd} cents={lineCents(line, 'owner_net_iqd')} />} prominent /></>}
      </Surface>)}
      <Surface title={loc('التوصيل وتكاليف الطلب', 'Delivery and order costs')} subtitle={loc('التعديل يخص هذا الطلب فقط', 'Changes apply to this order only')}>
        <Row label={loc('التوصيل على الزبون', 'Customer delivery charge')} value={<DisplayMoney iqd={data.totals.shipping_income_iqd ?? data.order.shipping_iqd} cents={orderCents('shipping_income_iqd')} />}
          onClick={() => beginEdit('shipping_iqd', loc('التوصيل على الزبون', 'Customer delivery charge'))} />
        <Row label={loc('رسوم الدفع عند الاستلام', 'Cash-on-delivery charge')} value={<DisplayMoney iqd={data.totals.cod_tax_iqd} cents={orderCents('cod_tax_iqd')} />}
          onClick={() => beginEdit('cod_tax_iqd', loc('رسوم الدفع عند الاستلام', 'Cash-on-delivery charge'))} />
        <Row label={loc('أجرة شركة التوصيل', 'Courier fee')} value={<DisplayMoney iqd={data.totals.courier_fee_iqd} cents={orderCents('courier_fee_iqd')} />}
          onClick={() => beginEdit('courier_fee_iqd', loc('أجرة شركة التوصيل', 'Courier fee'))} />
        <Row label={loc('رسوم الدفع', 'Payment fee')} value={<DisplayMoney iqd={data.totals.payment_fee_iqd} cents={orderCents('payment_fee_iqd')} />}
          onClick={() => beginEdit('payment_fee_iqd', loc('رسوم الدفع', 'Payment fee'))} />
        <Row label={loc('تكاليف إضافية للطلب', 'Additional order costs')} value={<DisplayMoney iqd={data.totals.manual_direct_iqd} cents={orderCents('manual_direct_iqd')} />}
          onClick={() => beginEdit('manual_direct_iqd', loc('تكاليف إضافية للطلب', 'Additional order costs'))} />
        {editor()}
        <p className="fw-note">{loc('هذا تصحيح لربح الطلب. تعديل فاتورة الزبون أو التحصيل يتم من إدارة الطلب والتحصيل؛ سعر المنتج وقواعد الطلبات الأخرى محفوظة.', 'This corrects order profit. Change the customer invoice or collection through order management and collections; catalogue prices and other orders’ rules are preserved.')}</p>
      </Surface>
      {data.costs?.length > 0 && <Surface title={loc('أجور وتكاليف هذا الطلب', 'This order’s earned costs')} subtitle={loc('إجمالي كل موظف، ثم تفاصيل أجره لكل منتج وقاعدة. تعديلات البنود تبقى مستقلة.', 'Each employee’s total, followed by product and rule details. Individual adjustments stay separate.')}>
        {hasPendingWagesWithConfirmedCosts(data) && <p className="fw-note" role="status">{loc('الأجور ذات التكلفة المثبتة يُستكمل حسابها تلقائيًا وفق قاعدة كل موظف وتاريخ استحقاقه. تتحدث النتيجة هنا دون طلب إعادة احتساب، وتبقى أي بيانات ناقصة موضحة تحت البند المعني.', 'Wages with confirmed product costs are completed automatically using each employee’s rule and earning date. Results refresh here without a recalculation request; any missing inputs remain identified under the affected entry.')}</p>}
        {groupOrderCosts(data.costs).map((group) => <details className="fw-advanced" key={group.id}>
          <summary><span className="fw-row"><span className="fw-row-label">{group.staffName || group.ruleName}</span><span className="fw-order-values">{group.knownCount > 0 && <Money value={group.knownAmount} />}{group.pendingCount > 0 && <Status tone="warning">{group.isStaff ? loc('أجر معلّق', 'Pay pending') : loc('تكلفة معلّقة', 'Cost pending')} · {group.pendingCount}</Status>}</span></span></summary>
          {group.pendingCount > 0 && <p className="fw-note">{group.knownCount > 0 ? loc('المبلغ المعروض هو الجزء المحتسب فقط؛ الإجمالي النهائي ينتظر البنود المعلقة.', 'The displayed amount is the calculated portion only; the final total awaits pending lines.') : loc('لم يُحتسب مبلغ نهائي بعد. راجع أسباب التعليق في التفاصيل أدناه.', 'No final amount is available yet. Review the pending reasons below.')}</p>}
          {group.costs.map((cost) => {
            const lines = costLines(cost), amount = displayedCostAmount(cost);
            const pending = amount == null;
            return <div key={cost.id}>
              <Row label={<>{cost.rule_name}<small>{payMethod(cost)}</small></>}
                hint={cost.state === 'reversed' ? loc('ملغى · السجل محفوظ', 'Reversed · history retained') : cost.effective_amount_iqd != null && cost.effective_amount_iqd !== cost.amount_iqd ? loc('المبلغ بعد التسويات المسجلة لهذا البند', 'Amount after recorded adjustments for this line') : undefined}
                value={pending ? <Status tone="warning">{loc('بانتظار الحساب', 'Calculation pending')}</Status> : <Money value={amount} />}
                onClick={['due', 'approved'].includes(cost.state) && amount != null ? () => beginEdit('staff_cost', `${cost.rule_name}${cost.staff_name ? ` · ${cost.staff_name}` : ''}`, `cost:${cost.id}`, cost.id) : undefined} />
              {lines.map((line) => <p className="fw-note" key={line.id}>{line.name_snapshot} · {[line.option_snapshot, line.color_snapshot].filter(Boolean).join(' · ')} · {loc('الكمية', 'Quantity')}: {line.qty}</p>)}
              {!lines.length && <p className="fw-note">{cost.scope_confidence === 'historical_unknown' ? loc('نطاق تاريخي على مستوى الطلب؛ البنود المشمولة غير محفوظة.', 'Historical order-level scope; the eligible product lines were not recorded.') : loc('أجر مرتبط بالطلب ككل', 'Pay associated with the whole order')}</p>}
              {pending && <div className="fw-note">{cost.review_reasons?.length ? cost.review_reasons.map((issue, index) => <p key={`${issue.code}:${index}`}>{reviewReason(issue, lines.find((line) => issue.line_ids.includes(line.id)))}</p>) : <p>{loc('ينتظر تثبيت التكلفة أو إكمال تسوية الأجر.', 'Awaiting verified cost or wage reconciliation.')}</p>}
                {lines.filter((line) => !['fifo', 'manual_verified', 'recorded_snapshot'].includes(line.cost_confidence)).map((line) => <div key={line.id}><p>{line.name_snapshot}</p><Button variant="ghost" disabled={saving} onClick={() => beginEdit('cogs_iqd', `${loc('إجمالي تكلفة القطع', 'Total goods cost')} · ${line.name_snapshot}`, line.id)}>{loc('تصحيح تكلفة هذا المنتج', 'Correct this product’s cost')}</Button></div>)}
              </div>}
              {edit?.field === 'staff_cost' && edit.cost_id === cost.id && editor(edit.line_id)}
            </div>;
          })}
        </details>)}
      </Surface>}
      <details className="fw-advanced"><summary>{loc('التحصيل وإسناد الموظف', 'Collection and task assignment')}</summary>
        <div className="fw-toolbar"><Button onClick={() => setAdvanced('collections')}>{loc('تسجيل تحصيل للطلب', 'Record order collection')}</Button>
          <Button onClick={() => setAdvanced('payroll')}>{loc('إسناد مهمة للموظف', 'Assign staff task')}</Button></div>
        {advanced && <Suspense fallback={<Loading text={loc('تحميل…', 'Loading…')} />}><FinanceOperationsPanel key={advanced}
          {...monthRange(financeDay(data.order.delivered_at || data.order.created_at).slice(0, 7))}
          initialTab={advanced} initialOrderId={orderId} onChanged={() => { setRevision((v) => v + 1); onChanged(); }} /></Suspense>}
      </details>
      <details className="fw-advanced"><summary><Clock3 size={15} />{loc('سجل التعديلات', 'Change history')}{data.history?.length ? ` · ${data.history.length}` : ''}</summary>
        <div className="fw-history">{data.history?.length ? data.history.map((entry, i) => <div className="fw-history-row" key={entry.id || `${entry.version}:${i}`}>
          <div><span>{({ net_goods_iqd: loc('صافي البيع', 'Net sales'), cogs_iqd: loc('تكلفة القطع', 'Goods cost'), shipping_iqd: loc('التوصيل على الزبون', 'Customer delivery charge'), cod_tax_iqd: loc('رسوم الدفع عند الاستلام', 'Cash-on-delivery charge'), courier_fee_iqd: loc('أجرة شركة التوصيل', 'Courier fee'), payment_fee_iqd: loc('رسوم الدفع', 'Payment fee'), manual_direct_iqd: loc('تكلفة إضافية', 'Additional cost'), amount_iqd: loc('أجور وتكاليف', 'Earned costs') } as Record<string, string>)[entry.field] ?? loc('تصحيح مالي', 'Financial correction')}</span><p>{entry.actor_name || loc('تعديل إداري', 'Admin change')} · {new Date(entry.created_at).toLocaleString()}</p></div>
          <span dir="ltr">{formatMoney(entry.old_value_iqd)} → {formatMoney(entry.new_value_iqd)}</span>
        </div>) : <p className="fw-note">{loc('لا تعديلات مسجلة حتى الآن.', 'No changes recorded yet.')}</p>}</div>
      </details>
    </>}
  </Sheet>;
}
