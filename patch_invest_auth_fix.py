import re

with open('src/pages/Invest.tsx', 'r') as f:
    content = f.read()

# Replace the specific navigate code
content = content.replace("    if (user && !user.isInvestor && !user.isAdmin) {\n      // In real scenario, redirect or show \"Not authorized\"\n      navigate('/');\n    }", "")

with open('src/pages/Invest.tsx', 'w') as f:
    f.write(content)
