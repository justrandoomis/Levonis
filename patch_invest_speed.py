import re

with open('src/pages/Invest.tsx', 'r') as f:
    content = f.read()

# Let's change thirtyDays to 2 hours
content = content.replace("const thirtyDays = 30 * 24 * 60 * 60 * 1000;", "const thirtyDays = 2 * 60 * 60 * 1000;")
content = content.replace("const sixtyDays = 60 * 24 * 60 * 60 * 1000;", "const sixtyDays = 4 * 60 * 60 * 1000;")

with open('src/pages/Invest.tsx', 'w') as f:
    f.write(content)
