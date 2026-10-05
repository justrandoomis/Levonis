import { Hono } from 'hono';
import type { AppContext } from '../lib/types';
import { requireAdmin, badRequest, conflict, forbidden, notFound, str } from '../lib/http';
import { isOwner, canViewFinancials } from '../lib/adminScope';
import { newId } from '../lib/crypto';
import { audit } from '../lib/audit';
import {
  baghdadDay,
  dateValue,
  fence,
  journalPlan,
  periodOpen,
  requireCapability,
  whole,
  type Capability,
  type JournalLine,
} from '../lib/operations';
import { settleAdvance } from '../lib/payrollAdvance';
import { validateRuleScope, readRuleScope } from '../lib/financeRuleScopes';
import { commitParticipantStatements, effectiveStaffCostSql, heldSourceSql, staffAdvanceSql, staffPaymentBudget, staffReconciliationBlockedSql } from '../lib/financeParticipants';
import { reconcileFinanceOrder } from '../lib/financeReconcile';
import { orderGoods, postStoredRefund, runOrderFinancialEffects, type CostRule } from '../lib/orderFinance';
import { operationsReport } from '../lib/operationsReport';
import { wageVersionStatement } from '../lib/financeWageTimeline';
import { nextEmploymentDay, queueStaffReconciliation, readStaff, updateStaffEmployment } from '../lib/financeEmployment';

