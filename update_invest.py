import re

with open('src/pages/Invest.tsx', 'r') as f:
    content = f.read()

content = content.replace(
    "const { balance, exchangeRate } = useWallet();",
    "const { balance, exchangeRate, chargeWallet, addTransaction } = useWallet();"
)

content = content.replace(
    "return <MoveFundsTab balance={balance} investments={investments} formatCurrency={formatCurrency} formatInputCurrency={formatInputCurrency} tInvest={tInvest} />;",
    "return <MoveFundsTab balance={balance} investments={investments} formatCurrency={formatCurrency} formatInputCurrency={formatInputCurrency} tInvest={tInvest} chargeWallet={chargeWallet} addTransaction={addTransaction} setActiveTab={setActiveTab} />;"
)

content = content.replace(
    "function MoveFundsTab({ balance, investments, formatCurrency, formatInputCurrency, tInvest }: { balance: number, investments: any[], formatCurrency: any, formatInputCurrency: any, tInvest: any }) {",
    "function MoveFundsTab({ balance, investments, formatCurrency, formatInputCurrency, tInvest, chargeWallet, addTransaction, setActiveTab }: { balance: number, investments: any[], formatCurrency: any, formatInputCurrency: any, tInvest: any, chargeWallet: any, addTransaction: any, setActiveTab: any }) {"
)

with open('src/pages/Invest.tsx', 'w') as f:
    f.write(content)
