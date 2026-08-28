import re

with open('src/pages/Invest.tsx', 'r') as f:
    content = f.read()

content = content.replace('<NavItem icon={<Home />} label="Home"', '<NavItem icon={<Home />} label={tInvest("Home", "الرئيسية")}')
content = content.replace('<NavItem icon={<TrendingUp />} label="Invest"', '<NavItem icon={<TrendingUp />} label={tInvest("Invest", "استثمار")}')
content = content.replace('<NavItem icon={<MessageSquare />} label="Support"', '<NavItem icon={<MessageSquare />} label={tInvest("Support", "الدعم")}')

with open('src/pages/Invest.tsx', 'w') as f:
    f.write(content)
