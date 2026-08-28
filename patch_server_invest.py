import re

with open('server.ts', 'r') as f:
    content = f.read()

init_db_patch = """
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
"""

content = content.replace('    try { await executeD1Query("ALTER TABLE users ADD COLUMN password TEXT"); } catch(e) {}', 
                          init_db_patch + '\n    try { await executeD1Query("ALTER TABLE users ADD COLUMN password TEXT"); } catch(e) {}')


with open('server.ts', 'w') as f:
    f.write(content)
