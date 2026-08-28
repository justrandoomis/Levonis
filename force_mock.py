import re

with open('src/pages/Invest.tsx', 'r') as f:
    content = f.read()

old_load = """      let invs = await queryDb('SELECT * FROM investments WHERE user_id = ? ORDER BY created_at DESC', [user.id]);
      if (!invs || invs.length === 0) {"""

new_load = """      let invs = await queryDb('SELECT * FROM investments WHERE user_id = ? ORDER BY created_at DESC', [user.id]);
      if (true) { // Force mock data for testing"""

content = content.replace(old_load, new_load)

with open('src/pages/Invest.tsx', 'w') as f:
    f.write(content)
