import re

with open('src/pages/Games.tsx', 'r') as f:
    content = f.read()

content = content.replace('<GamesPage dir={dir} testId="games-hub">', '<GamesPage>')
content = content.replace('backLabel={s.back}', 'back={s.back}')
content = content.replace('<Stars stars={state.level} s={s} />', '<Stars value={state.level} />')
content = content.replace('<CoinsChip coins={state.coins} lang={lang} s={s} />', '<CoinsChip value={state.coins} />')

with open('src/pages/Games.tsx', 'w') as f:
    f.write(content)

with open('src/pages/Leaderboards.tsx', 'r') as f:
    content = f.read()

content = content.replace('<GamesPage dir={dir} testId="leaderboards">', '<GamesPage>')
content = content.replace('backLabel={s.back}', 'back={s.back}')

with open('src/pages/Leaderboards.tsx', 'w') as f:
    f.write(content)

