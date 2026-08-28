import re

with open('src/pages/Invest.tsx', 'r') as f:
    content = f.read()

old_load = """      const invs = await queryDb('SELECT * FROM investments WHERE user_id = ? ORDER BY created_at DESC', [user.id]);
      setInvestments(invs || []);"""

new_load = """      let invs = await queryDb('SELECT * FROM investments WHERE user_id = ? ORDER BY created_at DESC', [user.id]);
      if (!invs || invs.length === 0) {
        const now = new Date().getTime();
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
        ];
      }
      setInvestments(invs || []);"""

content = content.replace(old_load, new_load)

old_items = """    queryDb('SELECT * FROM investment_items WHERE investment_id = ?', [inv.id]).then(res => {
      setItems(res || []);
    });"""

new_items = """    queryDb('SELECT * FROM investment_items WHERE investment_id = ?', [inv.id]).then(res => {
      if (!res || res.length === 0) {
        if (inv.id === 'mock1') {
          res = [
            { id: 'i1', investment_id: 'mock1', name: 'Real Estate - Commercial Building', price: 2500000, image: '' },
            { id: 'i2', investment_id: 'mock1', name: 'Tech Startup Shares', price: 2500000, image: '' }
          ];
        }
      }
      setItems(res || []);
    });"""

content = content.replace(old_items, new_items)

with open('src/pages/Invest.tsx', 'w') as f:
    f.write(content)
