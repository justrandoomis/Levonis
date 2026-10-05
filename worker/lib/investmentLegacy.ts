/** These amounts are USD cents, not IQD. There is deliberately no conversion
 * or entitlement posting here. Linking needs human evidence, not name matching. */
export async function investmentLegacy(db:D1Database,userId?:string){
  const investments=(await db.prepare(`SELECT i.*,u.name AS user_name,u.email,(SELECT COUNT(*) FROM investment_items WHERE investment_id=i.id) AS items_count,l.state AS review_state,l.evidence,l.contract_id FROM investments i JOIN users u ON u.id=i.user_id LEFT JOIN investment_legacy_links l ON l.legacy_investment_id=i.id WHERE (? IS NULL OR i.user_id=?) ORDER BY i.created_at DESC,i.id`).bind(userId??null,userId??null).all()).results??[];
  const ids=JSON.stringify(investments.map(i=>i.id));
  const items=(await db.prepare('SELECT * FROM investment_items WHERE investment_id IN (SELECT value FROM json_each(?)) ORDER BY investment_id,id').bind(ids).all()).results??[];
  const messages=(await db.prepare('SELECT id,user_id,sender,message,created_at FROM investor_messages WHERE (? IS NULL OR user_id=?) ORDER BY created_at,id').bind(userId??null,userId??null).all()).results??[];
  return {currency:'USD',unit:'cent',withdrawable:false,investments,items,messages};
}
