const fs = require('fs');

const path = 'package.json';
let content = fs.readFileSync(path, 'utf8');

content = content.replace(
  '"deploy": "npm run build && wrangler deploy",',
  '"deploy": "echo \'Skipping deploy in preview environment\'",'
);

fs.writeFileSync(path, content);
