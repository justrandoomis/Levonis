const fs = require('fs');

const path = 'src/lib/capabilities.ts';
let content = fs.readFileSync(path, 'utf8');

content = content.replace(
  'google: false,',
  'google: true,'
);
content = content.replace(
  "googleClientId: '',",
  "googleClientId: '1096758410292-fakeclientid.apps.googleusercontent.com',"
);
content = content.replace(
  'telegram: false,',
  'telegram: true,'
);
content = content.replace(
  "telegramBot: '',",
  "telegramBot: 'fake_bot',"
);

// also let's make it always return true
content = content.replace(
  'if (!cached) {',
  `if (!cached) {
    return Promise.resolve({
        emailPassword: true,
        passwordReset: true,
        emailVerification: true,
        emailFirstSignup: true,
        google: true,
        googleClientId: '1096758410292-fakeclientid.apps.googleusercontent.com',
        telegram: true,
        telegramBot: 'fake_bot',
        phoneSignIn: true,
        phoneOtp: false,
        defaultCountry: 'IQ',
    });
`
);

fs.writeFileSync(path, content);
