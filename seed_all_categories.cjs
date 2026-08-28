const http = require('http');

const subcats = ['ss6', 'ss7', 'ss8', 'ss9', 'ss10', 'ss11', 'ss12', 'ss13', 'ss14'];
const types = [
  { name: 'Tooling Kit', img: 'https://images.unsplash.com/photo-1531297484001-80022131f5a1?w=800' },
  { name: 'Spare Parts', img: 'https://images.unsplash.com/photo-1581092160562-40aa08e78837?w=800' },
  { name: 'Maintenance Guide', img: 'https://images.unsplash.com/photo-1584916201218-f4242ceb4809?w=800' }
];

function executeQuery(sql, params) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: 'localhost',
      port: 3000,
      path: '/api/d1/query',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    }, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => { resolve(JSON.parse(data)); });
    });
    req.on('error', reject);
    req.write(JSON.stringify({ sql, params }));
    req.end();
  });
}

async function seed() {
  for (const cat of subcats) {
    for (let i=0; i<3; i++) {
      const type = types[i];
      const id = 'prod_' + Math.random().toString(36).substr(2, 9);
      const slug = cat + '-product-' + i;
      
      const sql = `
        INSERT INTO products (
          id, name, slug, description, images, options, colors, 
          selling_type, shipping_methods, base_price, original_price, 
          product_cost, membership_prices, payment_options, 
          subcategory_id, display_order, is_featured, specifications,
          name_ar, description_ar
        ) VALUES (
          ?, ?, ?, ?, ?, '[]', '[]', 
          'direct_sale', '[]', ?, ?, 
          ?, '{"plus":0,"pro":0}', '["full"]', 
          ?, 0, 0, '[]', ?, ?
        )
      `;
      const price = Math.floor(Math.random() * 50 + 10) * 1000;
      const original_price = price + 5000;
      const params = [
        id,
        `${type.name} for ${cat}`,
        slug,
        `Description for ${type.name}`,
        JSON.stringify([type.img]),
        price,
        original_price,
        price - 2000,
        cat,
        `منتج وهمي ${cat}`,
        `وصف المنتج الوهمي`
      ];
      await executeQuery(sql, params);
    }
  }
  console.log("Seeded all subcategories");
}
seed();
