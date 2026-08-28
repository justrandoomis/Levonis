import re

with open('src/pages/Invest.tsx', 'r') as f:
    content = f.read()

# Replace mock investments
old_load_inv = """      let invs = await queryDb('SELECT * FROM investments WHERE user_id = ? ORDER BY created_at DESC', [user.id]);
      if (true) { // Force mock data for testing
        const now = new Date().getTime();
        const fifteenDays = 15 * 24 * 60 * 60 * 1000;
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
        ];
      }
      setInvestments(invs || []);"""

new_load_inv = """      const invs = await queryDb('SELECT * FROM investments WHERE user_id = ? ORDER BY created_at DESC', [user.id]);
      setInvestments(invs || []);"""

content = content.replace(old_load_inv, new_load_inv)

# Replace mock messages
old_msgs = """      let msgs = await queryDb('SELECT * FROM investor_messages WHERE user_id = ? ORDER BY created_at ASC', [user.id]);
      if (!msgs || msgs.length === 0) {
        msgs = [
          { id: 'm1', user_id: user.id, sender: 'admin', message: 'Hello! Welcome to your investment dashboard. How can I help you today?', created_at: new Date().toISOString() }
        ];
      }
      setMessages(msgs || []);"""

new_msgs = """      const msgs = await queryDb('SELECT * FROM investor_messages WHERE user_id = ? ORDER BY created_at ASC', [user.id]);
      setMessages(msgs || []);"""
content = content.replace(old_msgs, new_msgs)

# Replace mock items
old_items = """    queryDb('SELECT * FROM investment_items WHERE investment_id = ?', [inv.id]).then(res => {
      if (true) {
        if (inv.id === 'mock1') {
          res = [
            { id: 'i1', investment_id: 'mock1', name: 'Real Estate Share A', price: 2500, image: '' },
            { id: 'i2', investment_id: 'mock1', name: 'Tech Startup Bond', price: 2500, image: '' }
          ];
        } else if (inv.id === 'mock2') {
          res = [
            { id: 'i3', investment_id: 'mock2', name: 'Gold ETF', price: 10000, image: '' }
          ];
        }
      }
      setItems(res || []);
    });"""

new_items = """    queryDb('SELECT * FROM investment_items WHERE investment_id = ?', [inv.id]).then(res => {
      setItems(res || []);
    });"""

content = content.replace(old_items, new_items)

with open('src/pages/Invest.tsx', 'w') as f:
    f.write(content)
