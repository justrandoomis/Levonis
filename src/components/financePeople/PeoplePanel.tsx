import { useEffect, useRef, useState } from 'react';
import { Check, Pencil, Plus, RotateCcw, Trash2, Users, X } from 'lucide-react';
import WageChangeDialog from './WageChangeDialog';
import WageBasisFields from './WageBasisFields';
import StaffHistorySheet from './StaffHistorySheet';
import { createStaffReconciliationRunner, type ReconciliationActivity, type StaffReconciliation as Reconciliation } from './staffReconciliationRunner';
import ProductPicker from '../adminProducts/form/ProductPicker';
import { NumberInput } from '../ui/NumberInput';
import { Select } from '../ui/Field';
import { AccountPicker, api, Button, dateLabel, Dialog, Empty, Feedback, Field, Input, Loading, Money, PEOPLE, Surface, useLanguage, useMutation, useRemote, type Account, type PanelProps } from './shared';

type Named = { id: string; name?: string; name_ar?: string; name_en?: string; parent_id?: string | null };
type Scope = { catalog_ids: string[]; product_ids: string[]; excluded_product_ids: string[] };
type Staff = { id: string; name: string; role: string; active: number; user_id: string | null; employment_version: number; start_work_date?: string | null; archived_at?: string | null; period?: {earned_iqd:number;paid_iqd:number;adjustments_iqd:number;pending_costs:number}; account_name?: string; account_email?: string; balance?: { staff_net_iqd: number; staff_available_iqd: number; staff_debt_iqd: number; pending_costs?: number } };
type Rule = { id: string; version: number; name: string; staff_id: string | null; amount: number; basis: string; milestone: string; requires_assignment: number; active: number; scope?: Scope; target_type?: string; target_id?: string; cap_iqd?: number | null; group_key?: string; category_id?: string; center_id?: string | null; priority?: number; effective_from?: string; effective_to?: string | null; employment_effective_default?: number };
type StaffWrite = { staff?: Staff; reconciliation?: Reconciliation | null };
type Config = { can_manage_staff?: boolean; staff: Staff[]; catalogs: Named[]; rules: Rule[]; scope_products: Named[]; reconciliations?: Reconciliation[] };
const label = (n: Named | undefined) => n?.name_ar || n?.name || n?.name_en || n?.id || '';
const emptyScope = (): Scope => ({ catalog_ids: [], product_ids: [], excluded_product_ids: [] });
const todayInBaghdad = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Baghdad', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const firstEarningDay = (value: string) => { const day = new Date(`${value}T00:00:00Z`); day.setUTCDate(day.getUTCDate() + 1); return Number.isNaN(day.getTime()) ? '' : day.toISOString().slice(0, 10); };
function ruleScope(rule: Rule): Scope { return rule.scope ?? { catalog_ids: rule.target_type === 'catalog' && rule.target_id ? [rule.target_id] : [], product_ids: rule.target_type === 'product' && rule.target_id ? [rule.target_id] : [], excluded_product_ids: [] }; }

