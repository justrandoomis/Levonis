import { config } from 'dotenv';
config();

async function executeD1Query(sql: string, params: any[] = []) {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const dbId = process.env.CLOUDFLARE_DATABASE_ID;
  const token = process.env.CLOUDFLARE_API_TOKEN;

  if (!accountId || !dbId || !token) {
    throw new Error('Cloudflare D1 credentials are not configured');
  }

  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${dbId}/query`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ sql, params }),
  });

  const data = await response.json();
  if (!data.success) {
    console.error("D1 Error:", data.errors);
    throw new Error(data.errors?.[0]?.message || 'D1 query failed');
  }
    
  return data.result[0].results;
}

async function run() {
  try {
    await executeD1Query(`
      CREATE TABLE IF NOT EXISTS community_products (
        id TEXT PRIMARY KEY,
        merchant_id TEXT,
        name TEXT,
        name_en TEXT,
        name_ar TEXT,
        slug TEXT UNIQUE,
        description TEXT,
        description_en TEXT,
        description_ar TEXT,
        images TEXT,
        base_price REAL,
        original_price REAL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `);
    
    await executeD1Query(`
      CREATE TABLE IF NOT EXISTS community_requests (
        id TEXT PRIMARY KEY,
        customer_id TEXT,
        title TEXT,
        description TEXT,
        status TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `);
    
    await executeD1Query(`
      CREATE TABLE IF NOT EXISTS community_merchants (
        id TEXT PRIMARY KEY,
        name TEXT,
        rating REAL,
        verified BOOLEAN DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `);
    
    await executeD1Query(`INSERT OR IGNORE INTO community_products (id, merchant_id, name, slug, description, images, base_price) VALUES ('cprod_1', 'merch_1', 'Community 3D Print Model', 'comm-model-1', 'A 3D print model shared by community.', '["https://images.unsplash.com/photo-1505740420928-5e560c06d30e?w=800"]', 15.00)`);
    console.log("Done");
  } catch (e) {
    console.error(e);
  }
}
run();
