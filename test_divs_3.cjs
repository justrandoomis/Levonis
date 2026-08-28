const fs = require('fs');
const content = fs.readFileSync('src/pages/Product.tsx', 'utf8');

let level = 0;
let lines = content.split('\n');
for (let i = 135; i < lines.length; i++) {
  let line = lines[i];
  let opens = (line.match(/<div/g) || []).length;
  let closes = (line.match(/<\/div>/g) || []).length;
  level += opens - closes;
  if (opens > 0 || closes > 0) {
    console.log(`${i+1}: ${level} ${line.trim()}`);
  }
}
