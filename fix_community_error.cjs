const fs = require('fs');

const path = 'src/pages/Community.tsx';
let content = fs.readFileSync(path, 'utf8');

content = content.replace(
  "console.error(err);",
  "// removed console.error"
);

fs.writeFileSync(path, content);
