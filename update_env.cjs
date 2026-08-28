const fs = require('fs');
let env = fs.readFileSync('.env.example', 'utf8');

env += `
CLOUDFLARE_R2_ENDPOINT=your_r2_endpoint_url
CLOUDFLARE_R2_ACCESS_KEY_ID=your_access_key
CLOUDFLARE_R2_SECRET_ACCESS_KEY=your_secret_key
CLOUDFLARE_R2_BUCKET_NAME=your_bucket_name
CLOUDFLARE_R2_PUBLIC_URL=your_public_r2_url
`;

fs.writeFileSync('.env.example', env);
