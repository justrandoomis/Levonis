import re

with open('src/pages/InvestAdmin.tsx', 'r') as f:
    content = f.read()

# Replace loadUsers query to load all users
content = content.replace("SELECT * FROM users WHERE isInvestor = 1 OR isAdmin = 1", "SELECT * FROM users")

# Add toggle function
toggle_func = """
  const toggleInvestor = async (e: any, u: any) => {
    e.stopPropagation();
    await queryDb('UPDATE users SET isInvestor = ? WHERE id = ?', [u.isInvestor ? 0 : 1, u.id]);
    loadUsers();
  };
"""

content = content.replace("const loadUsers = async () => {", toggle_func + "\n  const loadUsers = async () => {")

# Add badge and toggle button in the user list
user_card = """
            <div key={u.id} className="bg-zinc-900 p-6 rounded-xl cursor-pointer hover:bg-zinc-800 transition flex justify-between items-center" onClick={() => setSelectedUser(u)}>
              <div>
                <h2 className="text-xl font-bold mb-1 flex items-center gap-2">
                  {u.name} 
                  {u.isInvestor === 1 && <span className="bg-gold text-black text-xs px-2 py-1 rounded font-bold">Investor</span>}
                </h2>
                <p className="text-zinc-400">{u.email}</p>
              </div>
              <button onClick={(e) => toggleInvestor(e, u)} className="bg-zinc-700 hover:bg-zinc-600 px-3 py-1 rounded text-sm">
                {u.isInvestor ? 'Revoke' : 'Make Investor'}
              </button>
            </div>
"""

content = re.sub(
    r"<div key=\{u\.id\} className=\"bg-zinc-900 p-6 rounded-xl cursor-pointer hover:bg-zinc-800 transition\" onClick=\{\(\) => setSelectedUser\(u\)\}>.*?<\/div>",
    user_card,
    content,
    flags=re.DOTALL
)

with open('src/pages/InvestAdmin.tsx', 'w') as f:
    f.write(content)
