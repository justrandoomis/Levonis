const fs = require('fs');
let content = fs.readFileSync('src/pages/Product.tsx', 'utf8');

// First, add DUMMY_PRODUCTS to imports if it's not there
if (!content.includes('import { DUMMY_PRODUCTS }')) {
  content = content.replace(
    "import { queryDb } from '../lib/db';",
    "import { queryDb } from '../lib/db';\nimport { DUMMY_PRODUCTS } from '../data';"
  );
}

// Second, replace the DB fetch logic to use DUMMY_PRODUCTS as fallback
const target = `        if (res && res.length > 0) {
          setProduct(res[0]);
        }`;

const replacement = `        if (res && res.length > 0) {
          setProduct(res[0]);
        } else {
          // Fallback to dummy products
          const dummy = DUMMY_PRODUCTS.find(p => String(p.slug) === String(slug) || String(p.id) === String(slug));
          if (dummy) {
            setProduct(dummy);
          } else {
            // Provide a generic fallback so it doesn't break
            setProduct({
              ...DUMMY_PRODUCTS[0],
              id: slug,
              slug: slug,
              name: (slug || '').includes('merchant') ? 'منتج متجر' : DUMMY_PRODUCTS[0].name,
              name_ar: (slug || '').includes('merchant') ? 'منتج متجر' : DUMMY_PRODUCTS[0].name_ar,
              name_en: (slug || '').includes('merchant') ? 'Merchant Product' : DUMMY_PRODUCTS[0].name_en,
            });
          }
        }`;

if (content.includes(target)) {
  content = content.replace(target, replacement);
}

// Fix images parsing for dummy products
const imagesTarget = "const images = JSON.parse(product.images || '[]');";
const imagesReplacement = "const images = Array.isArray(product.images) ? product.images : (function(){ try { return JSON.parse(product.images || '[]'); } catch(e) { return [product.images].filter(Boolean); } })();";

if (content.includes(imagesTarget)) {
  content = content.replace(imagesTarget, imagesReplacement);
}

// Fix firstImage
const firstImageTarget = "const firstImage = images[0] || 'https://images.unsplash.com/photo-1505740420928-5e560c06d30e?w=800';";
const firstImageReplacement = "const firstImage = images[0] || product.image_url || product.image || 'https://images.unsplash.com/photo-1505740420928-5e560c06d30e?w=800';";

if (content.includes(firstImageTarget)) {
  content = content.replace(firstImageTarget, firstImageReplacement);
}

fs.writeFileSync('src/pages/Product.tsx', content);
console.log('Patched Product.tsx for fallback');
