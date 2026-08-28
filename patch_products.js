const fs = require('fs');

// Patch Home.tsx
let home = fs.readFileSync('src/pages/Home.tsx', 'utf8');
home = home.replace(
  "const discounted = await queryDb('SELECT * FROM products WHERE original_price > base_price ORDER BY created_at DESC LIMIT 10');\n        setDiscountedProducts(discounted || []);",
  `const discounted = await queryDb('SELECT * FROM products WHERE original_price > base_price ORDER BY created_at DESC LIMIT 10');
        setDiscountedProducts(discounted && discounted.length > 0 ? discounted : DUMMY_PRODUCTS.slice(0, 10));`
);
home = home.replace(
  "const newest = await queryDb('SELECT * FROM products ORDER BY created_at DESC LIMIT 20 OFFSET 0');\n        setNewProducts(newest || []);",
  `const newest = await queryDb('SELECT * FROM products ORDER BY created_at DESC LIMIT 20 OFFSET 0');
        setNewProducts(newest && newest.length > 0 ? newest : DUMMY_PRODUCTS.slice(0, 20));`
);
home = home.replace(
  "const images = JSON.parse(p.images || '[]');",
  "const images = Array.isArray(p.images) ? p.images : (function(){ try { return JSON.parse(p.images || '[]'); } catch(e) { return [p.images].filter(Boolean); } })();"
);
fs.writeFileSync('src/pages/Home.tsx', home);

// Patch Products.tsx
let products = fs.readFileSync('src/pages/Products.tsx', 'utf8');
products = products.replace(
  "import { queryDb } from '../lib/db';",
  "import { queryDb } from '../lib/db';\nimport { DUMMY_PRODUCTS } from '../data';"
);
products = products.replace(
  "const res = await queryDb(sql, params);\n        setProducts(res || []);",
  `const res = await queryDb(sql, params);
        setProducts(res && res.length > 0 ? res : DUMMY_PRODUCTS);`
);
products = products.replace(
  "const images = JSON.parse(p.images || '[]');",
  "const images = Array.isArray(p.images) ? p.images : (function(){ try { return JSON.parse(p.images || '[]'); } catch(e) { return [p.images].filter(Boolean); } })();"
);
fs.writeFileSync('src/pages/Products.tsx', products);

console.log("Patched Home.tsx and Products.tsx");