export const adminFinanceOperationsRoutes = new Hono<AppContext>();
adminFinanceOperationsRoutes.use('*', requireAdmin);
const text = (v: unknown, max = 200) => str(v, 'text', { max, required: false }) ?? '';
adminFinanceOperationsRoutes.get('/config', async (c) => {
  if (!canViewFinancials(c.env, c.get('user')!)) throw forbidden('هذه الشاشة تتطلب صلاحية مالية');
  const db = c.env.DB;
  const [staff, centers, categories, catalogs, accounts, permissions, admins, groups] = await Promise.all([
    db.prepare('SELECT * FROM finance_staff ORDER BY name').all(),
    db.prepare('SELECT * FROM finance_cost_centers ORDER BY name').all(),
    db.prepare('SELECT id,name_ar,name_en FROM expense_categories WHERE active=1 ORDER BY sort').all(),
    db
      .prepare(
        'SELECT id,parent_id,name_ar,name_en,is_printer_catalog FROM catalogs WHERE active=1 ORDER BY sort',
      )
      .all(),
    db.prepare('SELECT * FROM accounting_accounts ORDER BY code').all(),
    db.prepare('SELECT * FROM ops_permissions').all(),
    db.prepare("SELECT id,name,email,admin_scope FROM users WHERE role='admin' ORDER BY name").all(),
    db
      .prepare('SELECT DISTINCT group_key FROM finance_cost_rules WHERE active=1 ORDER BY group_key')
      .all<{ group_key: string }>(),
  ]);
  return c.json({
    success: true,
    staff: staff.results ?? [],
    centers: centers.results ?? [],
    categories: categories.results ?? [],
    catalogs: catalogs.results ?? [],
    accounts: accounts.results ?? [],
    permissions: permissions.results ?? [],
    admins: admins.results ?? [],
    work_groups: (groups.results ?? []).map((r) => r.group_key),
  });
});
for (const [path, table] of [
  ['staff', 'finance_staff'],
  ['centers', 'finance_cost_centers'],
] as const) {
  adminFinanceOperationsRoutes.post(`/${path}`, async (c) => {
    const user = c.get('user')!;
    await requireCapability(c.env, user, 'rules');
    const b = await c.req.json<Record<string, unknown>>(),
      id = newId(path === 'staff' ? 'staff' : 'cc');
    if (path === 'staff')
      await c.env.DB.prepare('INSERT INTO finance_staff(id,name,role) VALUES (?,?,?)')
        .bind(id, str(b.name, 'الاسم', { min: 1, max: 120 }), text(b.role, 120))
        .run();
    else
      await c.env.DB.prepare(`INSERT INTO ${table}(id,name) VALUES (?,?)`)
        .bind(id, str(b.name, 'الاسم', { min: 1, max: 120 }))
        .run();
    return c.json({ success: true, id });
  });
  adminFinanceOperationsRoutes.patch(`/${path}/:id`, async (c) => {
    const user = c.get('user')!;
    await requireCapability(c.env, user, 'rules');
    const b = await c.req.json<Record<string, unknown>>();
    if(path==='staff'&&!isOwner(c.env,user))throw forbidden('تعديل بدء العمل للأدمن الرئيسي فقط');
    if(path==='staff')return c.json({success:true,id:c.req.param('id'),...await updateStaffEmployment(c.env.DB,c.req.param('id'),b,user.id)});
    await c.env.DB.prepare(`UPDATE ${table} SET name=?,active=? WHERE id=?`)
      .bind(str(b.name, 'الاسم', { min: 1, max: 120 }), b.active === false ? 0 : 1, c.req.param('id'))
      .run();
    return c.json({ success: true });
  });
}
adminFinanceOperationsRoutes.get('/rules', async (c) => {
  await requireCapability(c.env, c.get('user')!, 'rules');
  const { results } = await c.env.DB.prepare(
    'SELECT r.*,s.name AS staff_name,c.name AS center_name FROM finance_cost_rules r LEFT JOIN finance_staff s ON s.id=r.staff_id LEFT JOIN finance_cost_centers c ON c.id=r.center_id ORDER BY r.active DESC,r.name',
  ).all();
  return c.json({ success: true, rules: (results ?? []).map((r) => ({ ...r, scope: readRuleScope(r as unknown as CostRule) })) });
});
async function ruleValues(
  db: D1Database,
  b: Record<string, unknown>,
  actor: string,
  id: string,
  version: number,
  createdAt: string,
): Promise<CostRule & { active: number; created_by: string; scope_json: string }> {
  const target = text(b.target_type, 20) || 'all',
    basis = text(b.basis, 30) || 'unit',
    milestone = b.milestone === 'prepared' ? 'prepared' : 'delivered';
  if (
    !['all', 'catalog', 'product'].includes(target) ||
    !['unit', 'order', 'profit_percent', 'revenue_percent'].includes(basis)
  )
    throw badRequest('نوع القاعدة غير صحيح');
  const targetId = target === 'all' ? '' : text(b.target_id, 60);
  if (
    target !== 'all' &&
    !(await db
      .prepare(`SELECT id FROM ${target === 'product' ? 'products' : 'catalogs'} WHERE id=?`)
      .bind(targetId)
      .first())
  )
    throw badRequest('اختر القسم أو المنتج');
  const scope = b.scope == null ? null : await validateRuleScope(db,b.scope);
  const staffId = text(b.staff_id, 60) || null;
  const staff = staffId ? await db.prepare('SELECT id,name,start_work_date FROM finance_staff WHERE id=? AND active=1 AND archived_at IS NULL').bind(staffId).first<{id:string;name:string;start_work_date:string|null}>() : null;
  if(staffId && !staff) throw badRequest('اختر موظفًا نشطًا من القائمة');
  let category = text(b.category_id, 60);
  if(!category) {
    await db.prepare("INSERT OR IGNORE INTO expense_categories(id,slug,name_ar,name_en) VALUES ('finance_staff_wages','finance-staff-wages','أجور الموظفين','Staff wages')").run();
    category='finance_staff_wages';
  }
  if (!(await db.prepare('SELECT id FROM expense_categories WHERE id=? AND active=1').bind(category).first()))
    throw badRequest('اختر تصنيف المصروف');
  const from = dateValue(b.effective_from, staff?.start_work_date?nextEmploymentDay(staff.start_work_date):baghdadDay()),
    to = b.effective_to ? dateValue(b.effective_to) : null;
  if (to && to < from) throw badRequest('تاريخ نهاية القاعدة يسبق البداية');
  return {
    id,
    version,
    name: text(b.name,120) || (staff ? `أجر ${staff.name}` : 'تكلفة تشغيل'),
    group_key: text(b.group_key,80) || (staffId ? `staff:${staffId}:${milestone}` : `overhead:${id}`),
    scope_json: scope ? JSON.stringify(scope) : '{}',
    target_type: target as CostRule['target_type'],
    target_id: targetId,
    basis: basis as CostRule['basis'],
    amount: whole(b.amount, 'المبلغ أو النسبة', 0, basis.endsWith('percent') ? 10000 : 1e9),
    staff_id: staffId,
    category_id: category,
    center_id: text(b.center_id, 60) || null,
    milestone,
    requires_assignment: b.requires_assignment ? 1 : 0,
    cap_iqd: b.cap_iqd == null || b.cap_iqd === '' ? null : whole(b.cap_iqd, 'السقف'),
    priority: whole(b.priority ?? 0, 'الأولوية', 0, 10000),
    effective_from: from,
    employment_effective_default:staff?.start_work_date&&(b.effective_from===undefined||b.employment_effective_default===1)?1:0,
    effective_to: to,
    created_at: createdAt,
    created_by: actor,
    active: b.active === false ? 0 : 1,
  };
}
adminFinanceOperationsRoutes.post('/rules', async (c) => {
  const user = c.get('user')!;
  await requireCapability(c.env, user, 'rules');
  if(!isOwner(c.env,user))throw forbidden('تعديل الأجور والنسب للأدمن الرئيسي فقط');
  const b = await c.req.json<Record<string, unknown>>(),
    id = newId('rule'),
    now = new Date().toISOString(),
    r = await ruleValues(c.env.DB, b, user.id, id, 1, now);
  const keys = Object.keys(r);
  const statements=[
    c.env.DB.prepare(
      `INSERT INTO finance_cost_rules(${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`,
    ).bind(...Object.values(r)),
    c.env.DB.prepare(
      'INSERT INTO finance_rule_versions(rule_id,version,snapshot,created_at,actor_id) VALUES (?,1,?,?,?)',
    ).bind(id, JSON.stringify(r), now, user.id),
  ];
  if(r.staff_id)statements.push(wageVersionStatement(c.env.DB,r,user.id,'إنشاء قاعدة الأجر',now));
  const staff=r.staff_id?await readStaff(c.env.DB,r.staff_id):null;
  const reconciliation=staff?.start_work_date?await queueStaffReconciliation(c.env.DB,staff.id,user.id,statements,true,{...r}):null;
  if(!staff?.start_work_date)await c.env.DB.batch(statements);
  await audit(c.env.DB, user.id, 'finance.rule_created', id, {});
  return c.json({ success: true, id, reconciliation });
});
adminFinanceOperationsRoutes.put('/rules/:id', async (c) => {
  const user = c.get('user')!;
  await requireCapability(c.env, user, 'rules');
  const b = await c.req.json<Record<string, unknown>>(),
    db = c.env.DB,
    id = c.req.param('id'),
    old = await db.prepare('SELECT * FROM finance_cost_rules WHERE id=?').bind(id).first<CostRule>();
  if (!old) throw notFound('Rule not found');
  if(old.staff_id)throw conflict('استخدم تغيير الأجر بتاريخ سريان ومعاينة الأثر','WAGE_PREVIEW_REQUIRED');
  if (whole(b.version, 'version', 1) !== old.version) throw conflict('تغيرت القاعدة؛ حدّث الصفحة');
  const r = await ruleValues(db, b, user.id, id, old.version + 1, old.created_at),
    keys = Object.keys(r).filter((k) => k !== 'id');
  const statements=[
    ...fence(db, 'EXISTS(SELECT 1 FROM finance_cost_rules WHERE id=? AND version=?)', [id, old.version]),
    db
      .prepare(`UPDATE finance_cost_rules SET ${keys.map((k) => `${k}=?`).join(',')} WHERE id=?`)
      .bind(...keys.map((k) => r[k as keyof typeof r]), id),
    db
      .prepare(
        'INSERT INTO finance_rule_versions(rule_id,version,snapshot,created_at,actor_id) VALUES (?,?,?,?,?)',
      )
      .bind(id, r.version, JSON.stringify(r), new Date().toISOString(), user.id),
  ];
  const staff=r.staff_id?await readStaff(db,r.staff_id):null;
  const reconciliation=staff?.start_work_date?await queueStaffReconciliation(db,staff.id,user.id,statements,true,{...r}):null;
  if(!staff?.start_work_date)await db.batch(statements);
  await audit(db, user.id, 'finance.rule_updated', id, { version: r.version });
  return c.json({ success: true, id, reconciliation });
});
adminFinanceOperationsRoutes.get('/costs', async (c) => {
  await requireCapability(c.env, c.get('user')!, 'rules');
  const orderId = text(c.req.query('order_id'), 60),
    staffId = text(c.req.query('staff_id'), 60),
    offset = whole(c.req.query('offset') ?? 0, 'offset', 0, 100000);
  const { results } = await c.env.DB.prepare(
    `SELECT oc.*,${effectiveStaffCostSql('oc')} AS amount_iqd,s.name AS staff_name,c.name AS center_name,(SELECT COALESCE(SUM(a.amount_iqd),0) FROM finance_payment_allocations a WHERE a.cost_id=oc.id) AS paid_iqd FROM finance_order_costs oc LEFT JOIN finance_staff s ON s.id=oc.staff_id LEFT JOIN finance_cost_centers c ON c.id=oc.center_id WHERE (?='' OR oc.order_id=?) AND (?='' OR oc.staff_id=?) ORDER BY oc.cost_day DESC,oc.id LIMIT 100 OFFSET ?`,
  )
    .bind(orderId, orderId, staffId, staffId, offset)
    .all();
  return c.json({ success: true, costs: results ?? [], offset });
});
adminFinanceOperationsRoutes.post('/orders/:id/reconcile', async (c) => {
  const user = c.get('user')!;
  await requireCapability(c.env, user, 'rules');
  const id = c.req.param('id'),
    order = await c.env.DB.prepare('SELECT status,stage FROM orders WHERE id=?')
      .bind(id)
      .first<{ status: string; stage: string }>();
  if (!order) throw notFound('Order not found');
  if (
    ['preparing', 'local_delivery_prep', 'out_for_delivery', 'delivered'].includes(order.stage) ||
    order.status === 'delivered'
  )
    await runOrderFinancialEffects(c.env, id, 'prepared');
  if (order.status === 'delivered') await runOrderFinancialEffects(c.env, id, 'delivered');
  return c.json({ success: true });
});
adminFinanceOperationsRoutes.post('/orders/:id/assignment', async (c) => {
  const user = c.get('user')!;
  await requireCapability(c.env, user, 'rules');
  const b = await c.req.json<Record<string, unknown>>(),
    id = c.req.param('id'),
    group = str(b.group_key, 'المهمة', { min: 1, max: 80 }),
    staff = text(b.staff_id, 60);
  if (
    await c.env.DB.prepare(
      "SELECT id FROM finance_order_costs WHERE order_id=? AND group_key=? AND state<>'pending_cost' LIMIT 1",
    )
      .bind(id, group)
      .first()
  )
    throw conflict('أجر المهمة مثبت؛ صحّحه بعكس الاستحقاق أولًا');
  try {
    await c.env.DB.batch([
      // Financial posting may complete FIFO after the eligibility read.
      // Freeze the same rule inside the assignment write's transaction.
      ...fence(c.env.DB,
        "NOT EXISTS(SELECT 1 FROM finance_order_costs WHERE order_id=? AND group_key=? AND state<>'pending_cost')",
        [id, group]),
      c.env.DB.prepare(
        'INSERT INTO finance_task_assignments(order_id,group_key,staff_id,completed_at,actor_id) VALUES (?,?,?,?,?) ON CONFLICT(order_id,group_key) DO UPDATE SET staff_id=excluded.staff_id,completed_at=excluded.completed_at,actor_id=excluded.actor_id',
      ).bind(id, group, staff, b.completed ? new Date().toISOString() : null, user.id),
    ]);
  } catch (e) {
    if (/CHECK constraint failed/i.test(e instanceof Error ? e.message : String(e)))
      throw conflict('ثبت أجر المهمة أثناء حفظ الإسناد؛ حدّث الصفحة قبل تغيير الموظف');
    throw e;
  }
  await runOrderFinancialEffects(c.env, id, b.completed ? 'prepared' : 'delivered');
  return c.json({ success: true });
});
adminFinanceOperationsRoutes.post('/costs/:id/approve', async (c) => {
  const user = c.get('user')!;
  await requireCapability(c.env, user, 'pay');
  await c.env.DB.prepare("UPDATE finance_order_costs SET state='approved' WHERE id=? AND state='due'")
    .bind(c.req.param('id'))
    .run();
  return c.json({ success: true });
});
adminFinanceOperationsRoutes.post('/costs/:id/reverse', async (c) => {
  const user = c.get('user')!;
  await requireCapability(c.env, user, 'pay');
  const b = await c.req.json<Record<string, unknown>>(),
    db = c.env.DB,
    id = c.req.param('id');
  const cost = await db
    .prepare(`SELECT c.*,${effectiveStaffCostSql()} AS amount_iqd FROM finance_order_costs c WHERE id=?`)
    .bind(id)
    .first<{ state: string; amount_iqd: number; expense_id: string | null; staff_id: string | null }>();
  if (!cost) throw notFound('Cost not found');
  if (cost.state === 'reversed') return c.json({ success: true, already: true });
  if (
    await db
      .prepare('SELECT cost_id FROM finance_payment_allocations WHERE cost_id=? LIMIT 1')
      .bind(id)
      .first()
  )
    throw conflict('استحقاق مدفوع؛ سجّل استرداد الموظف بقيد مستقل أولًا');
  if(await db.prepare(`SELECT ${heldSourceSql("'staff'",'?')} AS held`).bind(id).first<{held:number}>().then((r)=>Number(r?.held??0)>0))
    throw conflict('هذا الاستحقاق محجوز في طلب سحب؛ ارفض طلب السحب أو ألغِه أولًا');
  const day = dateValue(b.day, baghdadDay()),
    reason = text(b.reason,500) || 'تصحيح الاستحقاق';
  await periodOpen(db, day);
  const statements = [
    ...fence(
      db,
      "EXISTS(SELECT 1 FROM finance_order_costs WHERE id=? AND state IN ('due','approved','pending_cost')) AND NOT EXISTS(SELECT 1 FROM finance_payment_allocations WHERE cost_id=?)",
      [id, id],
    ),
    db.prepare("UPDATE finance_order_costs SET state='reversed' WHERE id=?").bind(id),
  ];
  if (cost.amount_iqd > 0)
    statements.push(
      db
        .prepare(
          'INSERT INTO finance_cost_reversals(id,cost_id,amount_iqd,reversal_day,reason,actor_id) VALUES (?,?,?,?,?,?)',
        )
        .bind(newId('rev'), id, cost.amount_iqd, day, reason, user.id),
      ...journalPlan(
        db,
        {
          key: `cost-reversal:${id}`,
          day,
          title: reason,
          source: 'cost_reversal',
          sourceId: id,
          actor: user.id,
        },
        [
          { account: cost.staff_id ? '2100' : '2000', debit: cost.amount_iqd },
          { account: '5100', credit: cost.amount_iqd },
        ],
      ).statements,
    );
  await commitParticipantStatements(db,statements);
  await audit(db, user.id, 'finance.cost_reversed', id, { reason });
  return c.json({ success: true });
});
adminFinanceOperationsRoutes.get('/payroll', async (c) => {
  await requireCapability(c.env, c.get('user')!, 'pay');
  const db = c.env.DB,
    staffId = text(c.req.query('staff_id'), 60),
    offset = whole(c.req.query('offset') ?? 0, 'offset', 0, 100000);
  const { results } = await db
    .prepare(
      `SELECT s.*,
    (SELECT COALESCE(SUM(${effectiveStaffCostSql()}),0) FROM finance_order_costs c WHERE c.staff_id=s.id AND c.state IN ('due','approved')) AS due_iqd,
    (SELECT COALESCE(SUM(${effectiveStaffCostSql()}),0) FROM finance_order_costs c WHERE c.staff_id=s.id AND c.state='approved') AS approved_iqd,
    (SELECT COALESCE(SUM(a.amount_iqd),0) FROM finance_payment_allocations a JOIN finance_order_costs c ON c.id=a.cost_id WHERE c.staff_id=s.id) AS paid_iqd,
    (SELECT COALESCE(SUM(amount_iqd),0) FROM finance_staff_payments WHERE staff_id=s.id AND kind='advance')-
    (SELECT COALESCE(SUM(a.amount_iqd),0) FROM finance_payment_allocations a JOIN finance_staff_payments p ON p.id=a.payment_id WHERE p.staff_id=s.id AND p.kind='advance') AS advance_balance_iqd,
    (SELECT COUNT(*) FROM finance_order_costs WHERE staff_id=s.id AND state='pending_cost') AS pending_costs FROM finance_staff s ORDER BY name`,
    )
    .all();
  const payments = await db
    .prepare(
      'SELECT p.*,s.name AS staff_name FROM finance_staff_payments p JOIN finance_staff s ON s.id=p.staff_id ORDER BY p.created_at DESC LIMIT 100',
    )
    .all();
  // Payment staff can review the earnings they approve or settle without
  // acquiring permission to manage cost rules. The general /costs reader
  // continues to require that separate capability.
  const costs = await db.prepare(
    `SELECT oc.*,${effectiveStaffCostSql('oc')} AS amount_iqd,s.name AS staff_name,c.name AS center_name,
    (SELECT COALESCE(SUM(a.amount_iqd),0) FROM finance_payment_allocations a WHERE a.cost_id=oc.id) AS paid_iqd
    FROM finance_order_costs oc LEFT JOIN finance_staff s ON s.id=oc.staff_id
    LEFT JOIN finance_cost_centers c ON c.id=oc.center_id
    WHERE (?='' OR oc.staff_id=?) ORDER BY oc.cost_day DESC,oc.id LIMIT 100 OFFSET ?`,
  )
    .bind(staffId, staffId, offset)
    .all();
  return c.json({ success: true, staff: results ?? [], payments: payments.results ?? [], costs: costs.results ?? [], offset });
});
adminFinanceOperationsRoutes.post('/staff/:id/payments', async (c) => {
  const user = c.get('user')!;
  await requireCapability(c.env, user, 'pay');
  const b = await c.req.json<Record<string, unknown>>(),
    db = c.env.DB,
    staff = c.req.param('id'),
    id = str(b.operation_id, 'operation_id', { min: 8, max: 40 }),
    amount = whole(b.amount_iqd, 'المبلغ', 1),
    day = dateValue(b.payment_day, baghdadDay()),
    kind = b.kind === 'advance' ? 'advance' : 'payment';
  const prior = await db
    .prepare('SELECT staff_id,amount_iqd,kind FROM finance_staff_payments WHERE id=?')
    .bind(id)
    .first<{ staff_id: string; amount_iqd: number; kind: string }>();
  if (prior) {
    if (prior.staff_id !== staff || prior.amount_iqd !== amount || prior.kind !== kind)
      throw conflict('عملية الدفع مستخدمة لمحتوى مختلف');
    return c.json({ success: true, already: true });
  }
  await periodOpen(db, day);
  const statements = [
    db
      .prepare(
        'INSERT INTO finance_staff_payments(id,staff_id,amount_iqd,kind,payment_day,note,actor_id,created_at) VALUES (?,?,?,?,?,?,?,?)',
      )
      .bind(id, staff, amount, kind, day, text(b.note, 500), user.id, new Date().toISOString()),
  ];
  if (kind === 'payment') {
    const budget=await staffPaymentBudget(db,staff);
    if(budget.available_iqd<amount)throw badRequest('المبلغ يتجاوز صافي الأجور المتاح بعد التسويات والسلف والحجوزات');
    // Guard the canonical whole wage ledger BEFORE inserting this payment.
    // Approved positive rows alone omit debt from older blocked paid costs.
    statements.unshift(...budget.statements);
    const advance=(await db.prepare(`SELECT ${staffAdvanceSql('?')} AS balance`).bind(staff).first<{balance:number}>())?.balance??0;
    const costs =
      (
        await db
          .prepare(
            `SELECT c.id,${effectiveStaffCostSql()}-COALESCE((SELECT SUM(a.amount_iqd) FROM finance_payment_allocations a WHERE a.cost_id=c.id),0)-${heldSourceSql("'staff'", 'c.id')} AS balance FROM finance_order_costs c WHERE c.staff_id=? AND c.state='approved' AND NOT ${staffReconciliationBlockedSql()} ORDER BY c.cost_day,c.id`,
          )
          .bind(staff)
          .all<{ id: string; balance: number }>()
      ).results ?? [];
    if (costs.reduce((s, c) => s + c.balance, 0)-advance < amount)
      throw badRequest('المبلغ يتجاوز المستحقات المتاحة بعد خصم السلف وطلبات السحب');
    statements.push(...fence(db,`${staffAdvanceSql('?')}=? AND (SELECT COALESCE(SUM(${effectiveStaffCostSql()}-COALESCE((SELECT SUM(a.amount_iqd) FROM finance_payment_allocations a WHERE a.cost_id=c.id),0)-${heldSourceSql("'staff'",'c.id')}),0) FROM finance_order_costs c WHERE staff_id=? AND state='approved' AND NOT ${staffReconciliationBlockedSql()})=?`,[staff,advance,staff,costs.reduce((sum,c)=>sum+c.balance,0)]));
    let left = amount;
    for (const cost of costs) {
      if (left === 0) break;
      const take = Math.min(left, cost.balance);
      if (take <= 0) continue;
      statements.push(
        ...fence(
          db,
          `EXISTS(SELECT 1 FROM finance_order_costs c WHERE id=? AND state='approved' AND NOT ${staffReconciliationBlockedSql()} AND ${effectiveStaffCostSql()}-COALESCE((SELECT SUM(amount_iqd) FROM finance_payment_allocations WHERE cost_id=?),0)-${heldSourceSql("'staff'", 'c.id')}=?)`,
          [cost.id, cost.id, cost.balance],
        ),
        db
          .prepare('INSERT INTO finance_payment_allocations(payment_id,cost_id,amount_iqd) VALUES (?,?,?)')
          .bind(id, cost.id, take),
      );
      left -= take;
    }
  }
  statements.push(
    ...journalPlan(
      db,
      {
        key: `staff-payment:${id}`,
        day,
        title: kind === 'advance' ? 'سلفة موظف' : 'تسديد أجور موظف',
        source: 'staff_payment',
        sourceId: id,
        actor: user.id,
      },
      [
        { account: kind === 'advance' ? '1400' : '2100', debit: amount },
        { account: '1000', credit: amount },
      ],
    ).statements,
  );
  await commitParticipantStatements(db,statements);
  await audit(db, user.id, 'finance.staff_paid', id, { staff_id: staff, kind });
  return c.json({ success: true });
});
adminFinanceOperationsRoutes.post('/staff/:id/advance-settlements', async (c) => {
  const user = c.get('user')!;
  await requireCapability(c.env, user, 'pay');
  const b = await c.req.json<Record<string, unknown>>();
  await settleAdvance(c.env.DB, {
    id: str(b.operation_id, 'operation_id', { min: 8, max: 40 }),
    staffId: c.req.param('id'),
    amount: whole(b.amount_iqd, 'المبلغ', 1),
    day: dateValue(b.day, baghdadDay()),
    note: text(b.note, 500),
    actor: user.id,
  });
  return c.json({ success: true });
});
adminFinanceOperationsRoutes.get('/expenses', async (c) => {
  await requireCapability(c.env, c.get('user')!, 'rules');
  const q = text(c.req.query('q'), 120),
    from = dateValue(c.req.query('from'), baghdadDay()),
    to = dateValue(c.req.query('to'), baghdadDay());
  const r = await c.env.DB.prepare(
    `SELECT e.id,e.title,e.amount_iqd,e.expense_day,l.center_id,l.allocation_basis,l.target_type,l.target_id FROM operating_expenses e LEFT JOIN finance_expense_links l ON l.expense_id=e.id
    WHERE e.voided_at IS NULL AND e.expense_day BETWEEN ? AND ? AND (?='' OR instr(e.title||' '||e.id,?)>0)
    AND NOT EXISTS(SELECT 1 FROM finance_order_costs c WHERE c.expense_id=e.id) AND NOT EXISTS(SELECT 1 FROM finance_collections c WHERE c.expense_id=e.id) ORDER BY e.expense_day DESC,e.id LIMIT 200`,
  )
    .bind(from, to, q, q)
    .all();
  return c.json({ success: true, expenses: r.results ?? [] });
});
adminFinanceOperationsRoutes.post('/expense-links', async (c) => {
  const user = c.get('user')!;
  await requireCapability(c.env, user, 'rules');
  const b = await c.req.json<Record<string, unknown>>(),
    db = c.env.DB,
    basis = text(b.allocation_basis, 20) || 'none',
    expense = text(b.expense_id, 60),
    target = text(b.target_type, 20) || 'all',
    targetId = target === 'all' ? '' : text(b.target_id, 60);
  if (
    !['none', 'revenue', 'units', 'orders'].includes(basis) ||
    !['all', 'catalog', 'product'].includes(target)
  )
    throw badRequest('أساس التوزيع غير صحيح');
  const existing = await db
    .prepare('SELECT expense_day FROM operating_expenses WHERE id=? AND voided_at IS NULL')
    .bind(expense)
    .first<{ expense_day: string }>();
  if (!existing) throw notFound('Expense not found');
  await periodOpen(db, existing.expense_day);
  if (
    await db
      .prepare(
        'SELECT id FROM finance_order_costs WHERE expense_id=? UNION ALL SELECT id FROM finance_collections WHERE expense_id=?',
      )
      .bind(expense, expense)
      .first()
  )
    throw badRequest('التكلفة المرتبطة بعملية أصلية تدخل ربح الطلب مرة واحدة تلقائيًا');
  if (
    target !== 'all' &&
    !(await db
      .prepare(`SELECT id FROM ${target === 'product' ? 'products' : 'catalogs'} WHERE id=?`)
      .bind(targetId)
      .first())
  )
    throw badRequest('اختر نطاق التوزيع');
  const oldLink=await db.prepare('SELECT * FROM finance_expense_links WHERE expense_id=?').bind(expense).first<{center_id:string|null;order_id:string|null;allocation_basis:string;target_type:string;target_id:string}>();
  const orderId=text(b.order_id,60)||null;
  if(orderId && !await db.prepare('SELECT id FROM orders WHERE id=?').bind(orderId).first())throw badRequest('اختر طلبًا موجودًا');
  const changes=oldLink?fence(db,'EXISTS(SELECT 1 FROM finance_expense_links WHERE expense_id=? AND center_id IS ? AND order_id IS ? AND allocation_basis=? AND target_type=? AND target_id=?)',[expense,oldLink.center_id,oldLink.order_id,oldLink.allocation_basis,oldLink.target_type,oldLink.target_id]):fence(db,'NOT EXISTS(SELECT 1 FROM finance_expense_links WHERE expense_id=?)',[expense]);
  changes.push(db.prepare('INSERT INTO finance_expense_links(expense_id,center_id,order_id,allocation_basis,target_type,target_id) VALUES (?,?,?,?,?,?) ON CONFLICT(expense_id) DO UPDATE SET center_id=excluded.center_id,order_id=excluded.order_id,allocation_basis=excluded.allocation_basis,target_type=excluded.target_type,target_id=excluded.target_id')
    .bind(expense,text(b.center_id,60)||null,orderId,basis,target,targetId));
  await commitParticipantStatements(db,changes);
  for(const affected of new Set([oldLink?.order_id,orderId].filter((id):id is string=>!!id)))
    await reconcileFinanceOrder(db,affected,{actor:user.id});
  return c.json({ success: true });
});
adminFinanceOperationsRoutes.post('/collections', async (c) => {
  const user = c.get('user')!;
  await requireCapability(c.env, user, 'pay');
  const b = await c.req.json<Record<string, unknown>>(),
    db = c.env.DB,
    id = str(b.operation_id, 'operation_id', { min: 8, max: 40 }),
    orderId = text(b.order_id, 60),
    amount = whole(b.amount_iqd, 'المبلغ الإجمالي', 1),
    fee = whole(b.fee_iqd ?? 0, 'أجرة الشركة'),
    day = dateValue(b.collection_day, baghdadDay());
  if (fee > amount) throw badRequest('أجرة الشركة تتجاوز المبلغ الإجمالي');
  const existing = await db
    .prepare('SELECT order_id,amount_iqd,fee_iqd FROM finance_collections WHERE id=?')
    .bind(id)
    .first<{ order_id: string; amount_iqd: number; fee_iqd: number }>();
  if (existing) {
    if (existing.order_id !== orderId || existing.amount_iqd !== amount || existing.fee_iqd !== fee)
      throw conflict('عملية التحصيل مستخدمة لمحتوى مختلف');
    await reconcileFinanceOrder(db,orderId,{actor:user.id});
    return c.json({ success: true, already: true });
  }
  const order = await db
    .prepare('SELECT status,due_on_delivery_iqd,gini_paid_iqd,seller_type FROM orders WHERE id=?')
    .bind(orderId)
    .first<{ status: string; due_on_delivery_iqd: number; gini_paid_iqd: number; seller_type: string }>();
  if (!order || order.seller_type !== 'levonis') throw notFound('Platform order not found');
  if (order.status === 'cancelled') throw badRequest('الطلب ملغى');
  const salePosted = !!(await db
    .prepare("SELECT id FROM accounting_entries WHERE event_key=? AND state='posted'")
    .bind(`sale:${orderId}`)
    .first());
  const payer = b.payer === 'bank' ? 'bank' : b.payer === 'courier' ? 'courier' : 'customer';
  const giniRefunds = (await db
    .prepare("SELECT COALESCE(SUM(refund_iqd),0) AS n FROM finance_refund_facts WHERE order_id=? AND channel='gini'")
    .bind(orderId)
    .first<{ n: number }>())?.n ?? 0;
  const collected =
    (
      await db
        .prepare(
          "SELECT COALESCE(SUM(amount_iqd),0) AS n FROM finance_collections WHERE order_id=? AND (payer='bank')=?",
        )
        .bind(orderId, payer === 'bank' ? 1 : 0)
        .first<{ n: number }>()
    )?.n ?? 0;
  if (collected + amount > (payer === 'bank' ? order.gini_paid_iqd - giniRefunds : order.due_on_delivery_iqd))
    throw badRequest('التحصيل يتجاوز المبلغ المتبقي للطلب');
  await periodOpen(db, day);
  const expense = fee ? newId('opex') : null,
    statements = [
      ...fence(
        db,
        "(SELECT COALESCE(SUM(amount_iqd),0) FROM finance_collections WHERE order_id=? AND (payer='bank')=?)=? AND EXISTS(SELECT 1 FROM accounting_entries WHERE event_key=? AND state='posted')=? AND EXISTS(SELECT 1 FROM orders WHERE id=? AND status<>'cancelled') AND (SELECT COALESCE(SUM(refund_iqd),0) FROM finance_refund_facts WHERE order_id=? AND channel='gini')=?",
        [orderId, payer === 'bank' ? 1 : 0, collected, `sale:${orderId}`, salePosted ? 1 : 0, orderId, orderId, giniRefunds],
      ),
    ];
  if (expense) {
    const category = text(b.category_id, 60);
    if (!category) throw badRequest('اختر تصنيف مصروف أجرة التوصيل');
    statements.push(
      db
        .prepare(
          'INSERT INTO operating_expenses(id,category_id,amount_iqd,expense_day,title,note,created_by) VALUES (?,?,?,?,?,?,?)',
        )
        .bind(expense, category, fee, day, 'أجرة شركة التوصيل', orderId, user.id),
    );
  }
  statements.push(
    db
      .prepare(
        'INSERT INTO finance_collections(id,order_id,payer,amount_iqd,fee_iqd,collection_day,reference,actor_id,created_at,expense_id) VALUES (?,?,?,?,?,?,?,?,?,?)',
      )
      .bind(
        id,
        orderId,
        payer,
        amount,
        fee,
        day,
        text(b.reference),
        user.id,
        new Date().toISOString(),
        expense,
      ),
    ...journalPlan(
      db,
      {
        key: `collection:${id}`,
        day,
        title: 'تحصيل طلب',
        source: 'collection',
        sourceId: id,
        actor: user.id,
      },
      [
        { account: '1000', debit: amount - fee },
        { account: '5200', debit: fee },
        { account: salePosted ? '1100' : '2300', credit: amount },
      ],
    ).statements,
  );
  await db.batch(statements);
  await reconcileFinanceOrder(db,orderId,{actor:user.id,day});
  return c.json({ success: true });
});
adminFinanceOperationsRoutes.get('/receivables', async (c) => {
  await requireCapability(c.env, c.get('user')!, 'pay');
  const { results } = await c.env.DB.prepare(
    `WITH collected AS (
      SELECT order_id,SUM(amount_iqd) AS collected_iqd,SUM(fee_iqd) AS courier_fee_iqd,
        SUM(CASE WHEN payer='bank' THEN amount_iqd ELSE 0 END) AS bank_collected_iqd,
        SUM(CASE WHEN payer<>'bank' THEN amount_iqd ELSE 0 END) AS door_collected_iqd
      FROM finance_collections GROUP BY order_id
    ), refunds AS (
      SELECT order_id,SUM(refund_iqd) AS gini_refund_iqd FROM finance_refund_facts WHERE channel='gini' GROUP BY order_id
    ), balances AS (
      SELECT o.id,o.status,o.delivered_at,o.delivery_provider,o.delivery_tracking_no,o.due_on_delivery_iqd,o.gini_paid_iqd,
        COALESCE(c.collected_iqd,0) AS collected_iqd,COALESCE(c.courier_fee_iqd,0) AS courier_fee_iqd,
        COALESCE(c.bank_collected_iqd,0) AS bank_collected_iqd,COALESCE(c.door_collected_iqd,0) AS door_collected_iqd,
        COALESCE(r.gini_refund_iqd,0) AS gini_refund_iqd,
        o.gini_paid_iqd-COALESCE(r.gini_refund_iqd,0) AS bank_expected_iqd,
        o.gini_paid_iqd-COALESCE(r.gini_refund_iqd,0)-COALESCE(c.bank_collected_iqd,0) AS bank_balance_iqd,
        o.due_on_delivery_iqd-COALESCE(c.door_collected_iqd,0) AS door_balance_iqd,
        CAST(julianday('now')-julianday(o.delivered_at) AS INTEGER) AS overdue_days
      FROM orders o LEFT JOIN collected c ON c.order_id=o.id LEFT JOIN refunds r ON r.order_id=o.id
      WHERE o.status='delivered' AND o.seller_type='levonis'
    ) SELECT *,bank_balance_iqd+door_balance_iqd AS balance_iqd,
      MAX(0,bank_balance_iqd) AS bank_receivable_iqd,MAX(0,-bank_balance_iqd) AS bank_credit_balance_iqd,
      MAX(0,door_balance_iqd)+MAX(0,bank_balance_iqd) AS receivable_iqd
      FROM balances WHERE door_balance_iqd>0 OR bank_balance_iqd<>0 ORDER BY delivered_at LIMIT 100`,
  ).all();
  return c.json({ success: true, orders: results ?? [] });
});
adminFinanceOperationsRoutes.get('/journal', async (c) => {
  await requireCapability(c.env, c.get('user')!, 'accounting');
  const db = c.env.DB,
    from = dateValue(c.req.query('from'), baghdadDay()),
    to = dateValue(c.req.query('to'), baghdadDay());
  const [entries, trial, periods] = await Promise.all([
    db
      .prepare(
        `SELECT e.*,SUM(l.debit_iqd) AS amount_iqd,json_group_array(json_object('account',l.account_code,'debit_iqd',l.debit_iqd,'credit_iqd',l.credit_iqd)) AS lines_json FROM accounting_entries e JOIN accounting_lines l ON l.entry_id=e.id WHERE e.entry_day BETWEEN ? AND ? GROUP BY e.id ORDER BY e.entry_day DESC,e.created_at DESC LIMIT 100`,
      )
      .bind(from, to)
      .all(),
    db
      .prepare(
        "SELECT a.*,COALESCE(SUM(CASE WHEN e.state='posted' AND e.entry_day<=? THEN l.debit_iqd ELSE 0 END),0) AS debit_iqd,COALESCE(SUM(CASE WHEN e.state='posted' AND e.entry_day<=? THEN l.credit_iqd ELSE 0 END),0) AS credit_iqd FROM accounting_accounts a LEFT JOIN accounting_lines l ON l.account_code=a.code LEFT JOIN accounting_entries e ON e.id=l.entry_id GROUP BY a.code ORDER BY a.code",
      )
      .bind(to, to)
      .all(),
    db.prepare('SELECT * FROM accounting_periods ORDER BY month DESC LIMIT 24').all(),
  ]);
  return c.json({
    success: true,
    entries: entries.results ?? [],
    trial: trial.results ?? [],
    periods: periods.results ?? [],
  });
});
adminFinanceOperationsRoutes.post('/journal', async (c) => {
  const user = c.get('user')!;
  await requireCapability(c.env, user, 'accounting');
  const b = await c.req.json<Record<string, unknown>>(),
    id = str(b.operation_id, 'operation_id', { min: 8, max: 40 }),
    day = dateValue(b.day, baghdadDay());
  await periodOpen(c.env.DB, day);
  if (
    await c.env.DB.prepare('SELECT id FROM accounting_entries WHERE event_key=?').bind(`manual:${id}`).first()
  )
    return c.json({ success: true, already: true });
  const raw = Array.isArray(b.lines) ? b.lines : [];
  if (raw.length > 30) throw badRequest('Too many journal lines');
  const lines: JournalLine[] = raw.map((v) => {
    const r = v as Record<string, unknown>;
    return {
      account: text(r.account, 12),
      debit: whole(r.debit ?? 0, 'المدين'),
      credit: whole(r.credit ?? 0, 'الدائن'),
    };
  });
  await c.env.DB.batch(
    journalPlan(
      c.env.DB,
      {
        key: `manual:${id}`,
        day,
        title: str(b.title, 'العنوان', { min: 3, max: 200 }),
        source: 'manual',
        sourceId: id,
        actor: user.id,
      },
      lines,
    ).statements,
  );
  return c.json({ success: true });
});
adminFinanceOperationsRoutes.post('/journal/:id/reverse', async (c) => {
  const user = c.get('user')!;
  await requireCapability(c.env, user, 'accounting');
  const b = await c.req.json<Record<string, unknown>>(),
    db = c.env.DB,
    id = c.req.param('id'),
    day = dateValue(b.day, baghdadDay());
  await periodOpen(db, day);
  const entry = await db
    .prepare('SELECT source_type FROM accounting_entries WHERE id=?')
    .bind(id)
    .first<{ source_type: string }>();
  if (!entry) throw notFound('Entry not found');
  if (entry.source_type !== 'manual') throw badRequest('صحّح العملية الأصلية ليبقى القيد متطابقًا معها');
  if (await db.prepare('SELECT id FROM accounting_entries WHERE reversal_of=?').bind(id).first())
    return c.json({ success: true, already: true });
  const lines =
    (
      await db
        .prepare('SELECT account_code,debit_iqd,credit_iqd FROM accounting_lines WHERE entry_id=?')
        .bind(id)
        .all<{ account_code: string; debit_iqd: number; credit_iqd: number }>()
    ).results ?? [];
  await db.batch(
    journalPlan(
      db,
      {
        key: `reverse:${id}`,
        day,
        title: str(b.reason, 'السبب', { min: 3, max: 200 }),
        source: 'manual_reversal',
        sourceId: id,
        actor: user.id,
        reversalOf: id,
      },
      lines.map((l) => ({ account: l.account_code, debit: l.credit_iqd, credit: l.debit_iqd })),
    ).statements,
  );
  return c.json({ success: true });
});
adminFinanceOperationsRoutes.post('/periods/close', async (c) => {
  const user = c.get('user')!;
  await requireCapability(c.env, user, 'close');
  const b = await c.req.json<Record<string, unknown>>(),
    month = text(b.month, 7);
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month) || month >= baghdadDay().slice(0, 7))
    throw badRequest('اختر شهرًا سابقًا');
  if (
    await c.env.DB.prepare(
      "SELECT id FROM finance_order_costs WHERE substr(cost_day,1,7)=? AND state='pending_cost' LIMIT 1",
    )
      .bind(month)
      .first()
  )
    throw conflict('استكمل التكاليف المعلقة قبل إغلاق الشهر');
  if (
    await c.env.DB.prepare(
      'SELECT e.event_key FROM finance_posting_errors e JOIN orders o ON o.id=e.order_id WHERE substr(COALESCE(o.delivered_at,o.created_at),1,7)<=? LIMIT 1',
    )
      .bind(month)
      .first()
  )
    throw conflict('راجع أخطاء الترحيل قبل إغلاق الشهر');
  await c.env.DB.batch([
    ...fence(
      c.env.DB,
      "NOT EXISTS(SELECT 1 FROM finance_order_costs WHERE substr(cost_day,1,7)=? AND state='pending_cost') AND NOT EXISTS(SELECT 1 FROM finance_posting_errors e JOIN orders o ON o.id=e.order_id WHERE substr(COALESCE(o.delivered_at,o.created_at),1,7)<=?)",
      [month, month],
    ),
    c.env.DB.prepare(
      'INSERT INTO accounting_periods(month,closed_at,closed_by) VALUES (?,?,?) ON CONFLICT(month) DO NOTHING',
    ).bind(month, new Date().toISOString(), user.id),
  ]);
  await audit(c.env.DB, user.id, 'accounting.period_closed', month, {});
  return c.json({ success: true });
});
adminFinanceOperationsRoutes.put('/permissions', async (c) => {
  const user = c.get('user')!;
  if (!isOwner(c.env, user)) throw forbidden('المالك يحدد صلاحيات العمليات');
  const b = await c.req.json<Record<string, unknown>>(),
    caps: Capability[] = ['purchase', 'receive', 'count', 'transfer', 'rules', 'pay', 'accounting', 'close'],
    cap = text(b.capability, 20) as Capability;
  if (!caps.includes(cap)) throw badRequest('Unknown capability');
  await c.env.DB.prepare(
    'INSERT INTO ops_permissions(user_id,capability,allowed) VALUES (?,?,?) ON CONFLICT(user_id,capability) DO UPDATE SET allowed=excluded.allowed',
  )
    .bind(text(b.user_id, 60), cap, b.allowed === false ? 0 : 1)
    .run();
  await audit(c.env.DB, user.id, 'operations.permission_changed', text(b.user_id, 60), {
    capability: cap,
    allowed: b.allowed !== false,
  });
  return c.json({ success: true });
});
adminFinanceOperationsRoutes.get('/orders/:id/profit', async (c) => {
  await requireCapability(c.env, c.get('user')!, 'rules');
  const goods = await orderGoods(c.env.DB, c.req.param('id'));
  if (!goods) throw notFound('Order not found');
  const costs = await c.env.DB.prepare('SELECT * FROM finance_order_costs WHERE order_id=?')
    .bind(c.req.param('id'))
    .all();
  return c.json({ success: true, ...goods, costs: costs.results ?? [] });
});
adminFinanceOperationsRoutes.get('/posting-errors', async (c) => {
  await requireCapability(c.env, c.get('user')!, 'accounting');
  const r = await c.env.DB.prepare(
    'SELECT * FROM finance_posting_errors ORDER BY last_attempt_at DESC LIMIT 100',
  ).all();
  return c.json({ success: true, errors: r.results ?? [] });
});
adminFinanceOperationsRoutes.post('/orders/:id/retry-posting', async (c) => {
  const user = c.get('user')!;
  await requireCapability(c.env, user, 'accounting');
  const b = await c.req.json<Record<string, unknown>>(),
    id = c.req.param('id'),
    day = dateValue(b.day, baghdadDay());
  await periodOpen(c.env.DB, day);
  const order = await c.env.DB.prepare('SELECT status,stage FROM orders WHERE id=?')
    .bind(id)
    .first<{ status: string; stage: string }>();
  if (!order) throw notFound('Order not found');
  if (
    ['preparing', 'local_delivery_prep', 'out_for_delivery', 'delivered'].includes(order.stage) ||
    order.status === 'delivered'
  )
    await runOrderFinancialEffects(c.env, id, 'prepared', day);
  if (order.status === 'delivered') await runOrderFinancialEffects(c.env, id, 'delivered', day);
  const refunds =
    (
      await c.env.DB.prepare(
        'SELECT case_id FROM finance_refund_facts WHERE order_id=? AND posted_at IS NULL',
      )
        .bind(id)
        .all<{ case_id: string }>()
    ).results ?? [];
  for (const r of refunds) await postStoredRefund(c.env, r.case_id, user.id, day);
  await reconcileFinanceOrder(c.env.DB,id,{actor:user.id,day});
  await audit(c.env.DB, user.id, 'finance.posting_retried', id, { posting_day: day });
  return c.json({ success: true });
});
adminFinanceOperationsRoutes.get('/report', async (c) => {
  await requireCapability(c.env, c.get('user')!, 'rules');
  return c.json({
    success: true,
    ...(await operationsReport(
      c.env.DB,
      dateValue(c.req.query('from'), baghdadDay()),
      dateValue(c.req.query('to'), baghdadDay()),
    )),
  });
});
