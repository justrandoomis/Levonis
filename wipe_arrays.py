import re

with open('src/pages/Home.tsx', 'r') as f:
    content = f.read()

content = re.sub(r"\{\/\* 1\. Services Bar \*\/\}.*?\{\/\* 2\. Secondary Categories Bar \*\/\}", "{/* 2. Secondary Categories Bar */}", content, flags=re.DOTALL)
content = re.sub(r"\{\/\* 2\. Secondary Categories Bar \*\/\}.*?\{\/\* 3\. Promo Offers Bar \*\/\}", "{/* 3. Promo Offers Bar */}", content, flags=re.DOTALL)
content = re.sub(r"\{\/\* 3\. Promo Offers Bar \*\/\}.*?\{\/\* Sections Header \*\/\}", "{/* Sections Header */}", content, flags=re.DOTALL)

with open('src/pages/Home.tsx', 'w') as f:
    f.write(content)
