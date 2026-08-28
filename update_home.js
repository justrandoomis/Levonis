const fs = require('fs');
let code = fs.readFileSync('src/pages/Home.tsx', 'utf8');

const renderProductCardStr = `
  const renderProductCard = (p: any, widthClass = "w-[160px]") => {
    const images = JSON.parse(p.images || '[]');
    const firstImage = images[0] || 'https://images.unsplash.com/photo-1505740420928-5e560c06d30e?w=800';
    const name = lang === 'ar' && p.name_ar ? p.name_ar : p.name;
    
    let proPrice = null;
    if (p && p.membership_prices) {
      try {
        const parsed = typeof p.membership_prices === 'string' ? JSON.parse(p.membership_prices) : p.membership_prices;
        if (parsed.pro) proPrice = parsed.pro;
      } catch (e) {}
    }
    const isPro = user?.subscription_plan === 'pro';

    return (
      <Link to={\`/product/\${p.slug}\`} key={p.id} className={\`\${widthClass} shrink-0 bg-zinc-900/50 border border-zinc-800/50 rounded-xl overflow-hidden flex flex-col group hover:border-olive/50 transition-colors\`}>
        <div className="relative aspect-square overflow-hidden bg-black">
          <img src={firstImage} alt={name} className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500" />
          {p.original_price > p.base_price && (
            <div className="absolute top-2 right-2 bg-rose-500 text-white text-[10px] font-bold px-1.5 py-0.5 rounded">
              SALE
            </div>
          )}
        </div>
        <div className="p-3 flex flex-col flex-1">
          <h3 className="text-white font-medium text-sm line-clamp-2 mb-1">{name}</h3>
          <div className="mt-auto pt-2 flex items-center justify-between">
            <div className="flex flex-col gap-0.5">
              {(isPro && proPrice) ? (
                <>
                   <div className="flex flex-col">
                      <span className="text-zinc-500 text-[10px] line-through">{(p.base_price).toLocaleString()} د.ع</span>
                      <span className="text-gold font-extrabold text-[15px] flex items-center gap-1 drop-shadow-[0_0_8px_rgba(186,163,105,0.4)]">
                         <Star className="w-3.5 h-3.5 fill-gold" />
                         {(proPrice).toLocaleString()} د.ع
                      </span>
                   </div>
                </>
              ) : (
                <>
                   <div className="flex flex-col">
                     {p.original_price > p.base_price && (
                       <span className="text-zinc-500 text-[10px] line-through">{(p.original_price).toLocaleString()} د.ع</span>
                     )}
                     <span className="text-white font-bold text-sm">{(p.base_price).toLocaleString()} د.ع</span>
                   </div>
                   {proPrice && (
                     <div className="flex items-center gap-1 mt-0.5">
                        <Star className="w-2.5 h-2.5 text-zinc-500" />
                        <span className="text-zinc-500 font-medium text-[10px]">
                          {(proPrice).toLocaleString()} د.ع (للمشتركين)
                        </span>
                     </div>
                   )}
                </>
              )}
            </div>
          </div>
        </div>
      </Link>
    );
  };
`;

const extraSectionsStr = `
        {/* Discounted Products - Horizontal Scroll */}
        {discountedProducts.length > 0 && (
          <div className="mb-12">
            <div className="flex items-center justify-between gap-3 mb-6">
              <div className="flex items-center gap-3">
                <div className="w-1 h-6 bg-rose-500 rounded-full"></div>
                <h2 className="text-xl md:text-2xl font-bold text-white">
                  Dishes up to 50% off
                </h2>
              </div>
              <button onClick={() => navigate('/products')} className="text-zinc-400 hover:text-white transition-colors flex items-center gap-1 text-sm bg-zinc-900/80 px-3 py-1.5 rounded-full border border-zinc-800">
                <span>more</span>
                {dir === 'rtl' ? <ChevronLeft className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
              </button>
            </div>
            
            <div className="flex gap-4 overflow-x-auto hide-scrollbar pb-4 -mx-4 px-4 sm:mx-0 sm:px-0">
              {discountedProducts.map(p => renderProductCard(p, "w-[180px] md:w-[200px]"))}
            </div>
          </div>
        )}

        {/* Top Brands - Horizontal Scroll */}
        <div className="mb-12">
          <div className="flex items-center gap-3 mb-6">
            <div className="w-1 h-6 bg-[#B03142] rounded-full"></div>
            <h2 className="text-xl md:text-2xl font-bold text-white">
              Top brands
            </h2>
          </div>
          <div className="flex gap-4 overflow-x-auto hide-scrollbar pb-4 -mx-4 px-4 sm:mx-0 sm:px-0">
            {TOP_BRANDS.map(brand => (
              <div 
                key={brand.id} 
                onClick={() => navigate('/products?brand=' + brand.id)}
                className="shrink-0 flex flex-col items-center gap-3 cursor-pointer group w-[100px]"
              >
                <div className={\`w-[100px] h-[100px] rounded-2xl \${brand.color} p-0.5 overflow-hidden border border-zinc-800 group-hover:border-white/20 transition-all shadow-sm group-hover:shadow-md\`}>
                  <img src={brand.image} alt={brand.name} className="w-full h-full object-cover rounded-[14px] group-hover:scale-110 transition-transform duration-500" />
                </div>
                <h3 className="text-zinc-300 group-hover:text-white font-bold text-sm text-center leading-tight transition-colors line-clamp-2">
                  {brand.name}
                </h3>
              </div>
            ))}
          </div>
        </div>

        {/* Try Something New - Vertical Infinite Grid */}
        {newProducts.length > 0 && (
          <div className="mb-12">
            <div className="flex items-center justify-between gap-3 mb-6">
              <div className="flex items-center gap-3">
                <div className="w-1 h-6 bg-olive rounded-full"></div>
                <h2 className="text-xl md:text-2xl font-bold text-white">
                  Try something new
                </h2>
              </div>
              <button onClick={() => navigate('/products')} className="w-8 h-8 rounded-full bg-zinc-900 flex items-center justify-center hover:bg-zinc-800 transition-colors border border-zinc-800">
                {dir === 'rtl' ? <ChevronLeft className="w-5 h-5" /> : <ChevronRight className="w-5 h-5" />}
              </button>
            </div>
            
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3 sm:gap-4">
              {newProducts.map(p => renderProductCard(p, "w-full"))}
            </div>
          </div>
        )}
`;

code = code.replace("  const nextSlide = () => {", renderProductCardStr + "\n  const nextSlide = () => {");
code = code.replace("      </div>\n    </div>\n  );\n}", extraSectionsStr + "\n      </div>\n    </div>\n  );\n}");

fs.writeFileSync('src/pages/Home.tsx', code);
