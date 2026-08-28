import re

with open('src/pages/Invest.tsx', 'r') as f:
    content = f.read()

# Pass investments to MoveFundsTab
content = content.replace("<MoveFundsTab balance={balance} />", "<MoveFundsTab balance={balance} investments={investments} />")

# Update MoveFundsTab signature and logic
new_func = """function MoveFundsTab({ balance, investments }: { balance: number, investments: any[] }) {
  const [amount, setAmount] = useState('0');
  
  const now = new Date().getTime();
  const maturedInvestmentsTotal = investments.filter(inv => {
    if (inv.status !== 'active') return false;
    const end = new Date(inv.end_date).getTime();
    return now >= end;
  }).reduce((sum, inv) => sum + inv.amount + inv.expected_profit, 0);
  
  const availableBalance = balance + maturedInvestmentsTotal;
  
  const handleKey = (n: string) => {
"""

content = re.sub(r"function MoveFundsTab\(\{ balance \}: \{ balance: number \}\) \{\n  const \[amount, setAmount\] = useState\('0'\);\n  \n  const handleKey = \(n: string\) => \{", new_func, content)

content = content.replace("Available Balance: ${balance.toLocaleString()}", "Available Balance: ${availableBalance.toLocaleString()}")

with open('src/pages/Invest.tsx', 'w') as f:
    f.write(content)
