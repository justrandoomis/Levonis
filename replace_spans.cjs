const fs = require('fs');

let code = fs.readFileSync('src/pages/Subscription.tsx', 'utf8');

// Replace standard spans
code = code.replace(
  /<span>\{t\('benefitPlus(\d+)'\)\}<\/span>/g,
  `<ScrollReveal baseOpacity={0} enableBlur={true} baseRotation={5} blurStrength={10} containerClassName="!m-0 inline" textClassName="!text-[inherit] !font-inherit !leading-inherit inline">{t('benefitPlus$1')}</ScrollReveal>`
);

code = code.replace(
  /<span>\{t\('benefitPro(\d+)'\)\}<\/span>/g,
  `<ScrollReveal baseOpacity={0} enableBlur={true} baseRotation={5} blurStrength={10} containerClassName="!m-0 inline" textClassName="!text-[inherit] !font-inherit !leading-inherit inline">{t('benefitPro$1')}</ScrollReveal>`
);

// Replace bold spans
code = code.replace(
  /<span className="font-bold tracking-wide">\{t\('benefitPro(\d+)'\)\}<\/span>/g,
  `<ScrollReveal baseOpacity={0} enableBlur={true} baseRotation={5} blurStrength={10} containerClassName="!m-0 inline" textClassName="!text-[inherit] font-bold tracking-wide !leading-inherit inline">{t('benefitPro$1')}</ScrollReveal>`
);

fs.writeFileSync('src/pages/Subscription.tsx', code);
