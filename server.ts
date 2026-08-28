import { GoogleGenAI } from "@google/genai";
import express from "express";
import path from "path";
import fs from "fs";
import { createServer as createViteServer } from "vite";

const app = express();
const PORT = 3000;

app.use(express.json());

// Cloudflare D1 Helper function
const executeD1Query = async (sql: string, params: any[] = []) => {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const dbId = process.env.CLOUDFLARE_DATABASE_ID;
  const token = process.env.CLOUDFLARE_API_TOKEN;

  if (!accountId || !dbId || !token) {
    throw new Error('Cloudflare D1 credentials are not configured');
  }

  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${dbId}/query`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ sql, params }),
  });

  const data = await response.json();
  if (!data.success) {
    throw new Error(data.errors?.[0]?.message || 'D1 query failed');
  }
  
  return data.result[0].results;
};

// --- API Routes ---

import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import multer from "multer";
import crypto from "crypto";

const r2 = new S3Client({
  region: "auto",
  endpoint: process.env.CLOUDFLARE_R2_ENDPOINT || '',
  credentials: {
    accessKeyId: process.env.CLOUDFLARE_R2_ACCESS_KEY_ID || '',
    secretAccessKey: process.env.CLOUDFLARE_R2_SECRET_ACCESS_KEY || '',
  },
});

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || '' });

app.post('/api/translate', express.json(), async (req, res) => {
  try {
    const { text, targetLang } = req.body;
    if (!text) return res.json({ success: true, translation: '' });
    
    // If we have no API key, just return the original text
    if (!process.env.GEMINI_API_KEY) {
      return res.json({ success: true, translation: text });
    }

    const prompt = `Translate the following text to ${targetLang === 'en' ? 'English' : targetLang === 'ku' ? 'Sorani Kurdish' : 'Arabic'}. Only output the translated text, no extra words or explanations.\n\n${text}`;
    
    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: prompt,
    });
    
    res.json({ success: true, translation: response.text.trim() });
  } catch (error) {
    console.error('Translation error:', error);
    res.status(500).json({ success: false, error: 'Translation failed' });
  }
});

const upload = multer({ storage: multer.memoryStorage() });

app.post('/api/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, error: 'No file uploaded' });
    }

    if (!process.env.CLOUDFLARE_R2_ENDPOINT) {
      return res.status(500).json({ success: false, error: 'R2 not configured' });
    }

    const bucketName = process.env.CLOUDFLARE_R2_BUCKET_NAME || '';
    const publicUrl = process.env.CLOUDFLARE_R2_PUBLIC_URL || '';
    
    const fileExtension = req.file.originalname.split('.').pop();
    const fileName = `uploads/${Date.now()}-${crypto.randomBytes(4).toString('hex')}.${fileExtension}`;

    await r2.send(
      new PutObjectCommand({
        Bucket: bucketName,
        Key: fileName,
        Body: req.file.buffer,
        ContentType: req.file.mimetype,
      })
    );

    const fileUrl = `${publicUrl}/${fileName}`;
    res.json({ success: true, url: fileUrl });
  } catch (err: any) {
    console.error('Upload error', err);
    res.status(500).json({ success: false, error: err.message });
  }
});


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


app.post('/api/auth/google', async (req, res) => {
  try {
    const { email, name } = req.body;
    if (!email) {
      return res.status(400).json({ success: false, error: 'Email required' });
    }
    const users = await executeD1Query('SELECT * FROM users WHERE email = ?', [email]);
    let user;
    let generatedPassword = null;
    
    if (users.length > 0) {
      user = users[0];
      if (!user.password) {
        generatedPassword = Math.random().toString(36).slice(-8);
        const hashedPassword = await bcrypt.hash(generatedPassword, 10);
        await executeD1Query('UPDATE users SET password = ? WHERE id = ?', [hashedPassword, user.id]);
        console.log(`[EMAIL MOCK] To: ${email} | Subject: Your new password | Body: You can now sign in using your email/username and this password: ${generatedPassword}`);
      }
    } else {
      const id = Math.random().toString(36).substr(2, 9);
      const username = email.split('@')[0];
      generatedPassword = Math.random().toString(36).slice(-8);
      const hashedPassword = await bcrypt.hash(generatedPassword, 10);
      
      await executeD1Query(
        'INSERT INTO users (id, name, email, username, password) VALUES (?, ?, ?, ?, ?)',
        [id, name || 'User', email, username, hashedPassword]
      );
      user = { id, name: name || 'User', email, username };
      console.log(`[EMAIL MOCK] To: ${email} | Subject: Welcome to Levo! | Body: You can sign in using Google, or use this password: ${generatedPassword}`);
    }
    delete user.password;
    
    const token = jwt.sign({ userId: user.id, email: user.email }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ success: true, user, token, generatedPassword });
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

    const users = await executeD1Query('SELECT * FROM users WHERE email = ? OR username = ?', [email, email]);
    if (users.length === 0) {
      return res.status(400).json({ success: false, error: 'No account found with this email or username' });
    }

    const user = users[0];
    if (!user.password) {
      return res.status(400).json({ success: false, error: 'This account uses Google Sign-In. Please click "Continue with Google".' });
    }

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(400).json({ success: false, error: 'Incorrect password' });
    }

    // Don't send password back
    delete user.password;
    
    const token = jwt.sign({ userId: user.id, email: user.email }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ success: true, user, token });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});


app.post('/api/auth/forgot-password', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ success: false, error: 'Email required' });
    
    const users = await executeD1Query('SELECT * FROM users WHERE email = ?', [email]);
    if (users.length === 0) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }
    
    // In a real app we'd send an email with a reset token here.
    // For demo purposes, we'll just return success.
    res.json({ success: true, message: 'Password reset link sent.' });
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

app.post('/api/d1/init', async (req, res) => {
  try {
    
    await executeD1Query(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        name TEXT,
        email TEXT UNIQUE,
        username TEXT,
        isAdmin BOOLEAN DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `);
    
    // Attempt to add new columns to users

    try { await executeD1Query("ALTER TABLE users ADD COLUMN isInvestor BOOLEAN DEFAULT 0"); } catch(e) {}

    await executeD1Query(`
      CREATE TABLE IF NOT EXISTS investments (
        id TEXT PRIMARY KEY,
        user_id TEXT,
        amount REAL,
        expected_profit REAL,
        start_date DATETIME,
        end_date DATETIME,
        status TEXT DEFAULT 'active',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await executeD1Query(`
      CREATE TABLE IF NOT EXISTS investment_items (
        id TEXT PRIMARY KEY,
        investment_id TEXT,
        name TEXT,
        price REAL,
        image TEXT
      );
    `);

    await executeD1Query(`
      CREATE TABLE IF NOT EXISTS investor_messages (
        id TEXT PRIMARY KEY,
        user_id TEXT,
        sender TEXT,
        message TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `);

    try { await executeD1Query("ALTER TABLE users ADD COLUMN password TEXT"); } catch(e) {}
    try { await executeD1Query("ALTER TABLE users ADD COLUMN subscription_plan TEXT DEFAULT 'free'"); } catch(e) {}
    try { await executeD1Query("ALTER TABLE users ADD COLUMN subscription_status TEXT DEFAULT 'inactive'"); } catch(e) {}
    try { await executeD1Query("ALTER TABLE users ADD COLUMN subscription_expiry INTEGER DEFAULT 0"); } catch(e) {}
    try { await executeD1Query("ALTER TABLE users ADD COLUMN card_number TEXT"); } catch(e) {}

    
    await executeD1Query(`
      CREATE TABLE IF NOT EXISTS wallet_transactions (
        id TEXT PRIMARY KEY,
        type TEXT,
        amount REAL,
        status TEXT,
        date DATETIME DEFAULT CURRENT_TIMESTAMP,
        receiptUrl TEXT,
        note TEXT,
        adminNote TEXT,
        accountNumber TEXT,
        userId TEXT,
        currency TEXT DEFAULT 'USD'
      );
    `);

    try { await executeD1Query("ALTER TABLE wallet_transactions ADD COLUMN userId TEXT"); } catch(e) {}
    try { await executeD1Query("ALTER TABLE wallet_transactions ADD COLUMN currency TEXT DEFAULT 'USD'"); } catch(e) {}

    
    await executeD1Query(`
      CREATE TABLE IF NOT EXISTS products (
        id TEXT PRIMARY KEY,
        name TEXT,
        slug TEXT UNIQUE,
        description TEXT,
        images TEXT,
        options TEXT,
        colors TEXT,
        selling_type TEXT,
        shipping_methods TEXT,
        base_price REAL,
        original_price REAL,
        product_cost REAL,
        membership_prices TEXT,
        payment_options TEXT,
        subcategory_id TEXT,
        display_order INTEGER,
        is_featured BOOLEAN DEFAULT 0,
        specifications TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `);

    try { await executeD1Query("ALTER TABLE products ADD COLUMN name_en TEXT"); } catch(e) {}
    try { await executeD1Query("ALTER TABLE products ADD COLUMN name_ar TEXT"); } catch(e) {}
    try { await executeD1Query("ALTER TABLE products ADD COLUMN description_en TEXT"); } catch(e) {}
    try { await executeD1Query("ALTER TABLE products ADD COLUMN description_ar TEXT"); } catch(e) {}
    try { await executeD1Query("ALTER TABLE products ADD COLUMN name_ku TEXT"); } catch(e) {}
    try { await executeD1Query("ALTER TABLE products ADD COLUMN description_ku TEXT"); } catch(e) {}
    try { await executeD1Query("ALTER TABLE products ADD COLUMN brand TEXT"); } catch(e) {}
    try { await executeD1Query("ALTER TABLE products ADD COLUMN labels TEXT"); } catch(e) {}
    try { await executeD1Query("ALTER TABLE products ADD COLUMN hashtags TEXT"); } catch(e) {}
    try { await executeD1Query("ALTER TABLE products ADD COLUMN algorithm_tags TEXT"); } catch(e) {}
    try { await executeD1Query("ALTER TABLE products ADD COLUMN features TEXT"); } catch(e) {}
    try { await executeD1Query("ALTER TABLE products ADD COLUMN description_images TEXT"); } catch(e) {}
    try { await executeD1Query("ALTER TABLE products ADD COLUMN description_videos TEXT"); } catch(e) {}
    try { await executeD1Query("ALTER TABLE products ADD COLUMN stores TEXT"); } catch(e) {}
    try { await executeD1Query("ALTER TABLE products ADD COLUMN categories TEXT"); } catch(e) {}
    try { await executeD1Query("ALTER TABLE products ADD COLUMN warranty_plans TEXT"); } catch(e) {}
    try { await executeD1Query("ALTER TABLE products ADD COLUMN how_to_use TEXT"); } catch(e) {}

    await executeD1Query(`
      CREATE TABLE IF NOT EXISTS community_products (
        id TEXT PRIMARY KEY,
        merchant_id TEXT,
        name TEXT,
        name_en TEXT,
        name_ar TEXT,
        slug TEXT UNIQUE,
        description TEXT,
        description_en TEXT,
        description_ar TEXT,
        images TEXT,
        base_price REAL,
        original_price REAL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await executeD1Query(`
      CREATE TABLE IF NOT EXISTS community_requests (
        id TEXT PRIMARY KEY,
        customer_id TEXT,
        title TEXT,
        description TEXT,
        status TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await executeD1Query(`
      CREATE TABLE IF NOT EXISTS community_merchants (
        id TEXT PRIMARY KEY,
        name TEXT,
        rating REAL,
        verified BOOLEAN DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `);

    
    await executeD1Query(`
      CREATE TABLE IF NOT EXISTS admin_settings (
        key TEXT PRIMARY KEY,
        value TEXT
      );
    `);

    res.json({ success: true, message: 'Database initialized successfully' });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/d1/query', async (req, res) => {
  try {
    const { sql, params } = req.body;
    const result = await executeD1Query(sql, params);
    res.json({ success: true, result });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});


import * as cheerio from 'cheerio';

app.post('/api/extract', async (req, res) => {
  try {
    const { url } = req.body;
    if (!url) return res.status(400).json({ success: false, error: 'URL required' });

    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      }
    });
    
    if (!response.ok) {
      return res.status(500).json({ success: false, error: 'Failed to fetch URL' });
    }

    const html = await response.text();
    const $ = cheerio.load(html);

    let name = $('meta[property="og:title"]').attr('content') || $('title').text() || '';
    let description = $('meta[property="og:description"]').attr('content') || $('meta[name="description"]').attr('content') || '';
    let image = $('meta[property="og:image"]').attr('content') || '';
    let price = 0;

    // Try to parse JSON-LD
    $('script[type="application/ld+json"]').each((i, el) => {
      try {
        const data = JSON.parse($(el).html());
        const parseProduct = (obj) => {
          if (obj['@type'] === 'Product') {
            if (obj.name) name = obj.name;
            if (obj.description) description = obj.description;
            if (obj.image) {
              image = Array.isArray(obj.image) ? obj.image[0] : obj.image;
            }
          }
        };
        
        if (Array.isArray(data)) {
          data.forEach(parseProduct);
        } else {
          parseProduct(data);
        }
      } catch (e) {}
    });

    res.json({
      success: true,
      product: {
        name,
        description,
        images: image ? [image] : []
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok' });
});

async function startServer() {
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  
app.get('/api/make-all-investors', async (req, res) => {
  try {
    await executeD1Query('UPDATE users SET isInvestor = 1');
    res.json({ success: true });
  } catch (e: any) {
    res.json({ success: false, error: e.message });
  }
});

app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on port ${PORT}`);
  });
}

startServer();
