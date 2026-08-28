const http = require('http');

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
      res.on('end', () => { resolve(JSON.parse(data)); });
    });
    req.on('error', reject);
    req.write(JSON.stringify({ sql, params }));
    req.end();
  });
}

async function check() {
  const result = await executeQuery('SELECT * FROM sqlite_master WHERE type="table"', []);
  console.log(result);
}
check();
