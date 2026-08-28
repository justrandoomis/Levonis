const fs = require('fs');
let code = fs.readFileSync('src/App.tsx', 'utf8');

if (!code.includes('GradualBlur')) {
  code = code.replace(
    /import BottomNav from '.\/components\/BottomNav';/,
    `import BottomNav from './components/BottomNav';\nimport GradualBlur from './components/GradualBlur';`
  );

  code = code.replace(
    /<BottomNav \/>/,
    `<GradualBlur target="page" position="bottom" height="120px" strength={2} divCount={10} curve="bezier" exponential={true} opacity={1} zIndex={40} />\n      <BottomNav />`
  );

  fs.writeFileSync('src/App.tsx', code);
}
