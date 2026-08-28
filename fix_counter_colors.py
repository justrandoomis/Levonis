import re

with open('src/pages/Invest.tsx', 'r') as f:
    content = f.read()

# Fix textColor in AnimatedCurrency calls
content = content.replace('textColor="#52525b"', 'textColor="#a1a1aa" gradientFrom="black"')
content = content.replace('text-zinc-600', 'text-zinc-400')

# Also for InvestTab, the bg is zinc-900 (#18181b)
# For InvestmentDetails, the bg is also zinc-900 (#18181b)
# But wait, my replace might make gradientFrom="black" instead of #18181b.
# Let's just manually patch it.

# Actually, the gradient is just a tiny fade at top and bottom. black is fine, or #18181b.
content = content.replace('gradientFrom="black" gradientFrom="black"', 'gradientFrom="black"')

with open('src/pages/Invest.tsx', 'w') as f:
    f.write(content)
