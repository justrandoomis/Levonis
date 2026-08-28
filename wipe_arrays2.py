import re

with open('src/pages/Home.tsx', 'r') as f:
    content = f.read()

content = re.sub(r'<div className="flex flex-col gap-6 mb-16">.*?\{\/\* Sections Header \*\/\}', "{/* Sections Header */}", content, flags=re.DOTALL)

with open('src/pages/Home.tsx', 'w') as f:
    f.write(content)
