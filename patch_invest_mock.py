import re

with open('src/pages/Invest.tsx', 'r') as f:
    content = f.read()

# Mock investments
old_load = """      const invs = await queryDb('SELECT * FROM investments WHERE user_id = ? ORDER BY created_at DESC', [user.id]);
      setInvestments(invs || []);
      
      const msgs = await queryDb('SELECT * FROM investor_messages WHERE user_id = ? ORDER BY created_at ASC', [user.id]);
      setMessages(msgs || []);"""

new_load = """      let invs = await queryDb('SELECT * FROM investments WHERE user_id = ? ORDER BY created_at DESC', [user.id]);
      if (!invs || invs.length === 0) {
        const now = new Date().getTime();
        const thirtyDays = 30 * 24 * 60 * 60 * 1000;
        const sixtyDays = 60 * 24 * 60 * 60 * 1000;
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
        ];
      }
      setInvestments(invs || []);
      
      let msgs = await queryDb('SELECT * FROM investor_messages WHERE user_id = ? ORDER BY created_at ASC', [user.id]);
      if (!msgs || msgs.length === 0) {
        msgs = [
          { id: 'm1', user_id: user.id, sender: 'admin', message: 'Hello! Welcome to your investment dashboard. How can I help you today?', created_at: new Date().toISOString() }
        ];
      }
      setMessages(msgs || []);"""

content = content.replace(old_load, new_load)

# Mock items
old_items = """    queryDb('SELECT * FROM investment_items WHERE investment_id = ?', [inv.id]).then(res => {
      setItems(res || []);
    });"""

new_items = """    queryDb('SELECT * FROM investment_items WHERE investment_id = ?', [inv.id]).then(res => {
      if (!res || res.length === 0) {
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

content = content.replace(old_items, new_items)

with open('src/pages/Invest.tsx', 'w') as f:
    f.write(content)
