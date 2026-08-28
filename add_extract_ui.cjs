const fs = require('fs');

let code = fs.readFileSync('src/components/AdminProducts.tsx', 'utf8');

const uiCode = `
        <div className="bg-zinc-900/40 border border-[#6B46FF]/30 rounded-2xl p-4 mb-6 flex items-end gap-4 shadow-lg shadow-[#6B46FF]/5">
          <div className="flex-1">
            <label className="block text-xs font-bold text-[#6B46FF] uppercase tracking-wider mb-2">Auto Extract Product from URL</label>
            <input type="text" id="extract_url" placeholder="Paste product URL here (e.g., from Amazon, Aliexpress)..." className="w-full bg-zinc-800/50 border border-zinc-700 rounded-xl p-3 text-white focus:border-[#6B46FF] focus:outline-none" />
          </div>
          <button type="button" onClick={async () => {
            const urlInput = document.getElementById('extract_url') as HTMLInputElement;
            if (!urlInput || !urlInput.value) return;
            const btn = document.getElementById('extract_btn');
            if (btn) btn.innerHTML = 'Extracting...';
            try {
              const res = await fetch('/api/extract', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ url: urlInput.value })
              });
              const data = await res.json();
              if (data.success && data.product) {
                setForm(prev => ({
                  ...prev,
                  name: data.product.name || prev.name,
                  name_ar: '', // let user translate or type
                  description: data.product.description || prev.description,
                  images: data.product.images.length > 0 ? data.product.images : prev.images,
                  original_price: data.product.original_price || prev.original_price
                }));
                alert('Extraction successful! Please translate fields if needed.');
              } else {
                alert('Extraction failed or no data found.');
              }
            } catch(e) {
              alert('Error extracting product data.');
            }
            if (btn) btn.innerHTML = 'Extract Data';
          }} id="extract_btn" className="bg-[#6B46FF] hover:bg-[#5a3ae0] text-white px-6 py-3 rounded-xl font-bold transition-colors whitespace-nowrap">
            Extract Data
          </button>
        </div>
`;

if (!code.includes('Auto Extract Product from URL')) {
  code = code.replace(
    /\{\/\* General Info \*\/\}/,
    uiCode + "\n        {/* General Info */}"
  );
  fs.writeFileSync('src/components/AdminProducts.tsx', code);
}
