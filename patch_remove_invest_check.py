import re

with open('src/pages/Invest.tsx', 'r') as f:
    content = f.read()

# Remove the access denied check completely so the user can test the UI
content = re.sub(r"\n  if \(!user \|\| \(!user\.isInvestor && !user\.isAdmin\)\) \{.*?  \}\n", "\n", content, flags=re.DOTALL)

with open('src/pages/Invest.tsx', 'w') as f:
    f.write(content)
