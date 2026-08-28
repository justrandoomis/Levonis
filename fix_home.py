import re

with open('src/pages/Home.tsx', 'r') as f:
    content = f.read()

# Let's remove the Top Brands section completely
content = re.sub(r"\{\/\* Top Brands - Horizontal Scroll \*\/\}.*?\{\/\* Try Something New", "{/* Try Something New", content, flags=re.DOTALL)

with open('src/pages/Home.tsx', 'w') as f:
    f.write(content)
