const fs = require('fs');
let data = fs.readFileSync('src/data.ts', 'utf8');

// We will transform DUMMY_PRODUCTS in place before it is exported, or just export it mapped.
// Wait, DUMMY_PRODUCTS is already a const array. We can just modify the array elements directly at the bottom of the file!
data += `
DUMMY_PRODUCTS.forEach(p => {
  p.base_price = p.price;
  p.original_price = p.originalPrice || p.price;
  p.images = JSON.stringify([p.image]);
  p.slug = p.id;
  p.name_ar = p.name;
  p.name_en = p.name;
  p.description_ar = p.description;
  p.description_en = p.description;
  p.features = JSON.stringify(p.features || []);
  p.colors = JSON.stringify(p.colors ? p.colors.map(c => ({name: c, hex: c})) : []);
  if (p.proPrice) {
    p.membership_prices = JSON.stringify({ pro: p.proPrice });
  }
});
`;

fs.writeFileSync('src/data.ts', data);
