import { useCallback, useEffect, useState } from 'react';
import ProductPicker from '../adminProducts/form/ProductPicker';
import {
  api,
  Card,
  Cell,
  DataTable,
  FINANCE,
  Input,
  money,
  nameOf,
  Select,
  T,
  Tabs,
  today,
  useLabels,
  useOperation,
  type Named,
} from './shared';

type Rule = {
  id: string;
  version: number;
  name: string;
  group_key: string;
  target_type: string;
  target_id: string;
  basis: string;
  amount: number;
  staff_id: string | null;
  category_id: string;
  center_id: string | null;
  milestone: string;
  requires_assignment: number;
  cap_iqd: number | null;
  priority: number;
  effective_from: string;
  effective_to: string | null;
  active: number;
  staff_name?: string;
};
type Config = {
  work_groups: string[];
  staff: Array<Named & { role: string; active: number }>;
  centers: Named[];
  categories: Named[];
  catalogs: Array<Named & { parent_id: string | null; is_printer_catalog: number }>;
  accounts: Array<{ code: string; name: string }>;
  admins: Array<Named & { email: string }>;
  permissions: Array<{ user_id: string; capability: string; allowed: number }>;
};
type Cost = {
  id: string;
  order_id: string;
  rule_name: string;
  group_key: string;
  staff_name: string;
  staff_id: string | null;
  amount_iqd: number | null;
  paid_iqd: number;
  state: string;
  cost_day: string;
  rule_version: number;
  base_iqd: number | null;
  qty: number;
};
type StaffBalance = Named & {
  due_iqd: number;
  approved_iqd: number;
  paid_iqd: number;
  advance_balance_iqd: number;
  pending_costs: number;
};
const newRule = (): Omit<Rule, 'id' | 'version'> => ({
  name: '',
  group_key: '',
  target_type: 'all',
  target_id: '',
  basis: 'unit',
  amount: 0,
  staff_id: null,
  category_id: '',
  center_id: null,
  milestone: 'delivered',
  requires_assignment: 0,
  cap_iqd: null,
  priority: 0,
  effective_from: today(),
  effective_to: null,
  active: 1,
});
const emptyConfig: Config = {
  work_groups: [],
  staff: [],
  centers: [],
  categories: [],
  catalogs: [],
  accounts: [],
  admins: [],
  permissions: [],
};
const namedOptions = (list: Named[]) => list.map((x) => ({ id: x.id, name: nameOf(x) }));
export default function FinanceOperationsPanel({
  from,
  to,
  onChanged,
}: {
  from: string;
  to: string;
  onChanged: () => void;
}) {
  const { loc } = useLabels(),
    op = useOperation();
  const [tab, setTab] = useState('rules'),
    [config, setConfig] = useState<Config>(emptyConfig);
  const load = useCallback(async () => setConfig(await api.get<Config>(`${FINANCE}/config`)), []);
  const { run } = op;
  useEffect(() => {
    run(load);
  }, [load, run]);
  return (
    <div className={`${T.AP} mt-5`}>
      {op.feedback}
      <Tabs
        value={tab}
        onChange={setTab}
        items={[
          { id: 'rules', name: loc('قواعد التكاليف والموظفون', 'Cost rules and staff') },
          { id: 'payroll', name: loc('الاستحقاقات والرواتب', 'Dues and payroll') },
          { id: 'collections', name: loc('التحصيل وشركات التوصيل', 'Collections and couriers') },
          { id: 'reports', name: loc('ربح الطلب ومراكز التكلفة', 'Order profit and cost centers') },
          { id: 'accounting', name: loc('المحاسبة وإغلاق الفترات', 'Accounting and closing') },
          { id: 'permissions', name: loc('الصلاحيات', 'Permissions') },
        ]}
      />
      {tab === 'rules' && <Rules config={config} onConfig={load} onChanged={onChanged} />}
      {tab === 'payroll' && <Payroll config={config} onChanged={onChanged} />}
      {tab === 'collections' && <Collections config={config} onChanged={onChanged} />}
      {tab === 'reports' && <Reports config={config} from={from} to={to} />}{' '}
      {tab === 'accounting' && <Accounting config={config} from={from} to={to} />}
      {tab === 'permissions' && <Permissions config={config} onChanged={load} />}
    </div>
  );
}
function Rules({
  config,
  onConfig,
  onChanged,
}: {
  config: Config;
  onConfig: () => Promise<unknown>;
  onChanged: () => void;
}) {
  const { loc } = useLabels(),
    op = useOperation();
  const [rules, setRules] = useState<Rule[]>([]),
    [draft, setDraft] = useState<ReturnType<typeof newRule> | Rule>(newRule),
    [person, setPerson] = useState(''),
    [role, setRole] = useState(''),
    [center, setCenter] = useState('');
  const load = useCallback(async () => {
    const r = await api.get<{ rules: Rule[] }>(`${FINANCE}/rules`);
    setRules(r.rules);
  }, []);
  const { run } = op;
  useEffect(() => {
    run(load);
  }, [load, run]);
  const set = (k: string, v: unknown) => setDraft((d) => ({ ...d, [k]: v }));
  const isPercent = draft.basis.endsWith('percent');
  const preset = (kind: 'prep' | 'materials' | 'messages') => {
    const next = newRule(),
      printer = config.catalogs.find((c) => c.is_printer_catalog === 1),
      staff = config.staff.find((s) => nameOf(s).includes(kind === 'prep' ? 'سجاد' : 'حسين'));
    setDraft({
      ...next,
      name:
        kind === 'prep'
          ? loc('أجور سجاد لتجهيز الطابعات', 'Sajjad printer preparation')
          : kind === 'materials'
            ? loc('مواد تجهيز الطابعات', 'Printer preparation materials')
            : loc('أجور حسين للرد على الطلبات', 'Hussein order support'),
      group_key: kind === 'prep' ? 'تجهيز' : kind === 'materials' ? 'مواد' : 'الرد على الرسائل',
      target_type: kind === 'messages' ? 'all' : 'catalog',
      target_id: kind === 'messages' ? '' : (printer?.id ?? ''),
      staff_id: kind === 'materials' ? null : (staff?.id ?? null),
      basis: kind === 'prep' ? 'unit' : kind === 'materials' ? 'profit_percent' : 'order',
      amount: kind === 'prep' ? 5000 : kind === 'materials' ? 1000 : 0,
      milestone: kind === 'prep' ? 'prepared' : 'delivered',
      requires_assignment: kind === 'materials' ? 0 : 1,
      category_id:
        kind === 'materials'
          ? ''
          : (config.categories.find((c) => /رواتب|أجور|Salaries|Wages/i.test(nameOf(c)))?.id ?? ''),
    });
  };
  return (
    <div>
      {op.feedback}
      <Card title={loc('الموظفون ومراكز التكلفة', 'Staff and cost centers')}>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="grid gap-3">
            <Input label={loc('اسم الموظف', 'Employee name')} value={person} onChange={setPerson} />
            <Input label={loc('الوظيفة', 'Role')} value={role} onChange={setRole} />
            <button
              type="button"
              className={T.btnSecondary}
              disabled={op.busy || !person}
              onClick={() =>
                op.run(
                  async () => {
                    await api.post(`${FINANCE}/staff`, { name: person, role });
                    setPerson('');
                    setRole('');
                    await onConfig();
                  },
                  loc('تمت إضافة الموظف', 'Employee added'),
                )
              }
            >
              {loc('إضافة موظف', 'Add employee')}
            </button>
            <p className={`text-xs ${T.text3}`}>{config.staff.map(nameOf).join(' · ')}</p>
          </div>
          <div className="grid content-start gap-3">
            <Input
              label={loc(
                'مركز التكلفة (الطابعات / الفلمنت / الإدارة)',
                'Cost center (printers / filament / administration)',
              )}
              value={center}
              onChange={setCenter}
            />
            <button
              type="button"
              className={T.btnSecondary}
              disabled={op.busy || !center}
              onClick={() =>
                op.run(
                  async () => {
                    await api.post(`${FINANCE}/centers`, { name: center });
                    setCenter('');
                    await onConfig();
                  },
                  loc('تمت إضافة مركز التكلفة', 'Cost center added'),
                )
              }
            >
              {loc('إضافة مركز تكلفة', 'Add cost center')}
            </button>
            <p className={`text-xs ${T.text3}`}>{config.centers.map(nameOf).join(' · ')}</p>
          </div>
        </div>
      </Card>
      <Card title={loc('قاعدة تكلفة / أجر', 'Cost / wage rule')}>
        <div className="mb-4 flex flex-wrap gap-2">
          <button type="button" className={T.chip} onClick={() => preset('prep')}>
            {loc('مثال: سجاد 5,000 لكل طابعة', 'Example: Sajjad 5,000 per printer')}
          </button>
          <button type="button" className={T.chip} onClick={() => preset('materials')}>
            {loc('مثال: مواد 10% من الربح', 'Example: materials 10% of profit')}
          </button>
          <button type="button" className={T.chip} onClick={() => preset('messages')}>
            {loc('مثال: حسين لكل طلب', 'Example: Hussein per order')}
          </button>
        </div>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          <Input
            label={loc('اسم القاعدة', 'Rule name')}
            value={draft.name}
            onChange={(v) => set('name', v)}
          />
          <Input
            label={loc('مجموعة العمل (تجهيز / دعم / مواد)', 'Work group (preparation / support / materials)')}
            value={draft.group_key}
            onChange={(v) => set('group_key', v)}
            hint={loc(
              'ضمن المجموعة نفسها: المنتج يتقدم على القسم الفرعي ثم الرئيسي. مجموعات مختلفة تُجمع.',
              'Within a group: product overrides subcategory, then main category. Different groups add together.',
            )}
          />
          <Select
            label={loc('تطبيق على', 'Applies to')}
            value={draft.target_type}
            onChange={(v) => {
              set('target_type', v);
              set('target_id', '');
            }}
            options={[
              { id: 'all', name: loc('كل الطلبات', 'All orders') },
              { id: 'catalog', name: loc('قسم رئيسي أو فرعي', 'Main / subcategory') },
              { id: 'product', name: loc('منتج', 'Product') },
            ]}
          />
          {draft.target_type === 'catalog' && (
            <Select
              label={loc('القسم', 'Category')}
              value={draft.target_id}
              onChange={(v) => set('target_id', v)}
              empty={loc('اختر قسمًا', 'Choose category')}
              options={config.catalogs.map((c) => ({
                id: c.id,
                name: `${c.parent_id ? `${nameOf(config.catalogs.find((p) => p.id === c.parent_id) ?? c)} / ` : ''}${nameOf(c)}`,
              }))}
            />
          )}
          {draft.target_type === 'product' && (
            <ProductPicker value={draft.target_id} onChange={(id) => set('target_id', id)} />
          )}
          <Select
            label={loc('طريقة الحساب', 'Calculation')}
            value={draft.basis}
            onChange={(v) => set('basis', v)}
            options={[
              { id: 'unit', name: loc('مبلغ لكل قطعة', 'Amount per unit') },
              { id: 'order', name: loc('مبلغ لكل طلب', 'Amount per order') },
              { id: 'profit_percent', name: loc('نسبة من ربح البضاعة', 'Percent of goods profit') },
              { id: 'revenue_percent', name: loc('نسبة من صافي بيع البضاعة', 'Percent of net goods sales') },
            ]}
          />
          <Input
            label={isPercent ? loc('النسبة %', 'Percent %') : loc('المبلغ بالدينار', 'Amount IQD')}
            type="number"
            value={isPercent ? draft.amount / 100 : draft.amount}
            onChange={(v) => set('amount', isPercent ? Math.round(Number(v) * 100) : Number(v))}
          />
          <Select
            label={loc('المستفيد / الموظف', 'Beneficiary / employee')}
            value={draft.staff_id ?? ''}
            onChange={(v) => set('staff_id', v || null)}
            empty={loc('تكلفة عامة بدون موظف', 'General cost, no employee')}
            options={namedOptions(config.staff)}
          />
          <Select
            label={loc('تصنيف المصروف', 'Expense category')}
            value={draft.category_id}
            onChange={(v) => set('category_id', v)}
            empty={loc('اختر تصنيفًا', 'Choose expense category')}
            options={namedOptions(config.categories)}
          />
          <Select
            label={loc('مركز التكلفة', 'Cost center')}
            value={draft.center_id ?? ''}
            onChange={(v) => set('center_id', v || null)}
            empty={loc('بدون مركز', 'No center')}
            options={namedOptions(config.centers)}
          />
          <Select
            label={loc('متى يُسجل الاستحقاق؟', 'When is the cost earned?')}
            value={draft.milestone}
            onChange={(v) => set('milestone', v)}
            options={[
              { id: 'prepared', name: loc('إنجاز التجهيز', 'Preparation completed') },
              { id: 'delivered', name: loc('تسليم الطلب', 'Order delivered') },
            ]}
          />
          <Input
            label={loc('يبدأ من', 'Effective from')}
            type="date"
            value={draft.effective_from}
            onChange={(v) => set('effective_from', v)}
          />
          <Input
            label={loc('ينتهي في (اختياري)', 'Effective to (optional)')}
            type="date"
            value={draft.effective_to ?? ''}
            onChange={(v) => set('effective_to', v || null)}
          />
          <Input
            label={loc('سقف الأجر / القاعدة (اختياري)', 'Rule cap IQD (optional)')}
            type="number"
            value={draft.cap_iqd ?? ''}
            onChange={(v) => set('cap_iqd', v === '' ? null : Number(v))}
          />
          <Input
            label={loc('الأولوية عند تساوي النطاق', 'Priority for equal scopes')}
            type="number"
            value={draft.priority}
            onChange={(v) => set('priority', Number(v))}
          />
          <label className={`flex items-center gap-2 text-sm ${T.text2}`}>
            <input
              type="checkbox"
              checked={!!draft.requires_assignment}
              onChange={(e) => set('requires_assignment', e.target.checked ? 1 : 0)}
            />
            {loc(
              'يتطلب إسناد المهمة للموظف وإنجاز التجهيز',
              'Requires assigned employee and completed preparation',
            )}
          </label>
        </div>
        <p className={`my-4 text-xs leading-6 ${T.text3}`}>
          {loc(
            'نسبة الربح تُحسب بعد خصومات البضاعة وتكلفة FIFO وقبل الأجور. الربح السالب لا يولد عمولة، والتكلفة المجهولة تبقى معلقة. إصدارات القواعد محفوظة لكل طلب.',
            'Profit percentages use net goods after discounts and FIFO cost, before wages. Losses earn no commission; unknown costs stay pending. Each order retains its rule versions.',
          )}
        </p>
        <div className="flex gap-2">
          <button
            type="button"
            className={T.btnPrimary}
            disabled={op.busy || !draft.name || !draft.group_key || !draft.category_id}
            onClick={() =>
              op.run(
                async () => {
                  const b = {
                    ...draft,
                    active: !!draft.active,
                    requires_assignment: !!draft.requires_assignment,
                  };
                  if ('id' in draft) await api.put(`${FINANCE}/rules/${draft.id}`, b);
                  else await api.post(`${FINANCE}/rules`, b);
                  setDraft(newRule());
                  await load();
                  onChanged();
                },
                loc('تم حفظ القاعدة', 'Rule saved'),
              )
            }
          >
            {loc('حفظ القاعدة', 'Save rule')}
          </button>
          <button type="button" className={T.btnGhost} onClick={() => setDraft(newRule())}>
            {loc('قاعدة جديدة', 'New rule')}
          </button>
        </div>
      </Card>
      <Card title={loc('القواعد الحالية', 'Current rules')}>
        <DataTable
          headers={[
            loc('القاعدة / الإصدار', 'Rule / version'),
            loc('المجموعة', 'Group'),
            loc('الأجر', 'Amount'),
            loc('الموظف', 'Employee'),
            loc('الحالة', 'Status'),
            '',
          ]}
        >
          {rules.map((r) => (
            <tr key={r.id}>
              <Cell>
                {r.name} · v{r.version}
              </Cell>
              <Cell>{r.group_key}</Cell>
              <Cell>{r.basis.endsWith('percent') ? `${r.amount / 100}%` : money(r.amount)}</Cell>
              <Cell>{r.staff_name || '—'}</Cell>
              <Cell>{r.active ? loc('فعالة', 'Active') : loc('متوقفة', 'Inactive')}</Cell>
              <Cell>
                <button type="button" className={T.btnSecondary} onClick={() => setDraft(r)}>
                  {loc('تعديل', 'Edit')}
                </button>
                <button
                  type="button"
                  className={T.btnGhost}
                  disabled={op.busy}
                  onClick={() =>
                    op.run(async () => {
                      await api.put(`${FINANCE}/rules/${r.id}`, { ...r, active: !r.active });
                      await load();
                    })
                  }
                >
                  {r.active ? loc('إيقاف', 'Disable') : loc('تفعيل', 'Enable')}
                </button>
              </Cell>
            </tr>
          ))}
        </DataTable>
      </Card>
    </div>
  );
}
function Payroll({ config, onChanged }: { config: Config; onChanged: () => void }) {
  const { loc } = useLabels(),
    op = useOperation();
  const [staff, setStaff] = useState<StaffBalance[]>([]),
    [costs, setCosts] = useState<Cost[]>([]),
    [staffId, setStaffId] = useState(''),
    [amount, setAmount] = useState(''),
    [kind, setKind] = useState('payment'),
    [note, setNote] = useState(''),
    [payId, setPayId] = useState(() => crypto.randomUUID()),
    [orderId, setOrderId] = useState(''),
    [group, setGroup] = useState(''),
    [assigned, setAssigned] = useState(''),
    [complete, setComplete] = useState(true),
    [reversal, setReversal] = useState<Cost | null>(null),
    [reason, setReason] = useState(''),
    [offset, setOffset] = useState(0);
  const load = useCallback(async () => {
    const p = await api.get<{ staff: StaffBalance[]; costs: Cost[] }>(
      `${FINANCE}/payroll?staff_id=${encodeURIComponent(staffId)}&offset=${offset}`,
    );
    setStaff(p.staff);
    setCosts(p.costs);
  }, [staffId, offset]);
  const { run } = op;
  useEffect(() => {
    run(load);
  }, [load, run]);
  return (
    <div>
      {op.feedback}
      <Card title={loc('حساب الموظف', 'Employee ledger')}>
        <DataTable
          headers={[
            loc('الموظف', 'Employee'),
            loc('المستحق الكلي', 'Total earned'),
            loc('المعتمد', 'Approved'),
            loc('المسدّد', 'Settled'),
            loc('الباقي', 'Balance'),
            loc('سلفة متبقية', 'Advance balance'),
            loc('تكاليف معلقة', 'Pending costs'),
          ]}
        >
          {staff.map((s) => (
            <tr key={s.id}>
              <Cell>{nameOf(s)}</Cell>
              <Cell>{money(s.due_iqd)}</Cell>
              <Cell>{money(s.approved_iqd)}</Cell>
              <Cell>{money(s.paid_iqd)}</Cell>
              <Cell>{money(s.due_iqd - s.paid_iqd)}</Cell>
              <Cell>{money(s.advance_balance_iqd)}</Cell>
              <Cell>{s.pending_costs}</Cell>
            </tr>
          ))}
        </DataTable>
        <div className="mt-4 grid gap-3 sm:grid-cols-4">
          <Select
            label={loc('الموظف', 'Employee')}
            value={staffId}
            onChange={(v) => {
              setStaffId(v);
              setOffset(0);
            }}
            empty={loc('اختر موظفًا', 'Choose employee')}
            options={namedOptions(config.staff)}
          />
          <Select
            label={loc('نوع الدفعة', 'Payment type')}
            value={kind}
            onChange={setKind}
            options={[
              { id: 'payment', name: loc('تسديد مستحق معتمد', 'Settle approved dues') },
              { id: 'advance', name: loc('سلفة مقدمة', 'Advance') },
              { id: 'settlement', name: loc('خصم سلفة من الأجور', 'Apply advance to dues') },
            ]}
          />
          <Input
            label={loc('المبلغ بالدينار', 'Amount IQD')}
            type="number"
            value={amount}
            onChange={setAmount}
          />
          <Input label={loc('ملاحظة الدفع', 'Payment note')} value={note} onChange={setNote} />
        </div>
        <p className={`my-3 text-xs ${T.text3}`}>
          {loc(
            'المصروف يُسجّل عند استحقاقه؛ دفع الأجر يسدد الرصيد دون تسجيل مصروف ثانٍ.',
            'Costs are expensed when earned. Paying wages settles the balance without another expense.',
          )}
        </p>
        <button
          type="button"
          className={T.btnPrimary}
          disabled={op.busy || !staffId || !amount}
          onClick={() =>
            op.run(
              async () => {
                await api.post(
                  `${FINANCE}/staff/${staffId}/${kind === 'settlement' ? 'advance-settlements' : 'payments'}`,
                  { operation_id: payId, amount_iqd: Number(amount), kind, note },
                );
                setPayId(crypto.randomUUID());
                setAmount('');
                await load();
                onChanged();
              },
              loc('تم تسجيل الدفعة', 'Payment recorded'),
            )
          }
        >
          {loc('تسجيل الدفعة', 'Record payment')}
        </button>
      </Card>
      <Card title={loc('إسناد المهمة ومطابقة الطلب', 'Task assignment and order reconciliation')}>
        <div className="grid gap-3 sm:grid-cols-3">
          <Input label={loc('رقم الطلب', 'Order ID')} value={orderId} onChange={setOrderId} />
          <Select
            label={loc('المهمة من القواعد', 'Task from rules')}
            value={group}
            onChange={setGroup}
            empty={loc('اختر المهمة', 'Choose task')}
            options={(config.work_groups ?? []).map((g) => ({ id: g, name: g }))}
          />
          <Select
            label={loc('الموظف المنفّذ', 'Assigned employee')}
            value={assigned}
            onChange={setAssigned}
            empty={loc('اختر الموظف', 'Choose employee')}
            options={namedOptions(config.staff)}
          />
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={complete} onChange={(e) => setComplete(e.target.checked)} />
            {loc('تم إنجاز التجهيز', 'Preparation completed')}
          </label>
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          <button
            type="button"
            className={T.btnPrimary}
            disabled={op.busy || !orderId || !group || !assigned}
            onClick={() =>
              op.run(
                async () => {
                  await api.post(`${FINANCE}/orders/${encodeURIComponent(orderId)}/assignment`, {
                    group_key: group,
                    staff_id: assigned,
                    completed: complete,
                  });
                  await load();
                  onChanged();
                },
                loc('تم حفظ المهمة', 'Task saved'),
              )
            }
          >
            {loc('حفظ إسناد المهمة', 'Save assignment')}
          </button>
          <button
            type="button"
            className={T.btnSecondary}
            disabled={op.busy || !orderId}
            onClick={() =>
              op.run(
                async () => {
                  await api.post(`${FINANCE}/orders/${encodeURIComponent(orderId)}/reconcile`, {});
                  await load();
                  onChanged();
                },
                loc('تمت مطابقة الاستحقاقات', 'Costs reconciled'),
              )
            }
          >
            {loc('إعادة احتساب التكاليف المعلقة', 'Retry pending cost posting')}
          </button>
        </div>
      </Card>
      <Card title={loc('الاستحقاقات المسجلة', 'Recorded dues')}>
        <DataTable
          headers={[
            loc('الطلب / القاعدة', 'Order / rule'),
            loc('الموظف', 'Employee'),
            loc('أساس الحساب', 'Calculation base'),
            loc('المستحق / المدفوع', 'Earned / paid'),
            loc('الحالة', 'State'),
            '',
          ]}
        >
          {costs.map((c) => (
            <tr key={c.id}>
              <Cell>
                {c.order_id}
                <small className="block">
                  {c.rule_name} v{c.rule_version}
                </small>
              </Cell>
              <Cell>{c.staff_name || '—'}</Cell>
              <Cell>
                {money(c.base_iqd)} · {c.qty}
              </Cell>
              <Cell>
                {money(c.amount_iqd)} / {money(c.paid_iqd)}
              </Cell>
              <Cell>
                {loc(
                  { pending_cost: 'تكلفة معلقة', due: 'مستحق', approved: 'معتمد', reversed: 'معكوس' }[
                    c.state
                  ] || c.state,
                  c.state,
                )}
              </Cell>
              <Cell>
                {c.state === 'due' && (
                  <button
                    type="button"
                    className={T.btnSecondary}
                    disabled={op.busy}
                    onClick={() =>
                      op.run(
                        async () => {
                          await api.post(`${FINANCE}/costs/${c.id}/approve`, {});
                          await load();
                        },
                        loc('تم الاعتماد', 'Approved'),
                      )
                    }
                  >
                    {loc('اعتماد', 'Approve')}
                  </button>
                )}
                {c.state !== 'reversed' && !c.paid_iqd && (
                  <button
                    type="button"
                    className={T.btnGhost}
                    onClick={() => {
                      setReversal(c);
                      setReason('');
                    }}
                  >
                    {loc('عكس الاستحقاق', 'Reverse due')}
                  </button>
                )}
              </Cell>
            </tr>
          ))}
        </DataTable>
        <div className="mt-3 flex gap-2">
          <button
            type="button"
            className={T.btnGhost}
            disabled={!offset || op.busy}
            onClick={() => setOffset((o) => Math.max(0, o - 100))}
          >
            {loc('السابق', 'Previous')}
          </button>
          <button
            type="button"
            className={T.btnGhost}
            disabled={costs.length < 100 || op.busy}
            onClick={() => setOffset((o) => o + 100)}
          >
            {loc('التالي', 'Next')}
          </button>
        </div>
      </Card>
      {reversal && (
        <Card title={reversal.rule_name}>
          <Input label={loc('سبب عكس الاستحقاق', 'Reversal reason')} value={reason} onChange={setReason} />
          <button
            type="button"
            className={`${T.btnPrimary} mt-3`}
            disabled={op.busy || reason.length < 3}
            onClick={() =>
              op.run(
                async () => {
                  await api.post(`${FINANCE}/costs/${reversal.id}/reverse`, { reason });
                  setReversal(null);
                  await load();
                  onChanged();
                },
                loc('تم العكس في الفترة الحالية', 'Reversed in current period'),
              )
            }
          >
            {loc('تسجيل العكس', 'Record reversal')}
          </button>
        </Card>
      )}
    </div>
  );
}
function Collections({ config, onChanged }: { config: Config; onChanged: () => void }) {
  const { loc } = useLabels(),
    op = useOperation();
  const [rows, setRows] = useState<
      Array<{
        id: string;
        delivery_provider: string;
        due_on_delivery_iqd: number;
        collected_iqd: number;
        balance_iqd: number;
        bank_expected_iqd: number;
        bank_balance_iqd: number;
        door_balance_iqd: number;
        bank_credit_balance_iqd: number;
        overdue_days: number;
        courier_fee_iqd: number;
      }>
    >([]),
    [order, setOrder] = useState(''),
    [payer, setPayer] = useState('courier'),
    [amount, setAmount] = useState(''),
    [fee, setFee] = useState('0'),
    [reference, setReference] = useState(''),
    [category, setCategory] = useState(''),
    [id, setId] = useState(() => crypto.randomUUID());
  const load = useCallback(
    async () => setRows((await api.get<{ orders: typeof rows }>(`${FINANCE}/receivables`)).orders),
    [],
  );
  const { run } = op;
  useEffect(() => {
    run(load);
  }, [load, run]);
  return (
    <div>
      {op.feedback}
      <Card title={loc('تحصيل فعلي أو دفعة عميل مقدمة', 'Actual collection or customer prepayment')}>
        <div className="grid gap-3 sm:grid-cols-3">
          <Input label={loc('رقم الطلب', 'Order ID')} value={order} onChange={setOrder} />
          <Select
            label={loc('جهة الدفع', 'Payer')}
            value={payer}
            onChange={setPayer}
            options={[
              { id: 'courier', name: loc('شركة التوصيل', 'Courier') },
              { id: 'customer', name: loc('العميل', 'Customer') },
              { id: 'bank', name: loc('تسوية Gini من البنك', 'Gini bank settlement') },
            ]}
          />
          <Input
            label={loc('الإجمالي شاملاً أجرة الشركة', 'Gross collected including courier fee')}
            type="number"
            value={amount}
            onChange={setAmount}
          />
          <Input
            label={loc('الأجرة المحتجزة للشركة', 'Withheld courier fee')}
            type="number"
            value={fee}
            onChange={setFee}
          />
          <Select
            label={loc('تصنيف مصروف الأجرة', 'Fee expense category')}
            value={category}
            onChange={setCategory}
            empty={loc('اختر تصنيفًا', 'Choose category')}
            options={namedOptions(config.categories)}
          />
          <Input
            label={loc('رقم التسوية أو الوصل', 'Settlement / receipt reference')}
            value={reference}
            onChange={setReference}
          />
        </div>
        <p className={`my-3 text-sm ${T.text2}`}>
          {loc('صافي النقد المستلم', 'Net cash received')}: {money(Number(amount) - Number(fee))}
        </p>
        <button
          type="button"
          className={T.btnPrimary}
          disabled={op.busy || !order || !amount}
          onClick={() =>
            op.run(
              async () => {
                await api.post(`${FINANCE}/collections`, {
                  operation_id: id,
                  order_id: order,
                  payer,
                  amount_iqd: Number(amount),
                  fee_iqd: Number(fee),
                  category_id: category,
                  reference,
                });
                setId(crypto.randomUUID());
                setAmount('');
                await load();
                onChanged();
              },
              loc('تم تسجيل التحصيل', 'Collection recorded'),
            )
          }
        >
          {loc('تسجيل التحصيل', 'Record collection')}
        </button>
      </Card>
      <Card
        title={loc('ذمم البنك والتوصيل والتسويات الدائنة', 'Bank and courier receivables and credit balances')}
      >
        <p className={`mb-3 text-sm ${T.text2}`}>
          {loc('مرتجعات Gini تخصم من استحقاق البنك وحده. الرصيد الدائن للبنك بعد التحصيل يُعرض منفصلًا كتسوية مستحقة؛ أجرة الباب تبقى مستقلة.', 'Gini refunds reduce only the bank receivable. A bank credit after collection is shown separately as a settlement due; the door balance remains independent.')}
        </p>
        <DataTable
          headers={[
            loc('الطلب', 'Order'),
            loc('الشركة', 'Courier'),
            loc('المتوقع', 'Expected'),
            loc('المحصّل', 'Collected'),
            loc('أجور الشركة', 'Courier fees'),
            loc('مستحق الباب', 'Door due'),
            loc('مستحق البنك', 'Bank due'),
            loc('تسوية مستحقة للبنك', 'Bank credit settlement due'),
            loc('أيام التأخير', 'Overdue days'),
            '',
          ]}
        >
          {rows.map((r) => (
            <tr key={r.id}>
              <Cell>{r.id}</Cell>
              <Cell>{r.delivery_provider || '—'}</Cell>
              <Cell>{money(r.due_on_delivery_iqd + r.bank_expected_iqd)}</Cell>
              <Cell>{money(r.collected_iqd)}</Cell>
              <Cell>{money(r.courier_fee_iqd)}</Cell>
              <Cell>{money(Math.max(0, r.door_balance_iqd))}</Cell>
              <Cell>{money(Math.max(0, r.bank_balance_iqd))}</Cell>
              <Cell>{money(r.bank_credit_balance_iqd)}</Cell>
              <Cell>{r.overdue_days}</Cell>
              <Cell>
                {r.door_balance_iqd > 0 && <button
                  type="button"
                  className={T.btnSecondary}
                  onClick={() => {
                    setOrder(r.id);
                    setPayer('courier');
                    setAmount(String(r.door_balance_iqd));
                  }}
                >
                  {loc('تحصيل الباب', 'Collect door payment')}
                </button>}
                {r.bank_balance_iqd > 0 && <button
                  type="button"
                  className={T.btnSecondary}
                  onClick={() => {
                    setOrder(r.id);
                    setPayer('bank');
                    setAmount(String(r.bank_balance_iqd));
                  }}
                >
                  {loc('تحصيل البنك', 'Collect bank payment')}
                </button>}
              </Cell>
            </tr>
          ))}
        </DataTable>
      </Card>
    </div>
  );
}
type ProfitRow = {
  estimated_lines: number;
  id: string;
  net_goods_iqd: number;
  cogs_iqd: number;
  gross_profit_iqd: number | null;
  direct_cost_iqd: number;
  courier_fee_iqd: number;
  contribution_profit_iqd: number | null;
  allocated_overhead_iqd: number | null;
  managerial_net_iqd: number | null;
  collection_difference_iqd: number;
  pending_costs: number;
};
function Reports({ config, from, to }: { config: Config; from: string; to: string }) {
  const { loc } = useLabels(),
    op = useOperation();
  const [data, setData] = useState<{
      orders: ProfitRow[];
      centers: Array<Named & { rule_cost_iqd: number; manual_cost_iqd: number; pending_costs: number }>;
      refunds: Array<{
        case_id: string;
        order_id: string;
        refunded_day: string;
        refund_iqd: number;
        cogs_iqd: number | null;
        disposition: string;
      }>;
      general_expenses_iqd: number;
      allocated_overhead_iqd: number | null;
      truncated: boolean;
      suppliers: Array<
        Named & {
          ordered_total_iqd: number;
          paid_iqd: number;
          payable_iqd: number;
          prepaid_iqd: number;
          received_units: number;
        }
      >;
      wallets: Array<{ currency: string; liability_native_units: number }>;
    } | null>(null),
    [page, setPage] = useState(0),
    [detail, setDetail] = useState<{
      order: Record<string, unknown>;
      lines: Array<{
        id: string;
        name_snapshot: string;
        sku_snapshot: string;
        net_goods_iqd: number;
        cogs_iqd: number | null;
        cost_confidence: string;
        qty: number;
      }>;
      costs: Cost[];
    } | null>(null),
    [expense, setExpense] = useState(''),
    [basis, setBasis] = useState('revenue'),
    [center, setCenter] = useState(''),
    [expenses, setExpenses] = useState<
      Array<{ id: string; title: string; amount_iqd: number; expense_day: string }>
    >([]),
    [targetType, setTargetType] = useState('all'),
    [targetId, setTargetId] = useState('');
  const load = useCallback(async () => {
    const [r, e] = await Promise.all([
      api.get<NonNullable<typeof data>>(`${FINANCE}/report?from=${from}&to=${to}`),
      api.get<{ expenses: typeof expenses }>(`${FINANCE}/expenses?from=${from}&to=${to}`),
    ]);
    setData(r);
    setExpenses(e.expenses);
  }, [from, to]);
  const { run } = op;
  useEffect(() => {
    run(load);
    setPage(0);
  }, [load, run]);
  const exportRows = () => {
    if (!data) return;
    const keys: Array<keyof ProfitRow> = [
      'id',
      'net_goods_iqd',
      'cogs_iqd',
      'estimated_lines',
      'direct_cost_iqd',
      'courier_fee_iqd',
      'contribution_profit_iqd',
      'allocated_overhead_iqd',
      'managerial_net_iqd',
    ];
    const escape = (v: unknown) =>
      `"${String(v ?? '')
        .replace(/^[=+@-]/, "'$&")
        .replaceAll('"', '""')}"`;
    const csv =
      '\uFEFF' +
      [keys.join(','), ...data.orders.map((r) => keys.map((k) => escape(r[k])).join(','))].join('\r\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' })),
      a = document.createElement('a');
    a.href = url;
    a.download = `profit-${from}-${to}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };
  return (
    <div>
      {op.feedback}
      <Card title={loc('ربح الطلب بعد أجور العمل والتوصيل', 'Order profit after work and delivery costs')}>
        <p className={`mb-3 text-xs leading-6 ${T.text3}`}>
          {loc(
            'ربح المساهمة = صافي البضاعة − تكلفتها + التوصيل المحصّل − تكاليف الطلب − أجرة شركة التوصيل. الربح الإداري يطرح المصروفات الموزعة مرة واحدة. القيم المجهولة لا تعرض صفرًا.',
            'Contribution = net goods − goods cost + delivery charged − order costs − courier fee. Managerial profit subtracts allocated overhead once. Unknown values remain blank.',
          )}
        </p>
        {data?.truncated && (
          <p role="alert" className="mb-3 text-sm text-red-600">
            {loc(
              'الفترة تتجاوز 5,000 طلب؛ ضيّقها لحساب توزيع المصروفات بدقة.',
              'Range exceeds 5,000 orders; narrow it for exact overhead allocation.',
            )}
          </p>
        )}
        <div className="mb-3 flex flex-wrap gap-3">
          <button type="button" className={T.btnSecondary} disabled={!data} onClick={exportRows}>
            {loc('تصدير CSV', 'Export CSV')}
          </button>
          <span className={`text-sm ${T.text2}`}>
            {loc('المصروفات العامة / الموزعة', 'General / allocated overhead')}:{' '}
            {money(data?.general_expenses_iqd)} / {money(data?.allocated_overhead_iqd)}
          </span>
        </div>
        <DataTable
          headers={[
            loc('الطلب', 'Order'),
            loc('صافي البضاعة', 'Net goods'),
            loc('تكلفة البضاعة', 'COGS'),
            loc('أجور وتكاليف', 'Order costs'),
            loc('شركة التوصيل', 'Courier'),
            loc('ربح المساهمة', 'Contribution'),
            loc('مصروف موزع', 'Overhead share'),
            loc('ربح إداري', 'Managerial profit'),
            '',
          ]}
        >
          {data?.orders.slice(page * 50, (page + 1) * 50).map((r) => (
            <tr key={r.id}>
              <Cell>
                {r.id}
                {r.pending_costs > 0 && (
                  <small className="block text-amber-600">
                    {loc('تكاليف معلقة', 'Pending costs')}: {r.pending_costs}
                  </small>
                )}
              </Cell>
              <Cell>{money(r.net_goods_iqd)}</Cell>
              <Cell>
                {money(r.cogs_iqd)}
                {r.estimated_lines > 0 && (
                  <small className="block text-amber-600">{loc('تكلفة تقديرية', 'Estimated cost')}</small>
                )}
              </Cell>
              <Cell>{money(r.direct_cost_iqd)}</Cell>
              <Cell>{money(r.courier_fee_iqd)}</Cell>
              <Cell>{money(r.contribution_profit_iqd)}</Cell>
              <Cell>{money(r.allocated_overhead_iqd)}</Cell>
              <Cell>{money(r.managerial_net_iqd)}</Cell>
              <Cell>
                <button
                  type="button"
                  className={T.btnGhost}
                  onClick={() =>
                    op.run(async () => setDetail(await api.get(`${FINANCE}/orders/${r.id}/profit`)))
                  }
                >
                  {loc('تفاصيل', 'Details')}
                </button>
              </Cell>
            </tr>
          ))}
        </DataTable>
        <div className="mt-3 flex gap-2">
          <button type="button" className={T.btnGhost} disabled={!page} onClick={() => setPage((p) => p - 1)}>
            {loc('السابق', 'Previous')}
          </button>
          <button
            type="button"
            className={T.btnGhost}
            disabled={(page + 1) * 50 >= (data?.orders.length ?? 0)}
            onClick={() => setPage((p) => p + 1)}
          >
            {loc('التالي', 'Next')}
          </button>
        </div>
      </Card>
      {detail && (
        <Card title={`${loc('تفاصيل البضاعة والنسخ', 'Goods and selection details')} · ${detail.order.id}`}>
          <DataTable
            headers={[
              loc('المنتج / SKU', 'Product / SKU'),
              loc('القطع', 'Units'),
              loc('صافي البيع', 'Net sales'),
              loc('التكلفة', 'Cost'),
              loc('مصدر التكلفة', 'Cost source'),
            ]}
          >
            {detail.lines.map((l) => (
              <tr key={l.id}>
                <Cell>
                  {l.name_snapshot}
                  <small className="block">{l.sku_snapshot}</small>
                </Cell>
                <Cell>{l.qty}</Cell>
                <Cell>{money(l.net_goods_iqd)}</Cell>
                <Cell>{money(l.cogs_iqd)}</Cell>
                <Cell>
                  {l.cost_confidence === 'fifo' ? 'FIFO' : loc('تقدير / غير معروف', 'Snapshot / unknown')}
                </Cell>
              </tr>
            ))}
          </DataTable>
          <DataTable headers={[loc('القاعدة', 'Rule'), loc('المبلغ', 'Amount'), loc('الحالة', 'State')]}>
            {detail.costs.map((c) => (
              <tr key={c.id}>
                <Cell>{c.rule_name}</Cell>
                <Cell>{money(c.amount_iqd)}</Cell>
                <Cell>{c.state}</Cell>
              </tr>
            ))}
          </DataTable>
        </Card>
      )}
      <Card
        title={loc(
          'ربط مصروف عام بمركز تكلفة وطريقة توزيعه',
          'Link overhead to a cost center and allocation method',
        )}
      >
        <div className="grid gap-3 sm:grid-cols-3">
          <Select
            label={loc('المصروف العام من الفترة', 'General expense in period')}
            value={expense}
            onChange={setExpense}
            empty={loc('اختر المصروف', 'Choose expense')}
            options={expenses.map((e) => ({
              id: e.id,
              name: `${e.expense_day} · ${e.title} · ${money(e.amount_iqd)}`,
            }))}
          />
          <Select
            label={loc('يشمل طلبات', 'Applies to orders')}
            value={targetType}
            onChange={(v) => {
              setTargetType(v);
              setTargetId('');
            }}
            options={[
              { id: 'all', name: loc('كل الأقسام', 'All departments') },
              { id: 'catalog', name: loc('قسم رئيسي أو فرعي', 'Main or subcategory') },
              { id: 'product', name: loc('منتج محدد', 'Specific product') },
            ]}
          />
          {targetType === 'catalog' && (
            <Select
              label={loc('القسم', 'Category')}
              value={targetId}
              onChange={setTargetId}
              options={namedOptions(config.catalogs)}
              empty={loc('اختر القسم', 'Choose category')}
            />
          )}{' '}
          {targetType === 'product' && <ProductPicker value={targetId} onChange={setTargetId} />}
          <Select
            label={loc('مركز التكلفة', 'Cost center')}
            value={center}
            onChange={setCenter}
            empty={loc('بدون مركز', 'No center')}
            options={namedOptions(config.centers)}
          />
          <Select
            label={loc('التوزيع الإداري', 'Management allocation')}
            value={basis}
            onChange={setBasis}
            options={[
              { id: 'none', name: loc('يبقى عامًا', 'Unallocated') },
              { id: 'revenue', name: loc('حسب قيمة البيع', 'By sales value') },
              { id: 'units', name: loc('حسب القطع', 'By units') },
              { id: 'orders', name: loc('بالتساوي بين الطلبات', 'Equally per order') },
            ]}
          />
        </div>
        <button
          type="button"
          className={`${T.btnPrimary} mt-3`}
          disabled={op.busy || !expense}
          onClick={() =>
            op.run(
              async () => {
                await api.post(`${FINANCE}/expense-links`, {
                  expense_id: expense,
                  center_id: center,
                  allocation_basis: basis,
                  target_type: targetType,
                  target_id: targetId,
                });
                await load();
              },
              loc('تم حفظ توزيع المصروف', 'Expense allocation saved'),
            )
          }
        >
          {loc('ربط المصروف', 'Link expense')}
        </button>
      </Card>
      <Card title={loc('مراكز التكلفة', 'Cost centers')}>
        <DataTable
          headers={[
            loc('المركز', 'Center'),
            loc('استحقاقات القواعد', 'Rule costs'),
            loc('المصروفات العامة', 'General expenses'),
            loc('معلق', 'Pending'),
          ]}
        >
          {data?.centers.map((c) => (
            <tr key={c.id}>
              <Cell>{nameOf(c)}</Cell>
              <Cell>{money(c.rule_cost_iqd)}</Cell>
              <Cell>{money(c.manual_cost_iqd)}</Cell>
              <Cell>{c.pending_costs}</Cell>
            </tr>
          ))}
        </DataTable>
      </Card>
      <Card title={loc('المرتجعات في الفترة', 'Refunds in period')}>
        <DataTable
          headers={[
            loc('التاريخ / الطلب', 'Date / order'),
            loc('رد قيمة البضاعة', 'Goods refund'),
            loc('تكلفة أعيدت للمخزون', 'COGS restored'),
            loc('الفحص', 'Disposition'),
          ]}
        >
          {data?.refunds.map((r) => (
            <tr key={r.case_id}>
              <Cell>
                {r.refunded_day} · {r.order_id}
              </Cell>
              <Cell>{money(r.refund_iqd)}</Cell>
              <Cell>{money(r.cogs_iqd)}</Cell>
              <Cell>{r.disposition}</Cell>
            </tr>
          ))}
        </DataTable>
        <p className={`mt-2 text-xs ${T.text3}`}>
          {loc(
            'تظهر المرتجعات في تاريخها؛ لوحة الملخص المالي تجمعها مع مبيعات ومصروفات نفس الفترة.',
            'Refunds appear on their event date; the financial summary combines them with sales and expenses for the same period.',
          )}
        </p>
      </Card>
      <Card title={loc('أرصدة الموردين والمحافظ', 'Supplier and wallet balances')}>
        <DataTable
          headers={[
            loc('المورد', 'Supplier'),
            loc('المشتريات', 'Purchases'),
            loc('المدفوع', 'Paid'),
            loc('ذمة المورد', 'Supplier payable'),
            loc('دفعات مقدمة', 'Prepayments'),
            loc('المستلم', 'Received units'),
          ]}
        >
          {data?.suppliers.map((s) => (
            <tr key={s.id}>
              <Cell>{nameOf(s)}</Cell>
              <Cell>{money(s.ordered_total_iqd)}</Cell>
              <Cell>{money(s.paid_iqd)}</Cell>
              <Cell>{money(s.payable_iqd)}</Cell>
              <Cell>{money(s.prepaid_iqd)}</Cell>
              <Cell>{s.received_units}</Cell>
            </tr>
          ))}
        </DataTable>
        <p className={`mt-3 text-xs ${T.text3}`}>
          {loc(
            'المحافظ التزامات بعملتها الأصلية؛ USD بالسنت وPOINT بالنقاط، وليست إيرادات بيع.',
            'Wallets are liabilities in their native units: USD cents and POINT points, not sales revenue.',
          )}
        </p>
        {data?.wallets.map((w) => (
          <p className={`mt-1 text-sm ${T.text1}`} key={w.currency}>
            {w.currency}: {w.liability_native_units.toLocaleString('en-US')}
          </p>
        ))}
      </Card>
    </div>
  );
}
function Accounting({ config, from, to }: { config: Config; from: string; to: string }) {
  const { loc } = useLabels(),
    op = useOperation();
  const [data, setData] = useState<{
      entries: Array<{
        id: string;
        entry_day: string;
        title: string;
        amount_iqd: number;
        source_type: string;
        lines_json: string;
      }>;
      trial: Array<{ code: string; name: string; debit_iqd: number; credit_iqd: number }>;
      periods: Array<{ month: string }>;
    }>({ entries: [], trial: [], periods: [] }),
    [title, setTitle] = useState(''),
    [day, setDay] = useState(today),
    [lines, setLines] = useState([
      { account: '1000', debit: 0, credit: 0 },
      { account: '3000', debit: 0, credit: 0 },
    ]),
    [id, setId] = useState(() => crypto.randomUUID()),
    [month, setMonth] = useState(''),
    [reverse, setReverse] = useState(''),
    [reason, setReason] = useState('');
  const load = useCallback(
    async () => setData(await api.get(`${FINANCE}/journal?from=${from}&to=${to}`)),
    [from, to],
  );
  const { run } = op;
  useEffect(() => {
    run(load);
  }, [load, run]);
  const balance = lines.reduce((s, l) => s + l.debit - l.credit, 0);
  return (
    <div>
      {op.feedback}
      <PostingErrors />
      <Card title={loc('قيد محاسبي / رصيد افتتاحي', 'Journal / opening balance')}>
        <p className={`mb-3 text-xs leading-6 ${T.text3}`}>
          {loc(
            'ابدأ بأرصدة افتتاحية للمخزون والنقد والذمم ورأس المال. القيود الآلية تبدأ بالعمليات الجديدة. كل قيد متوازن، والتصحيح بقيد عكسي في فترة مفتوحة.',
            'Start with opening inventory, cash, receivables, liabilities and capital balances. Automatic journals begin with new operations. Entries balance; corrections use reversals in open periods.',
          )}
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          <Input label={loc('عنوان القيد', 'Entry title')} value={title} onChange={setTitle} />
          <Input label={loc('التاريخ', 'Date')} type="date" value={day} onChange={setDay} />
        </div>
        {lines.map((l, i) => (
          <div className="mt-3 grid gap-2 sm:grid-cols-3" key={i}>
            <Select
              label={loc('الحساب', 'Account')}
              value={l.account}
              onChange={(v) => setLines((a) => a.map((x, j) => (j === i ? { ...x, account: v } : x)))}
              options={config.accounts.map((a) => ({ id: a.code, name: `${a.code} · ${a.name}` }))}
            />
            <Input
              label={loc('مدين', 'Debit')}
              type="number"
              value={l.debit}
              onChange={(v) => setLines((a) => a.map((x, j) => (j === i ? { ...x, debit: Number(v) } : x)))}
            />
            <Input
              label={loc('دائن', 'Credit')}
              type="number"
              value={l.credit}
              onChange={(v) => setLines((a) => a.map((x, j) => (j === i ? { ...x, credit: Number(v) } : x)))}
            />
          </div>
        ))}
        <p className={`my-3 text-sm ${balance ? 'text-red-600' : T.text2}`}>
          {loc('فرق المدين والدائن', 'Debit-credit difference')}: {money(balance)}
        </p>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className={T.btnSecondary}
            onClick={() => setLines((a) => [...a, { account: '1000', debit: 0, credit: 0 }])}
          >
            {loc('سطر إضافي', 'Add line')}
          </button>
          <button
            type="button"
            className={T.btnPrimary}
            disabled={op.busy || balance !== 0 || !title}
            onClick={() =>
              op.run(
                async () => {
                  await api.post(`${FINANCE}/journal`, { operation_id: id, day, title, lines });
                  setId(crypto.randomUUID());
                  setTitle('');
                  setLines([
                    { account: '1000', debit: 0, credit: 0 },
                    { account: '3000', debit: 0, credit: 0 },
                  ]);
                  await load();
                },
                loc('تم ترحيل القيد', 'Journal posted'),
              )
            }
          >
            {loc('ترحيل القيد', 'Post journal')}
          </button>
        </div>
      </Card>
      <Card title={loc('ميزان المراجعة حتى نهاية الفترة', 'Trial balance through period end')}>
        <DataTable
          headers={[
            loc('الحساب', 'Account'),
            loc('المدين', 'Debit'),
            loc('الدائن', 'Credit'),
            loc('الرصيد', 'Balance'),
          ]}
        >
          {data.trial.map((a) => (
            <tr key={a.code}>
              <Cell>
                {a.code} · {a.name}
              </Cell>
              <Cell>{money(a.debit_iqd)}</Cell>
              <Cell>{money(a.credit_iqd)}</Cell>
              <Cell>{money(a.debit_iqd - a.credit_iqd)}</Cell>
            </tr>
          ))}
        </DataTable>
      </Card>
      <Card title={loc('دفتر القيود', 'Journal entries')}>
        <DataTable
          headers={[
            loc('التاريخ', 'Date'),
            loc('العنوان', 'Title'),
            loc('المبلغ', 'Amount'),
            loc('الأسطر', 'Lines'),
            '',
          ]}
        >
          {data.entries.map((e) => (
            <tr key={e.id}>
              <Cell>{e.entry_day}</Cell>
              <Cell>{e.title}</Cell>
              <Cell>{money(e.amount_iqd)}</Cell>
              <Cell>
                <details>
                  <summary className="cursor-pointer">{loc('عرض الحسابات', 'Show accounts')}</summary>
                  {(
                    JSON.parse(e.lines_json) as Array<{
                      account: string;
                      debit_iqd: number;
                      credit_iqd: number;
                    }>
                  ).map((l, i) => (
                    <p key={i}>
                      {l.account}: {money(l.debit_iqd)} / {money(l.credit_iqd)}
                    </p>
                  ))}
                </details>
              </Cell>
              <Cell>
                {e.source_type === 'manual' && (
                  <button
                    type="button"
                    className={T.btnGhost}
                    onClick={() => {
                      setReverse(e.id);
                      setReason('');
                    }}
                  >
                    {loc('عكس', 'Reverse')}
                  </button>
                )}
              </Cell>
            </tr>
          ))}
        </DataTable>
      </Card>
      {reverse && (
        <Card title={loc('عكس قيد', 'Reverse entry')}>
          <Input label={loc('سبب التصحيح', 'Correction reason')} value={reason} onChange={setReason} />
          <button
            type="button"
            className={`${T.btnPrimary} mt-3`}
            disabled={op.busy || reason.length < 3}
            onClick={() =>
              op.run(
                async () => {
                  await api.post(`${FINANCE}/journal/${reverse}/reverse`, { reason });
                  setReverse('');
                  await load();
                },
                loc('تم تسجيل القيد العكسي', 'Reversal posted'),
              )
            }
          >
            {loc('ترحيل العكس', 'Post reversal')}
          </button>
        </Card>
      )}
      <Card title={loc('إغلاق شهر محاسبي', 'Close accounting month')}>
        <div className="flex flex-wrap items-end gap-3">
          <Input label={loc('الشهر', 'Month')} type="month" value={month} onChange={setMonth} />
          <button
            type="button"
            className={T.btnSecondary}
            disabled={op.busy || !month}
            onClick={() =>
              op.run(
                async () => {
                  await api.post(`${FINANCE}/periods/close`, { month });
                  await load();
                },
                loc('تم إغلاق الشهر', 'Month closed'),
              )
            }
          >
            {loc('إغلاق الشهر', 'Close month')}
          </button>
        </div>
        <p className={`mt-3 text-xs ${T.text3}`}>
          {loc(
            'الشهر المغلق يمنع الترحيل والتعديل المالي. راجع الذمم والتكاليف المعلقة قبل الإغلاق.',
            'Closed months block financial posting and edits. Review receivables and pending costs before closing.',
          )}
        </p>
        <p className={`mt-2 text-sm ${T.text2}`}>{data.periods.map((p) => p.month).join(' · ')}</p>
      </Card>
    </div>
  );
}
function Permissions({ config, onChanged }: { config: Config; onChanged: () => Promise<unknown> }) {
  const { loc } = useLabels(),
    op = useOperation();
  const [user, setUser] = useState(''),
    [cap, setCap] = useState('receive'),
    [allowed, setAllowed] = useState(true);
  const capabilities = ['purchase', 'receive', 'count', 'transfer', 'rules', 'pay', 'accounting', 'close'];
  return (
    <div>
      {op.feedback}
      <Card title={loc('صلاحيات العمليات للمديرين', 'Operational permissions for administrators')}>
        <p className={`mb-3 text-xs ${T.text3}`}>
          {loc(
            'المالك يحدد الصلاحيات. صلاحية مالية لا تُمنح لمساعد الإدارة عبر هذا القسم.',
            'The owner sets permissions. This panel cannot grant financial access to assistants.',
          )}
        </p>
        <div className="grid gap-3 sm:grid-cols-3">
          <Select
            label={loc('المدير', 'Administrator')}
            value={user}
            onChange={setUser}
            empty={loc('اختر مديرًا', 'Choose administrator')}
            options={config.admins.map((a) => ({ id: a.id, name: `${nameOf(a)} · ${a.email}` }))}
          />
          <Select
            label={loc('العملية', 'Capability')}
            value={cap}
            onChange={setCap}
            options={capabilities.map((id, i) => ({
              id,
              name: [
                loc('المشتريات', 'Purchases'),
                loc('الاستلام', 'Receiving'),
                loc('الجرد', 'Counting'),
                loc('النقل', 'Transfers'),
                loc('قواعد التكاليف', 'Cost rules'),
                loc('المدفوعات', 'Payments'),
                loc('المحاسبة', 'Accounting'),
                loc('إغلاق الفترات', 'Closing'),
              ][i],
            }))}
          />
          <Select
            label={loc('الصلاحية', 'Permission')}
            value={allowed ? 'yes' : 'no'}
            onChange={(v) => setAllowed(v === 'yes')}
            options={[
              { id: 'yes', name: loc('مسموح', 'Allowed') },
              { id: 'no', name: loc('ممنوع', 'Denied') },
            ]}
          />
        </div>
        <button
          type="button"
          className={`${T.btnPrimary} mt-3`}
          disabled={op.busy || !user}
          onClick={() =>
            op.run(
              async () => {
                await api.put(`${FINANCE}/permissions`, { user_id: user, capability: cap, allowed });
                await onChanged();
              },
              loc('تم حفظ الصلاحية', 'Permission saved'),
            )
          }
        >
          {loc('حفظ', 'Save')}
        </button>
      </Card>
    </div>
  );
}

function PostingErrors() {
  const { loc } = useLabels(),
    op = useOperation(),
    [errors, setErrors] = useState<
      Array<{ event_key: string; order_id: string; message: string; last_attempt_at: string }>
    >([]);
  const load = useCallback(
    async () => setErrors((await api.get<{ errors: typeof errors }>(`${FINANCE}/posting-errors`)).errors),
    [],
  );
  const { run } = op;
  useEffect(() => {
    run(load);
  }, [run, load]);
  return (
    <Card title={loc('عمليات تنتظر الترحيل المالي', 'Operations awaiting financial posting')}>
      {op.feedback}
      <p className={`mb-3 text-xs ${T.text3}`}>
        {loc(
          'إعادة المحاولة تحفظ الحدث الأصلي، وترحّل التصحيح في الفترة الحالية المفتوحة.',
          'Retry retains the original event and posts in the current open period.',
        )}
      </p>
      <DataTable headers={[loc('الطلب', 'Order'), loc('الحدث', 'Event'), loc('سبب التعثر', 'Failure'), '']}>
        {errors.map((e) => (
          <tr key={e.event_key}>
            <Cell>{e.order_id}</Cell>
            <Cell>{e.event_key}</Cell>
            <Cell>{e.message}</Cell>
            <Cell>
              <button
                type="button"
                className={T.btnSecondary}
                disabled={op.busy}
                onClick={() =>
                  op.run(
                    async () => {
                      await api.post(`${FINANCE}/orders/${encodeURIComponent(e.order_id)}/retry-posting`, {});
                      await load();
                    },
                    loc('تمت إعادة الترحيل', 'Posting retried'),
                  )
                }
              >
                {loc('إعادة المحاولة', 'Retry')}
              </button>
            </Cell>
          </tr>
        ))}
      </DataTable>
    </Card>
  );
}
