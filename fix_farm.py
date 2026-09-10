import re

with open('src/pages/farm/PrinterFarm.tsx', 'r') as f:
    content = f.read()

content = content.replace('farm.profile.farm_name', 'farm.state.farm_name')
content = content.replace('farm.profile.level', 'farm.state.level')
content = content.replace('farm.profile.stars', 'farm.state.stars')
content = content.replace('farm.profile.coins', 'farm.state.coins')

with open('src/pages/farm/PrinterFarm.tsx', 'w') as f:
    f.write(content)

