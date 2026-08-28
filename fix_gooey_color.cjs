const fs = require('fs');
let code = fs.readFileSync('src/components/GooeyNav.tsx', 'utf8');

if (!code.includes('activeColor')) {
  code = code.replace(
    /initialActiveIndex = 0,\n  onChange\n}: any\) => \{/,
    `initialActiveIndex = 0,\n  onChange,\n  activeColor\n}: any) => {`
  );

  code = code.replace(
    /particle\.style\.setProperty\('--color', \`var\(--color-\$\{p\.color\}, white\)\`\);/,
    `particle.style.setProperty('--color', activeColor || \`var(--color-\${p.color}, white)\`);`
  );

  // Add the active color inline style to the container
  code = code.replace(
    /<div className="gooey-nav-container" ref=\{containerRef\}>/,
    `<div className="gooey-nav-container" ref={containerRef} style={{ '--active-bg': activeColor } as React.CSSProperties}>`
  );
  
  // also change the color of the text for the active pill
  // .effect.text.active gets color: black; but wait, if it's red/olive, maybe white text is better on it?
  // Let's check text color.
}
fs.writeFileSync('src/components/GooeyNav.tsx', code);
