const fs = require('fs');

const patchFile = (path) => {
  if (!fs.existsSync(path)) return;
  let content = fs.readFileSync(path, 'utf8');
  content = content.replace(
    /const firstImage = images\[0\] \|\| /g,
    'const firstImage = images[0] || p.image_url || p.image || '
  );
  fs.writeFileSync(path, content);
};

patchFile('src/pages/Home.tsx');
patchFile('src/pages/Products.tsx');
patchFile('src/pages/Bundles.tsx');
patchFile('src/pages/Community.tsx');
patchFile('src/pages/Profile.tsx');
console.log('Patched firstImage');
