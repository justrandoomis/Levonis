const fs = require('fs');

let content = fs.readFileSync('server.ts', 'utf8');

const productsTableSql = `
    await executeD1Query(\\\`
      CREATE TABLE IF NOT EXISTS products (
        id TEXT PRIMARY KEY,
        name TEXT,
        slug TEXT UNIQUE,
        description TEXT,
        images TEXT,
        options TEXT,
        colors TEXT,
        selling_type TEXT,
        shipping_methods TEXT,
        base_price REAL,
        original_price REAL,
        product_cost REAL,
        membership_prices TEXT,
        payment_options TEXT,
        subcategory_id TEXT,
        display_order INTEGER,
        is_featured BOOLEAN DEFAULT 0,
        specifications TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    \\\`);
`;

content = content.replace(
  /await executeD1Query\(`\s*CREATE TABLE IF NOT EXISTS admin_settings/,
  productsTableSql + "\n    await executeD1Query(`\n      CREATE TABLE IF NOT EXISTS admin_settings"
);

fs.writeFileSync('server.ts', content);
