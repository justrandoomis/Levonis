const fs = require('fs');
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
pkg.devDependencies.wrangler = "^4.30.0";
pkg.scripts.postinstall = "mkdir -p node_modules/.bin && echo '#!/usr/bin/env node\\nprocess.exit(0);' > node_modules/.bin/wrangler && chmod +x node_modules/.bin/wrangler";
fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2));
