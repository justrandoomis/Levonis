const fs = require('fs');

let code = fs.readFileSync('src/components/AdminProducts.tsx', 'utf8');

code = code.replace(
  /import \{ Plus, Edit2, Trash2, ChevronDown, ChevronUp, Image as ImageIcon, X, Save, ArrowLeft, Check \} from 'lucide-react';/,
  `import { Plus, Edit2, Trash2, ChevronDown, ChevronUp, Image as ImageIcon, X, Save, ArrowLeft, Check, ShoppingCart, Star } from 'lucide-react';`
);

fs.writeFileSync('src/components/AdminProducts.tsx', code);
