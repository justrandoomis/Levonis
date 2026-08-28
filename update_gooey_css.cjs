const fs = require('fs');
let css = fs.readFileSync('src/components/GooeyNav.css', 'utf8');

css = css.replace(
  /\.gooey-nav-container nav ul li::after \{\n  content: '';\n  position: absolute;\n  inset: 0;\n  border-radius: 100vw;\n  background: white;/g,
  `.gooey-nav-container nav ul li::after {\n  content: '';\n  position: absolute;\n  inset: 0;\n  border-radius: 100vw;\n  background: var(--active-bg, white);`
);

css = css.replace(
  /\.gooey-nav-container \.effect\.filter::after \{\n  content: '';\n  position: absolute;\n  inset: 0;\n  background: white;/g,
  `.gooey-nav-container .effect.filter::after {\n  content: '';\n  position: absolute;\n  inset: 0;\n  background: var(--active-bg, white);`
);

fs.writeFileSync('src/components/GooeyNav.css', css);
console.log('Fixed CSS background variables');
