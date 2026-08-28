const bcrypt = require('./node_modules/bcryptjs');
async function setPassword() {
  const password = "password123";
  const hashedPassword = await bcrypt.hash(password, 10);
  
  const res = await fetch('http://localhost:3000/api/d1/query', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ 
      sql: 'UPDATE users SET password = ? WHERE email = ?',
      params: [hashedPassword, 'aliamer59409@gmail.com']
    })
  });
  const data = await res.json();
  console.log('Database updated:', data);
}
setPassword();
