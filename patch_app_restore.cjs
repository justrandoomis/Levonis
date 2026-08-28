const fs = require('fs');
let content = fs.readFileSync('src/App.tsx', 'utf8');

// Insert GradualBlur back, but right before BottomNav
if (!content.includes('<GradualBlur target="page"')) {
  content = content.replace(
    '<BottomNav />',
    '<GradualBlur target="page" position="bottom" height="120px" strength={2} divCount={10} curve="bezier" exponential={true} opacity={1} zIndex={40} />\n      <BottomNav />'
  );
  fs.writeFileSync('src/App.tsx', content);
}
console.log('Restored GradualBlur');
