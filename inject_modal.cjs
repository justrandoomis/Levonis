const fs = require('fs');

let code = fs.readFileSync('src/components/AdminProducts.tsx', 'utf8');

code = code.replace(
  /        <\/SectionCard>\n      <\/div>\n    \);\n  \}/g,
  `        </SectionCard>
        {isPreviewOpen && <ProductPreviewModal form={form} onClose={() => setIsPreviewOpen(false)} dir={dir} />}
      </div>
    );
  }`
);

fs.writeFileSync('src/components/AdminProducts.tsx', code);
