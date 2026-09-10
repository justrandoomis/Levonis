const fs = require('fs');

const path = 'src/lib/capabilities.ts';
let content = fs.readFileSync(path, 'utf8');

content = content.replace(
  `    return Promise.resolve({
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
    });`,
  `    cached = Promise.resolve({
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
    }); return cached;`
);

fs.writeFileSync(path, content);
