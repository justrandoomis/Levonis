const fs = require('fs');
let content = fs.readFileSync('src/pages/Profile.tsx', 'utf8');

const target = `<svg viewBox="0 0 24 24" fill="currentColor" className="w-full h-full">
                  <path d="M12 2.25c-4.5 0-8 2-8 2v5.5c0 5.5 3.5 10 8 12 4.5-2 8-6.5 8-12v-5.5s-3.5-2-8-2zm-1.25 12.5l-3.5-3.5 1.5-1.5 2 2 5-5 1.5 1.5-6.5 6.5z" />
                </svg>`;

const replacement = `<svg viewBox="0 0 24 24" fill="currentColor" className="w-full h-full">
                  <path fillRule="evenodd" clipRule="evenodd" d="M12 2.25C7.5 2.25 4 4.25 4 4.25V9.75C4 15.25 7.5 19.75 12 21.75C16.5 19.75 20 15.25 20 9.75V4.25S16.5 2.25 12 2.25ZM16.3 8.3L10.8 13.8L7.7 10.7L6.3 12.1L10.8 16.6L17.7 9.7L16.3 8.3Z" />
                </svg>`;

content = content.replace(target, replacement);
fs.writeFileSync('src/pages/Profile.tsx', content);
