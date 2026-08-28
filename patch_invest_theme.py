import re

with open('src/pages/Invest.tsx', 'r') as f:
    content = f.read()

# 1. Main container
content = content.replace('bg-white text-black', 'bg-black text-white')

# 2. Bottom nav
content = content.replace('bg-white border-t border-zinc-200', 'bg-black border-t border-zinc-800')

# 3. Profile menu trigger
content = content.replace('bg-zinc-100 rounded-full', 'bg-zinc-800 rounded-full')

# 4. Profile menu dropdown
content = content.replace('bg-white border border-zinc-200 shadow-xl', 'bg-zinc-900 border border-zinc-800 shadow-xl')

# 5. Profile menu buttons (en/ar, iqd/usd)
content = content.replace("? 'bg-zinc-900 text-white' : 'bg-zinc-100 text-zinc-800'", "? 'bg-[#e6a84f] text-black font-bold' : 'bg-zinc-800 text-zinc-300'")

# 6. Icons / text colors
content = content.replace('text-zinc-900', 'text-white')
content = content.replace('text-zinc-800', 'text-zinc-200')
content = content.replace('text-zinc-700', 'text-zinc-300')

# 7. Card backgrounds
content = content.replace('bg-white rounded-2xl shadow-[0_4px_24px_rgba(0,0,0,0.06)]', 'bg-zinc-900 rounded-2xl border border-zinc-800')

# 8. List items and borders
content = content.replace('border-zinc-100', 'border-zinc-800')
content = content.replace('border-zinc-200', 'border-zinc-800')
content = content.replace('bg-zinc-50', 'bg-black')
content = content.replace('hover:bg-zinc-50', 'hover:bg-zinc-800')

# 9. Keypad buttons
content = content.replace('hover:bg-zinc-100 active:bg-zinc-200', 'hover:bg-zinc-800 active:bg-zinc-700')

# 10. Chat colors
content = content.replace('bg-zinc-200 rounded-full flex items-center justify-center mr-3', 'bg-zinc-800 rounded-full flex items-center justify-center mr-3')
content = content.replace("? 'bg-zinc-900 text-white self-end rounded-tr-sm' : 'bg-white border border-zinc-800 text-white self-start rounded-tl-sm'", "? 'bg-[#e6a84f] text-black self-end rounded-tr-sm font-medium' : 'bg-zinc-800 text-white self-start rounded-tl-sm'")

# 11. Chat input
content = content.replace('bg-zinc-100 rounded-full', 'bg-zinc-900 border border-zinc-800 rounded-full')
content = content.replace('bg-transparent outline-none text-sm text-white', 'bg-transparent outline-none text-sm text-white') # if text-zinc-900 was changed to text-white
content = content.replace('text-zinc-400', 'text-zinc-500') # Some adjustments

with open('src/pages/Invest.tsx', 'w') as f:
    f.write(content)