export default function PeoplePanel({ onChanged, from, to, month }: PanelProps = {}) {
  const { loc, lang, dir } = useLanguage();
  const query = new URLSearchParams(from || to ? {from: from || '', to: to || ''} : month ? {month} : {});
  const remote = useRemote<Config>(`${PEOPLE}/staff?${query}`), op = useMutation();
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const [editor, setEditor] = useState<{ rule?: Rule; staff: Staff } | null>(null);
  const [personEditor, setPersonEditor] = useState<{ person?: Staff } | null>(null);
  const [history, setHistory] = useState<Staff | null>(null);
  const [removing, setRemoving] = useState<Staff | null>(null);
  const [rechecking, setRechecking] = useState<{ person: Staff; revision: number; operation_id: string; storageKey: string } | null>(null);
  const [linking, setLinking] = useState<Staff | null>(null), [linkAccount, setLinkAccount] = useState<Account | null>(null);
  const [jobs, setJobs] = useState<Record<string, Reconciliation>>({});
  const refresh = async () => { await remote.load(); if (mounted.current) onChanged?.(); };
  const config = remote.data;
  const canManage = config?.can_manage_staff === true;
  const live = config?.staff.filter((person) => !person.archived_at) ?? [];
  const archived = config?.staff.filter((person) => person.archived_at) ?? [];
  const describe = (rule: Rule) => rule.basis.endsWith('percent') ? `${rule.amount / 100}% ${rule.basis === 'profit_percent' ? loc('من الربح', 'of profit') : loc('من البيع', 'of sales')}` : `${rule.amount.toLocaleString('en-US')} ${loc('د.ع', 'IQD')} ${rule.basis === 'unit' ? loc('لكل قطعة', 'per unit') : loc('لكل طلب', 'per order')}`;
  const backgroundNotice = () => loc('حُفظ التعديل. تظهر حالة احتساب المستحقات أدناه وتتحدث تلقائيًا.', 'Your change is saved. Calculation progress appears below and updates automatically.');
  const [activities, setActivities] = useState<Record<string, ReconciliationActivity>>({});
  const runtime = useRef({ load: remote.load, onChanged });
  runtime.current = { load: remote.load, onChanged };
  const runner = useRef<ReturnType<typeof createStaffReconciliationRunner> | null>(null);
  if (!runner.current) runner.current = createStaffReconciliationRunner({
    advance: async (job) => (await api.post<{ reconciliation: Reconciliation }>(`${PEOPLE}/staff/${encodeURIComponent(job.staff_id)}/reconcile`, { revision: job.revision }, { mascot: 'silent' })).reconciliation,
    read: async (staffId) => (await api.get<{ reconciliation: Reconciliation }>(`${PEOPLE}/staff/${encodeURIComponent(staffId)}/reconcile`, { mascot: 'silent' })).reconciliation,
    refresh: async (final) => { await runtime.current.load(); if (final && mounted.current) runtime.current.onChanged?.(); },
    onJob: (job) => setJobs((old) => ({ ...old, [job.staff_id]: job })),
    onActivity: (staffId, activity) => setActivities((old) => ({ ...old, [staffId]: activity })),
  });
  useEffect(() => {
    const current = runner.current!;
    if (canManage) current.start();
    return () => current.stop();
  }, [canManage]);
  useEffect(() => { if (canManage) runner.current!.sync(config?.reconciliations ?? []); }, [canManage, config?.reconciliations]);
  const reconcile = async (job: Reconciliation, retry = false) => {
    setJobs((old) => ({ ...old, [job.staff_id]: job }));
    if (canManage) { if (retry) runner.current!.retry(job); else runner.current!.sync([job]); }
    return job.state === 'complete';
  };
  const saved = (result: StaffWrite, message = loc('تم حفظ الموظف.', 'Employee saved.')) => {
    setPersonEditor(null); setEditor(null);
    let background = false;
    if (result.reconciliation) { background = result.reconciliation.state !== 'complete'; void reconcile(result.reconciliation); }
    void op.run(refresh, () => background ? backgroundNotice() : message);
  };
  const resume = (job: Reconciliation) => { if (canManage) { op.clear(); void reconcile(job, true); } };
  const latestJob = (person: Staff) => [jobs[person.id], config?.reconciliations?.find((item) => item.staff_id === person.id)].filter((item): item is Reconciliation => !!item).sort((a, b) => b.revision - a.revision || Date.parse(b.updated_at) - Date.parse(a.updated_at) || Number(b.state === 'complete') - Number(a.state === 'complete'))[0];
  const openRecheck = (person: Staff) => {
    const job = latestJob(person);
    if (job && job.state !== 'complete') { resume(job); return; }
    const revision = job?.revision ?? person.employment_version;
    const storageKey = `staff-recheck:${person.id}:${revision}`;
    let operation_id: string = crypto.randomUUID();
    try { const saved = sessionStorage.getItem(storageKey); if (saved) operation_id = saved; else sessionStorage.setItem(storageKey, operation_id); } catch { /* The open dialog still retains its operation ID when storage is unavailable. */ }
    op.clear(); setRechecking({ person, revision, operation_id, storageKey });
  };
  const recheckAction = (person: Staff) => {
    if (!canManage || !(person.period?.pending_costs || person.balance?.pending_costs)) return null;
    const job = latestJob(person), continuing = job && job.state !== 'complete';
    return <div className="fp-row-actions"><Button size="sm" icon={<RotateCcw size={14} />} disabled={op.busy || !!activities[person.id]?.busy} onClick={() => openRecheck(person)}>{continuing ? loc('متابعة فحص الاستحقاقات', 'Continue earnings review') : loc('إعادة فحص الاستحقاقات', 'Recheck earnings')}</Button></div>;
  };
  const jobNotice = (person: Staff) => {
    const job = latestJob(person);
    if (!job) return null;
    if (job.state === 'complete') return person.active && person.start_work_date && job.processed_orders === 0 && config?.rules.some((r) => r.staff_id === person.id && r.active)
      ? <p className="fp-note">{loc('اكتمل الحساب ولم يجد طلبات مسلّمة بعد تاريخ البداية. راجع التاريخ إن كنت تقصد احتساب طلبات أقدم.', 'Calculation complete: no deliveries were found after the start date. Check the date if earlier orders should qualify.')}</p> : <p className="fp-note" role="status">{loc(`اكتمل احتساب المستحقات · تمت مراجعة ${job.processed_orders} طلب`, `Earnings calculation complete · ${job.processed_orders} orders reviewed`)}</p>;
    const activity = activities[person.id];
    return <div className="fp-note"><p role="status">{job.state === 'failed' ? loc('حُفظ التعديل ويحتاج حساب المستحقات إلى متابعة.', 'Saved. The earnings calculation needs to be resumed.') : loc(`احتساب المستحقات السابقة · تمت مراجعة ${job.processed_orders} طلب`, `Calculating past earnings · ${job.processed_orders} orders reviewed`)}</p>{activity?.error && <p role="alert">{activity.error} {activity.retrying ? loc('سنتحقق من التقدم المحفوظ ثم نتابع تلقائيًا.', 'We will verify saved progress and resume automatically.') : loc('تعذرت المتابعة التلقائية؛ أعد المحاولة.', 'Automatic continuation stopped. Please retry.')}</p>}{canManage && !activity?.busy && (job.state === 'failed' || activity?.error && !activity.retrying) && <Button size="sm" className="mt-2" onClick={() => resume(job)}>{loc('متابعة الحساب', 'Continue calculation')}</Button>}</div>;
  };
  return <div className="ap fp fp-stack" dir={dir}>
    <Surface title={loc('الموظفون والأجور', 'Staff and earnings')} hint={loc('أضف الموظف، حدّد تاريخ بدئه، ثم اختر المنتجات والأجر.', 'Add a person and start date, then choose their products and pay.')} action={<Button variant="primary" icon={<Plus size={16} />} disabled={!canManage || op.busy} onClick={() => { op.clear(); setPersonEditor({}); }}>{loc('إضافة موظف', 'Add employee')}</Button>}>
      <Feedback error={op.error} notice={op.notice} />
      {!config ? <Loading error={remote.error} retry={remote.load} /> : <>
        <Feedback error={remote.error} />
        {remote.error && <div className="fp-row-actions"><p className="fp-muted" role="status">{loc('تعذر تحديث الأرصدة المعروضة. أعد تحميلها لمعرفة آخر نتيجة محفوظة.', 'Displayed balances could not refresh. Reload to see the latest saved result.')}</p><Button size="sm" loading={remote.loading} onClick={remote.load}>{loc('تحديث الأرصدة', 'Refresh balances')}</Button></div>}
        {!live.length ? <Empty><Users size={26} className="mb-3" aria-hidden="true" />{loc('أضف أول موظف ليبدأ إعداد أجره.', 'Add your first employee to set up their pay.')}</Empty> : <div className="fp-stack">{live.map((person) => {
          const rules = config.rules.filter((rule) => rule.staff_id === person.id);
          return <article className="fp-rule" key={person.id}>
            <div className="fp-rule-heading fp-staff-heading"><div className="flex items-center gap-3 min-w-0"><span className="fp-avatar" aria-hidden="true">{person.name.slice(0, 1)}</span><div className="min-w-0"><h3>{person.name}</h3><p className="fp-muted">{person.role || loc('موظف', 'Staff')}</p></div></div><span className={`fp-status ${person.active ? 'fp-status-available' : ''}`}>{person.active ? loc('نشط', 'Active') : loc('متوقف', 'Paused')}</span></div>
            {person.start_work_date && <p className="fp-row-meta">{loc('بدء العمل: ', 'Started: ')}{dateLabel(person.start_work_date, lang)} · {loc('الاستحقاق من ', 'Eligible from ')}{dateLabel(firstEarningDay(person.start_work_date), lang)}</p>}
            {person.period && <p className="fp-note">{loc('نتيجة الفترة: مستحق', 'Period: earned')} <Money value={person.period.earned_iqd} /> · {loc('مسدد في الفترة', 'Paid during period')} <Money value={person.period.paid_iqd} /> · {loc('تسويات مسجلة', 'Posted corrections')} <Money value={person.period.adjustments_iqd} />{person.period.pending_costs > 0 && <span> · {person.period.pending_costs} {loc('تكلفة تحتاج مراجعة', 'costs need review')}</span>}</p>}
            {person.balance && <div className="fp-stats"><div className="fp-stat"><span>{loc('الرصيد التراكمي','Cumulative balance')}</span><Money value={person.balance.staff_net_iqd} /></div><div className="fp-stat"><span>{loc('متاح للسحب','Available')}</span><Money value={person.balance.staff_available_iqd} /></div><div className="fp-stat"><span>{loc('الدين المتبقي','Remaining debt')}</span><Money value={person.balance.staff_debt_iqd} /></div></div>}<div className="fp-staff-actions"><Button size="sm" onClick={() => setHistory(person)}>{loc('السجل والتفاصيل','History and details')}</Button><Button size="sm" icon={<Pencil size={14} />} disabled={!canManage || op.busy} onClick={() => { op.clear(); setPersonEditor({ person }); }}>{loc('تعديل بدء العمل والبيانات', 'Edit start date and details')}</Button><Button size="sm" icon={<Plus size={15} />} disabled={!canManage || op.busy || !person.active} onClick={() => setEditor({ staff: person })}>{loc('إضافة أجر', 'Add earning rule')}</Button><Button size="sm" variant="ghost" icon={<Trash2 size={14} />} disabled={!canManage || op.busy} onClick={() => { op.clear(); setRemoving(person); }}>{loc('حذف الموظف', 'Delete employee')}</Button></div>
            {!person.user_id && <div className="fp-rule-heading fp-staff-heading"><p className="fp-muted">{loc('اربط حسابه ليشاهد أرباحه ويطلب السحب.', 'Link an account for earnings and withdrawals.')}</p><Button size="sm" disabled={!canManage || op.busy} onClick={() => { setLinking(person); setLinkAccount(null); op.clear(); }}>{loc('ربط الحساب', 'Link account')}</Button></div>}
            {jobNotice(person)}
            {recheckAction(person)}
            {rules.length === 0 ? <p className="fp-muted">{loc('لم تُضف قاعدة أجور بعد.', 'No earning rule yet.')}</p> : rules.map((rule) => {
              const scope = ruleScope(rule), all = !scope.catalog_ids.length && !scope.product_ids.length;
              return <div key={rule.id} className="fp-detail"><div className="fp-rule-heading"><strong>{describe(rule)}</strong><Button size="sm" variant="ghost" icon={<Pencil size={14} />} disabled={!canManage || op.busy || !person.active} onClick={() => setEditor({ rule, staff: person })}>{loc('تغيير الأجر', 'Change pay')}</Button></div><div className="fp-chips mt-2">{all && <span className="fp-status">{loc('كل المنتجات', 'All products')}</span>}{scope.catalog_ids.map((id) => <span className="fp-status" key={id}>{config.catalogs.find((c) => c.id === id) ? label(config.catalogs.find((c) => c.id === id)) : loc('قسم', 'Category')}</span>)}{scope.product_ids.map((id) => <span className="fp-status" key={id}>{config.scope_products?.find((p) => p.id === id) ? label(config.scope_products.find((p) => p.id === id)) : loc('منتج محدد', 'Selected product')}</span>)}{scope.excluded_product_ids.length > 0 && <span className="fp-status fp-status-rejected">{loc(`باستثناء ${scope.excluded_product_ids.length} منتج`, `${scope.excluded_product_ids.length} product exclusions`)}</span>}{!rule.active && <span className="fp-status">{loc('متوقفة', 'Paused')}</span>}</div><p className="fp-row-meta">{rule.milestone === 'prepared' && !person.start_work_date ? loc('عند إنجاز التجهيز', 'On preparation') : loc('عند التسليم', 'On delivery')}{rule.requires_assignment ? loc(' · يتطلب إسناد العمل', ' · requires assignment') : ''}</p>{((rule.employment_effective_default !== 1 && rule.effective_from) || rule.effective_to) && <p className="fp-row-meta">{loc('نفاذ محدد للقاعدة: ', 'Rule date limits: ')}{rule.employment_effective_default !== 1 && rule.effective_from && <>{loc('من ', 'from ')}{dateLabel(rule.effective_from, lang)} </>}{rule.effective_to && <>{loc('حتى ', 'through ')}{dateLabel(rule.effective_to, lang)}</>}</p>}</div>;
            })}
          </article>;
        })}</div>}
        {archived.length > 0 && <details className="fp-detail"><summary>{loc(`موظفون محذوفون (${archived.length})`, `Deleted employees (${archived.length})`)}</summary><div className="fp-stack">{archived.map((person) => <article key={person.id} className="fp-rule"><div className="fp-rule-heading fp-staff-heading"><div><h3>{person.name}</h3><p className="fp-muted">{loc('السجل والمستحقات السابقة محفوظة.', 'Previous earnings and history are preserved.')}</p></div><Button size="sm" icon={<RotateCcw size={14} />} loading={op.busy} disabled={!canManage} onClick={() => { let background = false; return op.run(async () => { const result = await api.patch<StaffWrite>(`${PEOPLE}/staff/${encodeURIComponent(person.id)}`, { active: true, restore: true }); await refresh(); if (result.reconciliation) { background = !await reconcile(result.reconciliation); if (mounted.current) await refresh(); } }, () => background ? backgroundNotice() : loc('تمت إعادة الموظف.', 'Employee restored.')); }}>{loc('إعادة الموظف', 'Restore employee')}</Button></div>{jobNotice(person)}{recheckAction(person)}</article>)}</div></details>}
      </>}
    </Surface>
    {personEditor && <StaffEditor person={personEditor.person} onClose={() => setPersonEditor(null)} onSaved={saved} />}
    {history && <StaffHistorySheet staff={history} onClose={() => setHistory(null)} />}
    {editor && config && (editor.rule ? <WageChangeDialog rule={editor.rule} staff={editor.staff} catalogs={config.catalogs} products={config.scope_products} onClose={() => setEditor(null)} onSaved={(result) => saved(result, loc('تم تسجيل تغيير الأجر والتسوية.', 'Pay change and adjustment recorded.'))} /> : <RuleBuilder config={config} initial={editor} onClose={() => setEditor(null)} onSaved={(result) => saved(result, loc('تم حفظ الأجر.', 'Pay saved.'))} />)}
    <Dialog open={!!rechecking} onClose={() => setRechecking(null)} title={loc('إعادة فحص الاستحقاقات', 'Recheck earnings')} busy={op.busy}>
      <p className="fp-note">{loc(`سيُعاد فحص الطلبات المسلّمة الخاصة بـ ${rechecking?.person.name ?? ''} باستخدام تواريخ العمل وقواعد الأجر المحفوظة ومصادر التكلفة الحالية. تُسجّل فروق الاستحقاق فقط، مع الحفاظ على المدفوعات والتعديلات اليدوية السابقة.`, `Delivered orders for ${rechecking?.person.name ?? ''} will be checked using saved employment dates, wage rules and current cost sources. Only earning differences are posted; earlier payments and manual adjustments remain recorded.`)}</p>
      <p className="fp-muted">{loc('يشمل الفحص جميع الفترات، وليس مرشح التاريخ المعروض فقط. أي تكلفة غير معروفة تبقى معلّقة مع بيان المطلوب.', 'The review covers all periods, beyond the displayed date filter. Unknown costs remain pending with an explanation of what is needed.')}</p>
      <Feedback error={op.error} />
      <footer className="fp-footer"><Button variant="ghost" disabled={op.busy} onClick={() => setRechecking(null)}>{loc('إلغاء', 'Cancel')}</Button><Button variant="primary" loading={op.busy} disabled={!canManage} onClick={() => op.run(async () => {
        const request = rechecking; if (!request) return;
        const result = await api.post<StaffWrite>(`${PEOPLE}/staff/${encodeURIComponent(request.person.id)}/recheck`, { revision: request.revision, operation_id: request.operation_id, reason: 'إعادة فحص الاستحقاقات بعد مراجعة مصدر التكلفة' }, { mascot: 'silent' });
        if (result.reconciliation) await reconcile(result.reconciliation);
        try { sessionStorage.removeItem(request.storageKey); } catch { /* The completed operation is already stored on the server. */ }
        setRechecking(null); await refresh();
      }, loc('بدأ فحص الاستحقاقات. يظهر التقدم مع الموظف ويتابع تلقائيًا.', 'Earnings review started. Progress appears with the employee and continues automatically.'))}>{loc('تأكيد وإعادة الفحص', 'Confirm and recheck')}</Button></footer>
    </Dialog>
    <Dialog open={!!removing} onClose={() => setRemoving(null)} title={loc('حذف الموظف', 'Delete employee')} busy={op.busy}>
      <p className="fp-note">{loc(`سيُزال ${removing?.name ?? ''} من الموظفين النشطين وتتوقف مستحقاته الجديدة. تبقى الأرباح والسحوبات السابقة وحسابه محفوظة، ويمكنك إعادته لاحقًا.`, `${removing?.name ?? ''} will leave the active list and stop earning new pay. Past earnings, withdrawals and the user account are preserved. You can restore this employee later.`)}</p><Feedback error={op.error} />
      <footer className="fp-footer"><Button variant="ghost" disabled={op.busy} onClick={() => setRemoving(null)}>{loc('رجوع', 'Back')}</Button><Button variant="danger" loading={op.busy} disabled={!canManage} onClick={() => { const person = removing; if (!person) return; let background = false; return op.run(async () => { const result = await api.delete<StaffWrite>(`${PEOPLE}/staff/${encodeURIComponent(person.id)}`); setRemoving(null); await refresh(); if (result.reconciliation) { background = !await reconcile(result.reconciliation); if (mounted.current) await refresh(); } }, () => background ? backgroundNotice() : loc('حُذف الموظف من القائمة النشطة وحُفظ سجله.', 'Employee removed from the active list; history preserved.')); }}>{loc('حذف الموظف', 'Delete employee')}</Button></footer>
    </Dialog>
    <Dialog open={!!linking} onClose={() => setLinking(null)} title={loc('ربط حساب الموظف', 'Link staff account')} busy={op.busy}><AccountPicker value={linkAccount} onChange={setLinkAccount} /><Feedback error={op.error} /><footer className="fp-footer"><Button variant="ghost" disabled={op.busy} onClick={() => setLinking(null)}>{loc('رجوع', 'Back')}</Button><Button variant="primary" loading={op.busy} disabled={!canManage || !linkAccount} onClick={() => { const person = linking, account = linkAccount; if (!person || !account) return; let background = false; return op.run(async () => { const result = await api.patch<StaffWrite>(`${PEOPLE}/staff/${encodeURIComponent(person.id)}`, { user_id: account.id }); setLinking(null); await refresh(); if (result.reconciliation) { background = !await reconcile(result.reconciliation); if (mounted.current) await refresh(); } }, () => background ? backgroundNotice() : loc('تم ربط الحساب.', 'Account linked.')); }}>{loc('ربط الحساب', 'Link account')}</Button></footer></Dialog>
  </div>;
}

