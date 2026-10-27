/**
 * THE OPENAPI 3.1 DOCUMENT of every Print Cloud route, served at
 * GET /api/print-cloud/v1/openapi.json.
 *
 * Built from ONE table (`OPERATIONS`). tests/printCloudOpenApi.test.ts holds it
 * equal to the routers both ways — every registered route is documented and
 * every documented route is registered — so the document cannot drift from
 * the code. Request bodies of the money paths are spelled out; every answer
 * shares the envelope `{ success: true, data }` and every refusal
 * `{ success: false, error, code, details: { messages: { ar, en, ckb } } }`.
 */

export type Access = 'public' | 'customer' | 'signed_webhook' | 'agent' | 'admin_op' | 'admin_money' | 'admin_cost';

export interface Operation {
  method: 'get' | 'post' | 'put' | 'patch' | 'delete';
  /** OpenAPI path relative to its base, `{param}` style. */
  path: string;
  base: 'customer' | 'agent' | 'admin';
  tag: string;
  summary: string;
  access: Access;
  body?: string;
  idempotent?: boolean;
}

const C = 'customer' as const;
const A = 'admin' as const;
const G = 'agent' as const;

export const OPERATIONS: readonly Operation[] = [
  // public
  { method: 'get', path: '/openapi.json', base: C, tag: 'meta', summary: 'This document', access: 'public' },
  { method: 'get', path: '/status', base: C, tag: 'meta', summary: 'Service status: installed, enabled, slicer connection, integration adapters', access: 'public' },
  { method: 'get', path: '/printers', base: C, tag: 'printers', summary: 'Printer models with specifications, credit tier and machine counts', access: 'public' },
  { method: 'get', path: '/printers/{id}', base: C, tag: 'printers', summary: 'One printer model with its credit packages', access: 'public' },
  { method: 'get', path: '/printers/{id}/availability', base: C, tag: 'printers', summary: 'Machines active, idle (able to take work now), offline, in maintenance; jobs waiting', access: 'public' },
  { method: 'get', path: '/packages', base: C, tag: 'pricing', summary: 'Printing-hour packages (filter tier_id)', access: 'public' },
  { method: 'get', path: '/store/categories', base: C, tag: 'store', summary: 'Product categories', access: 'public' },
  { method: 'get', path: '/store/products', base: C, tag: 'store', summary: 'Materials and accessories with price tiers and sellable stock', access: 'public' },
  { method: 'get', path: '/units', base: C, tag: 'store', summary: 'Measurement units and their base units', access: 'public' },
  { method: 'post', path: '/pricing/quote', base: C, tag: 'pricing', summary: 'Price lines without storing or reserving anything', access: 'public', body: 'QuoteRequest' },
  { method: 'post', path: '/payments/webhook', base: C, tag: 'payments', summary: 'Signed payment-processor confirmation (exactly-once)', access: 'signed_webhook', body: 'GatewayEvent' },
  // customer: balances
  { method: 'get', path: '/me/dashboard', base: C, tag: 'dashboard', summary: 'Credits, printers, inventory, jobs and files in one answer', access: 'customer' },
  { method: 'get', path: '/me/credits', base: C, tag: 'credits', summary: 'Printing-hour balances by tier and purchase lots', access: 'customer' },
  {
    method: 'get',
    path: '/me/credits/ledger',
    base: C,
    tag: 'credits',
    summary: 'Credit ledger, newest first (limit; the next page: before = the last row created_at and before_id = its id — exact; before alone = strictly before that instant)',
    access: 'customer',
  },
  { method: 'get', path: '/me/credits/reservations', base: C, tag: 'credits', summary: 'Credit reservations of the customer jobs', access: 'customer' },
  { method: 'get', path: '/me/credits/conversions', base: C, tag: 'credits', summary: 'The conversions allowed out of the customer classes: enabled rules with their ratio and both class names', access: 'customer' },
  { method: 'post', path: '/me/credits/convert', base: C, tag: 'credits', summary: 'Convert hours between tiers under an enabled rule', access: 'customer', body: 'ConvertRequest', idempotent: true },
  {
    method: 'post',
    path: '/me/credits/convert/quote',
    base: C,
    tag: 'credits',
    summary: 'What /convert would give now, by the same plan and refusals: received_seconds, the lots drawn and the lots received with their expiry; nothing is written',
    access: 'customer',
    body: 'ConvertRequest',
  },
  { method: 'get', path: '/me/printers', base: C, tag: 'dashboard', summary: 'Printer models the customer holds credit for', access: 'customer' },
  {
    method: 'get',
    path: '/me/inventory',
    base: C,
    tag: 'inventory',
    summary: 'Personal inventory (filter category); each row states low_stock_alert_default_qty (grams only, else null) and top_up_default_target_qty',
    access: 'customer',
  },
  { method: 'get', path: '/me/inventory/ledger', base: C, tag: 'inventory', summary: 'Inventory ledger (variant_id, limit; paged exactly by before + before_id like the credit ledger)', access: 'customer' },
  { method: 'patch', path: '/me/inventory/{variantId}/alert', base: C, tag: 'inventory', summary: 'Set the low-balance alert threshold', access: 'customer', body: 'AlertRequest' },
  { method: 'post', path: '/me/inventory/top-up-quote', base: C, tag: 'inventory', summary: 'Quote the quantity that tops a balance up to a target (default 1 kg)', access: 'customer', body: 'TopUpRequest' },
  { method: 'get', path: '/me/inventory/reorder-suggestions', base: C, tag: 'inventory', summary: 'Shortfalls of pending jobs and the purchase that covers them', access: 'customer' },
  { method: 'get', path: '/me/transactions', base: C, tag: 'dashboard', summary: 'Purchases, usage, refunds, buybacks and deliveries, newest first (limit; before = the previous page next_before)', access: 'customer' },
  {
    method: 'get',
    path: '/me/wallet',
    base: C,
    tag: 'payments',
    summary: 'The Levonis wallet as Print Cloud may spend it: connected (false while the owner switched wallet payments off), available_iqd (the wallet page figure), exchange_rate (official IQD per USD)',
    access: 'customer',
  },
  // quotes and orders
  { method: 'post', path: '/quotes', base: C, tag: 'orders', summary: 'Create a stored, expiring quote', access: 'customer', body: 'QuoteRequest' },
  { method: 'get', path: '/quotes/{id}', base: C, tag: 'orders', summary: 'A stored quote', access: 'customer' },
  { method: 'post', path: '/orders', base: C, tag: 'orders', summary: 'Create the order a quote becomes; holds stock', access: 'customer', body: 'OrderRequest', idempotent: true },
  { method: 'get', path: '/orders', base: C, tag: 'orders', summary: 'Order history', access: 'customer' },
  { method: 'get', path: '/orders/{id}', base: C, tag: 'orders', summary: 'One order with lines, payments and refunds', access: 'customer' },
  { method: 'post', path: '/orders/{id}/cancel', base: C, tag: 'orders', summary: 'Cancel an unpaid order (holds released)', access: 'customer' },
  {
    method: 'post',
    path: '/orders/{id}/pay/wallet',
    base: C,
    tag: 'payments',
    summary:
      'Pay the whole order from the Levonis wallet: debit, confirmation and fulfilment in one batch. 402 INSUFFICIENT_BALANCE {available_iqd, required_iqd} (nothing debited), 409 ORDER_NOT_PAYABLE, 503 PAYMENT_ADAPTER_DISABLED',
    access: 'customer',
    body: 'WalletPayRequest',
    idempotent: true,
  },
  { method: 'post', path: '/orders/{id}/dev-pay', base: C, tag: 'payments', summary: 'DEVELOPMENT ONLY: confirm own order (PRINT_CLOUD_DEV_PAYMENTS=on)', access: 'customer', body: 'DevPayRequest' },
  // files and imports
  { method: 'post', path: '/files', base: C, tag: 'files', summary: 'Upload an STL, 3MF or OBJ (multipart field "file")', access: 'customer', body: 'FileUpload' },
  { method: 'get', path: '/files', base: C, tag: 'files', summary: 'The customer model files', access: 'customer' },
  { method: 'get', path: '/files/signed', base: C, tag: 'files', summary: 'Download through a signed short-lived link (token)', access: 'customer' },
  { method: 'get', path: '/files/{id}', base: C, tag: 'files', summary: 'File metadata, geometry and printer fit', access: 'customer' },
  { method: 'delete', path: '/files/{id}', base: C, tag: 'files', summary: 'Delete a file no live job needs', access: 'customer' },
  { method: 'get', path: '/files/{id}/download', base: C, tag: 'files', summary: 'Download the original file', access: 'customer' },
  { method: 'post', path: '/files/{id}/download-link', base: C, tag: 'files', summary: 'Issue a five-minute signed link', access: 'customer' },
  { method: 'post', path: '/imports', base: C, tag: 'files', summary: 'Import a model by URL (allow-listed providers)', access: 'customer', body: 'ImportRequest' },
  { method: 'get', path: '/imports', base: C, tag: 'files', summary: 'URL imports', access: 'customer' },
  { method: 'get', path: '/imports/{id}', base: C, tag: 'files', summary: 'One import with its log; file_imported says whether a FILE was imported', access: 'customer' },
  // projects
  { method: 'post', path: '/projects', base: C, tag: 'projects', summary: 'Create a project', access: 'customer', body: 'ProjectRequest' },
  { method: 'get', path: '/projects', base: C, tag: 'projects', summary: 'Projects', access: 'customer' },
  { method: 'get', path: '/projects/{id}', base: C, tag: 'projects', summary: 'Project with models, plates and jobs', access: 'customer' },
  { method: 'patch', path: '/projects/{id}', base: C, tag: 'projects', summary: 'Update a project', access: 'customer', body: 'ProjectRequest' },
  { method: 'post', path: '/projects/{id}/duplicate', base: C, tag: 'projects', summary: 'Duplicate for printing again without re-uploading', access: 'customer' },
  { method: 'post', path: '/projects/{id}/models', base: C, tag: 'projects', summary: 'Add a file or imported model with quantity and materials', access: 'customer', body: 'ProjectModelRequest' },
  { method: 'patch', path: '/projects/{id}/models/{modelId}', base: C, tag: 'projects', summary: 'Update a model configuration', access: 'customer', body: 'ProjectModelRequest' },
  { method: 'post', path: '/projects/{id}/plates', base: C, tag: 'projects', summary: 'Create a build plate (manual placements or arranged)', access: 'customer', body: 'PlateRequest' },
  { method: 'get', path: '/projects/{id}/accessory-suggestions', base: C, tag: 'recommendations', summary: 'Accessory suggestions with the rule that matched', access: 'customer' },
  { method: 'get', path: '/projects/{id}/printer-recommendations', base: C, tag: 'recommendations', summary: 'Printer models compared with reasons (job_id)', access: 'customer' },
  { method: 'post', path: '/recommendations/{id}', base: C, tag: 'recommendations', summary: 'Accept, edit or reject a suggestion', access: 'customer', body: 'RecommendationDecision' },
  { method: 'get', path: '/profiles', base: C, tag: 'projects', summary: 'Saved print profiles', access: 'customer' },
  { method: 'post', path: '/profiles', base: C, tag: 'projects', summary: 'Save a print profile', access: 'customer', body: 'ProfileRequest' },
  { method: 'put', path: '/profiles/{id}', base: C, tag: 'projects', summary: 'Replace a print profile', access: 'customer', body: 'ProfileRequest' },
  // jobs
  { method: 'post', path: '/jobs', base: C, tag: 'jobs', summary: 'Create a print job', access: 'customer', body: 'JobRequest' },
  { method: 'get', path: '/jobs', base: C, tag: 'jobs', summary: 'Jobs grouped: current, queued, in preparation, completed, failed, cancelled; shipment_id names the live shipment a finished print is on', access: 'customer' },
  { method: 'get', path: '/jobs/{id}', base: C, tag: 'jobs', summary: 'Job with estimate, reservations, printer, telemetry (stale-flagged), events', access: 'customer' },
  { method: 'patch', path: '/jobs/{id}', base: C, tag: 'jobs', summary: 'Edit settings (back to draft; estimate invalidated)', access: 'customer', body: 'JobEditRequest' },
  { method: 'post', path: '/jobs/{id}/analyze', base: C, tag: 'jobs', summary: 'Request a slicer estimate', access: 'customer' },
  { method: 'get', path: '/jobs/{id}/projection', base: C, tag: 'jobs', summary: 'Required vs available hours and materials', access: 'customer' },
  { method: 'post', path: '/jobs/{id}/review', base: C, tag: 'jobs', summary: 'ready → awaiting_confirmation, with projected balances', access: 'customer' },
  { method: 'post', path: '/jobs/{id}/confirm', base: C, tag: 'jobs', summary: 'Reserve hours and every material; enter the queue', access: 'customer', idempotent: true },
  { method: 'post', path: '/jobs/{id}/cancel', base: C, tag: 'jobs', summary: 'Cancel; every reservation released once', access: 'customer', body: 'ReasonRequest' },
  { method: 'post', path: '/jobs/{id}/requests', base: C, tag: 'jobs', summary: 'Ask the workshop to pause or stop (recorded for an operator)', access: 'customer', body: 'JobRequestAction' },
  { method: 'post', path: '/jobs/{id}/reschedule', base: C, tag: 'queue', summary: 'Hold a queued job until a time', access: 'customer', body: 'RescheduleRequest' },
  { method: 'get', path: '/queue', base: C, tag: 'queue', summary: 'Own queued jobs with simulated start and end times', access: 'customer' },
  // shipments and buybacks
  {
    method: 'post',
    path: '/shipments',
    base: C,
    tag: 'fulfilment',
    summary: 'Pickup or delivery of finished prints and/or owned material; a print already on a live shipment is refused ALREADY_IN_SHIPMENT',
    access: 'customer',
    body: 'ShipmentRequest',
    idempotent: true,
  },
  {
    method: 'post',
    path: '/shipments/quote',
    base: C,
    tag: 'fulfilment',
    summary: 'What POST /shipments would do with this body, by the same assessment and refusals: fee_iqd and fee_rule, the starting status, the prints and material that would leave; nothing is written',
    access: 'customer',
    body: 'ShipmentRequest',
  },
  { method: 'get', path: '/shipments', base: C, tag: 'fulfilment', summary: 'Shipments', access: 'customer' },
  { method: 'get', path: '/shipments/{id}', base: C, tag: 'fulfilment', summary: 'One shipment', access: 'customer' },
  { method: 'post', path: '/shipments/{id}/cancel', base: C, tag: 'fulfilment', summary: 'Cancel before it leaves (material released)', access: 'customer' },
  { method: 'post', path: '/buybacks/quote', base: C, tag: 'buyback', summary: 'Value of selling material back, lot by lot', access: 'customer', body: 'BuybackRequest' },
  { method: 'post', path: '/buybacks', base: C, tag: 'buyback', summary: 'Request a buyback (units reserved; a replay of the key answers the first request)', access: 'customer', body: 'BuybackRequest', idempotent: true },
  { method: 'get', path: '/buybacks', base: C, tag: 'buyback', summary: 'Buyback requests', access: 'customer' },
  { method: 'post', path: '/buybacks/{id}/cancel', base: C, tag: 'buyback', summary: 'Cancel a pending buyback', access: 'customer' },
  // agent
  { method: 'get', path: '/printers', base: G, tag: 'agent', summary: 'Printers bound to this agent', access: 'agent' },
  { method: 'post', path: '/printers/{id}/telemetry', base: G, tag: 'agent', summary: 'Report telemetry', access: 'agent', body: 'Telemetry' },
  { method: 'post', path: '/jobs/{id}/events', base: G, tag: 'agent', summary: 'started | paused | resumed | completed | failed (idempotent: by state; paused and resumed by event_id)', access: 'agent', body: 'AgentJobEvent' },
  { method: 'get', path: '/jobs/{id}', base: G, tag: 'agent', summary: 'The print input and files of a job on a printer of this agent (job_control)', access: 'agent' },
  { method: 'get', path: '/commands', base: G, tag: 'agent', summary: 'Operator commands for this agent printers (since)', access: 'agent' },
  { method: 'post', path: '/slicing/claim', base: G, tag: 'agent', summary: 'Claim a slicing request under a lease', access: 'agent' },
  { method: 'post', path: '/slicing/{id}/result', base: G, tag: 'agent', summary: 'Post measured slicer figures', access: 'agent', body: 'Estimate' },
  { method: 'post', path: '/slicing/{id}/failure', base: G, tag: 'agent', summary: 'Report a slicing failure', access: 'agent', body: 'ErrorCodeRequest' },
  { method: 'get', path: '/files/{id}', base: G, tag: 'agent', summary: 'Download a file of a job this agent is slicing or printing', access: 'agent' },
  // admin
  { method: 'get', path: '/overview', base: A, tag: 'admin', summary: 'Counts that need attention', access: 'admin_op' },
  { method: 'get', path: '/settings', base: A, tag: 'admin', summary: 'Configuration (cost keys for the owner only)', access: 'admin_op' },
  { method: 'patch', path: '/settings', base: A, tag: 'admin', summary: 'Change configuration (versioned)', access: 'admin_money', body: 'SettingsPatch' },
  { method: 'get', path: '/adapters', base: A, tag: 'admin', summary: 'Integration adapters and their outbox backlog', access: 'admin_op' },
  { method: 'get', path: '/catalog/{entity}', base: A, tag: 'catalog', summary: 'List tiers | printer_models | printers | packages | conversion_rules | products | variants | promotions | locations | accessory_rules', access: 'admin_op' },
  { method: 'post', path: '/catalog/{entity}', base: A, tag: 'catalog', summary: 'Create (price fields need money scope, cost fields the owner)', access: 'admin_op', body: 'CatalogEntity' },
  { method: 'patch', path: '/catalog/{entity}/{id}', base: A, tag: 'catalog', summary: 'Update; price changes recorded', access: 'admin_op', body: 'CatalogEntity' },
  { method: 'put', path: '/variants/{id}/price-tiers', base: A, tag: 'pricing', summary: 'Replace gram/piece price tiers', access: 'admin_money', body: 'PriceTiers' },
  { method: 'get', path: '/categories', base: A, tag: 'catalog', summary: 'Categories with buyback rules', access: 'admin_op' },
  { method: 'patch', path: '/categories/{code}/buyback', base: A, tag: 'pricing', summary: 'Buyback switch and rate per category', access: 'admin_money', body: 'BuybackRule' },
  { method: 'get', path: '/price-changes', base: A, tag: 'pricing', summary: 'Price change history', access: 'admin_money' },
  { method: 'get', path: '/stock', base: A, tag: 'stock', summary: 'On hand, held, customer-owned and sellable per variant', access: 'admin_op' },
  { method: 'get', path: '/stock/lots', base: A, tag: 'stock', summary: 'Physical lots with costs (cost_known 0: cost pending)', access: 'admin_cost' },
  { method: 'post', path: '/stock/lots/{id}/cost', base: A, tag: 'stock', summary: 'State the cost of a cost-pending lot, once; units already used are valued from it', access: 'admin_cost', body: 'LotCostRequest' },
  { method: 'post', path: '/stock/receive', base: A, tag: 'stock', summary: 'Receive a supplier lot (cost: owner)', access: 'admin_op', body: 'ReceiveRequest' },
  { method: 'post', path: '/stock/adjust', base: A, tag: 'stock', summary: 'Count correction', access: 'admin_op', body: 'AdjustRequest' },
  { method: 'post', path: '/stock/waste', base: A, tag: 'stock', summary: 'Record waste or damage', access: 'admin_op', body: 'WasteRequest' },
  { method: 'get', path: '/customers/{userId}', base: A, tag: 'customers', summary: 'A customer balances, ledgers, orders, jobs', access: 'admin_money' },
  { method: 'post', path: '/customers/{userId}/credits/adjust', base: A, tag: 'customers', summary: 'Compensating credit adjustment', access: 'admin_money', body: 'CreditAdjust', idempotent: true },
  { method: 'post', path: '/customers/{userId}/inventory/adjust', base: A, tag: 'customers', summary: 'Compensating inventory adjustment', access: 'admin_money', body: 'InventoryAdjust', idempotent: true },
  { method: 'get', path: '/orders', base: A, tag: 'orders', summary: 'Orders (status)', access: 'admin_money' },
  { method: 'get', path: '/orders/{id}', base: A, tag: 'orders', summary: 'Order detail', access: 'admin_money' },
  { method: 'post', path: '/orders/{id}/confirm-payment', base: A, tag: 'payments', summary: 'Record a manual payment (exactly-once)', access: 'admin_money', body: 'ManualPayment' },
  { method: 'post', path: '/orders/{id}/cancel', base: A, tag: 'orders', summary: 'Cancel an unpaid order', access: 'admin_money', body: 'ReasonRequest' },
  {
    method: 'post',
    path: '/orders/{id}/refunds',
    base: A,
    tag: 'orders',
    summary: 'Refund unused hours or material of one line; an order paid from the Levonis wallet is credited back to the wallet in the same batch',
    access: 'admin_money',
    body: 'RefundRequest',
    idempotent: true,
  },
  { method: 'get', path: '/payment-events', base: A, tag: 'payments', summary: 'Every payment confirmation received', access: 'admin_money' },
  { method: 'get', path: '/jobs', base: A, tag: 'jobs', summary: 'All jobs (status)', access: 'admin_op' },
  { method: 'get', path: '/jobs/{id}', base: A, tag: 'jobs', summary: 'Job detail with consumption records', access: 'admin_op' },
  { method: 'post', path: '/jobs/{id}/approve', base: A, tag: 'jobs', summary: 'confirmed → queued', access: 'admin_op' },
  { method: 'post', path: '/jobs/{id}/reject', base: A, tag: 'jobs', summary: 'Reject a confirmed job (released)', access: 'admin_op', body: 'ReasonRequest' },
  { method: 'post', path: '/jobs/{id}/estimate', base: A, tag: 'jobs', summary: 'Operator-entered slicer figures', access: 'admin_op', body: 'Estimate' },
  { method: 'post', path: '/jobs/{id}/assign', base: A, tag: 'queue', summary: 'Put a queued job on a compatible machine', access: 'admin_op', body: 'AssignRequest' },
  { method: 'post', path: '/jobs/{id}/unassign', base: A, tag: 'queue', summary: 'preparing → queued', access: 'admin_op', body: 'ReasonRequest' },
  { method: 'post', path: '/jobs/{id}/start', base: A, tag: 'jobs', summary: 'preparing → printing', access: 'admin_op' },
  { method: 'post', path: '/jobs/{id}/pause', base: A, tag: 'jobs', summary: 'printing → paused', access: 'admin_op', body: 'ReasonRequest' },
  { method: 'post', path: '/jobs/{id}/resume', base: A, tag: 'jobs', summary: 'paused → printing', access: 'admin_op' },
  { method: 'post', path: '/jobs/{id}/complete', base: A, tag: 'jobs', summary: 'Complete with verified consumption (reconciled)', access: 'admin_op', body: 'Consumption' },
  { method: 'post', path: '/jobs/{id}/verify-completion', base: A, tag: 'jobs', summary: 'Verify an agent completion report', access: 'admin_op', body: 'VerifyRequest' },
  { method: 'post', path: '/jobs/{id}/fail', base: A, tag: 'jobs', summary: 'Record a failure', access: 'admin_op', body: 'FailureReport' },
  { method: 'post', path: '/jobs/{id}/cancel', base: A, tag: 'jobs', summary: 'Cancel (operator)', access: 'admin_op', body: 'ReasonRequest' },
  { method: 'post', path: '/jobs/{id}/priority', base: A, tag: 'queue', summary: 'Change priority', access: 'admin_op', body: 'PriorityRequest' },
  { method: 'get', path: '/failures', base: A, tag: 'jobs', summary: 'Failures (status)', access: 'admin_op' },
  { method: 'post', path: '/failures/{id}/resolve', base: A, tag: 'jobs', summary: 'Resolve under the policy; optional reprint', access: 'admin_op', body: 'FailureDecision' },
  { method: 'get', path: '/queue', base: A, tag: 'queue', summary: 'The queue with simulated start and end times', access: 'admin_op' },
  { method: 'post', path: '/queue/run', base: A, tag: 'queue', summary: 'Run the scheduler now', access: 'admin_op' },
  { method: 'get', path: '/printers', base: A, tag: 'printers', summary: 'Every printer: status, connectivity, job, telemetry age', access: 'admin_op' },
  { method: 'get', path: '/printers/{id}/events', base: A, tag: 'printers', summary: 'Printer event log', access: 'admin_op' },
  { method: 'post', path: '/printers/{id}/commands', base: A, tag: 'printers', summary: 'Queue a command for the agent', access: 'admin_op', body: 'CommandRequest' },
  { method: 'get', path: '/printers/{id}/maintenance', base: A, tag: 'printers', summary: 'Its maintenance windows, latest start first (cost for the owner only)', access: 'admin_op' },
  { method: 'post', path: '/printers/{id}/maintenance', base: A, tag: 'printers', summary: 'Plan a maintenance window', access: 'admin_op', body: 'MaintenanceRequest' },
  { method: 'patch', path: '/maintenance/{id}', base: A, tag: 'printers', summary: 'Close or cancel a maintenance window', access: 'admin_op', body: 'MaintenanceUpdate' },
  { method: 'get', path: '/agents', base: A, tag: 'printers', summary: 'Workshop agents', access: 'admin_op' },
  { method: 'post', path: '/agents', base: A, tag: 'printers', summary: 'Create an agent (token shown once)', access: 'admin_money', body: 'AgentRequest' },
  { method: 'post', path: '/agents/{id}/revoke', base: A, tag: 'printers', summary: 'Revoke an agent', access: 'admin_money' },
  { method: 'get', path: '/shipments', base: A, tag: 'fulfilment', summary: 'Shipments (status)', access: 'admin_op' },
  { method: 'get', path: '/shipments/{id}', base: A, tag: 'fulfilment', summary: 'One shipment with its items (fee for money scope only)', access: 'admin_op' },
  { method: 'post', path: '/shipments/{id}/advance', base: A, tag: 'fulfilment', summary: 'Move a shipment along (hand-over settles material)', access: 'admin_op', body: 'ShipmentAdvance' },
  { method: 'get', path: '/buybacks', base: A, tag: 'buyback', summary: 'Buyback requests (status)', access: 'admin_money' },
  { method: 'post', path: '/buybacks/{id}/approve', base: A, tag: 'buyback', summary: 'Approve (value from purchase lots)', access: 'admin_money', body: 'NoteRequest' },
  { method: 'post', path: '/buybacks/{id}/reject', base: A, tag: 'buyback', summary: 'Reject (units released)', access: 'admin_money', body: 'NoteRequest' },
  { method: 'post', path: '/buybacks/{id}/paid', base: A, tag: 'buyback', summary: 'Record the payout', access: 'admin_money', body: 'PaidRequest' },
  { method: 'get', path: '/reports/revenue', base: A, tag: 'reports', summary: 'Cash collected, deferred and recognised revenue (from, to)', access: 'admin_money' },
  { method: 'get', path: '/reports/profit', base: A, tag: 'reports', summary: 'Costs, gross and net profit, refunds by their effect, cost-pending use (owner)', access: 'admin_cost' },
  { method: 'get', path: '/reports/operations', base: A, tag: 'reports', summary: 'Utilisation, failure rate, material use', access: 'admin_op' },
  { method: 'get', path: '/reconcile', base: A, tag: 'reports', summary: 'Run every reconciliation check (report only)', access: 'admin_money' },
  { method: 'get', path: '/tasks', base: A, tag: 'admin', summary: 'Background work by kind and status, recent failures', access: 'admin_op' },
  { method: 'post', path: '/tasks/run', base: A, tag: 'admin', summary: 'Run a scheduling pass, then due background work, now', access: 'admin_op' },
  { method: 'get', path: '/audit', base: A, tag: 'admin', summary: 'Print Cloud audit trail (target)', access: 'admin_money' },
];

