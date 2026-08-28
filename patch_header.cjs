const fs = require('fs');
let content = fs.readFileSync('src/components/Header.tsx', 'utf8');

content = content.replace("import { Link, useLocation } from 'react-router-dom';", "import { Link, useLocation, useNavigate } from 'react-router-dom';");
content = content.replace("const location = useLocation();", "const location = useLocation();\n  const navigate = useNavigate();\n  const [searchQuery, setSearchQuery] = useState('');");

content = content.replace(/<input \s*type="text" \s*placeholder=\{t\('search'\)\}/, `<input \n          type="text" \n          placeholder={t('search')}\n          value={searchQuery}\n          onChange={(e) => setSearchQuery(e.target.value)}\n          onKeyDown={(e) => {\n            if (e.key === 'Enter' && searchQuery.trim()) {\n              navigate('/products?search=' + encodeURIComponent(searchQuery.trim()));\n              setSearchQuery('');\n            }\n          }}`);

fs.writeFileSync('src/components/Header.tsx', content);
console.log('Header patched');
