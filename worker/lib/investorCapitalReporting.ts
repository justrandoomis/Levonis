/** The contract source already caps recovered principal by actual funding
 * after losses. Raw per-allocation evidence can exceed that cap and must not
 * become extra principal in charts. Attribute the existing capped balance in
 * delivery order before filtering dates, so disjoint periods sum to the same
 * cumulative balance. This is read-only; it never changes events or payouts. */
export const investorReportedAllocationsSql = `SELECT contract_id,user_id,allocation_id,earning_day,profit_iqd,
  MAX(0,MIN(capital_iqd,principal_limit-prior_principal)) AS recovered_iqd
  FROM (
    SELECT r.contract_id,c.user_id,r.allocation_id,date(o.delivered_at,'+3 hours') AS earning_day,
      r.profit_iqd,r.capital_iqd,COALESCE(e.accrued_iqd,0) AS principal_limit,
      COALESCE(SUM(r.capital_iqd) OVER (PARTITION BY r.contract_id
        ORDER BY julianday(o.delivered_at),o.id,r.allocation_id
        ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING),0) AS prior_principal
    FROM investor_allocation_results r JOIN investment_contracts c ON c.id=r.contract_id
    JOIN order_item_inventory_allocations a ON a.id=r.allocation_id JOIN orders o ON o.id=a.order_id
    LEFT JOIN finance_investor_earnings e ON e.contract_id=r.contract_id AND e.kind='investor_capital'
    WHERE o.status='delivered'
  )`;
