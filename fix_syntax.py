import re

with open('src/components/AdminProducts.tsx', 'r') as f:
    content = f.read()

# Let's fix the duplicated price grid block
regex = r'<div className="grid grid-cols-1 md:grid-cols-3 gap-4">.*?<div className="grid grid-cols-1 md:grid-cols-4 gap-4 mt-4">'
content = re.sub(regex, '<div className="grid grid-cols-1 md:grid-cols-4 gap-4 mt-4">', content, flags=re.DOTALL)

with open('src/components/AdminProducts.tsx', 'w') as f:
    f.write(content)
