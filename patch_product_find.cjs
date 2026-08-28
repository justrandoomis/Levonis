const fs = require('fs');
let content = fs.readFileSync('src/pages/Product.tsx', 'utf8');
content = content.replace(
  "data = DUMMY_PRODUCTS.find(p => p.slug === id || p.id === id);",
  "data = DUMMY_PRODUCTS.find(p => String(p.slug) === String(id) || String(p.id) === String(id));"
);
fs.writeFileSync('src/pages/Product.tsx', content);
console.log('Patched find');
