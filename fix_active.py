import re

with open('src/pages/Invest.tsx', 'r') as f:
    content = f.read()

# I will revert that change
content = content.replace("set{tInvest('Active', 'نشط')}Tab", "setActiveTab")
content = content.replace("=== '{tInvest('Active', 'نشط')}'", "=== 'active'")
content = content.replace("!== '{tInvest('Active', 'نشط')}'", "!== 'active'")

# Re-apply correctly
content = content.replace(">Active<", ">{tInvest('Active', 'نشط')}<")

with open('src/pages/Invest.tsx', 'w') as f:
    f.write(content)
