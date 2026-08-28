const fs = require('fs');
let css = fs.readFileSync('src/components/GooeyNav.css', 'utf8');

// Use SVG filter instead of CSS filter contrast on black background
css = css.replace(
  /\.gooey-nav-container \.effect\.filter \{\n  filter: blur\(7px\) contrast\(100\) blur\(0\);\n  mix-blend-mode: lighten;\n\}/,
  `.gooey-nav-container .effect.filter {\n  filter: url('#gooey-nav-filter');\n}`
);

// Remove the black background completely
css = css.replace(
  /\.gooey-nav-container \.effect\.filter::before \{\n  content: '';\n  position: absolute;\n  inset: -75px;\n  z-index: -2;\n  background: black;\n\}/,
  `.gooey-nav-container .effect.filter::before {\n  /* Removed black background */\n}`
);

fs.writeFileSync('src/components/GooeyNav.css', css);
console.log('Fixed CSS');
