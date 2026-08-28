const fs = require('fs');

let code = fs.readFileSync('src/components/AdminProducts.tsx', 'utf8');

// I'll add the new fields if they don't exist. I need to make sure I don't break anything.
const marketingSection = `
        {/* Marketing & Tags */}
        <SectionCard title="Marketing & Tags">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="md:col-span-2">
              <label className="block text-xs font-bold text-zinc-500 uppercase tracking-wider mb-2">Algorithms & Suggestions (comma separated)</label>
              <input type="text" value={(form.algorithm_tags || []).join(', ')} onChange={e => setForm({...form, algorithm_tags: e.target.value.split(',').map(s=>s.trim()).filter(Boolean)})} placeholder="e.g. Trending, Recommended" className="w-full bg-zinc-800/30 border border-zinc-700 rounded-xl p-3 text-white focus:border-[#6B46FF] focus:outline-none" />
            </div>
`;

code = code.replace(
  /{\/\* Marketing & Tags \*\/}\s*<SectionCard title="Marketing & Tags">\s*<div className="grid grid-cols-1 md:grid-cols-2 gap-4">/,
  marketingSection.trim()
);

if (!code.includes('algorithm_tags: []')) {
    code = code.replace(/features: \[\],/g, "features: [],\n  algorithm_tags: [],");
}

fs.writeFileSync('src/components/AdminProducts.tsx', code);
