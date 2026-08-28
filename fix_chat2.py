import re

with open('src/pages/Chat.tsx', 'r') as f:
    content = f.read()

# Add emojis back if it's missing
if "const emojis =" not in content:
    content = content.replace("const [messages, setMessages]", "const emojis = ['😀','😂','😅','😍','😊','😎','🤔','😭','👍','🙏','❤️','🔥','✨','🎉','💯'];\n  const [messages, setMessages]")

with open('src/pages/Chat.tsx', 'w') as f:
    f.write(content)