export const BASE_PATHS = { customer: '/api/print-cloud/v1', agent: '/api/print-cloud/v1/agent', admin: '/api/admin/print-cloud' } as const;

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false });
const int = (min?: number) => ({ type: 'integer', ...(min !== undefined ? { minimum: min } : {}) });
const str = { type: 'string' };
const iqd = { type: 'integer', minimum: 0, description: 'Integer Iraqi dinars' };
/**
 * A COST the workshop paid (a supplier lot, a repair). Only the owner may send
 * or read one, so only the owner's copy of this document names it:
 * `openApiDocument` drops every property marked so for anyone else, the way
 * every answer drops cost figures (`stripCost`).
 */
const ownerCost = { ...iqd, 'x-levonis-access': 'owner' };

const SCHEMAS: Record<string, unknown> = {
  Messages: obj({ ar: str, en: str, ckb: str }, ['ar', 'en', 'ckb']),
  Error: obj(
    { success: { const: false }, error: str, code: str, details: { type: 'object', properties: { messages: { $ref: '#/components/schemas/Messages' } } } },
    ['success', 'error']
  ),
  QuoteLine: {
    oneOf: [
      obj({ kind: { const: 'credit_package' }, package_id: str, quantity: int(1) }, ['kind', 'package_id']),
      obj({ kind: { const: 'credit_hours' }, tier_id: str, seconds: int(60) }, ['kind', 'tier_id', 'seconds']),
      obj(
        { kind: { const: 'material' }, variant_id: str, quantity: int(1), unit: str, fulfillment: { enum: ['inventory', 'delivery', 'project'] }, project_id: str },
        ['kind', 'variant_id', 'quantity']
      ),
    ],
  },
  QuoteRequest: obj({ lines: { type: 'array', items: { $ref: '#/components/schemas/QuoteLine' }, maxItems: 25 }, coupon: str }, ['lines']),
  OrderRequest: obj({ quote_id: str, payment_method: { enum: ['manual', 'gateway', 'dev', 'levonis_wallet'] }, delivery_address: { $ref: '#/components/schemas/Address' } }, ['quote_id']),
  Address: obj({ recipient_name: str, phone: str, governorate: str, city: str, address_line: str, notes: str }, ['recipient_name', 'phone', 'governorate', 'city', 'address_line']),
  GatewayEvent: obj({ event_id: str, order_id: str, amount_iqd: iqd, status: { enum: ['succeeded', 'failed'] } }, ['event_id', 'order_id', 'amount_iqd', 'status']),
  DevPayRequest: obj({ event_id: str, amount_iqd: iqd }),
  WalletPayRequest: { type: 'object', description: 'Empty: the order total_iqd is what the wallet pays', properties: {}, additionalProperties: false },
  ConvertRequest: obj({ from_tier_id: str, to_tier_id: str, seconds: int(60) }, ['from_tier_id', 'to_tier_id', 'seconds']),
  AlertRequest: obj({ low_stock_alert_qty: { type: ['integer', 'null'], minimum: 0 } }, ['low_stock_alert_qty']),
  TopUpRequest: obj({ variant_id: str, target_qty: int(1), quantity: int(1) }, ['variant_id']),
  FileUpload: { type: 'object', properties: { file: { type: 'string', format: 'binary' } }, required: ['file'] },
  ImportRequest: obj({ url: { type: 'string', format: 'uri' } }, ['url']),
  Settings: obj({
    layer_height_um: int(40),
    infill_percent: int(0),
    supports: { enum: ['none', 'auto', 'tree', 'normal'] },
    nozzle_um: int(100),
    walls: int(1),
    brim: { type: 'boolean' },
    plate_type: str,
    orientation: { enum: ['as_uploaded', 'auto'] },
    pause_at_layers: { type: 'array', items: int(1) },
    notes: str,
  }),
  ProjectRequest: obj({ name: str, description: str, project_type: str, status: { enum: ['active', 'archived'] }, settings: { $ref: '#/components/schemas/Settings' } }),
  ProjectModelRequest: obj({
    file_id: str,
    import_id: str,
    name: str,
    quantity: int(1),
    transform: { type: 'object' },
    material_assignments: { type: 'array', items: obj({ part: str, variant_id: str }, ['variant_id']) },
    tags: { type: 'array', items: str },
  }),
  PlateRequest: obj({ printer_model_id: str, label: str, spacing_um: int(0), arrange: { type: 'boolean' }, instances: { type: 'array' }, placements: { type: 'array' } }, ['printer_model_id']),
  RecommendationDecision: obj({ status: { enum: ['accepted', 'rejected'] }, qty: int(1) }, ['status']),
  ProfileRequest: obj({ name: str, settings: { $ref: '#/components/schemas/Settings' } }, ['name']),
  JobRequest: obj(
    {
      project_id: str,
      printer_model_id: str,
      plate_id: str,
      title: str,
      settings: { $ref: '#/components/schemas/Settings' },
      profile_id: str,
      copies: int(1),
      accessories: { type: 'array', items: obj({ variant_id: str, qty: int(1) }, ['variant_id', 'qty']) },
      depends_on_job_id: str,
    },
    ['project_id', 'printer_model_id']
  ),
  JobEditRequest: obj({ settings: { $ref: '#/components/schemas/Settings' }, copies: int(1), accessories: { type: 'array' } }),
  ReasonRequest: obj({ reason: str }),
  NoteRequest: obj({ note: str }),
  JobRequestAction: obj({ action: { enum: ['pause', 'cancel', 'note'] }, message: str }, ['action']),
  RescheduleRequest: obj({ not_before: { type: ['string', 'null'], format: 'date-time' } }),
  ShipmentRequest: obj(
    {
      kind: { enum: ['pickup', 'delivery'] },
      job_ids: { type: 'array', items: str },
      items: { type: 'array', items: obj({ variant_id: str, qty: int(1) }, ['variant_id', 'qty']) },
      delivery_address: { $ref: '#/components/schemas/Address' },
      packaging: str,
      payment_method: { enum: ['manual', 'gateway', 'dev', 'levonis_wallet'] },
    },
    ['kind']
  ),
  BuybackRequest: obj({ variant_id: str, qty: int(1) }, ['variant_id', 'qty']),
  Telemetry: obj(
    {
      machine_state: { enum: ['idle', 'preparing', 'printing', 'paused', 'finished', 'error', 'offline'] },
      boot: {
        type: 'integer',
        minimum: 0,
        maximum: 9007199254740991,
        description:
          'The agent\'s boot counter: it persists it and raises it at every start of its process. With seq it ORDERS readings: a higher boot is a later run. A counter that goes back makes the agent\'s readings superseded until it passes the stored one (the cloud records boot_regressed)',
      },
      seq: {
        type: 'integer',
        minimum: 0,
        maximum: 9007199254740991,
        description: 'Strictly increasing within the boot. A reading whose (boot, seq) is not newer than the stored one is answered superseded and changes nothing (an error still records machine_error once)',
      },
      job_id: str,
      progress_permille: int(0),
      layer: int(0),
      total_layers: int(0),
      remaining_seconds: int(0),
      nozzle_temp_dc: { type: 'integer' },
      bed_temp_dc: { type: 'integer' },
      chamber_temp_dc: { type: 'integer' },
      errors: { type: 'array' },
      camera: { type: 'object' },
      reported_at: { type: 'string', format: 'date-time', description: 'When the reading was taken, by the agent clock. With sent_at it gives the reading its age, for freshness only; never its order' },
      sent_at: {
        type: 'string',
        format: 'date-time',
        description: 'When the agent sent it, by the same clock. The age is sent_at - reported_at (skew cancels), capped just past the stale window; without both the reading is as old as its arrival',
      },
    },
    ['machine_state', 'boot', 'seq']
  ),
  Consumption: obj({ printed_seconds: int(0), materials: { type: 'array', items: obj({ variant_id: str, qty: int(0) }, ['variant_id', 'qty']) } }, ['printed_seconds']),
  AgentJobEvent: obj({ event: { enum: ['started', 'paused', 'resumed', 'completed', 'failed'] }, printer_id: str, event_id: { type: 'string', pattern: '^[A-Za-z0-9_.:-]{8,120}$', description: 'Unique per job; required for paused and resumed' }, printed_seconds: int(0), materials: { type: 'array' }, reason_code: str, reason: str }, ['event', 'printer_id']),
  Estimate: obj(
    {
      duration_seconds: int(1),
      layer_count: int(1),
      color_changes: int(0),
      materials: { type: 'array', items: obj({ variant_id: str, model_grams: int(0), support_grams: int(0), purge_grams: int(0) }, ['variant_id', 'model_grams']) },
      slicer_name: str,
      slicer_version: str,
      printer_profile: str,
      compatible: { type: 'boolean' },
      warnings: { type: 'array', items: str },
      generated_config: { type: 'object' },
    },
    ['duration_seconds', 'materials']
  ),
  ErrorCodeRequest: obj({ error_code: str }, ['error_code']),
  SettingsPatch: obj({ version: int(0), config: { type: 'object' } }, ['version', 'config']),
  CatalogEntity: { type: 'object', description: 'Fields of the entity (worker/lib/printCloud/catalog.ts ENTITIES)' },
  PriceTiers: obj(
    { tiers: { type: 'array', items: obj({ mode: { enum: ['pack', 'bracket'] }, min_qty: int(1), pack_price_iqd: iqd, unit_price_milli_iqd: int(0) }, ['mode', 'min_qty']) } },
    ['tiers']
  ),
  BuybackRule: obj({ buyback_enabled: { type: 'boolean' }, buyback_rate_bps: int(0) }),
  ReceiveRequest: obj({ variant_id: str, qty: int(1), total_cost_iqd: ownerCost, location_id: str, lot_code: str, supplier: str, notes: str }, ['variant_id', 'qty']),
  LotCostRequest: obj({ total_cost_iqd: ownerCost }, ['total_cost_iqd']),
  AdjustRequest: obj({ variant_id: str, qty_delta: { type: 'integer' }, reason: str }, ['variant_id', 'qty_delta', 'reason']),
  WasteRequest: obj({ variant_id: str, qty: int(1), type: { enum: ['waste', 'damage'] }, reason: str }, ['variant_id', 'qty', 'reason']),
  CreditAdjust: obj({ tier_id: str, seconds: { type: 'integer' }, reason: str, compensation: { type: 'boolean' } }, ['tier_id', 'seconds', 'reason']),
  InventoryAdjust: obj({ variant_id: str, qty: { type: 'integer' }, reason: str, compensation: { type: 'boolean' } }, ['variant_id', 'qty', 'reason']),
  ManualPayment: obj({ reference: str, amount_iqd: iqd }, ['reference', 'amount_iqd']),
  RefundRequest: obj(
    {
      line_id: str,
      quantity: int(1),
      amount_iqd: iqd,
      reason: str,
      method: {
        enum: ['manual', 'gateway', 'dev', 'levonis_wallet'],
        description:
          'Left out: the order own rail — the Levonis wallet for an order paid from it (credited in the same batch; a wallet refund under one cent of value is refused below_one_cent with min_amount_iqd), else manual. Another method for a wallet-paid order, or levonis_wallet for any other, is refused VALIDATION',
      },
    },
    ['line_id', 'reason']
  ),
  AssignRequest: obj({ printer_id: str }, ['printer_id']),
  VerifyRequest: obj({ consumption_record_id: str, printed_seconds: int(0), materials: { type: 'array' } }, ['consumption_record_id']),
  FailureReport: obj(
    { reason_code: str, responsible: { enum: ['workshop', 'customer', 'model', 'undetermined'] }, description: str, printed_seconds: int(0), failed_materials: { type: 'array' } },
    ['reason_code']
  ),
  FailureDecision: obj(
    { responsible: { enum: ['workshop', 'customer', 'model', 'undetermined'] }, reprint: { type: 'boolean' }, note: str, billable_seconds: int(0), billable_materials: { type: 'array' } },
    ['responsible']
  ),
  PriorityRequest: obj({ priority: { type: 'integer', minimum: -100, maximum: 100 } }, ['priority']),
  CommandRequest: obj({ command: { enum: ['pause', 'resume', 'stop', 'light_on', 'light_off', 'camera_snapshot'] }, job_id: str }, ['command']),
  MaintenanceRequest: obj({ kind: { enum: ['scheduled', 'unscheduled', 'repair', 'calibration'] }, starts_at: { type: 'string', format: 'date-time' }, ends_at: { type: 'string', format: 'date-time' }, notes: str, cost_iqd: ownerCost }, ['starts_at', 'ends_at']),
  MaintenanceUpdate: obj({ status: { enum: ['planned', 'done', 'cancelled'] }, cost_iqd: ownerCost, notes: str }, ['status']),
  AgentRequest: obj({ name: str, capabilities: { type: 'array', items: { enum: ['telemetry', 'job_control', 'slicer', 'camera'] } } }, ['name']),
  ShipmentAdvance: obj({ to: { enum: ['ready_for_pickup', 'shipped', 'delivered', 'picked_up', 'cancelled'] }, carrier: str, tracking_ref: str, note: str }, ['to']),
  PaidRequest: obj({ reference: str }, ['reference']),
};

