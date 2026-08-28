import re

with open('src/pages/Chats.tsx', 'r') as f:
    content = f.read()

content = re.sub(
    r"const conversations = \[.*?\];",
    "const conversations: any[] = [];",
    content,
    flags=re.DOTALL
)

with open('src/pages/Chats.tsx', 'w') as f:
    f.write(content)
