import re

with open('src/pages/Games.tsx', 'r') as f:
    content = f.read()

content = content.replace('s.level(farm.profile.level)', '`${s.level} ${farm.profile.level}`')

with open('src/pages/Games.tsx', 'w') as f:
    f.write(content)

with open('src/pages/Leaderboards.tsx', 'r') as f:
    content = f.read()

content = content.replace('s.lbRank(rank)', '`${s.lbRank} ${rank}`')

with open('src/pages/Leaderboards.tsx', 'w') as f:
    f.write(content)

