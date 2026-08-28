const fs = require('fs');
let tsx = fs.readFileSync('src/components/GooeyNav.tsx', 'utf8');

const replacement = `  return (
    <>
      <svg style={{ position: 'absolute', width: 0, height: 0 }}>
        <defs>
          <filter id="gooey-nav-filter">
            <feGaussianBlur in="SourceGraphic" stdDeviation="7" result="blur" />
            <feColorMatrix in="blur" mode="matrix" values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 18 -7" result="goo" />
            <feComposite in="SourceGraphic" in2="goo" operator="atop" />
          </filter>
        </defs>
      </svg>
      <div className="gooey-nav-container" ref={containerRef}>`;

tsx = tsx.replace(/  return \(\n    <div className="gooey-nav-container" ref={containerRef}>/, replacement);
tsx = tsx.replace(/    <\/div>\n  \);\n\};/, `    </div>\n    </>\n  );\n};`);

fs.writeFileSync('src/components/GooeyNav.tsx', tsx);
console.log('Fixed TSX');
