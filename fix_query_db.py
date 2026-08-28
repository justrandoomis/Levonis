import re

with open('src/pages/Invest.tsx', 'r') as f:
    content = f.read()

content = content.replace("const { queryDb } = await import('../lib/db');", "")

with open('src/pages/Invest.tsx', 'w') as f:
    f.write(content)
