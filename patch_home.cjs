const fs = require('fs');
let content = fs.readFileSync('src/pages/Home.tsx', 'utf8');
content = content.replace(
  'const firstImage = images[0] ||',
  "console.log('p.images:', p.images, 'images:', images, 'firstImage:', images[0]);\n    const firstImage = images[0] ||"
);
fs.writeFileSync('src/pages/Home.tsx', content);
console.log('Patched Home.tsx');
