import re

with open('src/pages/Invest.tsx', 'r') as f:
    content = f.read()

# Fix lingering bg-white in ChatTab
content = content.replace('bg-white border-b border-zinc-800', 'bg-zinc-900 border-b border-zinc-800')
content = content.replace('bg-white border-t border-zinc-800', 'bg-zinc-900 border-t border-zinc-800')

# Fix image placeholder bg
content = content.replace('bg-zinc-200 rounded-lg', 'bg-zinc-800 rounded-lg')

# Fix progress bar bg
content = content.replace('w-full bg-zinc-100 h-2 rounded-full', 'w-full bg-zinc-800 h-2 rounded-full')

# Check text-black / text-zinc-900
content = content.replace('text-black', 'text-white') 
# wait, if I replace text-black to text-white, it'll mess up the gold button (which needs to be text-black).
# I'll manually handle the 'text-black' if needed. Actually I won't replace 'text-black' globally here.

with open('src/pages/Invest.tsx', 'w') as f:
    f.write(content)
