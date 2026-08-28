const fs = require('fs');
let content = fs.readFileSync('src/pages/Profile.tsx', 'utf8');

const target = `<svg viewBox="0 0 24 24" fill="currentColor" className="w-full h-full">
                  <path d="M20 7H4C2.9 7 2 7.9 2 9V17C2 18.1 2.9 19 4 19H20C21.1 19 22 18.1 22 17V9C22 7.9 21.1 7 20 7ZM17.5 15H15.5V11H17.5C18.6 11 19.5 11.9 19.5 13C19.5 14.1 18.6 15 17.5 15Z" />
                  <circle cx="17.5" cy="13" r="1.2" fill="#0a0a0a" />
                </svg>`;

const replacement = `<svg viewBox="0 0 24 24" fill="currentColor" className="w-full h-full">
                  <path fillRule="evenodd" clipRule="evenodd" d="M20 7H4C2.9 7 2 7.9 2 9V17C2 18.1 2.9 19 4 19H20C21.1 19 22 18.1 22 17V9C22 7.9 21.1 7 20 7ZM15 15.5V10.5C15 9.7 15.7 9 16.5 9H20V17H16.5C15.7 17 15 16.3 15 15.5Z" />
                  <path d="M16.5 10.5C15.9 10.5 15.5 10.9 15.5 11.5V14.5C15.5 15.1 15.9 15.5 16.5 15.5H20V10.5H16.5Z" />
                  <circle cx="17.2" cy="13" r="1.2" fill="#0a0a0a" />
                </svg>`;

content = content.replace(target, replacement);
fs.writeFileSync('src/pages/Profile.tsx', content);
