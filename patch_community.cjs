const fs = require('fs');

let community = fs.readFileSync('src/pages/Community.tsx', 'utf8');
community = community.replace(
  "const images = JSON.parse(p.images || '[]');",
  "const images = Array.isArray(p.images) ? p.images : (function(){ try { return JSON.parse(p.images || '[]'); } catch(e) { return [p.images].filter(Boolean); } })();"
);
fs.writeFileSync('src/pages/Community.tsx', community);
console.log("Patched Community.tsx");
