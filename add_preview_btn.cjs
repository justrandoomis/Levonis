const fs = require('fs');

let code = fs.readFileSync('src/components/AdminProducts.tsx', 'utf8');

code = code.replace(
  /<button onClick=\{handleSave\} disabled=\{isTranslating\} className="flex items-center gap-2 bg-\[#6B46FF\] text-white px-6 py-2 rounded-lg font-bold hover:bg-\[#6B46FF\]\/90 transition-colors disabled:opacity-50">/g,
  `<div className="flex gap-2">
            <button onClick={() => setIsPreviewOpen(true)} className="flex items-center gap-2 bg-zinc-800 text-white px-6 py-2 rounded-lg font-bold hover:bg-zinc-700 transition-colors">
              Preview
            </button>
            <button onClick={handleSave} disabled={isTranslating} className="flex items-center gap-2 bg-[#6B46FF] text-white px-6 py-2 rounded-lg font-bold hover:bg-[#6B46FF]/90 transition-colors disabled:opacity-50">`
);

// also close the div
code = code.replace(
  /\{\/\* General Info \*\/\}/g,
  `</div>\n        {/* General Info */}`
);

// Let's actually be careful with replacing the close div.
// It's better to just replace the whole block.
