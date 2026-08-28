import re

with open('src/pages/Products.tsx', 'r') as f:
    content = f.read()

content = re.sub(r"import \{ DUMMY_PRODUCTS \} from '\.\./data';\n", "", content)
content = content.replace("setProducts(res && res.length > 0 ? res : DUMMY_PRODUCTS);", "setProducts(res || []);")
content = content.replace("setProducts(DUMMY_PRODUCTS);", "setProducts([]);")

with open('src/pages/Products.tsx', 'w') as f:
    f.write(content)
