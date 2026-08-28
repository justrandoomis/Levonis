const fs = require('fs');
let content = fs.readFileSync('src/App.tsx', 'utf8');
content = content.replace(
  '<div className="h-28 shrink-0"></div>',
  '<div className="h-36 shrink-0"></div>'
);
fs.writeFileSync('src/App.tsx', content);
