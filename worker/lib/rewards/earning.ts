/**
 * WHO EARNS THE WEEKLY COUPONS, WRITTEN ONCE (owner, 2026-11-05; DECISIONS rows 295
 * and 298). `issueWeeklyRewards` issues by these fragments, and the customer's
 * «طابعاتك», the admin's «الطابعات» and the overview read by them too, so no screen
 * can say a printer earns while the sweep passes it over, or the other way round.
 *
 * Every fragment reads the same aliases: `d` is a slot's first unit with its `week`,
 * `o` its order and `oi` its order item (`slotJoins`). `b` names the statement's own
 * placeholders for the instant, the programme's start and the owner's months.
 *
 * A printer earns while ALL of these hold:
 *   · the order was delivered, by the shop, on a bought line (`SLOT_SOLD_HERE_SQL`);
 *   · the end of its warranty-replacement chain is open (`slotOpenSql`);
 *   · it was not traded in and is not in the shop for a trade-in;
 *   · no refund took this slot (`slotNotRefundedSql`);
 *   · it is a printer, not a bundle parent (`SLOT_IS_PRINTER_SQL`);
 *   · it is inside the owner's months of its base warranty (`slotInsideMonthsSql`);
 *   · its first week has come (`d.week >= 0`).
 *
 * This file holds no statement of its own and reads no configuration.
 *
 * NOTHING HERE READS AN IMPORT WHILE THE MODULE LOADS. This file sits on an import
 * cycle through services/myDevices, so a constant built at load reads `inShopSql`
 * before its module has run, and a process that entered at myDevices or at
 * routes/devices dies on it. So every fragment that needs an import is a function,
 * called when a statement is built (tests/rewardsEarningLoadOrder.test.ts).
 */
import { MAX_REPLACEMENT_HOPS, tradedInSql } from '../deviceCustody';
import { inShopSql } from '../services/myDevices';

/** The placeholders a statement binds the instant, the programme's start and the months to. */
export interface EarningBinds {
  now: string;
  started: string;
  months: string;
}

const chainHops = () => Array.from({ length: MAX_REPLACEMENT_HOPS }, (_, i) => i + 1);

/**
 * THE END OF A SLOT'S WARRANTY-REPLACEMENT CHAIN, joined to `d`, the unit the
 * customer bought. A replacement sits on the same line under a new unit_index, so
 * the slot keeps earning for the device in the customer's hands, and stops when
 * that device's warranty closes (worker/lib/deviceCustody.ts `liveUnitOfSlot`).
 */
const chainJoins = (root = 'd', hop = 'r') =>
  chainHops().map((h) => `LEFT JOIN order_item_units ${hop}${h} ON ${hop}${h}.id = ${h === 1 ? root : `${hop}${h - 1}`}.replaced_by_unit_id`).join('\n         ');

/** Still open. A unit closed by a cancel whose order was then delivered again stays open (serialAssignments.ts REDELIVERED); the query only reads delivered orders. */
const OPEN = (a: string) => `(${a}.warranty_closed_at IS NULL OR ${a}.warranty_closed_reason = 'order_cancelled')`;

const chainEndOpen = (root = 'd', hop = 'r') =>
  `CASE ${chainHops().reverse().map((h) => `WHEN ${hop}${h}.id IS NOT NULL THEN ${OPEN(`${hop}${h}`)}`).join(' ')} ELSE ${OPEN(root)} END`;

/** The live unit's own column, at the end of the chain. */
const chainEnd = (column: string, root = 'd', hop = 'r') =>
  `CASE ${chainHops().reverse().map((h) => `WHEN ${hop}${h}.id IS NOT NULL THEN ${hop}${h}.${column}`).join(' ')} ELSE ${root}.${column} END`;

/** Every unit id of the slot's chain, for a search on the device in the customer's hands. */
export const slotChainUnitIds = () => `d.id, ${chainHops().map((h) => `r${h}.id`).join(', ')}`;

/** Seven days from the later of the warranty's start, the delivery and the programme's start. */
const firstWeekJulian = (b: Pick<EarningBinds, 'started'>, u: string) =>
  `MAX(julianday(COALESCE(${u}.warranty_start_at, ${u}.delivered_at)),
       julianday(COALESCE(${u}.delivered_at, ${u}.warranty_start_at)),
       julianday(${b.started}))`;

/** The week a slot is in, 0 first. Over a unit row `u`, for the `d` table's own column. */
export const slotWeekSql = (b: Pick<EarningBinds, 'now' | 'started'>, u = 'u') =>
  `CAST((julianday(${b.now}) - ${firstWeekJulian(b, u)}) / 7 AS INTEGER)`;

