-- Migration file for Levonis 3D

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  name TEXT,
  email TEXT UNIQUE,
  username TEXT,
  isAdmin BOOLEAN DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS wallet_transactions (
  id TEXT PRIMARY KEY,
  type TEXT,
  amount REAL,
  status TEXT,
  date DATETIME DEFAULT CURRENT_TIMESTAMP,
  receiptUrl TEXT,
  note TEXT,
  adminNote TEXT,
  accountNumber TEXT
);

CREATE TABLE IF NOT EXISTS admin_settings (
  key TEXT PRIMARY KEY,
  value TEXT
);
