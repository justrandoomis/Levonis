import sys

def main():
    with open('src/pages/Product.tsx', 'r') as f:
        content = f.read()

    target = "        </div>\n\n        {/* Exchange Banner */}"
    
    replacement = """        </div>

        {/* Product Details Section */}
        <div className="border border-zinc-800/50 rounded-xl bg-zinc-900/50 mb-4 overflow-hidden">
          <button 
            className="w-full p-4 flex justify-between items-center text-white font-bold"
            onClick={() => setDetailsOpen(!detailsOpen)}
          >
            <div className="flex items-center gap-2 flex-row-reverse">
              <FileText className="w-5 h-5 text-zinc-400" />
              <span>وصف المنتج</span>
            </div>
            {detailsOpen ? <ChevronUp className="w-5 h-5 text-zinc-400" /> : <ChevronDown className="w-5 h-5 text-zinc-400" />}
          </button>
          {detailsOpen && (
            <div className="px-4 pb-4 text-sm text-zinc-400 text-right leading-relaxed">
              <p className="mb-2">هذا المنتج مصنوع بدقة باستخدام أحدث تقنيات الطباعة ثلاثية الأبعاد. يتميز بجودة عالية وتفاصيل دقيقة تلبي جميع احتياجاتك.</p>
              <p>نستخدم أفضل أنواع مواد الطباعة (PLA, PETG, Resin) لضمان المتانة والصلابة المثالية للمنتج النهائي.</p>
            </div>
          )}
        </div>

        {/* Product Specs Section */}
        <div className="border border-zinc-800/50 rounded-xl bg-zinc-900/50 mb-4 overflow-hidden">
          <button 
            className="w-full p-4 flex justify-between items-center text-white font-bold"
            onClick={() => setSpecsOpen(!specsOpen)}
          >
            <div className="flex items-center gap-2 flex-row-reverse">
              <Settings2 className="w-5 h-5 text-zinc-400" />
              <span>المواصفات التقنية</span>
            </div>
            {specsOpen ? <ChevronUp className="w-5 h-5 text-zinc-400" /> : <ChevronDown className="w-5 h-5 text-zinc-400" />}
          </button>
          {specsOpen && (
            <div className="px-4 pb-4">
              <div className="flex flex-col gap-2 text-sm text-right">
                <div className="flex justify-between border-b border-zinc-800 pb-2">
                   <span className="text-white">PLA / Resin</span>
                   <span className="text-zinc-500">المادة</span>
                </div>
                <div className="flex justify-between border-b border-zinc-800 pb-2">
                   <span className="text-white">0.1mm - 0.2mm</span>
                   <span className="text-zinc-500">دقة الطباعة</span>
                </div>
                <div className="flex justify-between border-b border-zinc-800 pb-2">
                   <span className="text-white">20% - 100%</span>
                   <span className="text-zinc-500">كثافة الحشو (Infill)</span>
                </div>
                <div className="flex justify-between pb-2">
                   <span className="text-white">15cm x 15cm x 20cm</span>
                   <span className="text-zinc-500">الأبعاد القصوى</span>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Media & Gallery Section */}
        <div className="border border-zinc-800/50 rounded-xl bg-zinc-900/50 mb-6 overflow-hidden">
          <button 
            className="w-full p-4 flex justify-between items-center text-white font-bold"
            onClick={() => setMediaOpen(!mediaOpen)}
          >
            <div className="flex items-center gap-2 flex-row-reverse">
              <ImageIcon className="w-5 h-5 text-zinc-400" />
              <span>الصور والفيديو</span>
            </div>
            {mediaOpen ? <ChevronUp className="w-5 h-5 text-zinc-400" /> : <ChevronDown className="w-5 h-5 text-zinc-400" />}
          </button>
          {mediaOpen && (
            <div className="px-4 pb-4">
               <div className="grid grid-cols-2 gap-2 mb-3">
                  <div className="aspect-square rounded-lg overflow-hidden bg-zinc-800 border border-zinc-700/50">
                    <img src="https://images.unsplash.com/photo-1629236715082-f5dc817293e6?w=400" alt="Detail 1" className="w-full h-full object-cover" />
                  </div>
                  <div className="aspect-square rounded-lg overflow-hidden bg-zinc-800 border border-zinc-700/50 relative">
                    <img src="https://images.unsplash.com/photo-1631427962232-803d4f30c64f?w=400" alt="Video thumbnail" className="w-full h-full object-cover opacity-70" />
                    <div className="absolute inset-0 flex items-center justify-center">
                       <PlayCircle className="w-8 h-8 text-white drop-shadow-md" />
                    </div>
                  </div>
               </div>
               <div className="aspect-video rounded-lg overflow-hidden bg-zinc-800 border border-zinc-700/50 relative w-full flex items-center justify-center">
                  <img src="https://images.unsplash.com/photo-1615820468979-3733c707d0f1?w=800" alt="Process" className="w-full h-full object-cover opacity-60" />
                  <div className="absolute inset-0 flex items-center justify-center bg-black/20">
                     <PlayCircle className="w-12 h-12 text-white drop-shadow-lg hover:scale-110 transition-transform cursor-pointer" />
                  </div>
                  <div className="absolute bottom-2 right-2 bg-black/60 px-2 py-1 rounded text-xs text-white">01:45</div>
               </div>
            </div>
          )}
        </div>

        {/* Exchange Banner */}"""

    if target in content:
        content = content.replace(target, replacement)
        with open('src/pages/Product.tsx', 'w') as f:
            f.write(content)
        print("Success")
    else:
        print("Target not found")

if __name__ == "__main__":
    main()
