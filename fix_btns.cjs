const fs = require('fs');

let code = fs.readFileSync('src/components/AdminProducts.tsx', 'utf8');

const regex = /<button onClick=\{handleSave\} disabled=\{isTranslating\} className="flex items-center gap-2 bg-\[#6B46FF\] text-white px-6 py-2 rounded-lg font-bold hover:bg-\[#6B46FF\]\/90 transition-colors disabled:opacity-50">\s*<Save className="w-4 h-4" \/> \{isTranslating \? "Translating & Saving\.\.\." : "Save Product"\}\s*<\/button>/g;

const replacement = `<div className="flex gap-2">
            <button onClick={() => setIsPreviewOpen(true)} className="flex items-center gap-2 bg-zinc-800 text-white px-6 py-2 rounded-lg font-bold hover:bg-zinc-700 transition-colors">
              Preview
            </button>
            <button onClick={handleSave} disabled={isTranslating} className="flex items-center gap-2 bg-[#6B46FF] text-white px-6 py-2 rounded-lg font-bold hover:bg-[#6B46FF]/90 transition-colors disabled:opacity-50">
              <Save className="w-4 h-4" /> {isTranslating ? "Translating & Saving..." : "Save Product"}
            </button>
          </div>`;

if(code.match(regex)) {
    code = code.replace(regex, replacement);
    fs.writeFileSync('src/components/AdminProducts.tsx', code);
    console.log("Updated buttons");
} else {
    console.log("Could not find regex match");
}
