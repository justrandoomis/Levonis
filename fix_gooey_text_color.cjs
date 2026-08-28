const fs = require('fs');
let code = fs.readFileSync('src/components/GooeyNav.css', 'utf8');

code = code.replace(
  /\.gooey-nav-container nav ul li\.active \{\n  color: black;/g,
  `.gooey-nav-container nav ul li.active {\n  color: var(--active-text-color, white);`
);

code = code.replace(
  /\.gooey-nav-container \.effect\.text\.active \{\n  color: black;/g,
  `.gooey-nav-container .effect.text.active {\n  color: var(--active-text-color, white);`
);

fs.writeFileSync('src/components/GooeyNav.css', code);
