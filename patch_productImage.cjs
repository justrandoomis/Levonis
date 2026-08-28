const fs = require('fs');
let content = fs.readFileSync('src/pages/Product.tsx', 'utf8');
content = content.replace(
  "const firstImage = images[0] || product.image_url ||",
  "const firstImage = images[0] || product.image_url || product.image ||"
);
fs.writeFileSync('src/pages/Product.tsx', content);
