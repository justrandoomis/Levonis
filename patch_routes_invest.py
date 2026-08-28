import re

with open('src/App.tsx', 'r') as f:
    content = f.read()

import_invest = "import Invest from './pages/Invest';\nimport InvestAdmin from './pages/InvestAdmin';\n"
content = content.replace("import Admin from './pages/Admin';", "import Admin from './pages/Admin';\n" + import_invest)

route_invest = "          <Route path=\"/invest\" element={<Invest />} />\n          <Route path=\"/admin/invest\" element={<InvestAdmin />} />\n"
content = content.replace("          <Route path=\"/admin\" element={<Admin />} />", "          <Route path=\"/admin\" element={<Admin />} />\n" + route_invest)

with open('src/App.tsx', 'w') as f:
    f.write(content)
