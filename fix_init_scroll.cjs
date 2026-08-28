const fs = require('fs');
let code = fs.readFileSync('src/components/CircularGallery.tsx', 'utf8');

if (!code.includes('this.scroll.target = this.viewport.width / 2;')) {
  code = code.replace(
    /this\.createMedias\(items, bend, textColor, borderRadius, font\);\n\s*this\.update\(\);/,
    `this.createMedias(items, bend, textColor, borderRadius, font);
    if (this.viewport && this.viewport.width) {
      this.scroll.target = this.viewport.width / 2;
      this.scroll.current = this.scroll.target;
      this.scroll.last = this.scroll.target;
    }
    this.update();`
  );
  fs.writeFileSync('src/components/CircularGallery.tsx', code);
  console.log('Fixed initial scroll');
} else {
  console.log('Already fixed');
}
