fetch('http://localhost:3000/api/d1/query', { 
  method: 'POST', 
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ sql: "PRAGMA table_info(users)" }) 
})
  .then(res => res.json())
  .then(console.log)
  .catch(console.error);
