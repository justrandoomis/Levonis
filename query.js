const fetch = require('node-fetch');
async function run() {
  const res = await fetch('https://ais-dev-uih3ftttvvwmcsodvj34xd-8339339706.europe-west2.run.app/api/d1/query', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sql: 'SELECT * FROM products LIMIT 1' })
  });
  const data = await res.json();
  console.log(data);
}
run();
