const fs = require('fs');
let content = fs.readFileSync('src/pages/Product.tsx', 'utf8');

// The closing of the px-4 py-5 div is around here:
//              ))}
//           </div>
//         </div>
//       </div>
//       {cartModalOpen && (

// We want to add one more </div> to close the inner wrapper.
content = content.replace(
  /          <\/div>\n        <\/div>\n      <\/div>\n      \{cartModalOpen && \(/,
  '          </div>\n        </div>\n      </div>\n      </div>\n      {cartModalOpen && ('
);

// At the very end of the file, we have:
//       ))}
//     </div>
//     </div>
//   );
// }

// We want to remove one </div> from the end.
content = content.replace(
  /      \}\)\}\n    <\/div>\n    <\/div>\n  \);\n\}/,
  '      }))}\n    </div>\n  );\n}'
);

fs.writeFileSync('src/pages/Product.tsx', content);
