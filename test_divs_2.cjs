const fs = require('fs');
const content = fs.readFileSync('src/pages/Product.tsx', 'utf8');

let level = 0;
let lines = content.split('\n');
for (let i = 135; i < lines.length; i++) {
  let line = lines[i];
  let opens = (line.match(/<div/g) || []).length;
  let closes = (line.match(/<\/div>/g) || []).length;
  level += opens - closes;
  if (i > 540 && i < 570) {
    console.log(`${i+1}: opens=${opens} closes=${closes} level_after=${level} line=${line}`);
  }
}
