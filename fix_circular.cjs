const fs = require('fs');

// 1. Fix CircularGallery.css
let css = fs.readFileSync('src/components/CircularGallery.css', 'utf8');
if (!css.includes('touch-action: pan-y;')) {
  css = css.replace(/cursor: grab;/, 'cursor: grab;\n  touch-action: pan-y;');
  fs.writeFileSync('src/components/CircularGallery.css', css);
}

// 2. Fix CircularGallery.tsx
let cg = fs.readFileSync('src/components/CircularGallery.tsx', 'utf8');

// Fix startY initialization
cg = cg.replace(/this\.start = e\.touches \? e\.touches\[0\]\.clientX : e\.clientX;/, 
  'this.start = e.touches ? e.touches[0].clientX : e.clientX;\n    this.startY = e.touches ? e.touches[0].clientY : e.clientY;\n    this.isDirectionDetermined = false;\n    this.isHorizontal = false;');

cg = cg.replace(/onTouchMove\(e: any\) \{\n\s*if \(!this\.isDown\) return;\n\s*const x = e\.touches \? e\.touches\[0\]\.clientX : e\.clientX;\n\s*const distance = \(this\.start - x\) \* \(this\.scrollSpeed \* 0\.025\);\n\s*this\.scroll\.target = this\.scroll\.position \+ distance;\n\s*\}/, 
  `onTouchMove(e: any) {
    if (!this.isDown) return;
    const x = e.touches ? e.touches[0].clientX : e.clientX;
    const y = e.touches ? e.touches[0].clientY : e.clientY;
    
    if (!this.isDirectionDetermined) {
      const dx = Math.abs(x - this.start);
      const dy = Math.abs(y - this.startY);
      if (dx > 5 || dy > 5) {
        this.isDirectionDetermined = true;
        this.isHorizontal = dx > dy;
      }
      if (!this.isDirectionDetermined) return;
    }
    
    if (!this.isHorizontal) return;
    
    const distance = (this.start - x) * (this.scrollSpeed * 0.025);
    this.scroll.target = this.scroll.position + distance;
  }`);

cg = cg.replace(/window\.addEventListener\('mousewheel', this\.boundOnWheel\);\n\s*window\.addEventListener\('wheel', this\.boundOnWheel\);\n\s*window\.addEventListener\('mousedown', this\.boundOnTouchDown\);\n\s*window\.addEventListener\('mousemove', this\.boundOnTouchMove\);\n\s*window\.addEventListener\('mouseup', this\.boundOnTouchUp\);\n\s*window\.addEventListener\('touchstart', this\.boundOnTouchDown\);\n\s*window\.addEventListener\('touchmove', this\.boundOnTouchMove\);\n\s*window\.addEventListener\('touchend', this\.boundOnTouchUp\);/,
  `this.container.addEventListener('mousewheel', this.boundOnWheel, { passive: true });
    this.container.addEventListener('wheel', this.boundOnWheel, { passive: true });
    this.container.addEventListener('mousedown', this.boundOnTouchDown);
    this.container.addEventListener('touchstart', this.boundOnTouchDown, { passive: true });
    
    window.addEventListener('mousemove', this.boundOnTouchMove);
    window.addEventListener('mouseup', this.boundOnTouchUp);
    window.addEventListener('touchmove', this.boundOnTouchMove, { passive: true });
    window.addEventListener('touchend', this.boundOnTouchUp);`);

cg = cg.replace(/window\.removeEventListener\('mousewheel', this\.boundOnWheel\);\n\s*window\.removeEventListener\('wheel', this\.boundOnWheel\);\n\s*window\.removeEventListener\('mousedown', this\.boundOnTouchDown\);\n\s*window\.removeEventListener\('mousemove', this\.boundOnTouchMove\);\n\s*window\.removeEventListener\('mouseup', this\.boundOnTouchUp\);\n\s*window\.removeEventListener\('touchstart', this\.boundOnTouchDown\);\n\s*window\.removeEventListener\('touchmove', this\.boundOnTouchMove\);\n\s*window\.removeEventListener\('touchend', this\.boundOnTouchUp\);/,
  `if (this.container) {
      this.container.removeEventListener('mousewheel', this.boundOnWheel);
      this.container.removeEventListener('wheel', this.boundOnWheel);
      this.container.removeEventListener('mousedown', this.boundOnTouchDown);
      this.container.removeEventListener('touchstart', this.boundOnTouchDown);
    }
    window.removeEventListener('mousemove', this.boundOnTouchMove);
    window.removeEventListener('mouseup', this.boundOnTouchUp);
    window.removeEventListener('touchmove', this.boundOnTouchMove);
    window.removeEventListener('touchend', this.boundOnTouchUp);`);

// Make sure class App properties have startY, etc
if (!cg.includes('startY: number')) {
  cg = cg.replace(/start: number = 0;/, 'start: number = 0; startY: number = 0; isDirectionDetermined: boolean = false; isHorizontal: boolean = false;');
}

fs.writeFileSync('src/components/CircularGallery.tsx', cg);

// 3. Fix Subscription.tsx to prevent re-renders on scroll
let sub = fs.readFileSync('src/pages/Subscription.tsx', 'utf8');

if (!sub.includes('const galleryItems = React.useMemo')) {
  const hookInjection = `
  const galleryItems = React.useMemo(() => {
    return activePlans.map((plan) => {
      return {
        image: generatePlanImage(plan, activeTab),
        text: ''
      };
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab]);
  `;
  
  sub = sub.replace(/const handleSubscribe = async \(\) => \{/, hookInjection + '\n  const handleSubscribe = async () => {');
  
  sub = sub.replace(/items=\{activePlans\.map\(\(plan\) => \{\n\s*return \{\n\s*image: generatePlanImage\(plan, activeTab\),\n\s*text: ''\n\s*\};\n\s*\}\)\}/, 'items={galleryItems}');
  
  fs.writeFileSync('src/pages/Subscription.tsx', sub);
}

