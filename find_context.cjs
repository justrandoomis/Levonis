const fs = require('fs');
const content = fs.readFileSync('src/pages/Product.tsx', 'utf8');
const regex = /<\/div>\r?\n\s*\);\r?\n\s*<div/g;
let match;
let i = 0;
while ((match = regex.exec(content)) !== null && i < 10) {
  console.log(`Match ${i+1} at index ${match.index}:`);
  console.log(content.substring(match.index - 50, match.index + 100));
  console.log('---');
  i++;
}
