const fs = require('fs');
let code = fs.readFileSync('src/components/CircularGallery.tsx', 'utf8');

// Update App constructor and onCheck
code = code.replace(/constructor\(\n    container: any,\n    \{\n      items,/, `onIndexChange: any;\n  constructor(\n    container: any,\n    \{\n      items,\n      onIndexChange,`);
code = code.replace(/this\.onCheckDebounce = debounce\(this\.onCheck\.bind\(this\), 200\);\n    this\.createRenderer\(\);/, `this.onCheckDebounce = debounce(this.onCheck.bind(this), 200);\n    this.onIndexChange = onIndexChange;\n    this.createRenderer();`);

code = code.replace(/  onCheck\(\) \{\n    if \(!this\.medias \|\| !this\.medias\[0\]\) return;\n    const width = this\.medias\[0\]\.width;\n    const itemIndex = Math\.round\(Math\.abs\(this\.scroll\.target\) \/ width\);\n    const item = width \* itemIndex;\n    this\.scroll\.target = this\.scroll\.target < 0 \? -item : item;\n  \}/, `  onCheck() {
    if (!this.medias || !this.medias[0]) return;
    const width = this.medias[0].width;
    const itemIndex = Math.round(Math.abs(this.scroll.target) / width);
    const item = width * itemIndex;
    this.scroll.target = this.scroll.target < 0 ? -item : item;
    
    if (this.onIndexChange) {
      // The array is concatenated with itself, so we take modulo of half length
      const realIndex = itemIndex % (this.mediasImages.length / 2);
      this.onIndexChange(realIndex);
    }
  }`);

// Update CircularGallery component signature and app creation
code = code.replace(/export default function CircularGallery\(\{\n  items,\n  bend = 3,\n  textColor = '#ffffff',\n  borderRadius = 0\.05,\n  font = 'bold 30px Figtree',\n  fontUrl,\n  scrollSpeed = 2,\n  scrollEase = 0\.05\n\}: any\) \{/, `export default function CircularGallery({
  items,
  bend = 3,
  textColor = '#ffffff',
  borderRadius = 0.05,
  font = 'bold 30px Figtree',
  fontUrl,
  scrollSpeed = 2,
  scrollEase = 0.05,
  onIndexChange
}: any) {`);

code = code.replace(/      app = new App\(containerRef\.current, \{\n        items,\n        bend,\n        textColor,\n        borderRadius,\n        font: resolvedFont,\n        scrollSpeed,\n        scrollEase/, `      app = new App(containerRef.current, {
        items,
        bend,
        textColor,
        borderRadius,
        font: resolvedFont,
        scrollSpeed,
        scrollEase,
        onIndexChange`);

fs.writeFileSync('src/components/CircularGallery.tsx', code);
