const fs = require('fs');
let data = fs.readFileSync('src/data.ts', 'utf8');
data = data.replace(
  '  images: JSON.stringify([p.image]),',
  '  images: JSON.stringify([p.image]),\n  image_url: p.image,'
);
fs.writeFileSync('src/data.ts', data);
console.log('Patched data4');
