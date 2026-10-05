import type { Env } from './types';
import { hasUnknownRefund, isConfirmedOrderCost } from './financeLedger';
import { baghdadDay, fence, journalPlan, operationsInstalled } from './operations';
import { newId } from './crypto';
import { getOrderGoods, getOrderProfitBase, workspaceInstalled } from './orderProfit';
import { ruleScopeRank } from './financeRuleScopes';
import { reconcileFinanceOrder } from './financeReconcile';
import { reconcileStaffOrderCosts } from './financeParticipants';
import { recordFinancialFailure } from './financePostingErrors';
import { wageVersions } from './financeWageTimeline';
import { employmentInstalled, nextEmploymentDay, staffCanAccrue, type EmploymentStaff } from './financeEmployment';
export { recordFinancialFailure } from './financePostingErrors';

export interface CostRule {
  id: string;
  version: number;
  name: string;
  group_key: string;
  target_type: 'all' | 'catalog' | 'product';
  target_id: string;
  basis: 'unit' | 'order' | 'profit_percent' | 'revenue_percent';
  amount: number;
  staff_id: string | null;
  category_id: string;
  center_id: string | null;
  milestone: 'prepared' | 'delivered';
  requires_assignment: number;
  cap_iqd: number | null;
  priority: number;
  effective_from: string;
  effective_to: string | null;
  created_at: string;
  scope_rank?: number;
  scope_json?: string;
  employment_effective_default?:number;
}
export function matchingRules(rules: CostRule[], productId: string, ancestors: Map<string, number>) {
  const groups = new Map<string, { rule: CostRule; rank: number }>();
  for (const rule of rules) {
    const rank = ruleScopeRank(rule, productId, ancestors);
    if (rank < 0) continue;
    const key = `${rule.staff_id ?? ''}:${rule.group_key}:${rule.milestone}`,
      prev = groups.get(key);
    if (
      !prev ||
      rank > prev.rank ||
      (rank === prev.rank &&
        (rule.priority > prev.rule.priority ||
          (rule.priority === prev.rule.priority && rule.id < prev.rule.id)))
    )
      groups.set(key, { rule, rank });
  }
  return [...groups.values()].map((v) => ({ ...v.rule, scope_rank: v.rank }));
}
export function costAmount(
  rule: Pick<CostRule, 'basis' | 'amount' | 'cap_iqd'>,
  qty: number,
  netGoods: number,
  cogs: number | null,
): number | null {
  let value: number | null =
    rule.basis === 'unit'
      ? rule.amount * qty
      : rule.basis === 'order'
        ? rule.amount
        : rule.basis === 'revenue_percent'
          ? Number(BigInt(netGoods) * BigInt(rule.amount) / 10000n)
          : cogs === null
            ? null
            : Number(BigInt(Math.max(0, netGoods - cogs)) * BigInt(rule.amount) / 10000n);
  if (value !== null && rule.cap_iqd !== null) value = Math.min(value, rule.cap_iqd);
  return value;
}
type RuleSnapshot = { line_id: string; product_id: string; rules: CostRule[] }[];
// Classification is a journal fact, not the order's delivery status. A
// delivered order may still be waiting for its sale journal to be posted.
const advanceCollectionsSql = `SELECT COALESCE(SUM(l.credit_iqd-l.debit_iqd),0) FROM finance_collections c
  JOIN accounting_entries e ON e.event_key='collection:'||c.id AND e.state='posted'
  JOIN accounting_lines l ON l.entry_id=e.id AND l.account_code='2300' WHERE c.order_id=?`;
