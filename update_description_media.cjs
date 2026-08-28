const fs = require('fs');

let code = fs.readFileSync('src/components/AdminProducts.tsx', 'utf8');

const regex = /\{\/\* Description Rich Media \*\/\}\s*<SectionCard title="Description Media \(Images & Videos\)">[\s\S]*?<\/SectionCard>/;

const replacement = `{/* Description Rich Media */}
        <SectionCard title="Description Media (Images & Videos)">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-bold text-zinc-500 uppercase tracking-wider mb-2">Description Images</label>
              <div className="flex flex-col gap-2">
                {(form.description_images || []).map((img, idx) => (
                  <div key={idx} className="flex gap-2">
                    <input type="text" value={img} onChange={e => {
                      const newImgs = [...(form.description_images || [])]; newImgs[idx] = e.target.value; setForm({...form, description_images: newImgs});
                    }} className="flex-1 bg-zinc-900 border border-zinc-700 rounded p-2 text-white text-sm" />
                    <button onClick={() => {
                      const newImgs = (form.description_images || []).filter((_, i) => i !== idx); setForm({...form, description_images: newImgs});
                    }} className="p-2 text-zinc-500 hover:text-red-500 bg-zinc-900 border border-zinc-700 rounded"><X className="w-4 h-4"/></button>
                  </div>
                ))}
                <label className="flex items-center justify-center gap-2 p-3 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 rounded-xl cursor-pointer transition-colors border border-dashed border-zinc-600">
                  <Plus className="w-4 h-4" /> Upload Description Image
                  <input type="file" className="hidden" accept="image/*" multiple onChange={async (e) => {
                    if (e.target.files) {
                      const newUrls = [];
                      for (let i = 0; i < e.target.files.length; i++) {
                        await new Promise(resolve => {
                          handleUploadImage(e.target.files![i], (url) => {
                            newUrls.push(url);
                            resolve();
                          });
                        });
                      }
                      setForm({...form, description_images: [...(form.description_images || []), ...newUrls]});
                    }
                  }} />
                </label>
              </div>
            </div>
            
            <div>
              <label className="block text-xs font-bold text-zinc-500 uppercase tracking-wider mb-2">Description Videos</label>
              <div className="flex flex-col gap-2">
                {(form.description_videos || []).map((vid, idx) => (
                  <div key={idx} className="flex gap-2">
                    <input type="text" value={vid} onChange={e => {
                      const newVids = [...(form.description_videos || [])]; newVids[idx] = e.target.value; setForm({...form, description_videos: newVids});
                    }} className="flex-1 bg-zinc-900 border border-zinc-700 rounded p-2 text-white text-sm" />
                    <button onClick={() => {
                      const newVids = (form.description_videos || []).filter((_, i) => i !== idx); setForm({...form, description_videos: newVids});
                    }} className="p-2 text-zinc-500 hover:text-red-500 bg-zinc-900 border border-zinc-700 rounded"><X className="w-4 h-4"/></button>
                  </div>
                ))}
                <label className="flex items-center justify-center gap-2 p-3 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 rounded-xl cursor-pointer transition-colors border border-dashed border-zinc-600">
                  <Plus className="w-4 h-4" /> Upload Description Video
                  <input type="file" className="hidden" accept="video/*" multiple onChange={async (e) => {
                    if (e.target.files) {
                      const newUrls = [];
                      for (let i = 0; i < e.target.files.length; i++) {
                        await new Promise(resolve => {
                          handleUploadImage(e.target.files![i], (url) => {
                            newUrls.push(url);
                            resolve();
                          });
                        });
                      }
                      setForm({...form, description_videos: [...(form.description_videos || []), ...newUrls]});
                    }
                  }} />
                </label>
              </div>
            </div>
          </div>
        </SectionCard>`;

if(code.match(regex)) {
    code = code.replace(regex, replacement);
    fs.writeFileSync('src/components/AdminProducts.tsx', code);
    console.log("Updated Description Media section");
} else {
    console.log("Could not find regex match");
}
