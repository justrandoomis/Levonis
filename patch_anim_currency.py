import re

with open('src/pages/Invest.tsx', 'r') as f:
    content = f.read()

old_currency = """function AnimatedCurrency({ amountInUSD, investCurrency, exchangeRate, fontSize = 14, textColor = 'inherit', fontWeight = 'inherit', gradientFrom = 'black' }: any) {
  const isUSD = investCurrency === 'USD';
  // For USD show 2-5 decimal places if it's changing slowly. We can just pass the raw value or toFixed(5)
  // Counter auto detects decimal places from value.toString(). Let's use toFixed(5) and parseFloat to remove trailing zeros.
  const val = isUSD ? parseFloat(amountInUSD.toFixed(5)) : parseFloat((amountInUSD * exchangeRate).toFixed(4));
  
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
}"""

new_currency = """function AnimatedCurrency({ amountInUSD, investCurrency, exchangeRate, fontSize = 14, textColor = 'inherit', fontWeight = 'inherit', gradientFrom = 'black' }: any) {
  const isUSD = investCurrency === 'USD';
  const val = isUSD ? amountInUSD : (amountInUSD * exchangeRate);
  const decimals = isUSD ? 5 : 2;
  
  return (
    <span className="inline-flex items-center justify-center gap-[2px] whitespace-nowrap" style={{ direction: 'ltr' }}>
      {isUSD && <span className="mb-[2px]">$</span>}
      <Counter 
        value={val} 
        fontSize={fontSize} 
        padding={0} 
        gap={1} 
        textColor={textColor} 
        fontWeight={fontWeight} 
        gradientFrom={gradientFrom}
        decimalPlaces={decimals}
      />
      {!isUSD && <span className="mb-[2px]"> IQD</span>}
    </span>
  );
}"""

content = content.replace(old_currency, new_currency)

with open('src/pages/Invest.tsx', 'w') as f:
    f.write(content)
