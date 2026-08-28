const fs = require('fs');
let content = fs.readFileSync('server.ts', 'utf8');

content = content.replace(
  "CREATE TABLE IF NOT EXISTS wallet_transactions (\\n        id TEXT PRIMARY KEY,\\n        type TEXT,\\n        amount REAL,\\n        status TEXT,\\n        date DATETIME DEFAULT CURRENT_TIMESTAMP,\\n        receiptUrl TEXT,\\n        note TEXT,\\n        adminNote TEXT,\\n        accountNumber TEXT\\n      );",
  "CREATE TABLE IF NOT EXISTS wallet_transactions (\\n        id TEXT PRIMARY KEY,\\n        userId TEXT,\\n        type TEXT,\\n        amount REAL,\\n        status TEXT,\\n        date DATETIME DEFAULT CURRENT_TIMESTAMP,\\n        receiptUrl TEXT,\\n        note TEXT,\\n        adminNote TEXT,\\n        accountNumber TEXT\\n      );"
);

fs.writeFileSync('server.ts', content);
