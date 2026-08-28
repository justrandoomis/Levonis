import re

with open('src/App.tsx', 'r') as f:
    content = f.read()

content = content.replace('<Route path="/invest" element={<Invest />} />', '<Route path="/invest" element={<ProtectedRoute><Invest /></ProtectedRoute>} />')
content = content.replace('<Route path="/admin/invest" element={<InvestAdmin />} />', '<Route path="/admin/invest" element={<ProtectedRoute><InvestAdmin /></ProtectedRoute>} />')
content = content.replace('<Route path="/admin" element={<Admin />} />', '<Route path="/admin" element={<ProtectedRoute><Admin /></ProtectedRoute>} />')

with open('src/App.tsx', 'w') as f:
    f.write(content)
