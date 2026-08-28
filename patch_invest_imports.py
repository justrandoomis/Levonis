import re

with open('src/pages/Invest.tsx', 'r') as f:
    content = f.read()

content = content.replace("import { useWallet } from '../WalletContext';", "import { useWallet } from '../WalletContext';\nimport { useLanguage } from '../LanguageContext';")

invest_func = """export default function Invest() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { balance, exchangeRate } = useWallet();
  const { lang, setLang } = useLanguage();
  
  const [investCurrency, setInvestCurrency] = useState<'IQD'|'USD'>(() => {
    return (localStorage.getItem('investCurrency') as 'IQD'|'USD') || 'IQD';
  });
  
  useEffect(() => {
    localStorage.setItem('investCurrency', investCurrency);
  }, [investCurrency]);

  const formatCurrency = (amountInUSD: number) => {
    if (investCurrency === 'IQD') {
      return (amountInUSD * exchangeRate).toLocaleString() + ' IQD';
    }
    return '$' + amountInUSD.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  };
  
  const formatInputCurrency = (amountInput: number | string) => {
    const num = typeof amountInput === 'string' ? parseFloat(amountInput) : amountInput;
    if (isNaN(num)) return investCurrency === 'IQD' ? '0 IQD' : '$0';
    return investCurrency === 'IQD' ? num.toLocaleString() + ' IQD' : '$' + num.toLocaleString();
  };

  const [activeTab, setActiveTab] = useState('home');"""

content = re.sub(r"export default function Invest\(\) \{.*?  const \[activeTab, setActiveTab\] = useState\('home'\);", invest_func, content, flags=re.DOTALL)

with open('src/pages/Invest.tsx', 'w') as f:
    f.write(content)