function StaffEditor({ person, onClose, onSaved }: { person?: Staff; onClose: () => void; onSaved: (result: StaffWrite) => void }) {
  const { loc, lang } = useLanguage(), op = useMutation();
  const [account, setAccount] = useState<Account | null>(null), [name, setName] = useState(person?.name ?? '');
  const [role, setRole] = useState(person?.role ?? ''), [startDate, setStartDate] = useState(person ? person.start_work_date ?? '' : todayInBaghdad()), [active, setActive] = useState(person ? !!person.active : true);
  const eligibleDay = firstEarningDay(startDate);
  const dirty = person ? name !== person.name || role !== person.role || startDate !== (person.start_work_date ?? '') || active !== !!person.active : !!account;
  const valid = person ? !!name.trim() && (!startDate || !!eligibleDay) : !!account && !!eligibleDay;
  const save = () => op.run(async () => {
    if (!valid) return;
    const value = { name: name.trim() || account?.name || account?.email, role: role.trim(), start_work_date: startDate || null, active };
    const result = person ? await api.patch<StaffWrite>(`${PEOPLE}/staff/${encodeURIComponent(person.id)}`, value) : await api.post<StaffWrite>(`${PEOPLE}/staff`, { ...value, user_id: account?.id });
    onSaved(result);
  });
  return <Dialog open title={person ? loc('تعديل الموظف', 'Edit employee') : loc('إضافة موظف', 'Add employee')} onClose={onClose} dirty={dirty} busy={op.busy}>
    <div className="fp-stack">
      {!person && <AccountPicker value={account} onChange={setAccount} />}
      {person && <Field label={loc('اسم الموظف', 'Employee name')} required><Input value={name} maxLength={120} onChange={(event) => setName(event.target.value)} autoComplete="off" /></Field>}
      <Field label={loc('تاريخ بدء العمل', 'Work start date')} required={!person} hint={eligibleDay ? loc(`تبدأ أهلية الطلبات المسلّمة من ${dateLabel(eligibleDay, lang)} بتوقيت بغداد. تُراجع الطلبات السابقة بحسب قواعد الأجر.`, `Delivered orders become eligible from ${dateLabel(eligibleDay, lang)} in Baghdad time. Past orders are reviewed under the earning rules.`) : loc('بلا تاريخ محدد؛ تبقى قواعد الاستحقاق الحالية كما هي.', 'No date set; existing earning rules remain unchanged.')}><Input type="date" value={startDate} onChange={(event) => setStartDate(event.target.value)} dir="ltr" /></Field>
      <Field label={loc('المسمى الوظيفي', 'Job title')} optional><Input value={role} maxLength={120} onChange={(event) => setRole(event.target.value)} placeholder={loc('مثال: تجهيز الطلبات', 'e.g. Order preparation')} autoComplete="organization-title" /></Field>
      {person && <Field label={loc('الحالة', 'Status')}><Select value={active ? 'active' : 'paused'} onChange={(event) => setActive(event.target.value === 'active')}><option value="active">{loc('نشط', 'Active')}</option><option value="paused">{loc('متوقف مؤقتًا', 'Paused')}</option></Select></Field>}
      <Feedback error={op.error} />
    </div>
    <footer className="fp-footer"><Button variant="ghost" disabled={op.busy} onClick={onClose}>{loc('رجوع', 'Back')}</Button><Button variant="primary" loading={op.busy} disabled={!valid || !!person && !dirty} onClick={save}>{person ? loc('حفظ التعديل', 'Save changes') : loc('إضافة الموظف', 'Add employee')}</Button></footer>
  </Dialog>;
}

