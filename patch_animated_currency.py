import re

with open('src/pages/Invest.tsx', 'r') as f:
    content = f.read()

# Create AnimatedCurrency component
comp = """
function AnimatedCurrency({ amountInUSD, investCurrency, exchangeRate, fontSize = 14, textColor = 'inherit', fontWeight = 'inherit', gradientFrom = 'black' }: any) {
  const isUSD = investCurrency === 'USD';
  // For USD show 2-5 decimal places if it's changing slowly. We can just pass the raw value or toFixed(5)
  // Counter auto detects decimal places from value.toString(). Let's use toFixed(5) and parseFloat to remove trailing zeros.
  const val = isUSD ? parseFloat(amountInUSD.toFixed(4)) : Math.floor(amountInUSD * exchangeRate);
  
  return (
    <span className="inline-flex items-center justify-center gap-[2px]" style={{ direction: 'ltr' }}>
      {isUSD && '$'}
      <Counter 
        value={val} 
        fontSize={fontSize} 
        padding={0} 
        gap={1} 
        textColor={textColor} 
        fontWeight={fontWeight} 
        gradientFrom={gradientFrom}
      />
      {!isUSD && ' IQD'}
    </span>
  );
}

export default function Invest() {
"""

content = content.replace("export default function Invest() {", comp)

# Now, update InvestHome to use AnimatedCurrency for totalProfit
# Find the exact lines in InvestHome we patched before
old_home_profit = """{tInvest('Up', 'أرباح')} {investCurrency === 'USD' ? '$' : ''}
          <Counter 
            value={investCurrency === 'USD' ? parseFloat(totalProfit.toFixed(2)) : Math.floor(totalProfit * exchangeRate)} 
            fontSize={14} 
            padding={0} 
            gap={1} 
            textColor="#52525b" 
            fontWeight={500} 
            gradientFrom="black" 
          />
          {investCurrency === 'IQD' ? ' IQD' : ''}"""

new_home_profit = """{tInvest('Up', 'أرباح')} <AnimatedCurrency amountInUSD={totalProfit} investCurrency={investCurrency} exchangeRate={exchangeRate} fontSize={14} textColor="#52525b" fontWeight={500} />"""
content = content.replace(old_home_profit, new_home_profit)

with open('src/pages/Invest.tsx', 'w') as f:
    f.write(content)
