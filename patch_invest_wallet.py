import re

with open('src/pages/Invest.tsx', 'r') as f:
    content = f.read()

content = content.replace("import { useAuth } from '../AuthContext';", "import { useAuth } from '../AuthContext';\nimport { useWallet } from '../WalletContext';")

# Inside Invest():
content = content.replace("  const { user } = useAuth();\n  const [activeTab, setActiveTab] = useState('home');", "  const { user } = useAuth();\n  const { balance } = useWallet();\n  const [activeTab, setActiveTab] = useState('home');")

# Remove the local balance state since we use wallet balance
content = re.sub(r"\s*const \[balance, setBalance\] = useState\(0\); // Available balance for withdrawal/investment", "", content)

# Remove setBalance(0); in loadData
content = re.sub(r"\s*setBalance\(0\);", "", content)

with open('src/pages/Invest.tsx', 'w') as f:
    f.write(content)
