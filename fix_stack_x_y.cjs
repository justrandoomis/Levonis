const fs = require('fs');
let code = fs.readFileSync('src/components/Stack.tsx', 'utf8');

code = code.replace(
  /<motion\.div className="card-rotate-disabled" style={{ x: "0px", y: "0px" }}>/g,
  `<motion.div className="card-rotate-disabled" initial={{ x: 0, y: 0 }}>`
);

fs.writeFileSync('src/components/Stack.tsx', code);
console.log('Fixed x, y in Stack.tsx');
