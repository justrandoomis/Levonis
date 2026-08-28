import re

with open('src/pages/Invest.tsx', 'r') as f:
    content = f.read()

old_mock = """        const now = new Date().getTime();
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

new_mock = """        const now = new Date().getTime();
        const fortyFiveDays = 45 * 24 * 60 * 60 * 1000;
        
        // If the user uses IQD, the exchange rate is ~1500, so we store the USD equivalent
        // If they use USD, exchangeRate is 1, so it stays 5M and 1M USD.
        const effectiveRate = exchangeRate || 1500;
        const mockAmount = 5000000 / effectiveRate;
        const mockProfit = 1000000 / effectiveRate;
        
        // Let's make it start a little bit ago so there's some profit, but we will explicitly show the total target
        // Actually, let's start it right now so it counts up from zero!
        invs = [
          {
            id: 'mock1',
            user_id: user.id,
            amount: mockAmount,
            expected_profit: mockProfit,
            status: 'active',
            start_date: new Date(now).toISOString(),
            end_date: new Date(now + fortyFiveDays).toISOString(),
            created_at: new Date(now).toISOString()
          }
        ];"""

content = content.replace(old_mock, new_mock)

with open('src/pages/Invest.tsx', 'w') as f:
    f.write(content)
