fetch('http://localhost:3000/api/d1/init', { method: 'POST' })
  .then(res => res.json())
  .then(console.log)
  .catch(console.error);
