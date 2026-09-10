const fs = require('fs');

const path = 'src/WalletContext.tsx';
let content = fs.readFileSync(path, 'utf8');

content = content.replace(
  "console.error('Failed to fetch settings', e);",
  "// removed console.error"
);

content = content.replace(
  "console.error('Failed to fetch wallet', e);",
  "// removed console.error"
);

fs.writeFileSync(path, content);
