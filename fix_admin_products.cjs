const fs = require('fs');

let code = fs.readFileSync('src/components/AdminProducts.tsx', 'utf8');

// Remove border and bg for product list item
code = code.replace(
  /className="bg-zinc-900\/50 rounded-xl p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-4 hover:bg-zinc-800\/50 transition-colors group"/g,
  'className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 p-4 hover:bg-zinc-800/30 rounded-xl transition-colors group"'
);

// Make all SectionCards open by default or remove the collapse logic entirely.
// Instead of an accordion, let's just render the children directly.
code = code.replace(
  /const SectionCard = \(\{ title, children, defaultOpen = false \}: \{ title: string, children: React\.ReactNode, defaultOpen\?: boolean \}\) => \{[\s\S]*?return \([\s\S]*?<\div>[\s\S]*?<\/div>[\s\S]*?<\/div>[\s\S]*?\);[\s\S]*?\};/m,
  `const SectionCard = ({ title, children }: { title: string, children: React.ReactNode }) => {
  return (
    <div className="bg-zinc-900/40 border border-zinc-800/50 rounded-2xl overflow-hidden mb-6 shadow-lg">
      <div className="w-full p-4 bg-zinc-800/20 border-b border-zinc-800/50">
        <h3 className="font-bold text-white">{title}</h3>
      </div>
      <div className="p-4">{children}</div>
    </div>
  );
};`
);

fs.writeFileSync('src/components/AdminProducts.tsx', code);
