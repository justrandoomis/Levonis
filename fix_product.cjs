const fs = require('fs');
let content = fs.readFileSync('src/pages/Product.tsx.backup', 'utf8');

// The corrupted string is exactly:
//     </div>
//   );
//       <div 
// We want to replace it globally.
// BUT wait, maybe the first one is legitimate? 
// In React, you can only return one root element. 
// If there are multiple, it's invalid.
// Let's replace ALL instances of `    </div>\n  );\n      <div` with just `      <div`?
// No, the `</div>` and `);` closed the return and the component!
// The correct structure of the file:
// return (
//   <div className="w-full ...
//      <div className="fixed top-0 ...
//      </div>
//      <div className="w-full pt-[60px] ...
//      ...
//   </div>
// );

// So if the file has `    </div>\n  );\n      <div`, it's closing the return prematurely.
// Let's replace `    </div>\n  );\n      <div` with just `      <div`.
content = content.replace(/    <\/div>\n  \);\n      <div/g, '      <div');

// But wait, there might be other places where it was inserted. Let's see what happens.
fs.writeFileSync('src/pages/Product.tsx', content);
console.log('Fixed syntax?');
