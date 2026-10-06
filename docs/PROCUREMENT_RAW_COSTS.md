# Raw supplier costs and shipment defaults

New purchases and stock-on-hand receipts separate the supplier price from freight. Catalogue costs and historical incoming references are never silently treated as raw supplier prices: those references may already contain freight.

| Profile | Supplier currency | Packed measure | Freight rate |
|---|---|---|---|
| Germany, land | EUR | kg | IQD/kg |
| China, air | CNY | kg | IQD/kg |
| China, sea | CNY | CBM | IQD/CBM |

Rates start unset. In Costs & freight, choose the profile and enter IQD per unit of supplier currency and the freight rate. They can be saved immediately or together with a confirmed purchase. Product lines reuse the raw price and packed measurements saved for that profile and exact stock selection; all remain editable. Packed product measurements are the initial fallback, never net weight or unpackaged dimensions.

The editor shows raw purchase cost in IQD, automatic freight, additional fees, and final landed unit cost separately. Additional charges remain available for actual extra expenses; the automatically calculated freight is added only once. The server recalculates all amounts, and receipts use the existing exact-cost allocation and investor funding machinery.

For example, one unit at EUR 855, IQD 1,626.25/EUR, 22.3 packed kg and IQD 5,950/kg yields IQD 1,390,444 raw cost plus IQD 132,685 freight: IQD 1,523,129 landed. For five units, rounding once over the purchase line yields IQD 6,952,219 raw plus IQD 663,425 freight, totaling IQD 7,615,644. The per-unit average can be fractional while stored totals and receipt allocations remain whole IQD.

Each purchase freezes its own rates, raw amounts and measurements. Changing reusable settings does not reprice received inventory or historical orders. Editing/cloning preserves the original foreign invoice total instead of deriving it from a rounded IQD amount. A repeating invoice-total average is not promoted to a trusted unit-price default; packed measurements are still remembered and the next raw unit price is left for explicit entry.

Defaults follow the actual stock identity (base, option, colour or variant). If an option shares stock across colours, the form states that its cost is shared; a separate variant is required for independently stored colour costs. Legacy drafts keep their manual values and do not acquire automatic freight on restore.

Migration 0172 adds profile/default tables and purchase snapshots. Profile version guards protect concurrent settings changes; confirmed-purchase defaults are written in the same transaction as the purchase. New monetary fields remain subject to assistant-admin financial redaction.

Targeted validation covers the example above, small-unit bulk purchases, CBM, extra charges, original invoice preservation, repeating averages, profile races, selection identity, restricted-admin redaction, receipts and investor funding. Live deployment and acceptance are tracked in the pull request.
