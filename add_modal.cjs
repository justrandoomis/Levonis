const fs = require('fs');

let code = fs.readFileSync('src/components/AdminProducts.tsx', 'utf8');

const modalCode = `

function ProductPreviewModal({ form, onClose, dir }: { form: any, onClose: () => void, dir: string }) {
  const mainImage = form.images?.[0] || '';
  const price = form.original_price || form.base_price || 0;
  
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4">
      <div className="bg-zinc-900 border border-zinc-800 rounded-2xl w-full max-w-4xl max-h-[90vh] overflow-hidden flex flex-col shadow-2xl">
        <div className="p-4 border-b border-zinc-800 flex items-center justify-between">
          <h3 className="text-white font-bold">Storefront Preview</h3>
          <button onClick={onClose} className="text-zinc-400 hover:text-white"><X className="w-5 h-5"/></button>
        </div>
        <div className="flex-1 overflow-y-auto p-6" dir={dir}>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
            <div>
              <div className="aspect-square bg-zinc-800 rounded-2xl overflow-hidden mb-4 border border-zinc-700">
                {mainImage ? (
                  <img src={mainImage} className="w-full h-full object-cover" />
                ) : (
                  <div className="w-full h-full flex items-center justify-center text-zinc-600">No Image</div>
                )}
              </div>
              <div className="grid grid-cols-5 gap-2">
                {form.images?.slice(1, 6).map((img: string, i: number) => (
                  <div key={i} className="aspect-square bg-zinc-800 rounded-xl overflow-hidden border border-zinc-700">
                    {img && <img src={img} className="w-full h-full object-cover" />}
                  </div>
                ))}
              </div>
            </div>
            <div className="flex flex-col gap-6">
              <div>
                <div className="text-[#6B46FF] font-bold mb-2">{form.brand}</div>
                <h1 className="text-2xl font-bold text-white mb-2">{dir === 'rtl' ? (form.name_ar || form.name) : form.name}</h1>
                <div className="flex items-center gap-4 text-sm text-zinc-400">
                  <div className="flex items-center gap-1 text-yellow-500"><Star className="w-4 h-4 fill-current"/> 5.0</div>
                  <div>•</div>
                  <div>120 Reviews</div>
                </div>
              </div>
              <div className="text-3xl font-bold text-white">IQD {price.toLocaleString()}</div>
              
              {form.colors?.length > 0 && (
                <div>
                  <h3 className="text-white font-bold mb-3">{dir === 'rtl' ? 'اللون' : 'Color'}</h3>
                  <div className="flex flex-wrap gap-2">
                    {form.colors.map((c: any, i: number) => (
                      <div key={i} className="w-10 h-10 rounded-full border-2 border-zinc-700" style={{backgroundColor: c.hex_code || '#333'}}></div>
                    ))}
                  </div>
                </div>
              )}
              
              {form.options?.length > 0 && (
                <div>
                  <h3 className="text-white font-bold mb-3">{dir === 'rtl' ? 'الخيارات' : 'Options'}</h3>
                  <div className="flex flex-wrap gap-2">
                    {form.options.map((o: any, i: number) => (
                      <div key={i} className="px-4 py-2 border border-zinc-700 rounded-xl text-zinc-300">{dir === 'rtl' ? (o.name_ar || o.name) : o.name}</div>
                    ))}
                  </div>
                </div>
              )}
              
              <div className="pt-6 border-t border-zinc-800">
                <button className="w-full bg-[#6B46FF] text-white font-bold py-4 rounded-xl flex items-center justify-center gap-2">
                  <ShoppingCart className="w-5 h-5" />
                  {dir === 'rtl' ? 'أضف إلى السلة' : 'Add to Cart'}
                </button>
              </div>
              
              <div>
                <h3 className="text-white font-bold mb-2">{dir === 'rtl' ? 'الوصف' : 'Description'}</h3>
                <p className="text-zinc-400 whitespace-pre-wrap">{dir === 'rtl' ? (form.description_ar || form.description) : form.description}</p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
`;

if (!code.includes('ProductPreviewModal')) {
  // Add modal definition at the bottom before export default function if not already there,
  // Actually since there are other components, let's put it right before "export default function AdminProducts"
  code = code.replace(
    /export default function AdminProducts\(\) \{/,
    modalCode + "\nexport default function AdminProducts() {"
  );
  fs.writeFileSync('src/components/AdminProducts.tsx', code);
}
