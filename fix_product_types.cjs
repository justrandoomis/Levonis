const fs = require('fs');

let code = fs.readFileSync('src/pages/Product.tsx', 'utf8');

// I also notice I left `const isPro = false;` and `const proPrice = product.base_price * 0.9;`
// Let's add the pro price back to the UI.
const pricingBlock = `
        {/* Pricing */}
        <div className="flex flex-col gap-3">
          <div className="bg-zinc-900/50 border border-zinc-800/50 rounded-2xl p-4 flex justify-between items-center w-full">
             <span className="text-white font-bold text-2xl">{(product.base_price).toLocaleString()} د.ع</span>
             <span className="bg-zinc-800 text-zinc-400 px-3 py-1 rounded-lg text-xs font-bold uppercase tracking-wider">السعر العادي</span>
          </div>
          {proPrice && (
            <button 
              onClick={() => navigate('/subscription')}
              className="flex justify-between items-center w-full mt-1 group"
            >
              <span className="text-zinc-500 font-medium text-sm flex items-center gap-1.5 group-hover:text-gold transition-colors">
                <Star className="w-3.5 h-3.5 text-zinc-500 group-hover:text-gold transition-colors" />
                {(proPrice).toLocaleString()} د.ع (لأعضاء PRO)
              </span>
              <span className="text-zinc-600 text-xs font-bold opacity-80 group-hover:opacity-100 group-hover:text-gold transition-colors">اشترك الآن</span>
            </button>
          )}
        </div>
`;

code = code.replace(/        {\/\* Pricing \*\/}.*?<\/div>        <\/div>/s, pricingBlock.trim());

fs.writeFileSync('src/pages/Product.tsx', code);
