import re

with open('src/pages/Cart.tsx', 'r') as f:
    content = f.read()

# Replace the storeGroups initialization
content = re.sub(r"const \[storeGroups, setStoreGroups\] = useState\(\[.*?\]\);", "const [storeGroups, setStoreGroups] = useState<any[]>([]);", content, flags=re.DOTALL)

with open('src/pages/Cart.tsx', 'w') as f:
    f.write(content)
