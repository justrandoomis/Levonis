const fs = require('fs');

let code = fs.readFileSync('src/components/AdminProducts.tsx', 'utf8');

code = code.replace(
  /const \[isEditing, setIsEditing\] = useState\(false\);/,
  `const [isEditing, setIsEditing] = useState(false);\n  const [isPreviewOpen, setIsPreviewOpen] = useState(false);`
);

fs.writeFileSync('src/components/AdminProducts.tsx', code);
