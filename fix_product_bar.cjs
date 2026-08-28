const fs = require('fs');
let content = fs.readFileSync('src/pages/Product.tsx', 'utf8');

// Replace the wrapper
content = content.replace(
  /<div className=\{\`w-full pb-\[100px\] min-h-\[100dvh\] bg-black text-zinc-300 font-sans transition-transform duration-500 ease-\[cubic-bezier\(0.32,0.72,0,1\)\] \$\{cartModalOpen \? "-translate-y-\[400px\] pointer-events-none" : "translate-y-0"\}\`\} dir=\{dir\}>/,
  '<div className="w-full min-h-[100dvh] bg-black text-zinc-300 font-sans" dir={dir}>'
);

fs.writeFileSync('src/pages/Product.tsx', content);
