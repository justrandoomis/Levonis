import re

with open('src/pages/Invest.tsx', 'r') as f:
    content = f.read()

content = content.replace("setInterval(() => setNow(Date.now()), 1000)", "setInterval(() => setNow(Date.now()), 50)")

with open('src/pages/Invest.tsx', 'w') as f:
    f.write(content)