export async function snapshotFor(
  db: D1Database,
  lines: Array<{ id: string; product_id: string | null }>,
  at: string,
  rulesOverride?:CostRule[],
  dayOverride?:string,
): Promise<RuleSnapshot> {
  const day = dayOverride??baghdadDay(new Date(at));
  const [rawRules, catalogs, placements] = await Promise.all([
    rulesOverride?Promise.resolve({results:rulesOverride.map((r)=>({snapshot:JSON.stringify(r)}))}):db
      .prepare(
        `SELECT v.snapshot FROM finance_rule_versions v WHERE v.created_at<=? AND v.version=(SELECT MAX(v2.version) FROM finance_rule_versions v2 WHERE v2.rule_id=v.rule_id AND v2.created_at<=?) ORDER BY v.rule_id LIMIT 500`,
      )
      .bind(at, at)
      .all<{ snapshot: string }>(),
    db.prepare('SELECT id,parent_id FROM catalogs').all<{ id: string; parent_id: string | null }>(),
    db
      .prepare(
        `SELECT product_id,catalog_id FROM product_catalogs WHERE product_id IN (SELECT value FROM json_each(?)) UNION SELECT id,category_id FROM products WHERE id IN (SELECT value FROM json_each(?)) UNION SELECT id,sub_category_id FROM products WHERE id IN (SELECT value FROM json_each(?))`,
      )
      .bind(...Array(3).fill(JSON.stringify(lines.map((l) => l.product_id).filter(Boolean))))
      .all<{ product_id: string; catalog_id: string | null }>(),
  ]);
  const parents = new Map((catalogs.results ?? []).map((c) => [c.id, c.parent_id]));
  const depth = (id: string) => {
    let n = 1,
      current = parents.get(id);
    const visited = new Set([id]);
    while (current && !visited.has(current)) {
      visited.add(current);
      n++;
      current = parents.get(current);
    }
    return n;
  };
  return lines.map((l) => {
    const ancestors = new Map<string, number>();
    for (const p of placements.results ?? []) {
      if (p.product_id !== l.product_id || !p.catalog_id) continue;
      let id: string | null = p.catalog_id;
      const seen = new Set<string>();
      while (id && !seen.has(id)) {
        seen.add(id);
        ancestors.set(id, depth(id));
        id = parents.get(id) ?? null;
      }
    }
    const rules = (rawRules.results ?? [])
      .map((v) => JSON.parse(v.snapshot) as CostRule & { active: number })
      .filter((r) => r.active === 1 && r.effective_from <= day && (!r.effective_to || r.effective_to >= day));
    return {
      line_id: l.id,
      product_id: l.product_id ?? '',
      rules: matchingRules(rules, l.product_id ?? '', ancestors),
    };
  });
}
/** Appended to checkout's transaction: applicability and versions freeze at sale. */
export async function planOrderFinanceSnapshot(
  db: D1Database,
  orderId: string,
  lines: Array<{ id: string; product_id: string | null }>,
  at: string,
  walletAdvanceIqd = 0,
) {
  if (!(await operationsInstalled(db))) return [];
  const frozen = await snapshotFor(db, lines, at);
  const statements = [
    db
      .prepare('INSERT INTO finance_order_snapshots(order_id,rules_json,created_at) VALUES (?,?,?)')
      .bind(orderId, JSON.stringify(frozen), at),
  ];
  if (await workspaceInstalled(db)) {
    for (const line of lines) {
      statements.push(db.prepare(`INSERT INTO finance_line_departments
        (order_item_id,main_catalog_id,sub_catalog_id,main_name,sub_name,captured_at)
        SELECT ?,p.category_id,p.sub_category_id,COALESCE(mc.name_ar,''),COALESCE(sc.name_ar,''),?
        FROM products p LEFT JOIN catalogs mc ON mc.id=p.category_id LEFT JOIN catalogs sc ON sc.id=p.sub_category_id
        WHERE p.id=? ON CONFLICT(order_item_id) DO NOTHING`).bind(line.id, at, line.product_id));
    }
  }
  if (walletAdvanceIqd > 0)
    statements.push(
      ...journalPlan(
        db,
        {
          key: `wallet-advance:${orderId}`,
          day: baghdadDay(new Date(at)),
          title: 'دفع طلب من المحفظة',
          source: 'order',
          sourceId: orderId,
        },
        [
          { account: '2200', debit: walletAdvanceIqd },
          { account: '2300', credit: walletAdvanceIqd },
        ],
      ).statements,
    );
  return statements;
}
export interface OrderGoodsLine {
  id: string;
  product_id: string | null;
  qty: number;
  line_total_iqd: number;
  component_alloc_iqd: number | null;
  bundle_parent_item_id: string | null;
  coupon_discount_iqd: number;
  membership_discount_iqd: number;
  cost_iqd: number | null;
  cost_basis: string;
  name_snapshot: string;
  variant_id: string | null;
  option_id: string;
  color_id: string;
  sku_snapshot: string;
}
export async function orderGoods(db: D1Database, orderId: string) {
  return getOrderGoods(db, orderId);
}
export async function runOrderFinancialEffects(
  env: Env,
  orderId: string,
  milestone: 'prepared' | 'delivered',
  postingDay?: string,
  staffOnly?:{staffId:string;employmentVersion:number;rules:CostRule[];skipReconcile?:boolean},
  deferDeliveryReconcile=false,
) {
  const db = env.DB;
  if (!(await operationsInstalled(db))) return;
  const goods = await orderGoods(db, orderId);
  if (!goods || goods.order.seller_type !== 'levonis') return;
  if (milestone === 'delivered' && goods.order.status !== 'delivered') return;
  let snapshot = await db
    .prepare('SELECT rules_json FROM finance_order_snapshots WHERE order_id=?')
    .bind(orderId)
    .first<{ rules_json: string }>();
  if (!snapshot) {
    const at = String(goods.order.created_at);
    const statements = await planOrderFinanceSnapshot(db, orderId, goods.lines, at);
    if (statements.length) await db.batch(statements);
    snapshot = await db
      .prepare('SELECT rules_json FROM finance_order_snapshots WHERE order_id=?')
      .bind(orderId)
      .first<{ rules_json: string }>();
  }
  if (!snapshot) return;
  let frozen = JSON.parse(snapshot.rules_json) as RuleSnapshot;
  const hasEmployment=await employmentInstalled(db);
  const staffRows=hasEmployment?(await db.prepare('SELECT * FROM finance_staff').all<EmploymentStaff>()).results??[]:[];
  const temporalVersions=await wageVersions(db);
  const temporalRules=new Set(temporalVersions.filter(v=>staffRows.find(s=>s.id===v.staff_id)?.start_work_date||(v.revision>1&&!v.id.startsWith('wage:baseline:'))).map(v=>v.rule_id));
  const temporalStaff=new Set(temporalVersions.filter(v=>temporalRules.has(v.rule_id)).map(v=>v.staff_id));
  const staffById=new Map(staffRows.map((s)=>[s.id,s]));
  // Deferred preparation pay must exist before the delivery sale publishes
  // investor profit. Publishing first would expose a transient inflated margin.
  if(!staffOnly&&milestone==='delivered'&&staffRows.some((s)=>s.start_work_date&&staffCanAccrue(s,goods.order)))
    await runOrderFinancialEffects(env,orderId,'prepared',postingDay??baghdadDay(new Date(String(goods.order.delivered_at??new Date().toISOString()))),undefined,true);
  if(hasEmployment){
    const eligible=staffRows.filter((s)=>!temporalStaff.has(s.id)&&s.start_work_date&&staffCanAccrue(s,goods.order)&&(!staffOnly||s.id===staffOnly.staffId));
    for(const employee of eligible){
      if(staffOnly&&employee.employment_version!==staffOnly.employmentVersion)throw new Error('تغير إعداد الموظف أثناء تطبيق الاستحقاقات');
      const prior=await db.prepare('SELECT employment_version FROM finance_staff_order_rules WHERE order_id=? AND staff_id=?').bind(orderId,employee.id).first<{employment_version:number}>();
      if(prior?.employment_version===employee.employment_version)continue;
      const rules=staffOnly?.rules??(await db.prepare('SELECT * FROM finance_cost_rules WHERE staff_id=? AND active=1').bind(employee.id).all<CostRule>()).results??[];
      const deliveredDay=baghdadDay(new Date(String(goods.order.delivered_at)));
      const applied=await snapshotFor(db,goods.lines,new Date().toISOString(),rules.map((r)=>r.employment_effective_default&&employee.start_work_date?{...r,effective_from:nextEmploymentDay(employee.start_work_date)}:r),deliveredDay);
      await db.batch([...fence(db,'EXISTS(SELECT 1 FROM finance_staff WHERE id=? AND employment_version=? AND active=1 AND archived_at IS NULL) AND EXISTS(SELECT 1 FROM orders WHERE id=? AND status=? AND delivered_at IS ?)',[employee.id,employee.employment_version,orderId,goods.order.status,goods.order.delivered_at]),
        db.prepare(`INSERT INTO finance_staff_order_rules(order_id,staff_id,employment_version,rules_json,created_at) VALUES (?,?,?,?,?) ON CONFLICT(order_id,staff_id) DO UPDATE SET employment_version=excluded.employment_version,rules_json=excluded.rules_json,created_at=excluded.created_at`).bind(orderId,employee.id,employee.employment_version,JSON.stringify(applied),new Date().toISOString())]);
    }
    const overlays=(await db.prepare('SELECT r.rules_json FROM finance_staff_order_rules r JOIN finance_staff s ON s.id=r.staff_id WHERE r.order_id=? AND r.employment_version=s.employment_version AND s.active=1 AND s.archived_at IS NULL').bind(orderId).all<{rules_json:string}>()).results??[];
    const supplemental=overlays.flatMap((r)=>JSON.parse(r.rules_json) as RuleSnapshot);
    frozen=goods.lines.map((line)=>({line_id:line.id,product_id:line.product_id??'',rules:[...(frozen.find((f)=>f.line_id===line.id)?.rules??[]).filter((r)=>!r.staff_id||!staffById.get(r.staff_id)?.start_work_date),...supplemental.filter((f)=>f.line_id===line.id).flatMap((f)=>f.rules)]}));
  }
  const assignments =
    (
      await db
        .prepare('SELECT group_key,staff_id,completed_at FROM finance_task_assignments WHERE order_id=?')
        .bind(orderId)
        .all<{ group_key: string; staff_id: string; completed_at: string | null }>()
    ).results ?? [];
  const day =
    postingDay ??
    (milestone === 'delivered'
      ? baghdadDay(new Date(String(goods.order.delivered_at ?? new Date().toISOString())))
      : baghdadDay());
  const statements: D1PreparedStatement[] = [];
  const charged =
    (
      await db
        .prepare(
          'SELECT rule_id,SUM(COALESCE(amount_iqd,0)) AS amount FROM finance_order_costs WHERE order_id=? GROUP BY rule_id',
        )
        .bind(orderId)
        .all<{ rule_id: string; amount: number }>()
    ).results ?? [];
  const capUsed = new Map(charged.map((r) => [r.rule_id, r.amount]));
  const groups = new Map<string, { rule: CostRule; lineIds: string[] }>();
  for (const line of goods.lines) {
    for (const rule of frozen.find((f) => f.line_id === line.id)?.rules ?? []) {
      if (rule.milestone !== milestone || temporalRules.has(rule.id)) continue;
      const key = rule.basis === 'order' ? `${rule.staff_id ?? ''}:${rule.group_key}:order` : `${rule.id}:${line.id}`;
      const found = groups.get(key);
      if (found) {
        found.lineIds.push(line.id);
        if (
          (rule.scope_rank ?? 0) > (found.rule.scope_rank ?? 0) ||
          ((rule.scope_rank ?? 0) === (found.rule.scope_rank ?? 0) && rule.priority > found.rule.priority)
        )
          found.rule = rule;
      } else groups.set(key, { rule, lineIds: [line.id] });
    }
  }
  const percentageBase=[...groups.values()].some(({rule})=>['profit_percent','revenue_percent'].includes(rule.basis))?await getOrderProfitBase(db,orderId):null;
  for (const { rule, lineIds } of groups.values()) {
    const assigned = assignments.find((a) => a.group_key === rule.group_key);
    if (rule.requires_assignment && (!assigned || (milestone === 'prepared' && !assigned.completed_at)))
      continue;
    const staff = assigned?.staff_id ?? rule.staff_id;
    if(staffOnly&&staff!==staffOnly.staffId)continue;
    const employee=staff?staffById.get(staff):undefined;
    if(employee&&!staffCanAccrue(employee,goods.order))continue;
    const relevant = goods.lines.filter((l) => lineIds.includes(l.id));
    const percentageLines=['profit_percent','revenue_percent'].includes(rule.basis)?percentageBase!.lines.filter(l=>lineIds.includes(l.id)):null;
    const qty = relevant.reduce((s, l) => s + l.qty, 0),
      revenue = percentageLines?percentageLines.reduce((sum,l)=>sum+l.retained_revenue_iqd,0):relevant.reduce((s, l) => s + l.net_goods_iqd, 0);
    const costLines=percentageLines??relevant;
    const cogs = costLines.some((l) => l.cogs_iqd === null || !isConfirmedOrderCost(l.cost_confidence))
      ? null
      : costLines.reduce((s, l) => s + l.cogs_iqd!, 0);
    const unknownRevenue=percentageLines?.some(hasUnknownRefund)??false;
    const snapshotJson = JSON.stringify({
      rule,
      line_ids: lineIds,
      net_goods_iqd: unknownRevenue?null:revenue,
      fifo_cogs_iqd: cogs,
      qty,
      staff_id: staff,
    });
    let amount = unknownRevenue?null:costAmount({ ...rule, cap_iqd: null }, qty, revenue, cogs);
    const itemId = rule.basis === 'order' ? null : lineIds[0];
    if(staff&&await db.prepare(`SELECT 1 FROM finance_order_costs WHERE order_id=? AND staff_id=? AND group_key=? AND milestone=? AND rule_id<>? AND state<>'reversed' AND (order_item_id IS ? OR order_item_id IS NULL OR ? IS NULL) LIMIT 1`).bind(orderId,staff,rule.group_key,milestone,rule.id,itemId,itemId).first())continue;
    const existing = await db
      .prepare(
        'SELECT id,state,amount_iqd FROM finance_order_costs WHERE order_id=? AND rule_id=? AND order_item_id IS ?',
      )
      .bind(orderId, rule.id, itemId)
      .first<{ id: string; state: string; amount_iqd: number | null }>();
    if (existing && existing.state !== 'pending_cost') continue;
    if(employee)statements.push(...fence(db,'EXISTS(SELECT 1 FROM finance_staff WHERE id=? AND employment_version=? AND active=1 AND archived_at IS NULL) AND EXISTS(SELECT 1 FROM orders WHERE id=? AND status=? AND delivered_at IS ?)',[employee.id,employee.employment_version,orderId,goods.order.status,goods.order.delivered_at??null]));
    // The employee and completion state read above must still belong to this
    // task when its cost becomes payable. Reassignment is a competing write,
    // even when the previous cost was only waiting for FIFO.
    statements.push(...fence(
      db,
      assigned
        ? 'EXISTS(SELECT 1 FROM finance_task_assignments WHERE order_id=? AND group_key=? AND staff_id=? AND completed_at IS ?)'
        : 'NOT EXISTS(SELECT 1 FROM finance_task_assignments WHERE order_id=? AND group_key=?)',
      assigned ? [orderId, rule.group_key, assigned.staff_id, assigned.completed_at] : [orderId, rule.group_key],
    ));
    if (existing && amount === null) {
      statements.push(
        ...fence(db, "EXISTS(SELECT 1 FROM finance_order_costs WHERE id=? AND state='pending_cost')", [existing.id]),
        db.prepare("UPDATE finance_order_costs SET staff_id=?,snapshot=? WHERE id=? AND state='pending_cost'")
          .bind(staff, snapshotJson, existing.id),
      );
      continue;
    }
    if (amount !== null && rule.cap_iqd !== null)
      amount = Math.min(amount, Math.max(0, rule.cap_iqd - (capUsed.get(rule.id) ?? 0)));
    if (amount !== null) capUsed.set(rule.id, (capUsed.get(rule.id) ?? 0) + amount);
    const id = existing?.id ?? newId('oc'),
      expense = amount !== null && amount > 0 ? newId('opex') : null;
    if (existing)
      statements.push(
        ...fence(db, "EXISTS(SELECT 1 FROM finance_order_costs WHERE id=? AND state='pending_cost')", [id]),
      );
    if (expense)
      statements.push(
        db
          .prepare(
            'INSERT INTO operating_expenses(id,category_id,amount_iqd,expense_day,title,note) VALUES (?,?,?,?,?,?)',
          )
          .bind(
            expense,
            rule.category_id,
            amount,
            day,
            rule.name,
            `طلب ${orderId} / قاعدة ${rule.id} إصدار ${rule.version}`,
          ),
      );
    if (existing)
      statements.push(
        db
          .prepare(
            "UPDATE finance_order_costs SET amount_iqd=?,base_iqd=?,state='due',expense_id=?,snapshot=?,cost_day=?,staff_id=? WHERE id=? AND state='pending_cost'",
          )
          .bind(
            amount,
            unknownRevenue?null:rule.basis === 'profit_percent' ? (cogs === null ? null : Math.max(0, revenue - cogs)) : revenue,
            expense,
            snapshotJson,
            day,
            staff,
            id,
          ),
      );
    else
      statements.push(
        db
          .prepare(
            'INSERT INTO finance_order_costs(id,order_id,order_item_id,rule_id,rule_version,rule_name,group_key,staff_id,category_id,center_id,milestone,base_iqd,qty,amount_iqd,cost_day,state,expense_id,snapshot) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
          )
          .bind(
            id,
            orderId,
            itemId,
            rule.id,
            rule.version,
            rule.name,
            rule.group_key,
            staff,
            rule.category_id,
            rule.center_id,
            milestone,
            unknownRevenue?null:rule.basis === 'profit_percent' ? (cogs === null ? null : Math.max(0, revenue - cogs)) : revenue,
            qty,
            amount,
            day,
            amount === null ? 'pending_cost' : 'due',
            expense,
            snapshotJson,
          ),
      );
    if (expense)
      statements.push(
        ...journalPlan(
          db,
          { key: `order-cost:${id}`, day, title: rule.name, source: 'order_cost', sourceId: id },
          [
            { account: '5100', debit: amount! },
            { account: staff ? '2100' : '2000', credit: amount! },
          ],
        ).statements,
      );
  }
  if (
    !staffOnly && milestone === 'delivered' &&
    !(await db.prepare('SELECT id FROM accounting_entries WHERE event_key=?').bind(`sale:${orderId}`).first())
  ) {
    const revenue = goods.lines.reduce((s, l) => s + l.net_goods_iqd, 0),
      shipping = Number(goods.order.shipping_iqd ?? 0) + Number(goods.order.cod_tax_iqd ?? 0),
      total = revenue + shipping;
    const prepaid =
      (
        await db
          .prepare(
            `SELECT (${advanceCollectionsSql}) AS n`,
          )
          .bind(orderId)
          .first<{ n: number }>()
      )?.n ?? 0;
    const receivable = Math.max(
      0,
      Math.min(
        total,
        Number(goods.order.due_on_delivery_iqd ?? 0) + Number(goods.order.gini_paid_iqd ?? 0) - prepaid,
      ),
    );
    if (total > 0)
      statements.push(
        // Serialize with collections: if another request records an advance
        // or posts this sale after our reads, the entire batch must retry.
        ...fence(
          db,
          `(${advanceCollectionsSql})=? AND NOT EXISTS(SELECT 1 FROM accounting_entries WHERE event_key=?)`,
          [orderId, prepaid, `sale:${orderId}`],
        ),
        ...journalPlan(
          db,
          { key: `sale:${orderId}`, day, title: 'إيراد طلب مستلم', source: 'order', sourceId: orderId },
          [
            { account: '1100', debit: receivable },
            { account: '2300', debit: total - receivable },
            { account: '4000', credit: revenue },
            { account: '4100', credit: shipping },
          ],
        ).statements,
      );
  }
  if (
    !staffOnly && milestone === 'delivered' &&
    !(await db.prepare('SELECT id FROM accounting_entries WHERE event_key=?').bind(`cogs:${orderId}`).first())
  ) {
    const cogs = goods.lines.every((l) => l.cogs_iqd !== null && isConfirmedOrderCost(l.cost_confidence))
      ? goods.lines.reduce((s, l) => s + (l.cogs_iqd ?? 0), 0)
      : null;
    if (cogs && cogs > 0)
      statements.push(
        ...journalPlan(
          db,
          { key: `cogs:${orderId}`, day, title: 'تكلفة بضاعة مباعة', source: 'order', sourceId: orderId },
          [
            { account: '5000', debit: cogs },
            { account: '1200', credit: cogs },
          ],
        ).statements,
      );
  }
  if (statements.length) await db.batch(statements);
  await db
    .prepare('DELETE FROM finance_posting_errors WHERE event_key=?')
    .bind(`${milestone}:${orderId}`)
    .run();
  if (!staffOnly && milestone === 'delivered') {
    if (goods.lines.some((l) => l.cogs_iqd === null || !isConfirmedOrderCost(l.cost_confidence)))
      await recordFinancialFailure(
        db,
        orderId,
        'cogs',
        new Error('تكلفة البضاعة غير مكتملة؛ راجع دفعات المخزون أو تكلفة الطلب المثبتة وأعد الترحيل'),
      );
    else
      await db.prepare('DELETE FROM finance_posting_errors WHERE event_key=?').bind(`cogs:${orderId}`).run();
  }
  // Prepared wages, delivery and explicit retries all validate the same source
  // before their percentage earnings become available for withdrawal.
  // The delivery call posts sale/COGS immediately after its preparation pass.
  // Publishing investors in that inner pass would require a sale not posted yet.
  if(deferDeliveryReconcile) await reconcileStaffOrderCosts(db,orderId,{day});
  else if(!staffOnly?.skipReconcile){const reconciled=await reconcileFinanceOrder(db, orderId, { day });if(!reconciled.complete)throw new Error('تغيرت بيانات الطلب أثناء التسوية؛ أعد المحاولة');}
}
export async function recordReturnFinancials(
  env: Env,
  input: {
    caseId: string;
    orderId: string;
    itemId: string;
    refundIqd: number;
    qty: number;
    restocked: boolean;
    actor: string;
    day: string;
    cogsIqd?: number | null;
    channel?: string;
  },
) {
  const db = env.DB;
  if (!(await operationsInstalled(db))) return;
  const goods = await orderGoods(db, input.orderId),
    line = goods?.lines.find((l) => l.id === input.itemId);
  if (!line) return;
  const cost = input.restocked
    ? input.cogsIqd !== undefined
      ? input.cogsIqd
      : line.cogs_iqd === null
        ? null
        : Math.floor((line.cogs_iqd * input.qty) / line.qty)
    : 0;
  await db
    .prepare(
      'INSERT INTO finance_refund_facts(case_id,order_id,refund_iqd,qty,disposition,refunded_day,cogs_iqd,channel) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(case_id) DO NOTHING',
    )
    .bind(
      input.caseId,
      input.orderId,
      input.refundIqd,
      input.qty,
      input.restocked ? 'restock' : 'damage',
      input.day,
      cost,
      input.channel ?? 'wallet',
    )
    .run();
  await postStoredRefund(env, input.caseId, input.actor, input.day);
}
export async function postStoredRefund(env: Env, caseId: string, actor: string, postingDay?: string) {
  const db = env.DB;
  const fact = await db
    .prepare('SELECT * FROM finance_refund_facts WHERE case_id=?')
    .bind(caseId)
    .first<{
      case_id: string;
      order_id: string;
      refund_iqd: number;
      cogs_iqd: number | null;
      disposition: string;
      channel: string;
      refunded_day: string;
      posted_at: string | null;
    }>();
  if (!fact) return;
  if (fact.posted_at) {
    await reconcileFinanceOrder(db, fact.order_id, { actor, day: postingDay });
    return;
  }
  const day = postingDay ?? fact.refunded_day;
  const statements: D1PreparedStatement[] = [];
  if (fact.refund_iqd > 0)
    statements.push(
      ...journalPlan(
        db,
        {
          key: `refund:${caseId}`,
          day: day,
          title: 'رد قيمة البضاعة إلى العميل',
          source: 'return',
          sourceId: caseId,
          actor: actor,
        },
        [
          { account: '4000', debit: fact.refund_iqd },
          { account: fact.channel === 'gini' ? '1100' : '2200', credit: fact.refund_iqd },
        ],
      ).statements,
    );
  if (fact.disposition === 'restock' && fact.cogs_iqd && fact.cogs_iqd > 0)
    statements.push(
      ...journalPlan(
        db,
        {
          key: `return-stock:${caseId}`,
          day: day,
          title: 'تكلفة بضاعة مرتجعة',
          source: 'return',
          sourceId: caseId,
          actor: actor,
        },
        [
          { account: '1200', debit: fact.cogs_iqd },
          { account: '5000', credit: fact.cogs_iqd },
        ],
      ).statements,
    );
  statements.push(
    db
      .prepare('UPDATE finance_refund_facts SET posted_at=? WHERE case_id=? AND posted_at IS NULL')
      .bind(new Date().toISOString(), caseId),
  );
  await db.batch(statements);
  await db
    .prepare('DELETE FROM finance_posting_errors WHERE event_key=?')
    .bind(`refund:${fact.order_id}`)
    .run();
  await reconcileFinanceOrder(db, fact.order_id, { actor, day });
}
