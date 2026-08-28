const http = require('http');

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

async function run() {
  await executeQuery("UPDATE products SET subcategory_id = 'ss1', name_ar = 'ايفون 16 برو ماكس', description_ar = 'هاتف ذكي بشاشة رائعة وبطارية قوية' WHERE slug = 'iphone-16-pro-max-fake'");
  await executeQuery("UPDATE products SET subcategory_id = 'ss2', name_ar = 'ماك بوك برو M3', description_ar = 'أداء مذهل مع شريحة M3 Max' WHERE slug = 'macbook-pro-m3-max-fake'");
  await executeQuery("UPDATE products SET subcategory_id = 'ss3', name_ar = 'سماعات سوني', description_ar = 'سماعات رائدة في عزل الضوضاء' WHERE slug = 'sony-wh-1000xm5-fake'");
  await executeQuery("UPDATE products SET subcategory_id = 'ss4', name_ar = 'سامسونج اس 24 الترا', description_ar = 'الذكاء الاصطناعي من جالكسي هنا' WHERE slug = 'samsung-galaxy-s24-ultra-fake'");
  await executeQuery("UPDATE products SET subcategory_id = 'ss5', name_ar = 'باور بانك انكر', description_ar = 'باور بانك قوي جدا' WHERE slug = 'anker-powercore-24k-fake'");
  console.log("Updated products");
}
run();
