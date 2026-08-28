const fs = require('fs');
let content = fs.readFileSync('src/pages/Product.tsx', 'utf8');
content = content.replace(/id\.includes/g, "(id || '').includes");
fs.writeFileSync('src/pages/Product.tsx', content);
console.log('Patched includes');
