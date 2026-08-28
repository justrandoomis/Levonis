const http = require('http');

const products = [
  // Product 1: Many options and colors, Pre-order
  {
    name: 'iPhone 16 Pro Max - Fake',
    slug: 'iphone-16-pro-max-fake',
    description: 'The ultimate smartphone with an incredible display and battery life.',
    images: JSON.stringify(['https://images.unsplash.com/photo-1605236453806-6ff36851218e?w=800']),
    options: JSON.stringify([
      { id: 'opt1', name: '256GB' },
      { id: 'opt2', name: '512GB' },
      { id: 'opt3', name: '1TB' }
    ]),
    colors: JSON.stringify([
      { id: 'col1', name: 'Titanium Black', hex: '#2C2C2C', price: 1500000, original_price: 1600000 },
      { id: 'col2', name: 'Titanium White', hex: '#F2F2F2', price: 1500000, original_price: 1600000 },
      { id: 'col3', name: 'Titanium Blue', hex: '#2A3B4C', price: 1550000, original_price: 1650000 }
    ]),
    selling_type: 'pre_order',
    base_price: 1500000,
    original_price: 1600000,
    product_cost: 1300000,
    membership_prices: JSON.stringify({ plus: 1450000, pro: 1400000 }),
    specifications: JSON.stringify([
      { key: 'Screen', value: '6.7 inch OLED' },
      { key: 'Processor', value: 'A18 Pro' }
    ])
  },
  // Product 2: Only options, Direct Sale
  {
    name: 'MacBook Pro M3 Max - Fake',
    slug: 'macbook-pro-m3-max-fake',
    description: 'Mind-blowing performance with the M3 Max chip. Ideal for heavy workflows.',
    images: JSON.stringify(['https://images.unsplash.com/photo-1517336714731-489689fd1ca8?w=800']),
    options: JSON.stringify([
      { id: 'opt1', name: '36GB RAM / 1TB SSD' },
      { id: 'opt2', name: '64GB RAM / 2TB SSD' }
    ]),
    colors: JSON.stringify([]),
    selling_type: 'direct_sale',
    base_price: 4500000,
    original_price: 4800000,
    product_cost: 4000000,
    membership_prices: JSON.stringify({ plus: 4400000, pro: 4300000 }),
    specifications: JSON.stringify([
      { key: 'CPU', value: 'M3 Max 16-core' },
      { key: 'Battery', value: 'Up to 22 hours' }
    ])
  },
  // Product 3: Only colors, Direct Sale
  {
    name: 'Sony WH-1000XM5 - Fake',
    slug: 'sony-wh-1000xm5-fake',
    description: 'Industry-leading noise cancellation headphones.',
    images: JSON.stringify(['https://images.unsplash.com/photo-1618366712010-f4ae9c647dcb?w=800']),
    options: JSON.stringify([]),
    colors: JSON.stringify([
      { id: 'col1', name: 'Black', hex: '#000000', price: 450000, original_price: 500000 },
      { id: 'col2', name: 'Silver', hex: '#C0C0C0', price: 450000, original_price: 500000 }
    ]),
    selling_type: 'direct_sale',
    base_price: 450000,
    original_price: 500000,
    product_cost: 350000,
    membership_prices: JSON.stringify({ plus: 430000, pro: 410000 }),
    specifications: JSON.stringify([
      { key: 'Battery', value: '30 Hours' },
      { key: 'Noise Canceling', value: 'Yes, Active' }
    ])
  },
  // Product 4: Pre-order, lots of colors and options
  {
    name: 'Samsung Galaxy S24 Ultra - Fake',
    slug: 'samsung-galaxy-s24-ultra-fake',
    description: 'Galaxy AI is here. Epic camera and performance.',
    images: JSON.stringify(['https://images.unsplash.com/photo-1707343843437-caacff5cfa74?w=800']),
    options: JSON.stringify([
      { id: 'opt1', name: '256GB / 12GB RAM' },
      { id: 'opt2', name: '512GB / 12GB RAM' },
      { id: 'opt3', name: '1TB / 12GB RAM' }
    ]),
    colors: JSON.stringify([
      { id: 'col1', name: 'Titanium Gray', hex: '#808080', price: 1400000, original_price: 1550000 },
      { id: 'col2', name: 'Titanium Violet', hex: '#8A2BE2', price: 1400000, original_price: 1550000 },
      { id: 'col3', name: 'Titanium Yellow', hex: '#FFFF00', price: 1400000, original_price: 1550000 }
    ]),
    selling_type: 'pre_order',
    base_price: 1400000,
    original_price: 1550000,
    product_cost: 1200000,
    membership_prices: JSON.stringify({ plus: 1350000, pro: 1300000 }),
    specifications: JSON.stringify([
      { key: 'Screen', value: '6.8 inch QHD+ AMOLED' },
      { key: 'Stylus', value: 'S-Pen Included' }
    ])
  },
  // Product 5: Basic product, direct sale
  {
    name: 'Anker PowerCore 24K - Fake',
    slug: 'anker-powercore-24k-fake',
    description: 'Ultra-powerful power bank with 140W fast charging.',
    images: JSON.stringify(['https://images.unsplash.com/photo-1609091839311-d5365f9ff1c5?w=800']),
    options: JSON.stringify([]),
    colors: JSON.stringify([]),
    selling_type: 'direct_sale',
    base_price: 150000,
    original_price: 180000,
    product_cost: 100000,
    membership_prices: JSON.stringify({ plus: 140000, pro: 135000 }),
    specifications: JSON.stringify([
      { key: 'Capacity', value: '24000 mAh' },
      { key: 'Output', value: '140W Max' }
    ])
  }
];

function executeQuery(sql, params) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: 'localhost',
      port: 3000,
      path: '/api/d1/query',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      }
    }, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on('error', reject);
    req.write(JSON.stringify({ sql, params }));
    req.end();
  });
}

async function seed() {
  for (const product of products) {
    const id = 'prod_' + Math.random().toString(36).substr(2, 9);
    
    // Check if slug exists
    const existing = await executeQuery('SELECT id FROM products WHERE slug = ?', [product.slug]);
    if (existing && existing.result && existing.result.length > 0) {
      console.log(`Product ${product.slug} already exists`);
      continue;
    }
    
    const sql = `
      INSERT INTO products (
        id, name, slug, description, images, options, colors, 
        selling_type, shipping_methods, base_price, original_price, 
        product_cost, membership_prices, payment_options, 
        subcategory_id, display_order, is_featured, specifications
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, 
        ?, '[]', ?, ?, 
        ?, ?, '["full"]', 
        '', 0, 1, ?
      )
    `;
    const params = [
      id,
      product.name,
      product.slug,
      product.description,
      product.images,
      product.options,
      product.colors,
      product.selling_type,
      product.base_price,
      product.original_price,
      product.product_cost,
      product.membership_prices,
      product.specifications
    ];
    
    try {
      const result = await executeQuery(sql, params);
      if (!result.success) {
        console.error('Failed to insert', product.name, result.error);
      } else {
        console.log('Inserted', product.name);
      }
    } catch (e) {
      console.error('Error inserting', product.name, e);
    }
  }
}

seed();
