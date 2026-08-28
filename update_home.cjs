const fs = require('fs');
let code = fs.readFileSync('src/pages/Home.tsx', 'utf8');

if (!code.includes('TrueFocus')) {
  code = code.replace(
    /import \{ ChevronRight, ChevronLeft/g,
    `import TrueFocus from '../components/TrueFocus';\nimport { ChevronRight, ChevronLeft`
  );

  code = code.replace(
    /<h2 className="text-4xl md:text-5xl font-black mb-2 tracking-tight">\{banner\.title\}<\/h2>/g,
    `<h2 className="text-4xl md:text-5xl font-black mb-2 tracking-tight">\n                    {/* Use TrueFocus for banner title if we want, or from admin settings later */}\n                    <TrueFocus sentence={banner.title} blurAmount={2} borderColor="#6B46FF" glowColor="rgba(107, 70, 255, 0.6)" animationDuration={0.8} pauseBetweenAnimations={0.5} />\n                  </h2>`
  );

  fs.writeFileSync('src/pages/Home.tsx', code);
}
