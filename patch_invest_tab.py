import re

with open('src/pages/Invest.tsx', 'r') as f:
    content = f.read()

# Add balance to InvestTab props
content = content.replace(
    "function InvestTab({ investments, loadData, formatCurrency, tInvest, investCurrency, exchangeRate }: {",
    "function InvestTab({ balance, investments, loadData, formatCurrency, tInvest, investCurrency, exchangeRate }: { balance: number,"
)

content = content.replace(
    "return <InvestTab investments={investments}",
    "return <InvestTab balance={balance} investments={investments}"
)

with open('src/pages/Invest.tsx', 'w') as f:
    f.write(content)
