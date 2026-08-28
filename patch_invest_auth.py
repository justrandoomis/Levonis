import re

with open('src/pages/Invest.tsx', 'r') as f:
    content = f.read()

# Replace the useEffect and return if not authorized
auth_check = """
  if (!user || (!user.isInvestor && !user.isAdmin)) {
    return (
      <div className="w-full min-h-screen bg-white text-black font-sans flex flex-col items-center justify-center p-6 text-center">
        <h1 className="text-2xl font-bold mb-4">Access Denied</h1>
        <p className="text-zinc-500 mb-8">You do not have permission to view the investor dashboard. Please contact the administrator.</p>
        <button onClick={() => navigate('/')} className="bg-zinc-900 text-white px-6 py-3 rounded-full font-bold">Return Home</button>
      </div>
    );
  }
"""

# Remove the old useEffect
content = re.sub(r"  useEffect\(\(\) => \{\n    if \(user && !user\.isInvestor && !user\.isAdmin\) \{\n      navigate\('/'\);\n    \}\n    loadData\(\);\n  \}, \[user\]\);", 
"""
  useEffect(() => {
    loadData();
  }, [user]);
""", content, flags=re.DOTALL)

# Insert the auth check before return
content = content.replace("  return (\n    <div className=\"w-full min-h-screen", auth_check + "\n  return (\n    <div className=\"w-full min-h-screen")

with open('src/pages/Invest.tsx', 'w') as f:
    f.write(content)
