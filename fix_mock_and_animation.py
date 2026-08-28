import re

with open('src/pages/Invest.tsx', 'r') as f:
    content = f.read()

# Fix AnimatedCurrency to have continuous animation for IQD as well
old_anim = "const val = isUSD ? parseFloat(amountInUSD.toFixed(4)) : Math.floor(amountInUSD * exchangeRate);"
new_anim = "const val = isUSD ? parseFloat(amountInUSD.toFixed(5)) : parseFloat((amountInUSD * exchangeRate).toFixed(4));"
content = content.replace(old_anim, new_anim)

# Fix mock data to be 5,000,000 and 1,000,000 divided by exchangeRate so they display exactly those numbers in IQD
old_mock = """        const now = new Date().getTime();
        const fifteenDays = 15 * 24 * 60 * 60 * 1000;
        const thirtyDays = 30 * 24 * 60 * 60 * 1000;
        invs = [
          {
            id: 'mock1',
            user_id: user.id,
            amount: 5000000,
            expected_profit: 1000000,
            status: 'active',
            start_date: new Date(now - fifteenDays).toISOString(),
            end_date: new Date(now + thirtyDays).toISOString(),
            created_at: new Date(now - fifteenDays).toISOString()
          }
        ];"""

new_mock = """        const now = new Date().getTime();
        const fifteenDays = 15 * 24 * 60 * 60 * 1000;
        const thirtyDays = 30 * 24 * 60 * 60 * 1000;
        
        // If the user uses IQD, the exchange rate is ~1500, so we store the USD equivalent
        // If they use USD, exchangeRate is 1, so it stays 5M and 1M USD.
        const effectiveRate = exchangeRate || 1500;
        const mockAmount = 5000000 / effectiveRate;
        const mockProfit = 1000000 / effectiveRate;
        
        invs = [
          {
            id: 'mock1',
            user_id: user.id,
            amount: mockAmount,
            expected_profit: mockProfit,
            status: 'active',
            start_date: new Date(now - fifteenDays).toISOString(),
            end_date: new Date(now + thirtyDays).toISOString(),
            created_at: new Date(now - fifteenDays).toISOString()
          }
        ];"""

content = content.replace(old_mock, new_mock)

with open('src/pages/Invest.tsx', 'w') as f:
    f.write(content)
