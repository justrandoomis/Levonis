import re

with open('src/pages/Chat.tsx', 'r') as f:
    content = f.read()

content = re.sub(
    r"const \[messages, setMessages\] = useState<Message\[\]>\(\[.*?\]\);",
    "const [messages, setMessages] = useState<Message[]>([]);",
    content,
    flags=re.DOTALL
)

with open('src/pages/Chat.tsx', 'w') as f:
    f.write(content)
