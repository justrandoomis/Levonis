import re

with open('src/pages/MerchantStore.tsx', 'r') as f:
    content = f.read()

content = re.sub(
    r"setMerchant\(\{.*?\}\);",
    "setMerchant(null);",
    content,
    flags=re.DOTALL
)

content = re.sub(
    r"setProducts\(\[.*?\]\);",
    "setProducts([]);",
    content,
    flags=re.DOTALL
)

with open('src/pages/MerchantStore.tsx', 'w') as f:
    f.write(content)
