const fs = require('fs');
let code = fs.readFileSync('src/components/Stack.tsx', 'utf8');

code = code.replace(
  /animate=\{\{\n\s*rotateZ: \(stack\.length - index - 1\) \* 4 \+ randomRotate,\n\s*scale: 1 \+ index \* 0\.06 - stack\.length \* 0\.06,\n\s*transformOrigin: '90% 90%'\n\s*\}\}/,
  `style={{ transformOrigin: '90% 90%' }}\n              animate={{
                rotateZ: (stack.length - index - 1) * 4 + randomRotate,
                scale: 1 + index * 0.06 - stack.length * 0.06
              }}`
);

fs.writeFileSync('src/components/Stack.tsx', code);
console.log('Fixed Stack.tsx');
