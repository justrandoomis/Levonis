const fs = require('fs');

const path = 'src/WalletContext.tsx';
let content = fs.readFileSync(path, 'utf8');

content = content.replace(
  "console.error('Failed to fetch settings', e);",
  `console.error('Failed to fetch settings', e);
      setSettings({
        exchangeRate: 1400,
        currency: 'IQD',
        adVideoUrl: '',
        paymentMethods: [],
        checkoutDeliveryMethods: [],
        checkoutPaymentMethods: [],
        cartShippingMethods: [],
        homeSections: [],
        homeBanners: {},
        homeSectionItems: {},
        homeAds: [],
      });`
);

fs.writeFileSync(path, content);
