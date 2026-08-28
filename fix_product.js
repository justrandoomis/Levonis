const fs = require('fs');
let code = fs.readFileSync('src/pages/Product.tsx', 'utf8');

// The file has completely messed up nested divs closing incorrectly like '    </div>    </div>  );'
// It seems `</div>    </div>  );` was created by my sed command replacing `  );` with `</div>    </div>  );` wait no, the backup itself is messed up.

// Let's replace '    </div>    </div>  );' with '' to see if that helps some syntax errors
code = code.replace(/    <\/div>    <\/div>  \);/g, '');
fs.writeFileSync('src/pages/Product.tsx', code);
