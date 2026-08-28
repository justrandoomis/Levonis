import re

with open('src/pages/Invest.tsx', 'r') as f:
    content = f.read()

content = content.replace(
    '<div className="w-full min-h-screen bg-black text-white font-sans flex flex-col">',
    '<div className="w-full min-h-screen bg-black text-white font-sans flex flex-col" dir="ltr">'
)

with open('src/pages/Invest.tsx', 'w') as f:
    f.write(content)
