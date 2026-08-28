import re

with open('src/pages/Invest.tsx', 'r') as f:
    content = f.read()

old_mock = """        const thirtyDays = 2 * 60 * 60 * 1000;
        const sixtyDays = 4 * 60 * 60 * 1000;
        invs = [
          {
            id: 'mock1',
            user_id: user.id,
            amount: 5000,
            expected_profit: 500,
            status: 'active',
            start_date: new Date(now - thirtyDays).toISOString(),
            end_date: new Date(now + thirtyDays).toISOString(),
            created_at: new Date(now - thirtyDays).toISOString()
          },
          {
            id: 'mock2',
            user_id: user.id,
            amount: 10000,
            expected_profit: 2000,
            status: 'completed',
            start_date: new Date(now - sixtyDays).toISOString(),
            end_date: new Date(now - thirtyDays).toISOString(),
            created_at: new Date(now - sixtyDays).toISOString()
          }
        ];"""

new_mock = """        const fifteenDays = 15 * 24 * 60 * 60 * 1000;
        const thirtyDays = 30 * 24 * 60 * 60 * 1000;
        const fortyFiveDays = 45 * 24 * 60 * 60 * 1000;
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
          },
          {
            id: 'mock2',
            user_id: user.id,
            amount: 2500000,
            expected_profit: 500000,
            status: 'completed',
            start_date: new Date(now - fortyFiveDays - fifteenDays).toISOString(),
            end_date: new Date(now - fifteenDays).toISOString(),
            created_at: new Date(now - fortyFiveDays - fifteenDays).toISOString()
          }
        ];"""

content = content.replace(old_mock, new_mock)

with open('src/pages/Invest.tsx', 'w') as f:
    f.write(content)
