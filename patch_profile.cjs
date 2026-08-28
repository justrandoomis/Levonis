const fs = require('fs');

let profile = fs.readFileSync('src/pages/Profile.tsx', 'utf8');
profile = profile.replace(
  "const images = JSON.parse(p.images || '[]');",
  "const images = Array.isArray(p.images) ? p.images : (function(){ try { return JSON.parse(p.images || '[]'); } catch(e) { return [p.images].filter(Boolean); } })();"
);
profile = profile.replace(
  "JSON.parse(bundle.images || '[]')[0]",
  "(Array.isArray(bundle.images) ? bundle.images : (function(){ try { return JSON.parse(bundle.images || '[]'); } catch(e) { return [bundle.images].filter(Boolean); } })())[0]"
);
fs.writeFileSync('src/pages/Profile.tsx', profile);
console.log("Patched Profile.tsx");
