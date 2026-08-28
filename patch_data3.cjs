const fs = require('fs');
let data = fs.readFileSync('src/data.ts', 'utf8');

data = data.replace(
  'export const DUMMY_PRODUCTS: any[] = [',
  'const _DUMMY_PRODUCTS: any[] = ['
);
data = data.replace(
  /];\s*DUMMY_PRODUCTS\.forEach\([\s\S]*\}\);/g,
  '];\n'
);

data += `
export const DUMMY_PRODUCTS = _DUMMY_PRODUCTS.map(p => ({
  ...p,
  base_price: p.price,
  original_price: p.originalPrice || p.price,
  images: JSON.stringify([p.image]),
  slug: p.id,
  name_ar: p.name,
  name_en: p.name,
  description_ar: p.description,
  description_en: p.description,
  features: JSON.stringify(p.features || []),
  colors: JSON.stringify(p.colors ? p.colors.map(c => ({name: c, hex: c})) : []),
  membership_prices: p.proPrice ? JSON.stringify({ pro: p.proPrice }) : null
}));
`;

fs.writeFileSync('src/data.ts', data);
