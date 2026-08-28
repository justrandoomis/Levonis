import re

with open('src/pages/Orders.tsx', 'r') as f:
    content = f.read()

content = re.sub(r"const dummyOrders = \[.*?\];", "const dummyOrders: any[] = [];", content, flags=re.DOTALL)

with open('src/pages/Orders.tsx', 'w') as f:
    f.write(content)
