const fs = require('fs');

let code = fs.readFileSync('src/pages/Admin.tsx', 'utf8');

code = code.replace(
  /<div className="max-w-\[1200px\] mx-auto bg-zinc-900\/50 backdrop-blur-xl border border-zinc-800\/50 rounded-3xl p-6 md:p-8 shadow-\[0_10px_40px_-10px_rgba\(0,0,0,0\.05\)\] text-white">/g,
  '<div className={`max-w-[1200px] mx-auto text-white ${activeTab === \'products\' ? \'\' : \'bg-zinc-900/50 backdrop-blur-xl border border-zinc-800/50 rounded-3xl p-6 md:p-8 shadow-lg\'}`}>'
);

fs.writeFileSync('src/pages/Admin.tsx', code);