function RuleBuilder({ config, initial, onClose, onSaved }: { config: Config; initial: { rule?: Rule; staff: Staff }; onClose: () => void; onSaved: (result: StaffWrite) => void }) {
  const { loc, lang } = useLanguage(), op = useMutation();
  const existing = initial.rule;
  const [step, setStep] = useState(existing ? 1 : 0);
  const originalScope = existing ? ruleScope(existing) : emptyScope();
  const [scope, setScope] = useState<Scope>(originalScope), [mode, setMode] = useState(originalScope.catalog_ids.length ? 'categories' : originalScope.product_ids.length ? 'products' : 'all');
  const [products, setProducts] = useState<Named[]>(config.scope_products ?? []);
  const [basis, setBasis] = useState(existing?.basis ?? 'unit'), [amount, setAmount] = useState<number | null>(existing ? existing.amount / (existing.basis.endsWith('percent') ? 100 : 1) : null), [milestone, setMilestone] = useState(initial.staff.start_work_date ? 'delivered' : existing?.milestone ?? 'delivered'), [assignment, setAssignment] = useState(!!existing?.requires_assignment), [active, setActive] = useState(existing ? !!existing.active : true), [cap, setCap] = useState<number | null>(existing?.cap_iqd ?? null), [name, setName] = useState(existing?.name ?? '');
  const [quantity, setQuantity] = useState<number | null>(6), [sampleProfit, setSampleProfit] = useState<number | null>(100000);
  const isPercent = basis.endsWith('percent'), accountName = initial.staff.name;
  const employmentFrom = initial.staff.start_work_date ? firstEarningDay(initial.staff.start_work_date) : '';
  const explicitFrom = existing?.employment_effective_default !== 1 ? existing?.effective_from ?? '' : '';
  const effectiveFrom = explicitFrom > employmentFrom ? explicitFrom : employmentFrom;
  const canNext = step === 0 ? mode === 'all' || (mode === 'categories' ? scope.catalog_ids.length > 0 : scope.product_ids.length > 0) : amount != null && amount > 0 && (!isPercent || amount <= 100);
  const calculation = amount == null ? 0 : basis === 'unit' ? amount * (quantity ?? 0) : basis === 'order' ? amount : Math.floor((sampleProfit ?? 0) * Math.round(amount * 100) / 10000);
  const toggle = (key: keyof Scope, id: string) => setScope((s) => ({ ...s, [key]: s[key].includes(id) ? s[key].filter((x) => x !== id) : [...s[key], id] }));
  const chooseMode = (next: string) => { setMode(next); setScope((s) => ({ ...s, catalog_ids: next === 'categories' ? s.catalog_ids : [], product_ids: next === 'products' ? s.product_ids : [] })); };
  const addProduct = (key: 'product_ids' | 'excluded_product_ids', id: string, p: Named | null) => {
    if (!id || !p) return;
    setProducts((old) => [...old.filter((x) => x.id !== id), p]);
    setScope((s) => ({ ...s, [key]: s[key].includes(id) ? s[key] : [...s[key], id] }));
  };
  const save = () => op.run(async () => {
    if (amount == null || amount <= 0) return;
    const payload = { ...existing, staff_id: initial.staff.id, name: name || undefined, basis, amount: isPercent ? Math.round(amount * 100) : amount, scope, milestone, requires_assignment: assignment ? 1 : 0, active, cap_iqd: cap, target_type: 'all', target_id: '' };
    const result = existing ? await api.put<StaffWrite>(`/api/admin/finance-operations/rules/${encodeURIComponent(existing.id)}`, payload) : await api.post<StaffWrite>('/api/admin/finance-operations/rules', payload);
    onSaved(result);
  });
  const productList = (key: 'product_ids' | 'excluded_product_ids') => <div className="fp-stack"><div className="fp-chips">{scope[key].map((id) => <button key={id} type="button" className={`fp-chip ${key === 'excluded_product_ids' ? 'fp-chip-excluded' : 'fp-chip-selected'}`} onClick={() => toggle(key, id)} aria-label={loc(`إزالة ${label(products.find((p) => p.id === id) ?? { id })}`, `Remove ${label(products.find((p) => p.id === id) ?? { id })}`)}><span>{label(products.find((p) => p.id === id) ?? { id })}</span><X size={13} aria-hidden="true" /></button>)}</div><ProductPicker value="" keepOpen excludeComposition={false} ariaLabel={key === 'product_ids' ? loc('ابحث عن منتج مشمول', 'Search eligible products') : loc('ابحث عن منتج مستثنى', 'Search excluded products')} onChange={(id, p) => addProduct(key, id, p)} /></div>;
  return <Dialog open onClose={onClose} busy={op.busy} dirty title={existing ? loc('تعديل قاعدة الأجر', 'Edit earning rule') : loc('إعداد الأجر', 'Set up earnings')}>
    <p className="fp-muted mb-3">{accountName}</p><ol className="fp-steps">{[loc('المشمول', 'Scope'), loc('الأجر', 'Pay'), loc('المراجعة', 'Review')].map((text, i) => <li key={i} aria-current={step === i ? 'step' : undefined} data-done={step > i}>{i + 1}. {text}</li>)}</ol>
    <Feedback error={op.error} />
    {step === 0 && <div className="fp-stack"><div className="fp-chips">{[['all', loc('كل المنتجات', 'All products')], ['categories', loc('أقسام معينة', 'Categories')], ['products', loc('منتجات معينة', 'Products')]].map(([id, text]) => <button type="button" className="fp-chip" aria-pressed={mode === id} key={id} onClick={() => chooseMode(id)}>{text}</button>)}</div>{mode === 'categories' && <div className="fp-chips">{config.catalogs.map((c) => <button type="button" key={c.id} className="fp-chip" aria-pressed={scope.catalog_ids.includes(c.id)} onClick={() => toggle('catalog_ids', c.id)}>{scope.catalog_ids.includes(c.id) && <Check size={14} aria-hidden="true" />}{label(c)}</button>)}</div>}{mode === 'products' && productList('product_ids')}<details className="fp-detail" open={scope.excluded_product_ids.length > 0 || undefined}><summary>{loc('استثناء منتجات', 'Exclude products')}{scope.excluded_product_ids.length > 0 ? ` (${scope.excluded_product_ids.length})` : ''}</summary>{productList('excluded_product_ids')}</details><p className="fp-note">{loc('الأقسام تشمل أقسامها الفرعية. المنتج المستثنى لا يولّد أجرًا لهذه القاعدة.', 'Categories include their children. Excluded products do not earn pay under this rule.')}</p></div>}
    {step === 1 && <div className="fp-stack"><WageBasisFields basis={basis} amount={amount} onBasisChange={setBasis} onAmountChange={setAmount} cap={cap} /><details className="fp-detail"><summary>{loc('خيارات إضافية', 'More options')}</summary><div className="fp-stack">{!initial.staff.start_work_date && <Field label={loc('الاستحقاق عند', 'Earned when')}><Select value={milestone} onChange={(e) => setMilestone(e.target.value)}><option value="delivered">{loc('تسليم الطلب', 'Order delivery')}</option><option value="prepared">{loc('إنجاز التجهيز', 'Preparation complete')}</option></Select></Field>}<label className="fp-check"><input type="checkbox" checked={assignment} onChange={(e) => setAssignment(e.target.checked)} />{loc('يتطلب إسناد المهمة لهذا الموظف', 'Requires assigning the task to this employee')}</label><Field label={loc('سقف الأجر', 'Pay cap')} optional><NumberInput kind="money" value={cap} onValueChange={(n, valid) => setCap(valid ? n : null)} /></Field><Field label={loc('اسم القاعدة', 'Rule name')} optional><Input value={name} onChange={(e) => setName(e.target.value)} /></Field><label className="fp-check"><input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />{loc('القاعدة فعّالة', 'Rule enabled')}</label></div></details></div>}
    {step === 2 && <div className="fp-stack"><div className="fp-account"><span className="fp-avatar" aria-hidden="true">{accountName.slice(0, 1)}</span><div><strong>{accountName}</strong><p>{isPercent ? `${amount}% ${basis === 'profit_percent' ? loc('من الربح', 'of profit') : loc('من البيع', 'of sales')}` : `${amount?.toLocaleString('en-US')} ${loc('د.ع', 'IQD')} ${basis === 'unit' ? loc('لكل قطعة', 'per unit') : loc('لكل طلب', 'per order')}`}</p></div></div><p className="fp-note">{mode === 'all' ? loc('تشمل جميع المنتجات', 'All products included') : mode === 'categories' ? scope.catalog_ids.map((id) => label(config.catalogs.find((c) => c.id === id) ?? { id })).join('، ') : scope.product_ids.map((id) => label(products.find((p) => p.id === id) ?? { id })).join('، ')}{scope.excluded_product_ids.length > 0 && <> · {loc(`باستثناء ${scope.excluded_product_ids.length} منتج`, `${scope.excluded_product_ids.length} exclusions`)}</>}</p><details className="fp-detail"><summary>{loc('تجربة الحساب', 'Try the calculation')}</summary><div className="fp-stack">{basis === 'unit' && <Field label={loc('عدد القطع المشمولة', 'Eligible quantity')}><NumberInput kind="quantity" min={1} value={quantity} onValueChange={(n) => setQuantity(n)} /></Field>}{isPercent && <Field label={basis === 'profit_percent' ? loc('ربح المنتجات المشمولة', 'Eligible product profit') : loc('صافي مبيعات المنتجات المشمولة', 'Eligible net sales')}><NumberInput kind="money" value={sampleProfit} onValueChange={(n) => setSampleProfit(n)} /></Field>}<div className="fp-rule-heading"><span>{loc('الأجر في هذا المثال', 'Pay in this example')}</span><Money value={cap == null ? calculation : Math.min(cap, calculation)} /></div><p className="fp-muted">{loc('هذه معاينة فقط ولا تسجل أي مستحقات.', 'This preview does not create earnings.')}</p></div></details><p className="fp-muted">{initial.staff.start_work_date ? loc(`تُراجع الطلبات المسلّمة المؤهلة من ${dateLabel(effectiveFrom, lang)} بتوقيت بغداد لحساب المستحقات السابقة.`, `Eligible delivered orders from ${dateLabel(effectiveFrom, lang)} in Baghdad time are reviewed for past earnings.`) : loc('تسري القاعدة حسب تاريخها الحالي. أضف تاريخ بدء العمل لاحتساب الطلبات السابقة.', 'The current rule start date applies. Add a work start date to calculate past orders.')}{existing?.effective_to && <> {loc('تنتهي أهلية هذه القاعدة في ', 'This rule ends on ')}{dateLabel(existing.effective_to, lang)}.</>}</p></div>}
    <footer className="fp-footer"><Button variant="ghost" disabled={op.busy} onClick={() => step ? setStep(step - 1) : onClose()}>{step ? loc('السابق', 'Back') : loc('إلغاء', 'Cancel')}</Button>{step < 2 ? <Button variant="primary" disabled={!canNext} onClick={() => setStep(step + 1)}>{loc('التالي', 'Continue')}</Button> : <Button variant="primary" loading={op.busy} onClick={save}>{loc('حفظ القاعدة', 'Save rule')}</Button>}</footer>
  </Dialog>;
}
export { PeoplePanel };
