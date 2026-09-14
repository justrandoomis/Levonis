// Exact-source integration; draft branch only, remove before merge.
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
const before='187c96d0c15412f74573eba83c983d1b03b718d4';
if(execFileSync('git',['rev-parse','HEAD^'],{encoding:'utf8'}).trim()!==before)throw new Error('Unexpected parent; reconcile before editing');
const edits=new Map();
function replace(path,from,to){let text=edits.get(path);if(text===undefined){text=readFileSync(path,'utf8');if(text!==execFileSync('git',['show',`${before}:${path}`],{encoding:'utf8',maxBuffer:8*1024*1024}))throw new Error('Original changed: '+path);}if(text.split(from).length!==2)throw new Error('Expected one anchor: '+path+' '+from.slice(0,90));edits.set(path,text.replace(from,to));}
const domain='packages/pricing/src/fulfillment.ts';
replace(domain,'  direct_stock: number | null;','  direct_stock: number | null;\n  fulfillment_fees: FulfillmentLadder | null;\n  transport_fees: FulfillmentLadder | null;');
replace(domain,'  version: 2;','  version: 2;\n  pricing_basis?: \'direct\' | \'preorder\';');
replace(domain,'): { prices: FulfillmentLadder; waived: number } {','): { prices: FulfillmentLadder; fees: FulfillmentLadder; waived: number } {');
replace(domain,'  const regularDelta = prices.regular - beneath.regular;','  const regularDelta = prices.regular - beneath.regular;\n  const fees: FulfillmentLadder = { regular: regular?.mode === \'adjust\' ? Math.max(0, regularDelta) : 0, prime: 0, pro: 0 };');
replace(domain,'    prices[tier] = beneath[tier] + (exempt ? 0 : delta);','    prices[tier] = beneath[tier] + (exempt ? 0 : delta);\n    fees[tier] = isFee && !exempt ? Math.max(0, delta) : 0;');
replace(domain,'  return { prices, waived };','  return { prices, fees, waived };');
replace(domain,'  const parentTransport = method ? defaults.preorder?.transports?.[method] : undefined;','  const parentTransport = method ? defaults.preorder?.transports?.[method] : undefined;\n  if (method && !regularAmount(ownTransport, parentTransport)) errors.push(\'TRANSPORT_COMMISSION_UNCONFIGURED\');');
replace(domain,': { prices: fulfillment.prices, waived: 0 };',': { prices: fulfillment.prices, fees: { regular: 0, prime: 0, pro: 0 }, waived: 0 };');
replace(domain,'snapshot: null, direct_stock: directStock, pro_direct_waived_iqd: 0','snapshot: null, direct_stock: directStock, fulfillment_fees: null, transport_fees: null, pro_direct_waived_iqd: 0');
replace(domain,'    ok: true, errors: [], prices, direct_stock: directStock,','    ok: true, errors: [], prices, direct_stock: directStock,\n    fulfillment_fees: fulfillment.fees, transport_fees: transported.fees,');
const pricing='packages/pricing/src/pricing.ts';
replace(pricing,"import { safeParse } from './json';","import { safeParse } from './json';\nimport { resolveStructuredUnitPrice, canonicalModelSelection } from './fulfillmentPricing';\nimport type { ModelFulfillment, FulfillmentType, FulfillmentSnapshot } from './fulfillment';");
replace(pricing,'export interface OptionV2 extends PriceFields {','export interface OptionV2 extends PriceFields {\n  fulfillment?: ModelFulfillment;\n  legacy_fulfillment_ids?: Array<{ id: string; fulfillment_type: FulfillmentType }>;');
replace(pricing,'export interface PricingProduct {','export interface PricingProduct {\n  id?: string;\n  fulfillment?: ModelFulfillment;');
replace(pricing,'export interface ResolvedPrice {','export interface ResolvedPrice {\n  fulfillment_snapshot?: FulfillmentSnapshot | null;');
replace(pricing,'export function resolveUnitPrice(input: {','function resolveLegacyUnitPrice(input: {\n  fulfillmentType?: FulfillmentType;\n  quantity?: number;');
replace(pricing,'/** Reads the PRO pricing policy + transport defaults out of admin settings values. */',`/** The public entry point stays the one used by storefront, cart, checkout and admin. */
export type UnitPriceInput = Parameters<typeof resolveLegacyUnitPrice>[0];
export function resolveUnitPrice(input: UnitPriceInput): ResolvedPrice {
  const canonical = canonicalModelSelection(input.product.options, input.optionId);
  const model = input.product.options.find(row => row.id === canonical.id);
  if (input.product.fulfillment || model?.fulfillment) return resolveStructuredUnitPrice(input, resolveLegacyUnitPrice);
  const result = resolveLegacyUnitPrice(input);
  if (input.fulfillmentType === 'direct_sale' && input.transportMethod) result.errors.push('TRANSPORT_NOT_APPLICABLE');
  if (input.fulfillmentType === 'pre_order' && !input.transportMethod) result.errors.push('TRANSPORT_REQUIRED');
  return result;
}

/** Reads the PRO pricing policy + transport defaults out of admin settings values. */`);
for(const [path,text] of edits)writeFileSync(path,text);
execFileSync('git',['diff','--check'],{stdio:'inherit'});execFileSync('git',['add','--',...edits.keys()],{stdio:'inherit'});
console.log('Integrated only exact-source files: '+[...edits.keys()].join(', '));
