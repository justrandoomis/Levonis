const fs = require('fs');

let code = fs.readFileSync('src/components/AdminProducts.tsx', 'utf8');

code = code.replace(/new Promise\(resolve => \{/g, 'new Promise<void>(resolve => {');

fs.writeFileSync('src/components/AdminProducts.tsx', code);
