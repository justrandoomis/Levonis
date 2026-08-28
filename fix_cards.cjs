const fs = require('fs');
let code = fs.readFileSync('src/pages/Subscription.tsx', 'utf8');

const generatePlanTextureCode = `
const generatePlanImage = (plan: any, activeTab: string) => {
  const canvas = document.createElement('canvas');
  canvas.width = 600;
  canvas.height = 800;
  const ctx = canvas.getContext('2d');
  if (!ctx) return '';
  
  const isPro = activeTab === 'pro';
  const primaryColor = isPro ? '#B03142' : '#8B9B7B';
  
  // Background
  const gradient = ctx.createLinearGradient(0, 0, 0, canvas.height);
  gradient.addColorStop(0, '#27272a');
  gradient.addColorStop(1, '#18181b');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  
  // Border
  ctx.lineWidth = 12;
  ctx.strokeStyle = primaryColor;
  ctx.strokeRect(6, 6, canvas.width - 12, canvas.height - 12);
  
  // Badge
  if (plan.badge) {
    ctx.fillStyle = primaryColor;
    ctx.fillRect(0, 0, canvas.width, 90);
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 36px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(plan.badge.toUpperCase(), canvas.width / 2, 45);
  }
  
  // Number
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 220px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(plan.number, canvas.width / 2, 280);
  
  // Unit
  ctx.fillStyle = '#a1a1aa';
  ctx.font = 'bold 60px sans-serif';
  ctx.fillText(plan.unit, canvas.width / 2, 430);
  
  // Divider
  ctx.strokeStyle = 'rgba(255,255,255,0.1)';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(100, 520);
  ctx.lineTo(500, 520);
  ctx.stroke();
  
  // Price Per Unit
  ctx.fillStyle = '#e4e4e7';
  ctx.font = '48px sans-serif';
  ctx.fillText(plan.pricePerUnit, canvas.width / 2, 600);
  
  // Savings
  if (plan.savings) {
    ctx.fillStyle = isPro ? 'rgba(176, 49, 66, 0.8)' : 'rgba(139, 155, 123, 0.5)';
    const rw = 220, rh = 70, rx = canvas.width / 2 - rw / 2, ry = 640, r = 35;
    ctx.beginPath();
    ctx.moveTo(rx + r, ry);
    ctx.lineTo(rx + rw - r, ry);
    ctx.quadraticCurveTo(rx + rw, ry, rx + rw, ry + r);
    ctx.lineTo(rx + rw, ry + rh - r);
    ctx.quadraticCurveTo(rx + rw, ry + rh, rx + rw - r, ry + rh);
    ctx.lineTo(rx + r, ry + rh);
    ctx.quadraticCurveTo(rx, ry + rh, rx, ry + rh - r);
    ctx.lineTo(rx, ry + r);
    ctx.quadraticCurveTo(rx, ry, rx + r, ry);
    ctx.closePath();
    ctx.fill();
    
    ctx.fillStyle = '#facc15';
    ctx.font = 'bold 38px sans-serif';
    ctx.fillText(plan.savings, canvas.width / 2, ry + rh / 2 + 2);
  }
  
  // Total
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 44px sans-serif';
  ctx.fillText('Total: ' + plan.total, canvas.width / 2, 750);
  
  return canvas.toDataURL('image/png');
};
`;

if (!code.includes('generatePlanImage')) {
  code = code.replace(/export default function Subscription\(\) \{/, generatePlanTextureCode + '\nexport default function Subscription() {');
}

const replacement = `                {/* Circular Plans Gallery */}
        <div className="pt-4 pb-4 min-h-[400px] px-2 sm:px-0 relative mb-8">
          <div style={{ height: '450px', position: 'relative' }}>
            <CircularGallery
              bend={3}
              textColor="#ffffff"
              borderRadius={0.1}
              scrollEase={0.08}
              fontUrl="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@700&display=swap"
              font="bold 24px 'Plus Jakarta Sans'"
              scrollSpeed={3.5}
              onIndexChange={(index: number) => {
                if (activePlans[index]) {
                  setSelectedDuration(activePlans[index].id);
                }
              }}
              items={activePlans.map((plan) => {
                return {
                  image: generatePlanImage(plan, activeTab),
                  text: ''
                };
              })}
            />
          </div>
        </div>`;

const regex = /\{\/\* Circular Plans Gallery \*\/\}[\s\S]*?<\/AnimatePresence>\n\s*<\/div>/;

if (regex.test(code)) {
  code = code.replace(regex, replacement);
  fs.writeFileSync('src/pages/Subscription.tsx', code);
  console.log('Successfully replaced plans grid.');
} else {
  console.error('Regex did not match.');
}
