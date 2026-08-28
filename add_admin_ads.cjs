const fs = require('fs');
let code = fs.readFileSync('src/pages/Admin.tsx', 'utf8');

if (!code.includes('AdminAds')) {
  code = code.replace(
    /import AdminProducts from '\.\.\/components\/AdminProducts';\n/,
    `import AdminProducts from '../components/AdminProducts';\nimport AdminAds from '../components/AdminAds';\nimport { Megaphone } from 'lucide-react';\n`
  );

  code = code.replace(
    /    \{ id: 'store_settings', icon: Settings, label: 'Store Settings' \}\n  \];/,
    `    { id: 'store_settings', icon: Settings, label: 'Store Settings' },\n    { id: 'ads', icon: Megaphone, label: 'Ads & Texts' }\n  ];`
  );

  code = code.replace(
    /        \{activeTab === 'products' && \(\n          <AdminProducts \/>\n        \)\}/,
    `        {activeTab === 'products' && (\n          <AdminProducts />\n        )}\n        {activeTab === 'ads' && (\n          <AdminAds />\n        )}`
  );

  fs.writeFileSync('src/pages/Admin.tsx', code);
}
