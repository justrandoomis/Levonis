const fs = require('fs');

let admin = fs.readFileSync('src/components/AdminProducts.tsx', 'utf8');
admin = admin.replace(
  "const images = JSON.parse(p.images || '[]');",
  "const images = Array.isArray(p.images) ? p.images : (function(){ try { return JSON.parse(p.images || '[]'); } catch(e) { return [p.images].filter(Boolean); } })();"
);
fs.writeFileSync('src/components/AdminProducts.tsx', admin);
console.log("Patched AdminProducts.tsx");
