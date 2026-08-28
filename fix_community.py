import re

with open('src/pages/Community.tsx', 'r') as f:
    content = f.read()

content = re.sub(
    r"setMerchants\(m && m\.length > 0 \? m : \[.*?\]\);",
    "setMerchants(m || []);",
    content,
    flags=re.DOTALL
)

content = re.sub(
    r"setRequests\(r && r\.length > 0 \? r : \[.*?\]\);",
    "setRequests(r || []);",
    content,
    flags=re.DOTALL
)

with open('src/pages/Community.tsx', 'w') as f:
    f.write(content)