const SECURITY: Record<Access, Array<Record<string, string[]>>> = {
  public: [],
  customer: [{ levonisSession: [] }],
  signed_webhook: [{ webhookSignature: [] }],
  agent: [{ agentToken: [] }],
  admin_op: [{ levonisSession: [] }],
  admin_money: [{ levonisSession: [] }],
  admin_cost: [{ levonisSession: [] }],
};

const ACCESS_NOTE: Record<Access, string> = {
  public: 'No sign-in.',
  customer: 'A signed-in Levonis account; only the caller own rows.',
  signed_webhook: 'X-PrintCloud-Signature: t=<unix>,v1=<HMAC-SHA256 of "t.body">.',
  agent: 'Authorization: Bearer <agent token>.',
  admin_op: 'Any platform admin (the workshop operator).',
  admin_money: 'Owner or full admin (403 FINANCIAL_SCOPE_REQUIRED for an assistant).',
  admin_cost: 'The verified owner (403 COST_ACCESS_DENIED for everyone else).',
};

/** The schemas as a caller may see them: owner-only cost properties removed unless `withCost`. */
function schemasFor(withCost: boolean): Record<string, unknown> {
  if (withCost) return SCHEMAS;
  const out: Record<string, unknown> = {};
  for (const [name, schema] of Object.entries(SCHEMAS)) {
    const props = (schema as { properties?: Record<string, { 'x-levonis-access'?: string }> }).properties;
    if (!props || !Object.values(props).some((p) => p['x-levonis-access'] === 'owner')) {
      out[name] = schema;
      continue;
    }
    const kept = Object.fromEntries(Object.entries(props).filter(([, p]) => p['x-levonis-access'] !== 'owner'));
    const required = ((schema as { required?: string[] }).required ?? []).filter((r) => r in kept);
    out[name] = { ...(schema as object), properties: kept, required };
  }
  return out;
}

