const fs = require('fs');

const patchFile = (path) => {
  let content = fs.readFileSync(path, 'utf8');
  // product.base_price.toLocaleString -> (product?.base_price || 0).toLocaleString
  content = content.replace(/\(product\.base_price\)\.toLocaleString\(\)/g, '((product.base_price) || 0).toLocaleString()');
  // p.base_price.toLocaleString -> (p?.base_price || 0).toLocaleString
  content = content.replace(/\(p\.base_price\)\.toLocaleString\(\)/g, '((p.base_price) || 0).toLocaleString()');
  // proPrice.toLocaleString -> (proPrice || 0).toLocaleString
  content = content.replace(/\(proPrice\)\.toLocaleString\(\)/g, '((proPrice) || 0).toLocaleString()');
  fs.writeFileSync(path, content);
};

patchFile('src/pages/Product.tsx');
patchFile('src/pages/Home.tsx');
patchFile('src/pages/Products.tsx');
patchFile('src/pages/Bundles.tsx');
patchFile('src/pages/Community.tsx');
patchFile('src/pages/Profile.tsx');
console.log('Patched toLocaleString');
