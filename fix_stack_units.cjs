const fs = require('fs');
let code = fs.readFileSync('src/components/Stack.tsx', 'utf8');

// Fix rotateX and rotateY to output strings with "deg"
code = code.replace(
  /const rotateX = useTransform\(y, \[-100, 100\], \[60, -60\]\);/,
  `const rotateX = useTransform(y, [-100, 100], ["60deg", "-60deg"]);`
);
code = code.replace(
  /const rotateY = useTransform\(x, \[-100, 100\], \[-60, 60\]\);/,
  `const rotateY = useTransform(x, [-100, 100], ["-60deg", "60deg"]);`
);

// Fix rotateZ to output string with "deg"
code = code.replace(
  /rotateZ: \(stack\.length - index - 1\) \* 4 \+ randomRotate,/g,
  `rotateZ: \`\${(stack.length - index - 1) * 4 + randomRotate}deg\`, `
);

// Fix x: 0, y: 0 in style to be valid or use initial
code = code.replace(
  /<motion\.div className="card-rotate-disabled" style={{ x: 0, y: 0 }}>/g,
  `<motion.div className="card-rotate-disabled" style={{ x: "0px", y: "0px" }}>`
);

fs.writeFileSync('src/components/Stack.tsx', code);
console.log('Fixed Stack.tsx units');
