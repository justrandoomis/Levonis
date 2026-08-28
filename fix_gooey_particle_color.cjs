const fs = require('fs');
let code = fs.readFileSync('src/components/GooeyNav.tsx', 'utf8');

code = code.replace(
  /particle\.style\.setProperty\('--color', activeColor \|\| `var\(--color-\$\{p\.color\}, white\)`\);/,
  `particle.style.setProperty('--color', \`var(--active-bg, white)\`);`
);

fs.writeFileSync('src/components/GooeyNav.tsx', code);
console.log('Fixed GooeyNav.tsx particle color');
