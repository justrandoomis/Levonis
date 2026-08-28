const fs = require('fs');
let content = fs.readFileSync('src/pages/Product.tsx.backup', 'utf8');

// Replace all instances of:
// </div>
// );
// <div
// with just <div
content = content.replace(/<\/div>\r?\n\s*\);\r?\n\s*(<div)/g, '$1');

// There might be some left at the end of the file.
// Let's see how many matches we make.
fs.writeFileSync('src/pages/Product.tsx', content);
