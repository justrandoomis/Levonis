const fs = require('fs');

const patchFile = (path) => {
  if (!fs.existsSync(path)) return;
  let content = fs.readFileSync(path, 'utf8');
  content = content.replace(/\$\{p\.slug\}/g, '${p.slug || p.id}');
  content = content.replace(/\$\{product\.slug\}/g, '${product.slug || product.id}');
  fs.writeFileSync(path, content);
};

patchFile('src/pages/Home.tsx');
patchFile('src/pages/Products.tsx');
patchFile('src/pages/Bundles.tsx');
patchFile('src/pages/Community.tsx');
patchFile('src/pages/Profile.tsx');
console.log('Patched Links');
