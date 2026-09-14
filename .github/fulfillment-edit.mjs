// Authored integration transport, only for the isolated draft branch. Remove after use.
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
const before = '4bb0a53e73588bb373f634ed363cf1a1b4bea549';
if (execFileSync('git',['rev-parse','HEAD^'],{encoding:'utf8'}).trim() !== before) throw new Error('Unexpected parent; do not overwrite concurrent work');
const edits = new Map();
function replace(path, from, to) {
  let content=edits.get(path);
  if(content===undefined){
    content=readFileSync(path,'utf8');
    const original=execFileSync('git',['show',`${before}:${path}`],{encoding:'utf8',maxBuffer:8*1024*1024});
    if(content!==original)throw new Error('Unexpected original source: '+path);
  }
  if(content.split(from).length!==2)throw new Error('Expected one exact integration anchor: '+path+' '+from.slice(0,80));
  edits.set(path,content.replace(from,to));
}
replace('packages/pricing/src/fulfillmentMigration.ts',
  '    model.reserved = canonical.reserved;',
  '    if (canonical.reserved !== undefined) model.reserved = canonical.reserved;\n    else delete model.reserved;');
replace('tests/fulfillmentDomain.test.ts',
  "      const p = resolve({ override, tier, tierActive: true });\n      const d = resolve({ override, tier, tierActive: true, fulfillmentType: 'direct_sale', transportMethod: null });",
  "      // The supplied A1 example has no PRIME discount; do not introduce the\n      // unrelated transport fixture's 50k PRIME discount into this product.\n      const modelPrices = { regular: pre, prime: pre, pro };\n      const p = resolve({ override, tier, tierActive: true, productRegularIqd: pre, modelPrices });\n      const d = resolve({ override, tier, tierActive: true, productRegularIqd: pre, modelPrices, fulfillmentType: 'direct_sale', transportMethod: null });");
replace('packages/pricing/src/fulfillment.ts',
  "  const proActive = input.tier === 'pro' && input.tierActive;\n  // All ladder prices include their corresponding benefit for preview. Charging\n  // still selects the regular rung for an expired membership below.\n  void proActive;",
  "  // All ladder prices include their corresponding benefit for preview. Charging\n  // still selects the regular rung for an expired membership below.");
for (const [path, content] of edits) writeFileSync(path,content);
execFileSync('git',['diff','--check'],{stdio:'inherit'});
execFileSync('git',['add','--',...edits.keys()],{stdio:'inherit'});
console.log('Applied only reviewed exact-source edits: '+[...edits.keys()].join(', '));
