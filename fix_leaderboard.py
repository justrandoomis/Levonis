import re

with open('src/pages/Leaderboards.tsx', 'r') as f:
    content = f.read()

content = content.replace('leaderboardScore(board, row.score, lang, s)', 'leaderboardScore(board, row.score)')

with open('src/pages/Leaderboards.tsx', 'w') as f:
    f.write(content)

with open('src/pages/Checkout.tsx', 'r') as f:
    content = f.read()

content = content.replace('useState<1 | 2 | 3>(1)', 'useState<1 | 2 | 3 | 4>(1)')

with open('src/pages/Checkout.tsx', 'w') as f:
    f.write(content)
