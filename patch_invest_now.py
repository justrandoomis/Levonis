import re

with open('src/pages/Invest.tsx', 'r') as f:
    content = f.read()

# For InvestHome
home_replace = """
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
"""
content = re.sub(r"function InvestHome\(\{ (.*?)\) \{\n  const \{ user \} = useAuth\(\);", "function InvestHome({ \\1) {\n  const { user } = useAuth();\n" + home_replace, content)
content = content.replace("  const now = new Date().getTime();\n  \n  investments.forEach(inv => {", "  investments.forEach(inv => {")

# For InvestTab
tab_replace = """
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
"""
content = re.sub(r"function InvestTab\(\{ (.*?)\) \{\n  const \[selectedInvest, setSelectedInvest\] = useState<any \| null>\(null\);", "function InvestTab({ \\1) {\n  const [selectedInvest, setSelectedInvest] = useState<any | null>(null);\n" + tab_replace, content)
content = content.replace("  const now = new Date().getTime();\n  \n  investments.forEach(inv => {", "  investments.forEach(inv => {")

# For InvestmentDetails
det_replace = """
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
"""
content = re.sub(r"function InvestmentDetails\(\{ (.*?)\) \{\n  const \[items, setItems\] = useState<any\[\]>\(\[\]\);", "function InvestmentDetails({ \\1) {\n  const [items, setItems] = useState<any[]>([]);\n" + det_replace, content)
content = content.replace("  const now = new Date().getTime();\n  const start =", "  const start =")

with open('src/pages/Invest.tsx', 'w') as f:
    f.write(content)
