const fs = require('fs');

let code = fs.readFileSync('src/components/AdminProducts.tsx', 'utf8');

const regex = /\{\/\* Product Images \*\/\}\s*<SectionCard title="Product Images">[\s\S]*?<\/SectionCard>/;

const replacement = `{/* Product Images */}
        <SectionCard title="Product Images">
          <div className="flex flex-col gap-3">
            {form.images.map((img, idx) => (
              <div key={idx} className="flex gap-2">
                <input type="text" value={img} onChange={e => {
                  const newImages = [...form.images]; newImages[idx] = e.target.value; setForm({...form, images: newImages});
                }} className="flex-1 bg-zinc-800/30 border border-zinc-700 rounded-xl p-3 text-white focus:border-[#6B46FF] focus:outline-none" placeholder="Image URL" />
                <button onClick={() => {
                  const newImages = form.images.filter((_, i) => i !== idx); setForm({...form, images: newImages});
                }} className="p-3 bg-zinc-800 border border-zinc-700 text-zinc-500 hover:text-red-500 rounded-xl transition-colors"><X className="w-5 h-5"/></button>
              </div>
            ))}
            <div className="flex gap-2">
              <label className="flex-1 flex items-center justify-center gap-2 p-3 bg-zinc-800 hover:bg-zinc-700 text-zinc-200 rounded-xl border border-dashed border-zinc-600 transition-colors cursor-pointer">
                <Plus className="w-4 h-4" /> Upload Image
                <input type="file" className="hidden" accept="image/*" multiple onChange={async (e) => {
                  if (e.target.files) {
                    const newUrls = [];
                    for (let i = 0; i < e.target.files.length; i++) {
                      await new Promise(resolve => {
                        handleUploadImage(e.target.files[i], (url) => {
                          newUrls.push(url);
                          resolve();
                        });
                      });
                    }
                    setForm({...form, images: [...form.images, ...newUrls].filter(img => img !== '')});
                  }
                }} />
              </label>
            </div>
          </div>
        </SectionCard>`;

if(code.match(regex)) {
    code = code.replace(regex, replacement);
    fs.writeFileSync('src/components/AdminProducts.tsx', code);
    console.log("Updated Product Images section");
} else {
    console.log("Could not find regex match");
}
