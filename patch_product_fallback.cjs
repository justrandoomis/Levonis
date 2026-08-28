const fs = require('fs');
let content = fs.readFileSync('src/pages/Product.tsx', 'utf8');

const target = `      if (!data) {
        throw new Error('Product not found');
      }`;

const replacement = `      if (!data) {
        // Provide a fallback dummy product so the page doesn't break on fake links
        data = {
          ...DUMMY_PRODUCTS[0],
          id: id,
          slug: id,
          name: id.includes('merchant') ? 'منتج متجر' : DUMMY_PRODUCTS[0].name,
          name_ar: id.includes('merchant') ? 'منتج متجر' : DUMMY_PRODUCTS[0].name_ar,
          name_en: id.includes('merchant') ? 'Merchant Product' : DUMMY_PRODUCTS[0].name_en,
        };
      }`;

content = content.replace(target, replacement);
fs.writeFileSync('src/pages/Product.tsx', content);
console.log('Patched fallback');
