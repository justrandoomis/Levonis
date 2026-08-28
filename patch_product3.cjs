const fs = require('fs');
let content = fs.readFileSync('src/pages/Product.tsx', 'utf8');
if (!content.includes('referrerPolicy')) {
  content = content.replace(/<img /g, '<img referrerPolicy="no-referrer" ');
  fs.writeFileSync('src/pages/Product.tsx', content);
}
console.log('Patched Product.tsx for referrerPolicy');
