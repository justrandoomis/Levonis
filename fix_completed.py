import re

with open('src/pages/Invest.tsx', 'r') as f:
    content = f.read()

content = content.replace("is{tInvest('Completed', 'مكتمل')}", "isCompleted")
content = content.replace("=== '{tInvest('Completed', 'مكتمل')}'", "=== 'completed'")
content = content.replace("!== '{tInvest('Completed', 'مكتمل')}'", "!== 'completed'")
content = content.replace(">Completed<", ">{tInvest('Completed', 'مكتمل')}<")

with open('src/pages/Invest.tsx', 'w') as f:
    f.write(content)
