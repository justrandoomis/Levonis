const fs = require('fs');
let code = fs.readFileSync('src/pages/Subscription.tsx', 'utf8');

if (!code.includes("import GooeyNav from '../components/GooeyNav';")) {
  code = code.replace(
    /import ScrollReveal from '\.\.\/components\/ScrollReveal';/,
    `import ScrollReveal from '../components/ScrollReveal';\nimport GooeyNav from '../components/GooeyNav';`
  );
}

const toggleRegex = /\{\/\* Tier Toggle \*\/\}[\s\S]*?\{\/\* Circular Plans Gallery \*\/\}/;

const replacement = `{/* Tier Toggle */}
        <div className="mb-8 relative shadow-lg h-[60px] bg-zinc-900/60 backdrop-blur-xl border border-white/10 rounded-full flex items-center">
          <GooeyNav
            items={[
              { label: t('plus') },
              { label: <div className="flex items-center gap-1.5">{t('pro')} <Sparkles className="w-4 h-4" /></div> }
            ]}
            initialActiveIndex={activeTab === 'plus' ? 0 : 1}
            onChange={(index) => {
              if (index === 0) setActiveTab('plus');
              else {
                setActiveTab('pro');
                setSelectedDuration('1yr');
              }
            }}
          />
        </div>
        {/* Circular Plans Gallery */}`;

code = code.replace(toggleRegex, replacement);

fs.writeFileSync('src/pages/Subscription.tsx', code);
console.log('Fixed Subscription.tsx tier toggle');
