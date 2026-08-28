const fs = require('fs');
let content = fs.readFileSync('src/App.tsx', 'utf8');
content = content.replace(
  '<GradualBlur target="page" position="bottom" height="120px" strength={2} divCount={10} curve="bezier" exponential={true} opacity={1} zIndex={40} />',
  ''
);
fs.writeFileSync('src/App.tsx', content);
console.log('Removed GradualBlur');
