const fs = require('fs');
let content = fs.readFileSync('src/pages/Product.tsx', 'utf8');

// 1. Fallback product so dummy link won't break
const target1 = `      if (!data) {
        throw new Error('Product not found');
      }`;

const replacement1 = `      if (!data) {
        // Provide a fallback dummy product so the page doesn't break on fake links
        data = {
          ...DUMMY_PRODUCTS[0],
          id: id,
          slug: id,
          name: (id || '').includes('merchant') ? 'منتج متجر' : DUMMY_PRODUCTS[0].name,
          name_ar: (id || '').includes('merchant') ? 'منتج متجر' : DUMMY_PRODUCTS[0].name_ar,
          name_en: (id || '').includes('merchant') ? 'Merchant Product' : DUMMY_PRODUCTS[0].name_en,
        };
      }`;
content = content.replace(target1, replacement1);

// 2. Fix images parsing to prevent crash
const target2 = `  const images = Array.isArray(product.images) ? product.images : JSON.parse(product.images || '[]');
  const firstImage = images[0] || 'https://via.placeholder.com/300';`;

const replacement2 = `  const images = Array.isArray(product.images) ? product.images : (function(){ try { return JSON.parse(product.images || '[]'); } catch(e) { return [product.images].filter(Boolean); } })();
  const firstImage = images[0] || product.image_url || product.image || 'https://via.placeholder.com/300';`;
content = content.replace(target2, replacement2);
content = content.replace(
  "const firstImage = images[0] || 'https://via.placeholder.com/300';",
  "const firstImage = images[0] || product.image_url || product.image || 'https://via.placeholder.com/300';"
);

// 3. Fix referrerPolicy
content = content.replace(/<img /g, '<img referrerPolicy="no-referrer" ');

fs.writeFileSync('src/pages/Product.tsx', content);
console.log('Patched restored Product.tsx');
