import re

with open('src/pages/Invest.tsx', 'r') as f:
    content = f.read()

content = content.replace('<LineChart data={data}>', '<AreaChart data={data}>')

with open('src/pages/Invest.tsx', 'w') as f:
    f.write(content)
