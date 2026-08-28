import re

with open('src/pages/Checkout.tsx', 'r') as f:
    content = f.read()

content = re.sub(
    r"const addresses = \[.*?\];",
    "const addresses: any[] = [];",
    content,
    flags=re.DOTALL
)

content = re.sub(
    r"const items = \[.*?\];",
    "const items: any[] = [];",
    content,
    flags=re.DOTALL
)

with open('src/pages/Checkout.tsx', 'w') as f:
    f.write(content)
