const fs = require('fs');

let code = fs.readFileSync('src/components/AdminProducts.tsx', 'utf8');

const oldComponent = code.substring(
    code.indexOf('const SectionCard ='),
    code.indexOf('};', code.indexOf('const SectionCard =')) + 2
);

const newComponent = `const SectionCard = ({ title, children, defaultOpen = false }: { title: string, children: React.ReactNode, defaultOpen?: boolean }) => {
  return (
    <div className="bg-zinc-900/40 border border-zinc-800/50 rounded-2xl overflow-hidden mb-6 shadow-lg">
      <div className="w-full p-4 bg-zinc-800/20 border-b border-zinc-800/50">
        <h3 className="font-bold text-white">{title}</h3>
      </div>
      <div className="p-4">{children}</div>
    </div>
  );
};`;

code = code.replace(oldComponent, newComponent);

fs.writeFileSync('src/components/AdminProducts.tsx', code);
