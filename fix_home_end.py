import re

with open('src/pages/Home.tsx', 'r') as f:
    content = f.read()

# If the file ends with <div className="relative z-30 max-w-7xl mx-auto px-4 sm:px-10 py-12 bg-black rounded-t-[36px] -mt-10">
# Let's append the discounted and new products sections

end_content = """
        {/* Discounted Products - Horizontal Scroll */}
        {discountedProducts.length > 0 && (
          <div className="mb-12">
            <div className="flex items-center justify-between gap-3 mb-6">
              <div className="flex items-center gap-3">
                <div className="w-1 h-6 bg-rose-500 rounded-full"></div>
                <h2 className="text-xl md:text-2xl font-bold text-white">
                  Discounted Products
                </h2>
              </div>
              <button onClick={() => navigate('/products')} className="text-zinc-400 hover:text-white transition-colors flex items-center gap-1 text-sm bg-zinc-900/80 px-3 py-1.5 rounded-full">
                <span>more</span>
                {dir === 'rtl' ? <ChevronLeft className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
              </button>
            </div>
            
            <div className="flex gap-4 overflow-x-auto hide-scrollbar pb-4 -mx-4 px-4 sm:mx-0 sm:px-0 snap-x">
              {discountedProducts.map((p, index) => (
                <AnimatedItem key={p.id} index={index} className="snap-start shrink-0">
                  {renderProductCard(p, "w-[180px] md:w-[200px]")}
                </AnimatedItem>
              ))}
            </div>
          </div>
        )}

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
              <button onClick={() => navigate('/products')} className="w-8 h-8 rounded-full bg-zinc-900 flex items-center justify-center hover:bg-zinc-800 transition-colors">
                {dir === 'rtl' ? <ChevronLeft className="w-5 h-5" /> : <ChevronRight className="w-5 h-5" />}
              </button>
            </div>
            
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3 sm:gap-4">
              {newProducts.map((p, index) => (<AnimatedItem key={p.id} index={index}>{renderProductCard(p, "w-full")}</AnimatedItem>))}
            </div>
            {hasMore && (
              <div ref={observerTarget} className="w-full h-20 flex items-center justify-center mt-4">
                <div className="w-6 h-6 border-2 border-olive border-t-transparent rounded-full animate-spin"></div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
"""

if content.strip().endswith('py-12 bg-black rounded-t-[36px] -mt-10">'):
    with open('src/pages/Home.tsx', 'w') as f:
        f.write(content + "\n" + end_content)

