/** Current wage allocation is a projection. The original rule/line snapshot
 * remains evidence; old installations fall back to that recorded scope. */
export function financialCostLines<T extends {id:string}>(cost:Record<string,unknown>,lines:T[]):T[] {
  if(cost.order_item_id)return lines.filter(line=>line.id===cost.order_item_id);
  let ids:unknown;
  try {
    ids=cost.wage_line_ids_json!=null?JSON.parse(String(cost.wage_line_ids_json))
      :JSON.parse(String(cost.snapshot??'{}')).line_ids;
  } catch { /* Legacy costs without a recorded scope apply to the whole order. */ }
  return Array.isArray(ids)?lines.filter(line=>ids.includes(line.id)):lines;
}
