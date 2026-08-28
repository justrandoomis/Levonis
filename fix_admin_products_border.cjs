const fs = require('fs');

let code = fs.readFileSync('src/components/AdminProducts.tsx', 'utf8');

code = code.replace(
  /className="bg-zinc-900 border border-zinc-700 rounded-xl p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-4 hover:border-\[#6B46FF\]\/30 transition-colors shadow-lg group"/g,
  'className="bg-zinc-900/50 rounded-xl p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-4 hover:bg-zinc-800/50 transition-colors group"'
);

fs.writeFileSync('src/components/AdminProducts.tsx', code);
