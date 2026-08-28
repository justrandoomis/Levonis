const fs = require('fs');
let content = fs.readFileSync('src/App.tsx', 'utf8');

const imports = `import Orders from './pages/Orders';
import Warranty from './pages/Warranty';
import Cart from './pages/Cart';
import Community from './pages/Community';
import Chats from './pages/Chats';
import Tools from './pages/Tools';`;

if (!content.includes('import Orders from')) {
  content = content.replace("import Profile from './pages/Profile';", `import Profile from './pages/Profile';\n${imports}`);
}

content = content.replace(/<Route path="\/community".*/, `<Route path="/community" element={<ProtectedRoute><Community /></ProtectedRoute>} />`);
content = content.replace(/<Route path="\/chats".*/, `<Route path="/chats" element={<ProtectedRoute><Chats /></ProtectedRoute>} />`);
content = content.replace(/<Route path="\/cart".*/, `<Route path="/cart" element={<ProtectedRoute><Cart /></ProtectedRoute>} />`);
content = content.replace(/<Route path="\/orders".*/, `<Route path="/orders" element={<ProtectedRoute><Orders /></ProtectedRoute>} />\n          <Route path="/warranty" element={<ProtectedRoute><Warranty /></ProtectedRoute>} />\n          <Route path="/tools" element={<ProtectedRoute><Tools /></ProtectedRoute>} />`);

fs.writeFileSync('src/App.tsx', content);
