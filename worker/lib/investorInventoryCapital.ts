/** Capital on the shelf is a principal quantity, not the purchase's original
 * total or today's catalogue cost. Procurement records the integer remainder
 * on each received lot; location splits must not count a receipt twice. */
export async function investorInventoryCapital(db: D1Database, contract: {id:string;incoming_id:string;capital_share_bps:number}) {
  const exact = await db.prepare(`SELECT
    EXISTS(SELECT 1 FROM purchase_investor_allocations WHERE contract_id=?1) AS exact,
    COALESCE(SUM(l.qty_remaining*p.unit_principal_iqd),0) AS n,
    COALESCE(SUM(CASE WHEN p.lot_id IS NULL THEN l.qty_remaining ELSE 0 END),0) AS missing_qty
    FROM inventory_lots l LEFT JOIN purchase_investor_lot_capital p ON p.lot_id=l.id AND p.contract_id=?1
    WHERE l.incoming_id=?2 AND l.qty_remaining>0`).bind(contract.id,contract.incoming_id).first<{exact:number;n:number;missing_qty:number}>();
  if (exact?.exact) {
    const funded = (await db.prepare("SELECT COALESCE(SUM(amount_iqd),0) AS n FROM investor_finance_events WHERE contract_id=? AND kind='funding'").bind(contract.id).first<{n:number}>())?.n ?? 0;
    const received = await db.prepare(`SELECT COALESCE(SUM(r.qty*p.unit_principal_iqd),0) AS n,
      COALESCE(SUM(CASE WHEN p.lot_id IS NULL THEN r.qty ELSE 0 END),0) AS missing_qty
      FROM incoming_inventory_receipts r LEFT JOIN purchase_investor_lot_capital p ON p.lot_id=r.lot_id AND p.contract_id=?
      WHERE r.incoming_id=?`).bind(contract.id,contract.incoming_id).first<{n:number;missing_qty:number}>();
    return { inventory_iqd: exact.missing_qty ? null : exact.n, received_iqd: received?.missing_qty ? null : Math.min(funded, received?.n ?? 0) };
  }
  const inventory = await db.prepare(`SELECT
    COALESCE(SUM(l.qty_remaining*COALESCE((SELECT v.unit_cost_iqd FROM inventory_lot_cost_versions v WHERE v.lot_id=l.id ORDER BY version DESC LIMIT 1),l.unit_cost_iqd)),0) AS n,
    COALESCE(SUM(CASE WHEN COALESCE((SELECT v.unit_cost_iqd FROM inventory_lot_cost_versions v WHERE v.lot_id=l.id ORDER BY version DESC LIMIT 1),l.unit_cost_iqd) IS NULL THEN l.qty_remaining ELSE 0 END),0) AS unknown
    FROM inventory_lots l WHERE l.incoming_id=?`).bind(contract.incoming_id).first<{n:number;unknown:number}>();
  const received = await db.prepare(`SELECT MIN(c.principal_iqd*i.qty_received/i.qty_ordered,
    COALESCE((SELECT SUM(e.amount_iqd) FROM investor_finance_events e WHERE e.contract_id=c.id AND e.kind='funding'),0)) AS n
    FROM investment_contracts c JOIN incoming_inventory i ON i.id=c.incoming_id WHERE c.id=?`).bind(contract.id).first<{n:number}>();
  return { inventory_iqd: inventory?.unknown ? null : Number(BigInt(inventory?.n ?? 0)*BigInt(contract.capital_share_bps)/10000n), received_iqd: received?.n ?? 0 };
}
