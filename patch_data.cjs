const fs = require('fs');
let data = fs.readFileSync('src/data.ts', 'utf8');

data = data.replace(
  'export const DUMMY_PRODUCTS: Product[] = [',
  `export const DUMMY_PRODUCTS: any[] = [`
);

fs.writeFileSync('src/data.ts', data);
