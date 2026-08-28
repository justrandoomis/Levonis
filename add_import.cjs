const fs = require('fs');

let code = fs.readFileSync('src/pages/Subscription.tsx', 'utf8');

if (!code.includes('ScrollReveal')) {
  code = code.replace(
    /import \{ useAuth \} from '\.\.\/AuthContext';\n/,
    `import { useAuth } from '../AuthContext';\nimport ScrollReveal from '../components/ScrollReveal';\n`
  );
  fs.writeFileSync('src/pages/Subscription.tsx', code);
}
