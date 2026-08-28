async function run() {
  const res = await fetch('http://localhost:3000/api/d1/query', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sql: 'SELECT * FROM products LIMIT 1' })
  });
  const data = await res.json();
  console.log(JSON.stringify(data, null, 2));
}
run();
