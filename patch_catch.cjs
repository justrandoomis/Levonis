const fs = require('fs');

// Home.tsx
let home = fs.readFileSync('src/pages/Home.tsx', 'utf8');
home = home.replace(
  "console.error('Failed to fetch home products', err);",
  "console.error('Failed to fetch home products', err);\n        setDiscountedProducts(DUMMY_PRODUCTS.slice(0, 10));\n        setNewProducts(DUMMY_PRODUCTS.slice(0, 20));"
);
fs.writeFileSync('src/pages/Home.tsx', home);

// Products.tsx
let products = fs.readFileSync('src/pages/Products.tsx', 'utf8');
products = products.replace(
  "console.error(err);",
  "console.error(err);\n        setProducts(DUMMY_PRODUCTS);"
);
fs.writeFileSync('src/pages/Products.tsx', products);

console.log("Patched catch blocks");
