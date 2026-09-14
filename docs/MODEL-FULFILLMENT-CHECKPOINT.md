# Model / fulfillment / transport continuation

User source: the latest Pasted text(3).txt, 924-line product-domain brief (not the previous mascot brief).
Base Main: 4c72b27857ed52074c0288d4aabb310c7bafa45a.
Work branch: codex/model-fulfillment-pricing.

## Saved first implementation

Shared strict fulfillment types, validation, public cost filtering, hierarchical resolver with zero/false overrides, independent membership waivers, reconciled snapshots and lead times. Pure legacy normalization planner retains all original rows as alias metadata, groups only by explicit group-scoped variant keys, refuses conflicts and reserved noncanonical rows, and is idempotent. Tests include the two-model A1 case, three transports, per-model override precedence and PRO model-delta preservation. Example prices in tests are fixtures only, never production data.

## NOT COMPLETE / NOT DEPLOYABLE

This checkpoint has NOT yet wired the new resolver into existing persistence, TXT parser/exporter, admin, storefront, cart or order routes. It does NOT claim a live migration or deployment. Keep Main unchanged until these are implemented and full checks pass. Do not publish unconnected domain code as a finished feature.

Resume integration inside the existing ProductDoc / relational overlay and write planners, preserving old IDs, inventory holds, color/combination relations and historical order snapshots. Do not replace any working mascot, payment, order, review, wallet or merchant logic. Use the existing safe live deployment workflow only after exact-source verification. No additional product prices or transport dates are authorized as live data.
