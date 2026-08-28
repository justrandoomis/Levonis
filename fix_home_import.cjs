const fs = require('fs');
let code = fs.readFileSync('src/pages/Home.tsx', 'utf8');

if (!code.includes('TrueFocus from')) {
  code = code.replace(
    /import React, \{ useState, useEffect, useRef \} from 'react';/,
    `import React, { useState, useEffect, useRef } from 'react';\nimport TrueFocus from '../components/TrueFocus';`
  );
  fs.writeFileSync('src/pages/Home.tsx', code);
}
