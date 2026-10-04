import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { Check, Clock3, Pencil, Package, ShieldCheck } from 'lucide-react';
import { api } from '../../lib/api';
import { useLanguage } from '../../LanguageContext';
import { Button, Field, Loading, Money, Row, Sheet, Status, Surface, formatMoney } from './ui';
import { financeDay, monthRange, WORKSPACE_API, type OrderProfit, type ProfitLine } from './types';

const FinanceOperationsPanel = lazy(() => import('../adminOperations/FinanceOperationsPanel'));

type EditableField = 'net_goods_iqd' | 'cogs_iqd' | 'shipping_iqd' | 'cod_tax_iqd' | 'courier_fee_iqd' | 'payment_fee_iqd' | 'manual_direct_iqd' | 'staff_cost';
type Edit = { field: EditableField; label: string; line_id?: string; cost_id?: string; value: string };

export default function OrderProfitSheet({ orderId, onClose, onChanged }: {
  orderId: string; onClose: () => void; onChanged: () => void;
}) {
  const { loc } = useLanguage();
  const [data, setData] = useState<OrderProfit | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [edit, setEdit] = useState<Edit | null>(null);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState('');
  const [noticePending, setNoticePending] = useState(false);
  const [revision, setRevision] = useState(0);
  const [advanced, setAdvanced] = useState<'collections' | 'payroll' | null>(null);
  const requestId = useRef(crypto.randomUUID());
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError('');
    api.get<OrderProfit>(`${WORKSPACE_API}/orders/${encodeURIComponent(orderId)}`)
      .then((r) => { if (active) setData(r); })
      .catch((e) => { if (active) setError(e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [orderId, revision]);
  const beginEdit = useCallback((field: EditableField, label: string, line_id?: string, cost_id?: string) => {
    requestId.current = crypto.randomUUID();
    setNotice('');
    setEdit({ field, label, line_id, cost_id, value: '' });
  }, []);
  const save = async () => {
    if (!edit || saving || edit.value.trim() === '') return;
    const value = Number(edit.value);
    if (!Number.isSafeInteger(value) || value < 0) { setError(loc('أدخل مبلغًا صحيحًا بالدينار', 'Enter a whole IQD amount')); return; }
    setSaving(true); setError('');
    try {
      let reconciliationPending = false;
      let carryforward = 0;
      if (edit.field === 'staff_cost') {
        const result = await api.patch<{ carryforward_iqd?: number; reconciliation_pending?: boolean }>(`/api/admin/finance-people/costs/${encodeURIComponent(edit.cost_id!)}`, { amount_iqd: value });
        carryforward = result.carryforward_iqd ?? 0;
        reconciliationPending = result.reconciliation_pending ?? false;
      } else {
        const result = await api.post<{ reconciliation_pending?: boolean }>(`${WORKSPACE_API}/orders/${encodeURIComponent(orderId)}/adjustments`, {
          operation_id: requestId.current, field: edit.field, value_iqd: value,
          ...(edit.line_id ? { line_id: edit.line_id } : {}), version: data?.version,
        });
        reconciliationPending = result.reconciliation_pending ?? false;
      }
      setNoticePending(reconciliationPending);
      setEdit(null); setNotice(reconciliationPending ? loc('حُفظت القيمة، وتسوية الاستحقاقات ما زالت معلقة. راجع تنبيهات المحاسبة.', 'Value saved; entitlement reconciliation is still pending. Review the accounting alerts.') : carryforward > 0 ? `${loc('حُفظ الأجر، وسيُسوّى المبلغ المدفوع الزائد من الاستحقاقات التالية:', 'Wage saved; the overpayment will be settled from future earnings:')} ${formatMoney(carryforward)}` : loc('تم الحفظ وإعادة حساب الأرباح', 'Saved and profits recalculated'));
      setRevision((v) => v + 1); onChanged();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setSaving(false); }
  };
  const editor = (lineId?: string) => edit && edit.line_id === lineId && <div className="fw-inline-editor">
    <Field label={edit.label} hint={loc('أدخل القيمة الجديدة فقط. يُحفظ سجل التغيير تلقائيًا.', 'Enter the new value only. History is saved automatically.')}>
      <input className="fw-input" type="number" inputMode="numeric" min="0" step="1" autoFocus
        aria-label={loc('القيمة الجديدة بالدينار', 'New IQD value')} value={edit.value} disabled={saving}
        placeholder={loc('القيمة الجديدة', 'New value')} onChange={(e) => { requestId.current = crypto.randomUUID(); setEdit({ ...edit, value: e.target.value }); }}
        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void save(); } }} />
    </Field>
    <div className="fw-inline-editor-actions"><Button variant="ghost" onClick={() => setEdit(null)} disabled={saving}>{loc('إلغاء', 'Cancel')}</Button>
      <Button variant="primary" busy={saving} disabled={edit.value.trim() === ''} onClick={save}><Check size={16} />{loc('حفظ القيمة', 'Save value')}</Button></div>
  </div>;
  const metric = (line: ProfitLine, label: string, field: EditableField, value: number | null | undefined, editable = true) => {
    const content = <><span className="fw-line-metric-label">{label}{editable && <Pencil size={11} aria-hidden />}</span><Money value={value} /></>;
    return editable ? <button type="button" className="fw-line-metric fw-line-metric--editable" onClick={() => beginEdit(field, label, line.id)}
      aria-label={`${loc('تعديل', 'Edit')} ${label} · ${line.name_snapshot}`}>{content}</button> : <div className="fw-line-metric">{content}</div>;
  };
  return <Sheet title={`${loc('تفاصيل ربح الطلب', 'Order profit')} · ${orderId}`} subtitle={data?.order?.customer_name || loc('كل قطعة، وتكلفتها وربحها', 'Each product, its cost and profit')}
    onClose={onClose} footer={data && <><span className="fw-muted">{loc('صافي المالك', 'Owner net')}</span><Money value={data.totals.owner_net_iqd} /></>}>
    {loading && !data ? <Loading text={loc('تحميل تفاصيل الطلب…', 'Loading order details…')} /> : null}
    {error && <div className="fw-error" role="alert">{error}<Button variant="ghost" onClick={() => setRevision((v) => v + 1)}>{loc('تحديث', 'Refresh')}</Button></div>}
    {notice && <p className={noticePending ? 'fw-note' : 'fw-success'} role="status">{noticePending ? <Status tone="warning">{loc('التسوية معلقة', 'Reconciliation pending')}</Status> : <Check size={16} />}{notice}</p>}
    {data && <>
      {data.order.status !== 'delivered' && <p className="fw-note"><Status tone="warning">{loc('أرقام تقديرية', 'Projected figures')}</Status> {loc('يُعتمد الربح عند استلام الطلب. التحصيل يُراجع بصورة مستقلة.', 'Profit is recognised on delivery. Collections are reviewed separately.')}</p>}
      {data.warnings?.length > 0 && <div className="fw-error">{data.warnings.some((w) => w.startsWith('cost:')) && <p>{loc('بعض التكاليف مرجعية أو غير مكتملة. افتح المنتج لتثبيتها قبل اعتماد الربح.', 'Some costs are reference values or incomplete. Verify the product costs before accepting profit.')}</p>}{data.warnings.filter((w) => !w.startsWith('cost:')).map((w) => <p key={w}>{w === 'investor:pending' ? loc('توزيع حصة المستثمر بانتظار تثبيت التكلفة وتسوية الطلب.', 'Investor distribution is awaiting verified costs and order reconciliation.') : w}</p>)}</div>}
      <div className="fw-metrics">
        <div className="fw-metric"><span>{loc('صافي بيع البضاعة', 'Net goods sales')}</span><Money value={data.totals.net_goods_iqd} /></div>
        <div className="fw-metric"><span>{loc('تكلفة البضاعة', 'Goods cost')}</span><Money value={data.totals.cogs_iqd} /></div>
        <div className="fw-metric"><span>{loc('حصة المستثمر', 'Investor share')}</span><Money value={data.totals.investor_iqd} /></div>
        <div className="fw-metric"><span>{loc('صافي المالك', 'Owner net')}</span><Money value={data.totals.owner_net_iqd} /></div>
      </div>
      {data.lines.map((line) => <Surface className="fw-line-item" key={line.id}>
        <div className="fw-line-heading">
          {line.image_snapshot || line.product_image || line.image_url ? <img className="fw-product-image" src={line.image_snapshot || line.product_image || line.image_url} alt="" /> : <span className="fw-order-icon"><Package size={20} /></span>}
          <div><h3>{line.name_snapshot}</h3><p>{[line.option_snapshot, line.color_snapshot, line.sku_snapshot].filter(Boolean).join(' · ')}</p>
            <p>{loc('الكمية', 'Quantity')}: {line.qty}{line.returned_qty > 0 ? ` · ${loc('مرتجع', 'Returned')}: ${line.returned_qty}` : ''}</p></div>
        </div>
        <Status tone={['fifo', 'manual_verified'].includes(line.cost_confidence) ? 'positive' : 'warning'}>{line.cost_confidence === 'fifo' ? <><ShieldCheck size={12} />{loc('تكلفة من دفعات الشراء', 'Purchase lot cost')}</> : line.cost_confidence === 'manual_verified' ? loc('تكلفة ثبتها المدير', 'Cost verified by admin') : line.cogs_iqd == null ? loc('التكلفة غير مكتملة', 'Cost incomplete') : loc('تكلفة مرجعية', 'Reference cost')}</Status>
        <div className="fw-line-metrics">
          {metric(line, loc('صافي البيع', 'Net sales'), 'net_goods_iqd', line.net_goods_iqd)}
          {metric(line, loc('تكلفة القطع', 'Goods cost'), 'cogs_iqd', line.cogs_iqd)}
          {metric(line, loc('أجور الموظفين', 'Staff wages'), 'manual_direct_iqd', line.wages_iqd, false)}
          {metric(line, loc('المواد', 'Materials'), 'manual_direct_iqd', line.materials_iqd, false)}
          {metric(line, loc('تكلفة إضافية', 'Additional cost'), 'manual_direct_iqd', line.manual_direct_iqd)}
          {metric(line, loc('نصيب الترويج', 'Promotion share'), 'manual_direct_iqd', line.promotion_iqd, false)}
        </div>
        {editor(line.id)}
        {(line.refund_iqd ?? 0) > 0 && <><Row label={loc('المبلغ المرتجع', 'Refunded amount')} value={<Money value={line.refund_iqd} />} /><Row label={loc('البيع المتبقي بعد المرتجع', 'Sales retained after returns')} value={<Money value={line.retained_revenue_iqd} />} /></>}
        <div className="fw-line-profit"><span>{loc('ربح البضاعة', 'Goods profit')}</span><Money value={line.gross_profit_iqd} /></div>
        <Row label={loc('حصة المستثمر', 'Investor share')} value={<Money value={line.investor_iqd} />} />
        <Row label={loc('صافي المالك', 'Owner net')} value={<Money value={line.owner_net_iqd} />} prominent />
      </Surface>)}
      <Surface title={loc('التوصيل وتكاليف الطلب', 'Delivery and order costs')} subtitle={loc('التعديل يخص هذا الطلب فقط', 'Changes apply to this order only')}>
        <Row label={loc('التوصيل على الزبون', 'Customer delivery charge')} value={<Money value={data.totals.shipping_income_iqd ?? data.order.shipping_iqd} />}
          onClick={() => beginEdit('shipping_iqd', loc('التوصيل على الزبون', 'Customer delivery charge'))} />
        <Row label={loc('رسوم الدفع عند الاستلام', 'Cash-on-delivery charge')} value={<Money value={data.totals.cod_tax_iqd} />}
          onClick={() => beginEdit('cod_tax_iqd', loc('رسوم الدفع عند الاستلام', 'Cash-on-delivery charge'))} />
        <Row label={loc('أجرة شركة التوصيل', 'Courier fee')} value={<Money value={data.totals.courier_fee_iqd} />}
          onClick={() => beginEdit('courier_fee_iqd', loc('أجرة شركة التوصيل', 'Courier fee'))} />
        <Row label={loc('رسوم الدفع', 'Payment fee')} value={<Money value={data.totals.payment_fee_iqd} />}
          onClick={() => beginEdit('payment_fee_iqd', loc('رسوم الدفع', 'Payment fee'))} />
        <Row label={loc('تكاليف إضافية للطلب', 'Additional order costs')} value={<Money value={data.totals.manual_direct_iqd} />}
          onClick={() => beginEdit('manual_direct_iqd', loc('تكاليف إضافية للطلب', 'Additional order costs'))} />
        {editor()}
        <p className="fw-note">{loc('هذا تصحيح لربح الطلب. تعديل فاتورة الزبون أو التحصيل يتم من إدارة الطلب والتحصيل؛ سعر المنتج وقواعد الطلبات الأخرى محفوظة.', 'This corrects order profit. Change the customer invoice or collection through order management and collections; catalogue prices and other orders’ rules are preserved.')}</p>
      </Surface>
      {data.costs?.length > 0 && <Surface title={loc('أجور وتكاليف هذا الطلب', 'This order’s earned costs')}>
        {data.costs.map((cost) => <Row key={cost.id} label={<>{cost.rule_name}{cost.staff_name && <small>{cost.staff_name}</small>}</>}
          hint={cost.state === 'reversed' ? loc('ملغى', 'Reversed') : cost.state === 'pending_cost' ? loc('ينتظر تثبيت التكلفة', 'Awaiting verified cost') : undefined}
          value={<Money value={cost.state === 'reversed' ? 0 : cost.effective_amount_iqd ?? cost.amount_iqd} />} onClick={['due', 'approved'].includes(cost.state) && (cost.effective_amount_iqd ?? cost.amount_iqd) != null ? () => beginEdit('staff_cost', `${cost.rule_name}${cost.staff_name ? ` · ${cost.staff_name}` : ''}`, `cost:${cost.id}`, cost.id) : undefined} />)}
        {edit?.field === 'staff_cost' && editor(edit.line_id)}
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
