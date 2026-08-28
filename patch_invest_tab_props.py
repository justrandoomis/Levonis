import re

with open('src/pages/Invest.tsx', 'r') as f:
    content = f.read()

content = content.replace(
    "return <InvestTab balance={balance} investments={investments} loadData={loadData} formatCurrency={formatCurrency} tInvest={tInvest} investCurrency={investCurrency} exchangeRate={exchangeRate} />;",
    "return <InvestTab balance={balance} investments={investments} loadData={loadData} formatCurrency={formatCurrency} tInvest={tInvest} investCurrency={investCurrency} exchangeRate={exchangeRate} chargeWallet={chargeWallet} user={user} />;"
)

content = content.replace(
    "function InvestTab({ balance, investments, loadData, formatCurrency, tInvest, investCurrency, exchangeRate }: { balance: number, investments: any[], loadData: () => void, formatCurrency: any, tInvest: any, investCurrency: any, exchangeRate: any }) {",
    "function InvestTab({ balance, investments, loadData, formatCurrency, tInvest, investCurrency, exchangeRate, chargeWallet, user }: { balance: number, investments: any[], loadData: () => void, formatCurrency: any, tInvest: any, investCurrency: any, exchangeRate: any, chargeWallet: any, user: any }) {\n  const [showForm, setShowForm] = useState(false);\n  const [investAmount, setInvestAmount] = useState('');\n  const [investPlan, setInvestPlan] = useState('3M');"
)

with open('src/pages/Invest.tsx', 'w') as f:
    f.write(content)
