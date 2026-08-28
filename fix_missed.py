import re

with open('src/pages/Invest.tsx', 'r') as f:
    content = f.read()

content = content.replace('hover:bg-black rounded-xl transition-colors', 'hover:bg-zinc-50 rounded-xl transition-colors')
content = content.replace('<div className="w-full h-full flex flex-col bg-black">', '<div className="w-full h-full flex flex-col bg-white">')
content = content.replace('active:bg-zinc-700', 'active:bg-zinc-200')

with open('src/pages/Invest.tsx', 'w') as f:
    f.write(content)