const iso = (expression: string) => `strftime('%Y-%m-%dT%H:%M:%fZ', ${expression})`;

/** When a slot's week 0 began: the instant every later week is counted from. */
export const slotFirstWeekAtSql = (b: Pick<EarningBinds, 'started'>, u = 'd') => iso(firstWeekJulian(b, u));

/** At most `months` of its base warranty, from the warranty's own start: an extended warranty adds nothing. */
const monthsFrom = (b: Pick<EarningBinds, 'months'>, u: string) =>
  `COALESCE(${u}.warranty_start_at, ${u}.delivered_at), '+' || MIN(COALESCE(${u}.warranty_base_months, 12), ${b.months}) || ' months'`;

export const slotInsideMonthsSql = (b: Pick<EarningBinds, 'now' | 'months'>, u = 'u') => `julianday(${monthsFrom(b, u)}) > julianday(${b.now})`;

/** When a slot's weeks run out. */
export const slotEndsAtSql = (b: Pick<EarningBinds, 'months'>, u = 'd') => iso(monthsFrom(b, u));

/** The order and line behind `d`, and the chain's joins. */
export const slotJoins = () => `JOIN orders o ON o.id = d.order_id
         JOIN order_items oi ON oi.id = d.order_item_id
         ${chainJoins()}`;

/** Delivered by the shop on a bought line. The cheap tests: the sweep puts them first. */
export const SLOT_SOLD_HERE_SQL = `o.status = 'delivered'
          AND COALESCE(o.seller_type, 'levonis') <> 'merchant'
          AND oi.product_id IS NOT NULL
          AND oi.gift_entitlement_id IS NULL`;

/** The canonical printer: in a printer catalog, and not a bundle parent (its printer component line is the device). */
export const SLOT_IS_PRINTER_SQL = `NOT EXISTS (SELECT 1 FROM order_items k WHERE k.bundle_parent_item_id = oi.id)
          AND EXISTS (SELECT 1 FROM product_catalogs pc JOIN catalogs c ON c.id = pc.catalog_id AND c.is_printer_catalog = 1
                       WHERE pc.product_id = oi.product_id)`;

export const slotOpenSql = () => chainEndOpen();
export const slotTradedInSql = () => tradedInSql('d');
export const slotInShopSql = () => inShopSql('d');

/**
 * A refund the case could not pin on a unit still takes a printer off
 * the line: the highest slots still open stop, as revokeRewardsForReturn
 * does. A lower slot counts by the end of its own chain: one whose
 * replacement went back is already the printer that refund took.
 */
export const slotNotRefundedSql = () => `(SELECT COUNT(*) FROM order_item_units low
                 ${chainJoins('low', 'lr')}
                WHERE low.order_item_id = d.order_item_id AND low.replacement_of_unit_id IS NULL AND low.unit_index < d.unit_index
                  AND ${chainEndOpen('low', 'lr')})
              < oi.qty - COALESCE((SELECT SUM(rc.qty) FROM return_cases rc
                                    WHERE rc.order_item_id = oi.id AND rc.state = 'resolved' AND rc.resolution = 'refund'), 0)`;

/** Why a printer of this customer earns nothing. The server's list, in the words of the spec. */
export type PrinterStopped = 'warranty_closed' | 'warranty_over' | 'returned' | 'traded_in' | 'in_shop' | 'programme_off';

/**
 * WHY A PRINTER STOPPED, or NULL while it earns. NULL holds exactly when every test
 * the sweep runs holds, and that is what the tests hold it to. A slot whose first
 * week has not come yet reads as the programme not having reached it.
 */
export const slotStoppedSql = (b: Pick<EarningBinds, 'now' | 'months'>) => `CASE
           WHEN ${slotTradedInSql()} IS NOT NULL THEN 'traded_in'
           WHEN ${slotInShopSql()} IS NOT NULL THEN 'in_shop'
           WHEN (${slotNotRefundedSql()}) IS NOT TRUE THEN 'returned'
           WHEN (${slotOpenSql()}) IS NOT TRUE THEN CASE WHEN ${chainEnd('warranty_closed_reason')} = 'returned' THEN 'returned' ELSE 'warranty_closed' END
           WHEN d.week IS NULL THEN 'programme_off'
           WHEN (${slotInsideMonthsSql(b, 'd')}) IS NOT TRUE THEN 'warranty_over'
           WHEN d.week < 0 THEN 'programme_off'
           ELSE NULL
         END`;

/** A slot's warranty end, from the device in the customer's hands. */
export const slotWarrantyEndSql = () => `COALESCE(${chainEnd('warranty_end_at')}, d.warranty_end_at)`;
