const fs = require('fs');

let bundles = fs.readFileSync('src/pages/Bundles.tsx', 'utf8');
bundles = bundles.replace(
  "const images = JSON.parse(p.images || '[]');",
  "const images = Array.isArray(p.images) ? p.images : (function(){ try { return JSON.parse(p.images || '[]'); } catch(e) { return [p.images].filter(Boolean); } })();"
);
fs.writeFileSync('src/pages/Bundles.tsx', bundles);
console.log("Patched Bundles.tsx");
