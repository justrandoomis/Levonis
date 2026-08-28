import re

with open('src/pages/Invest.tsx', 'r') as f:
    content = f.read()

old_items = """    queryDb('SELECT * FROM investment_items WHERE investment_id = ?', [inv.id]).then(res => {
      if (!res || res.length === 0) {"""

new_items = """    queryDb('SELECT * FROM investment_items WHERE investment_id = ?', [inv.id]).then(res => {
      if (true) {"""

content = content.replace(old_items, new_items)

with open('src/pages/Invest.tsx', 'w') as f:
    f.write(content)
