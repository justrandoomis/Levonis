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
  const users = await executeQuery('SELECT id FROM users LIMIT 1', []);
  if (users && users.result && users.result.length > 0) {
    const userId = users.result[0].id;
    const t1 = `INSERT INTO wallet_transactions (id, type, amount, status, date, userId, currency) VALUES ('wt_1', 'deposit', 500000, 'approved', datetime('now', '-2 days'), ?, 'IQD')`;
    const t2 = `INSERT INTO wallet_transactions (id, type, amount, status, date, userId, currency) VALUES ('wt_2', 'purchase', -150000, 'approved', datetime('now', '-1 days'), ?, 'IQD')`;
    const t3 = `INSERT INTO wallet_transactions (id, type, amount, status, date, userId, currency) VALUES ('wt_3', 'deposit', 100000, 'pending', datetime('now'), ?, 'IQD')`;
    
    await executeQuery(t1, [userId]);
    await executeQuery(t2, [userId]);
    await executeQuery(t3, [userId]);
    console.log("Seeded transactions for user", userId);
  } else {
    console.log("No users found");
  }
}
run();
