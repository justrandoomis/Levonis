const fs = require('fs');
let code = fs.readFileSync('server.ts', 'utf8');

const authRoutes = `
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET || 'super_secret_jwt_key_123';

app.post('/api/auth/register', async (req, res) => {
  try {
    const { name, email, username, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ success: false, error: 'Email and password required' });
    }
    
    // Check if user exists
    const existing = await executeD1Query('SELECT * FROM users WHERE email = ?', [email]);
    if (existing.length > 0) {
      return res.status(400).json({ success: false, error: 'Email already exists' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const id = Math.random().toString(36).substr(2, 9);
    
    await executeD1Query(
      'INSERT INTO users (id, name, email, username, password) VALUES (?, ?, ?, ?, ?)',
      [id, name || '', email, username || '', hashedPassword]
    );
    
    const user = { id, name, email, username };
    const token = jwt.sign({ userId: id, email }, JWT_SECRET, { expiresIn: '7d' });
    
    res.json({ success: true, user, token });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ success: false, error: 'Email and password required' });
    }

    const users = await executeD1Query('SELECT * FROM users WHERE email = ?', [email]);
    if (users.length === 0) {
      return res.status(400).json({ success: false, error: 'Invalid credentials' });
    }

    const user = users[0];
    if (!user.password) {
      return res.status(400).json({ success: false, error: 'Invalid credentials' });
    }

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(400).json({ success: false, error: 'Invalid credentials' });
    }

    // Don't send password back
    delete user.password;
    
    const token = jwt.sign({ userId: user.id, email: user.email }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ success: true, user, token });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/auth/me', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }
    
    const token = authHeader.split(' ')[1];
    const decoded: any = jwt.verify(token, JWT_SECRET);
    
    const users = await executeD1Query('SELECT * FROM users WHERE id = ?', [decoded.userId]);
    if (users.length === 0) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }
    
    const user = users[0];
    delete user.password;
    res.json({ success: true, user });
  } catch (err: any) {
    res.status(401).json({ success: false, error: 'Invalid token' });
  }
});
`;

code = code.replace(
  '// --- API Routes ---',
  '// --- API Routes ---\n' + authRoutes
);

code = code.replace(
  'try { await executeD1Query("ALTER TABLE users ADD COLUMN subscription_plan TEXT DEFAULT \'free\'"); } catch(e) {}',
  'try { await executeD1Query("ALTER TABLE users ADD COLUMN password TEXT"); } catch(e) {}\n    try { await executeD1Query("ALTER TABLE users ADD COLUMN subscription_plan TEXT DEFAULT \'free\'"); } catch(e) {}'
);

fs.writeFileSync('server.ts', code);
