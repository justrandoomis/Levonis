import re

with open('server.ts', 'r') as f:
    content = f.read()

# Add a route to make all users investors
route = """
app.get('/api/make-all-investors', async (req, res) => {
  try {
    await executeD1Query('UPDATE users SET isInvestor = 1');
    res.json({ success: true });
  } catch (e: any) {
    res.json({ success: false, error: e.message });
  }
});
"""

content = content.replace("app.listen(PORT", route + "\napp.listen(PORT")

with open('server.ts', 'w') as f:
    f.write(content)