export function openApiDocument(opts: { withCost?: boolean } = {}) {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const op of OPERATIONS) {
    const full = `${BASE_PATHS[op.base]}${op.path}`;
    const params = [...op.path.matchAll(/\{(\w+)\}/g)].map((m) => ({ name: m[1], in: 'path', required: true, schema: { type: 'string' } }));
    if (op.idempotent) params.push({ name: 'Idempotency-Key', in: 'header', required: true, schema: { type: 'string' } });
    paths[full] ??= {};
    paths[full][op.method] = {
      tags: [op.tag],
      summary: op.summary,
      description: ACCESS_NOTE[op.access],
      operationId: `${op.base}_${op.method}_${op.path.replace(/[{}]/g, '').replace(/[^A-Za-z0-9]+/g, '_')}`,
      security: SECURITY[op.access],
      ...(params.length ? { parameters: params } : {}),
      ...(op.body
        ? {
            requestBody: {
              required: true,
              content:
                op.body === 'FileUpload'
                  ? { 'multipart/form-data': { schema: { $ref: '#/components/schemas/FileUpload' } } }
                  : { 'application/json': { schema: { $ref: `#/components/schemas/${op.body}` } } },
            },
          }
        : {}),
      responses: {
        '200': { description: 'OK', content: { 'application/json': { schema: { type: 'object', properties: { success: { const: true }, data: {} } } } } },
        default: { description: 'Refusal', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      },
    };
  }
  return {
    openapi: '3.1.0',
    info: {
      title: 'Levonis Print Cloud API',
      version: '1.0.0',
      description:
        'Remote rental of the Levonis workshop 3D printers: printing-hour credits, gram-based materials, personal inventory, model files, print jobs and the workshop. Money is integer IQD; time is integer seconds; quantities are integers in the variant base unit.',
    },
    servers: [{ url: 'https://levonis-iq.com' }, { url: 'https://cloud.levonis-iq.com' }],
    components: {
      securitySchemes: {
        levonisSession: { type: 'apiKey', in: 'cookie', name: 'levonis_session' },
        agentToken: { type: 'http', scheme: 'bearer' },
        webhookSignature: { type: 'apiKey', in: 'header', name: 'X-PrintCloud-Signature' },
      },
      schemas: schemasFor(opts.withCost === true),
    },
    paths,
  };
}
