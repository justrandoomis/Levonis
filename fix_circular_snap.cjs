const fs = require('fs');
let code = fs.readFileSync('src/components/CircularGallery.tsx', 'utf8');

code = code.replace(
  /if \(this\.viewport && this\.viewport\.width\) \{\n\s*this\.scroll\.target = this\.viewport\.width \/ 2;\n\s*this\.scroll\.current = this\.scroll\.target;\n\s*this\.scroll\.last = this\.scroll\.target;\n\s*\}/,
  `if (this.viewport && this.viewport.width) {
      this.scroll.target = 0;
      this.scroll.current = this.scroll.target;
      this.scroll.last = this.scroll.target;
    }`
);

code = code.replace(
  /onCheck\(\) \{\n\s*if \(\!this\.medias \|\| \!this\.medias\[0\]\) return;\n\s*const width = this\.medias\[0\]\.width;\n\s*const H = this\.viewport\.width \/ 2;\n\s*\n\s*\/\/ Find the closest index to the center\n\s*const centerIndex = Math\.round\(\(this\.scroll\.target - H\) \/ width\);\n\s*\n\s*\/\/ Snap target so this plane is at exactly x = 0 \(center\)\n\s*this\.scroll\.target = H \+ centerIndex \* width;/,
  `onCheck() {
    if (!this.medias || !this.medias[0]) return;
    const width = this.medias[0].width;
    
    // Find the closest index to the center
    const centerIndex = Math.round(this.scroll.target / width);
    
    // Snap target so this plane is at exactly x = 0 (center)
    this.scroll.target = centerIndex * width;`
);

fs.writeFileSync('src/components/CircularGallery.tsx', code);
console.log('Fixed CircularGallery snap');
