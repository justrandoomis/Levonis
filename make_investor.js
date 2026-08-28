import fs from 'fs';
fetch('http://localhost:3000/api/auth/me', {
  method: 'POST',
  headers: { 'Authorization': `Bearer ${fs.readFileSync('.token', 'utf-8')}` }
}).then(r => r.json()).then(console.log);
