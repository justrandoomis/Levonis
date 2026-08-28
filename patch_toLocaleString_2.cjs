const fs = require('fs');

const patchFile = (path) => {
  if (!fs.existsSync(path)) return;
  let content = fs.readFileSync(path, 'utf8');
  // p.original_price.toLocaleString -> (p?.original_price || 0).toLocaleString
  content = content.replace(/\(p\.original_price\)\.toLocaleString\(\)/g, '((p.original_price) || 0).toLocaleString()');
  fs.writeFileSync(path, content);
};

patchFile('src/pages/Home.tsx');
patchFile('src/pages/Products.tsx');
patchFile('src/pages/Bundles.tsx');
console.log('Patched toLocaleString 2');
